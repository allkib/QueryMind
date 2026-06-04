from __future__ import annotations

import math
import os
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from types import MappingProxyType
from typing import Any, Callable, Dict, TypeVar

import numpy as np
import pandas as pd
import requests

from schema import load_dataframe

T = TypeVar("T")
DATABRICKS_TIMEOUT_SEC = int(os.getenv("DATABRICKS_TIMEOUT_SEC", "60"))
WAREHOUSE_START_TIMEOUT_SEC = int(os.getenv("WAREHOUSE_START_TIMEOUT_SEC", "120"))
HEALTH_CACHE_TTL_SEC = int(os.getenv("DATABRICKS_HEALTH_CACHE_SEC", "120"))

_health_cache: Dict[str, Any] | None = None
_health_cache_at: float = 0.0


def get_executor_mode() -> str:
    return os.getenv("EXECUTOR", "local").lower()


def _run_with_timeout(fn: Callable[[], T], timeout_sec: int, label: str) -> T:
    pool = ThreadPoolExecutor(max_workers=1)
    future = pool.submit(fn)
    try:
        return future.result(timeout=timeout_sec)
    except FuturesTimeoutError as exc:
        raise RuntimeError(
            f"{label} timed out after {timeout_sec}s. "
            "Start your SQL warehouse in Databricks, confirm the `wells` table exists, "
            "or set EXECUTOR=local in .env for instant CSV mode."
        ) from exc
    finally:
        # Do not wait=True — a stuck Databricks connect would block forever otherwise.
        pool.shutdown(wait=False, cancel_futures=True)


class UnsafeCodeError(RuntimeError):
    pass


FORBIDDEN_TOKENS = [
    " open(",
    "open(",
    "os.",
    "subprocess",
    "eval(",
    "exec(",
    "__import__",
    "socket",
    "requests",
    "urllib",
]

ALLOWED_IMPORT_LINES = {
    "import pandas as pd",
    "import numpy as np",
}


def _validate_code_safety(code: str) -> None:
    for raw_line in code.splitlines():
        line = raw_line.strip()
        if line.startswith("import ") or line.startswith("from "):
            if line not in ALLOWED_IMPORT_LINES:
                raise UnsafeCodeError(f"Disallowed import statement: {line}")

    lowered = code.lower()
    for token in FORBIDDEN_TOKENS:
        if token in lowered:
            raise UnsafeCodeError(f"Disallowed token in generated code: {token.strip()}")


def _sanitize_code(code: str) -> str:
    """
    Remove safe import lines because imports are blocked in the sandbox and
    pandas/numpy are already injected as pd/np.
    """
    kept_lines: list[str] = []
    for raw_line in code.splitlines():
        line = raw_line.strip()
        if line in ALLOWED_IMPORT_LINES:
            continue
        kept_lines.append(raw_line)
    return "\n".join(kept_lines)


def _build_sandbox(df: pd.DataFrame) -> Dict[str, Any]:
    """
    Construct a minimal, mostly read-only globals dict for executing generated code.
    """
    safe_builtins = {
        "len": len,
        "range": range,
        "min": min,
        "max": max,
        "sum": sum,
        "abs": abs,
        "round": round,
        "sorted": sorted,
        "math": math,
    }

    globals_dict: Dict[str, Any] = {
        "__builtins__": MappingProxyType(safe_builtins),
        "pd": pd,
        "np": np,
        "df": df,
    }
    return globals_dict


def execute_code(code: str) -> pd.DataFrame | Any:
    """
    Execute generated pandas code in a restricted sandbox.

    Expects the code to define a variable named `result`. Returns the value of
    `result`. If `result` is a DataFrame, it may be truncated for safety.
    """
    if not code.strip():
        raise ValueError("No code provided to execute.")

    mode = get_executor_mode()
    if mode == "databricks":
        result = _execute_databricks_sql(code)
    else:
        _validate_code_safety(code)
        safe_code = _sanitize_code(code)

        df = load_dataframe()
        globals_dict = _build_sandbox(df)
        locals_dict: Dict[str, Any] = {}

        try:
            exec(safe_code, globals_dict, locals_dict)
        except Exception as exc:
            raise RuntimeError(f"Error while executing generated code: {exc}") from exc

        if "result" not in locals_dict:
            raise RuntimeError("Generated code did not define a variable named 'result'.")

        result = locals_dict["result"]

    if isinstance(result, pd.DataFrame):
        if len(result) > 500:
            result = result.head(500)
        return result

    # Wrap scalars into a single-row DataFrame for consistent API.
    if not isinstance(result, (pd.DataFrame, pd.Series)):
        return pd.DataFrame({"value": [result]})

    if isinstance(result, pd.Series):
        return result.to_frame(name=result.name or "value")

    return result


def _databricks_api_base() -> str:
    host = os.getenv("DATABRICKS_HOST", "")
    hostname = host.replace("https://", "").replace("http://", "").strip("/")
    return f"https://{hostname}"


def _warehouse_id_from_http_path(http_path: str) -> str:
    return http_path.rstrip("/").split("/")[-1]


def _databricks_headers() -> Dict[str, str]:
    token = os.getenv("DATABRICKS_TOKEN")
    if not token:
        raise RuntimeError("DATABRICKS_TOKEN is not set.")
    return {"Authorization": f"Bearer {token}"}


def get_warehouse_state() -> Dict[str, Any]:
    http_path = os.getenv("DATABRICKS_HTTP_PATH", "")
    warehouse_id = _warehouse_id_from_http_path(http_path)
    url = f"{_databricks_api_base()}/api/2.0/sql/warehouses/{warehouse_id}"
    response = requests.get(url, headers=_databricks_headers(), timeout=15)
    response.raise_for_status()
    return response.json()


def ensure_warehouse_running() -> str:
    """
    Ensure the configured SQL warehouse is RUNNING, starting it via REST API if needed.
    """
    info = get_warehouse_state()
    state = str(info.get("state", "UNKNOWN"))
    if state == "RUNNING":
        return state

    if state in {"STOPPED", "STOPPING"}:
        warehouse_id = _warehouse_id_from_http_path(os.getenv("DATABRICKS_HTTP_PATH", ""))
        start_url = f"{_databricks_api_base()}/api/2.0/sql/warehouses/{warehouse_id}/start"
        requests.post(start_url, headers=_databricks_headers(), timeout=15)

    deadline = time.time() + WAREHOUSE_START_TIMEOUT_SEC
    while time.time() < deadline:
        info = get_warehouse_state()
        state = str(info.get("state", "UNKNOWN"))
        if state == "RUNNING":
            return state
        if state in {"DELETED", "DELETING"}:
            raise RuntimeError(f"SQL warehouse is unavailable (state={state}).")
        time.sleep(2)

    raise RuntimeError(
        f"SQL warehouse did not reach RUNNING within {WAREHOUSE_START_TIMEOUT_SEC}s "
        f"(last state={state}). Open Databricks → SQL Warehouses and confirm it is started."
    )


def _execute_databricks_sql(query: str) -> pd.DataFrame:
    cleaned = query.strip().rstrip(";")
    if not cleaned:
        raise ValueError("No SQL query provided.")

    first_token = cleaned.split(None, 1)[0].lower() if cleaned.split(None, 1) else ""
    if first_token not in {"select", "with"}:
        raise RuntimeError("Databricks mode only allows SELECT queries.")

    host = os.getenv("DATABRICKS_HOST")
    token = os.getenv("DATABRICKS_TOKEN")
    http_path = os.getenv("DATABRICKS_HTTP_PATH")
    if not host or not token or not http_path:
        raise RuntimeError(
            "Missing Databricks config. Set DATABRICKS_HOST, DATABRICKS_TOKEN, and DATABRICKS_HTTP_PATH."
        )

    ensure_warehouse_running()
    warehouse_id = _warehouse_id_from_http_path(http_path)
    wait_timeout = os.getenv("DATABRICKS_WAIT_TIMEOUT", "50s")
    url = f"{_databricks_api_base()}/api/2.0/sql/statements"
    payload = {
        "warehouse_id": warehouse_id,
        "statement": cleaned,
        "wait_timeout": wait_timeout,
        "format": "JSON_ARRAY",
    }

    def _run_query() -> pd.DataFrame:
        response = requests.post(
            url,
            headers={**_databricks_headers(), "Content-Type": "application/json"},
            json=payload,
            timeout=DATABRICKS_TIMEOUT_SEC,
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Databricks SQL API error ({response.status_code}): {response.text[:500]}"
            )

        data = response.json()
        status = data.get("status", {})
        state = status.get("state")
        if state != "SUCCEEDED":
            error = status.get("error", {}) or {}
            message = error.get("message") or status.get("message") or str(status)
            raise RuntimeError(f"Databricks query failed ({state}): {message}")

        manifest = data.get("manifest") or {}
        schema = manifest.get("schema") or {}
        columns_meta = schema.get("columns") or []
        columns = [str(col.get("name", f"col_{i}")) for i, col in enumerate(columns_meta)]

        rows: list[list[Any]] = []
        result = data.get("result") or {}
        if result.get("data_array"):
            rows.extend(result["data_array"])

        statement_id = data.get("statement_id")
        total_chunks = int(manifest.get("total_chunk_count") or 0)
        if statement_id and total_chunks > 1:
            for chunk_index in range(1, total_chunks):
                chunk_url = (
                    f"{_databricks_api_base()}/api/2.0/sql/statements/"
                    f"{statement_id}/result/chunks/{chunk_index}"
                )
                chunk_resp = requests.get(
                    chunk_url,
                    headers=_databricks_headers(),
                    timeout=DATABRICKS_TIMEOUT_SEC,
                )
                chunk_resp.raise_for_status()
                chunk_data = chunk_resp.json()
                rows.extend(chunk_data.get("data_array") or [])

        if not columns and rows:
            columns = [f"col_{i}" for i in range(len(rows[0]))]

        frame = pd.DataFrame(rows, columns=columns)
        if len(frame) > 500:
            frame = frame.head(500)
        return frame

    try:
        return _run_with_timeout(_run_query, DATABRICKS_TIMEOUT_SEC, "Databricks SQL execution")
    except Exception as exc:
        raise RuntimeError(f"Error while executing Databricks SQL: {exc}") from exc


def clear_databricks_health_cache() -> None:
    """Drop cached health results (e.g. after a failed query)."""
    global _health_cache, _health_cache_at
    _health_cache = None
    _health_cache_at = 0.0


def databricks_health_light() -> Dict[str, Any]:
    """
    Fast health probe: warehouse REST state only (no SQL statement).
    Used on page navigation to avoid redundant SELECT 1 calls.
    """
    started = time.perf_counter()
    warehouse_state = ensure_warehouse_running()
    latency_ms = int((time.perf_counter() - started) * 1000)
    return {
        "probe": "light",
        "latency_ms": latency_ms,
        "warehouse_state": warehouse_state,
    }


def databricks_health_full() -> Dict[str, Any]:
    """
    Full connectivity check: warehouse state plus SELECT 1 through the SQL API.
    """
    started = time.perf_counter()
    warehouse = get_warehouse_state()
    warehouse_state = str(warehouse.get("state", "UNKNOWN"))
    if warehouse_state != "RUNNING":
        warehouse_state = ensure_warehouse_running()
    result = _execute_databricks_sql("SELECT 1 AS ok")
    latency_ms = int((time.perf_counter() - started) * 1000)
    ok_value = None
    if not result.empty and "ok" in result.columns:
        ok_value = result.iloc[0]["ok"]
    return {
        "probe": "full",
        "latency_ms": latency_ms,
        "rows": len(result),
        "ok_value": ok_value,
        "warehouse_state": warehouse_state,
    }


def databricks_healthcheck(probe: str = "light") -> Dict[str, Any]:
    """Run a Databricks health probe (`light` or `full`)."""
    if probe == "full":
        return databricks_health_full()
    return databricks_health_light()


def get_databricks_health(
    probe: str = "light",
    *,
    use_cache: bool = True,
    force: bool = False,
) -> Dict[str, Any]:
    """
    Return cached health when still fresh so page loads do not re-hit the warehouse.
    """
    global _health_cache, _health_cache_at

    probe = probe if probe in {"light", "full"} else "light"
    now = time.time()

    if (
        use_cache
        and not force
        and _health_cache is not None
        and (now - _health_cache_at) < HEALTH_CACHE_TTL_SEC
        and _health_cache.get("probe") == probe
    ):
        return {**_health_cache, "cached": True}

    result = databricks_healthcheck(probe=probe)
    _health_cache = result
    _health_cache_at = now
    return {**result, "cached": False}



import io
import os
import math
import time
from datetime import date, datetime
from typing import Any, Dict

from flask import Flask, jsonify, render_template, request, send_file
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from dotenv import load_dotenv

from executor import (
    clear_databricks_health_cache,
    get_databricks_health,
    get_executor_mode,
)
from data_io import import_wells_csv, result_to_csv_bytes, result_to_workbook_bytes
from history import clear_history, get_history, init_db, save_history
from prompts import explain_query, generate_with_retry
from schema import (
    clear_page_data_cache,
    get_dashboard_data,
    get_dataset_stats,
    get_schema,
    get_schema_page_data,
    get_table_name,
)

load_dotenv(override=True)
init_db()


def _json_safe_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, bool | int | str):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _json_safe_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe_value(v) for v in value]
    if isinstance(value, tuple):
        return [_json_safe_value(v) for v in value]

    # pandas/numpy objects and other custom values fallback to strings.
    text = str(value)
    if text.lower() in {"nan", "nat", "inf", "-inf"}:
        return None
    return text


def _json_safe_result(exec_result: Any) -> Dict[str, Any] | None:
    if exec_result is None:
        return None

    columns = [str(col) for col in list(exec_result.columns)]
    raw_rows = exec_result.to_dict(orient="records")
    rows = [{str(k): _json_safe_value(v) for k, v in row.items()} for row in raw_rows]
    return {"columns": columns, "rows": rows}


def create_app() -> Flask:
    app = Flask(__name__)
    CORS(app)

    # General-purpose rate limiting. Defaults apply to every route; the
    # LLM-backed and upload routes get tighter per-route limits below. Uses an
    # in-memory store by default; set RATELIMIT_STORAGE_URI (e.g. redis://...)
    # for multi-process deployments behind gunicorn.
    limiter = Limiter(
        key_func=get_remote_address,
        app=app,
        default_limits=["240 per hour", "60 per minute"],
        storage_uri=os.getenv("RATELIMIT_STORAGE_URI", "memory://"),
        strategy="fixed-window",
        headers_enabled=True,
    )

    @app.errorhandler(429)
    def ratelimit_handler(error: Any) -> Any:
        return (
            jsonify(
                {
                    "error": "Rate limit exceeded. Please slow down and try again shortly.",
                    "detail": str(getattr(error, "description", "")),
                    "result": None,
                    "code": "",
                }
            ),
            429,
        )

    @app.route("/", methods=["GET"])
    def home() -> Any:
        return render_template(
            "home.html",
            active_page="home",
            table_name=get_table_name(),
        )

    @app.route("/workspace", methods=["GET"])
    def workspace() -> Any:
        return render_template("workspace.html", active_page="workspace")

    @app.route("/dashboard", methods=["GET"])
    def dashboard() -> Any:
        return render_template("dashboard.html", active_page="dashboard")

    @app.route("/schema", methods=["GET"])
    def schema_page() -> Any:
        return render_template("schema.html", active_page="schema")

    @app.route("/dashboard/data", methods=["GET"])
    def dashboard_data() -> Any:
        try:
            return jsonify({"ok": True, **get_dashboard_data()})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @app.route("/schema/info", methods=["GET"])
    def schema_info() -> Any:
        try:
            return jsonify({"ok": True, **get_schema_page_data()})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @app.route("/query", methods=["POST"])
    @limiter.limit("12 per minute;120 per hour")
    def query() -> Any:
        payload: Dict[str, Any] = request.get_json(force=True) or {}
        question = (payload.get("question") or "").strip()
        if not question:
            return (
                jsonify(
                    {
                        "code": "",
                        "result": None,
                        "error": "Missing 'question' in request body.",
                    }
                ),
                400,
            )

        code = ""
        try:
            schema = get_schema()
        except Exception as e:  # pragma: no cover - early dev
            save_history(question, "", None, success=False, error=str(e))
            return (
                jsonify(
                    {
                        "code": "",
                        "result": None,
                        "error": f"Failed to load schema: {e}",
                    }
                ),
                500,
            )

        started = time.perf_counter()
        try:
            code, exec_result, retry_count, _attempt_errors = generate_with_retry(
                question, schema
            )
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            response_result = _json_safe_result(exec_result)
            save_history(question, code, response_result, success=True)
            row_count = len((response_result or {}).get("rows", []))
            return jsonify(
                {
                    "code": code,
                    "result": response_result,
                    "error": None,
                    "retry_count": retry_count,
                    "attempts": retry_count + 1,
                    "elapsed_ms": elapsed_ms,
                    "result_row_count": row_count,
                }
            )
        except Exception as e:
            err_msg = str(e)
            if get_executor_mode() == "databricks":
                clear_databricks_health_cache()
            save_history(question, code, None, success=False, error=err_msg)
            return (
                jsonify(
                    {
                        "code": code,
                        "result": None,
                        "error": err_msg,
                        "retry_count": None,
                        "attempts": None,
                    }
                ),
                500,
            )

    @app.route("/explain", methods=["POST"])
    @limiter.limit("20 per minute;200 per hour")
    def explain() -> Any:
        payload: Dict[str, Any] = request.get_json(force=True) or {}
        question = (payload.get("question") or "").strip()
        code = (payload.get("code") or "").strip()
        if not question or not code:
            return (
                jsonify({"ok": False, "error": "Missing 'question' or 'code'."}),
                400,
            )

        result_columns = payload.get("result_columns") or []
        if not isinstance(result_columns, list):
            result_columns = []
        result_rows = payload.get("result_row_count")
        try:
            result_rows = int(result_rows) if result_rows is not None else None
        except (TypeError, ValueError):
            result_rows = None

        try:
            schema = get_schema()
        except Exception as e:
            return jsonify({"ok": False, "error": f"Failed to load schema: {e}"}), 500

        input_rows: int | None = None
        try:
            input_rows = int(get_dataset_stats().get("row_count"))
        except Exception:
            input_rows = None

        try:
            explanation = explain_query(
                question,
                code,
                schema,
                input_rows=input_rows,
                result_rows=result_rows,
                result_columns=[str(c) for c in result_columns],
            )
            return jsonify({"ok": True, "explanation": explanation})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @app.route("/import/csv", methods=["POST"])
    @limiter.limit("10 per minute")
    def import_csv() -> Any:
        upload = request.files.get("file")
        try:
            info = import_wells_csv(upload)
            clear_page_data_cache()
            mode = get_executor_mode()
            message = f"Imported {info['rows']:,} rows into local dataset."
            if mode == "databricks":
                message += (
                    " Queries in Databricks mode still use "
                    f"{os.getenv('DATABRICKS_TABLE', 'workspace.querymind.wells')} "
                    "unless you load this file there too."
                )
            return jsonify({"ok": True, "message": message, **info})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 400

    @app.route("/export/csv", methods=["POST"])
    def export_csv() -> Any:
        payload: Dict[str, Any] = request.get_json(force=True) or {}
        result = payload.get("result")
        try:
            csv_bytes = result_to_csv_bytes(result)
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 400

        buffer = io.BytesIO(csv_bytes)
        buffer.seek(0)
        return send_file(
            buffer,
            mimetype="text/csv",
            as_attachment=True,
            download_name="querymind-results.csv",
        )

    @app.route("/export/xlsx", methods=["POST"])
    @limiter.limit("30 per minute")
    def export_xlsx() -> Any:
        payload: Dict[str, Any] = request.get_json(force=True) or {}
        try:
            xlsx_bytes = result_to_workbook_bytes(payload)
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 400

        buffer = io.BytesIO(xlsx_bytes)
        buffer.seek(0)
        return send_file(
            buffer,
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            as_attachment=True,
            download_name="querymind-report.xlsx",
        )

    @app.route("/export/template", methods=["GET"])
    def export_template() -> Any:
        from schema import DATA_PATH

        if not DATA_PATH.exists():
            return jsonify({"error": "Template file not found."}), 404
        return send_file(
            DATA_PATH,
            mimetype="text/csv",
            as_attachment=True,
            download_name="wells-template.csv",
        )

    @app.route("/history", methods=["GET"])
    def history() -> Any:
        limit = request.args.get("limit", "10")
        try:
            limit_int = int(limit)
        except ValueError:
            limit_int = 10
        return jsonify({"history": get_history(limit=limit_int)})

    @app.route("/history", methods=["DELETE"])
    def history_clear() -> Any:
        clear_history()
        return jsonify({"ok": True})

    @app.route("/dataset/stats", methods=["GET"])
    @limiter.exempt
    def dataset_stats() -> Any:
        try:
            stats = get_dataset_stats()
            return jsonify({"ok": True, **stats})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500

    @app.route("/health", methods=["GET"])
    @limiter.exempt
    def health() -> Any:
        mode = get_executor_mode()
        databricks_configured = bool(
            os.getenv("DATABRICKS_HOST")
            and os.getenv("DATABRICKS_TOKEN")
            and os.getenv("DATABRICKS_HTTP_PATH")
        )
        return jsonify(
            {
                "ok": True,
                "mode": mode,
                "databricks_configured": databricks_configured,
            }
        )

    @app.route("/health/databricks", methods=["GET"])
    @limiter.exempt
    def health_databricks() -> Any:
        mode = get_executor_mode()
        if mode != "databricks":
            return (
                jsonify(
                    {
                        "ok": True,
                        "mode": mode,
                        "message": "Running in local CSV mode.",
                    }
                ),
                200,
            )

        probe = request.args.get("probe", "light")
        if probe not in ("light", "full"):
            probe = "light"
        force = request.args.get("force", "").lower() in ("1", "true", "yes")

        try:
            health = get_databricks_health(probe=probe, use_cache=True, force=force)
            return jsonify(
                {
                    "ok": True,
                    "mode": mode,
                    **health,
                }
            )
        except Exception as e:
            clear_databricks_health_cache()
            return (
                jsonify(
                    {
                        "ok": False,
                        "mode": mode,
                        "warehouse_state": "UNKNOWN",
                        "error": str(e),
                        "probe": probe,
                    }
                ),
                503,
            )

    return app


app = create_app()


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)


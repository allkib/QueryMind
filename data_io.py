from __future__ import annotations

import io
from typing import Any, Dict, List

import pandas as pd

from schema import DATA_PATH

EXPECTED_COLUMNS = [
    "well_id",
    "month",
    "production_bbl",
    "field",
    "operator",
    "depth_ft",
]

MAX_IMPORT_ROWS = 100_000


def import_wells_csv(file_storage: Any) -> Dict[str, Any]:
    """
    Validate and replace the local wells dataset from an uploaded CSV file.
    """
    if not file_storage or not file_storage.filename:
        raise ValueError("No file uploaded.")

    df = pd.read_csv(file_storage)
    if df.empty:
        raise ValueError("CSV file is empty.")

    df.columns = [str(col).strip() for col in df.columns]
    missing = [col for col in EXPECTED_COLUMNS if col not in df.columns]
    if missing:
        raise ValueError(
            f"CSV is missing required columns: {', '.join(missing)}. "
            f"Expected: {', '.join(EXPECTED_COLUMNS)}"
        )

    df = df[EXPECTED_COLUMNS].copy()
    df["production_bbl"] = pd.to_numeric(df["production_bbl"], errors="coerce")
    df["depth_ft"] = pd.to_numeric(df["depth_ft"], errors="coerce")

    if df["production_bbl"].isna().any() or df["depth_ft"].isna().any():
        raise ValueError(
            "production_bbl and depth_ft must be numeric in every row."
        )

    if len(df) > MAX_IMPORT_ROWS:
        raise ValueError(f"CSV exceeds maximum of {MAX_IMPORT_ROWS:,} rows.")

    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(DATA_PATH, index=False)

    return {
        "rows": len(df),
        "columns": EXPECTED_COLUMNS,
        "path": str(DATA_PATH),
    }


def result_to_csv_bytes(result: Dict[str, Any]) -> bytes:
    """
    Convert a query result payload into CSV bytes for download.
    """
    if not result or not result.get("columns"):
        raise ValueError("No result data to export.")

    columns: List[str] = [str(c) for c in result["columns"]]
    rows = result.get("rows") or []
    df = pd.DataFrame(rows, columns=columns)
    buffer = io.StringIO()
    df.to_csv(buffer, index=False)
    return buffer.getvalue().encode("utf-8")

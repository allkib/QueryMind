from __future__ import annotations

import os
from pathlib import Path

import pandas as pd


DATA_PATH = Path(__file__).parent / "sample_data" / "wells.csv"
DATABRICKS_TABLE = "workspace.querymind.wells"


def get_table_name() -> str:
    return os.getenv("DATABRICKS_TABLE", DATABRICKS_TABLE)


def get_schema() -> str:
    """
    Return a human-readable schema string for the wells dataset, including
    column names, dtypes, and a couple of sample rows.
    """
    if os.getenv("EXECUTOR", "local").lower() == "databricks":
        table = get_table_name()
        from executor import _execute_databricks_sql

        sample_df = _execute_databricks_sql(f"SELECT * FROM {table} LIMIT 2")
        bounds_df = _execute_databricks_sql(
            f"SELECT MIN(month) AS min_month, MAX(month) AS max_month FROM {table}"
        )
        min_month = bounds_df.iloc[0]["min_month"] if not bounds_df.empty else None
        max_month = bounds_df.iloc[0]["max_month"] if not bounds_df.empty else None
        return _format_schema(
            table_name=table,
            df=sample_df,
            min_month=min_month,
            max_month=max_month,
        )

    if not DATA_PATH.exists():
        raise FileNotFoundError(f"Sample data not found at {DATA_PATH}")

    df = pd.read_csv(DATA_PATH)
    return _format_schema(
        table_name="wells (local CSV)",
        df=df,
        min_month=str(df["month"].min()) if "month" in df.columns else None,
        max_month=str(df["month"].max()) if "month" in df.columns else None,
    )


def _load_schema_dataframe_from_databricks() -> pd.DataFrame:
    from executor import _execute_databricks_sql

    table = get_table_name()
    return _execute_databricks_sql(f"SELECT * FROM {table} LIMIT 2")


def _format_schema(
    table_name: str,
    df: pd.DataFrame,
    min_month: str | None = None,
    max_month: str | None = None,
) -> str:

    lines: list[str] = []
    lines.append(f"Table: {table_name}")
    if min_month and max_month:
        lines.append(f"Data month range: {min_month} to {max_month}")
    lines.append("Columns and dtypes:")
    for col, dtype in df.dtypes.items():
        lines.append(f"- {col}: {dtype}")

    lines.append("")
    lines.append("Example rows:")
    sample = df.head(2)
    lines.extend(sample.to_csv(index=False).strip().splitlines())

    return "\n".join(lines)


def get_dataset_stats() -> dict[str, int]:
    """Row count and distinct field/operator/well counts for the UI header."""
    if os.getenv("EXECUTOR", "local").lower() == "databricks":
        from executor import _execute_databricks_sql

        table = get_table_name()
        stats_df = _execute_databricks_sql(
            f"""
            SELECT
              COUNT(*) AS row_count,
              COUNT(DISTINCT field) AS field_count,
              COUNT(DISTINCT operator) AS operator_count,
              COUNT(DISTINCT well_id) AS well_count
            FROM {table}
            """
        )
        row = stats_df.iloc[0]
        return {
            "row_count": int(row["row_count"]),
            "field_count": int(row["field_count"]),
            "operator_count": int(row["operator_count"]),
            "well_count": int(row["well_count"]),
        }

    if not DATA_PATH.exists():
        raise FileNotFoundError(f"Sample data not found at {DATA_PATH}")

    df = pd.read_csv(DATA_PATH)
    return {
        "row_count": len(df),
        "field_count": int(df["field"].nunique()) if "field" in df.columns else 0,
        "operator_count": int(df["operator"].nunique()) if "operator" in df.columns else 0,
        "well_count": int(df["well_id"].nunique()) if "well_id" in df.columns else 0,
    }


def load_dataframe() -> pd.DataFrame:
    """
    Load the wells.csv DataFrame for execution.
    """
    if not DATA_PATH.exists():
        raise FileNotFoundError(f"Sample data not found at {DATA_PATH}")
    return pd.read_csv(DATA_PATH)


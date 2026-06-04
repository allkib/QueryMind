from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Callable

import pandas as pd


DATA_PATH = Path(__file__).parent / "sample_data" / "wells.csv"
DATABRICKS_TABLE = "workspace.querymind.wells"

SCHEMA_COLUMN_META: list[dict[str, str]] = [
    {
        "name": "well_id",
        "sql_type": "string",
        "comment": "Unique well identifier (e.g. W001)",
    },
    {
        "name": "month",
        "sql_type": "string",
        "comment": "Production month in YYYY-MM format",
    },
    {
        "name": "production_bbl",
        "sql_type": "bigint",
        "comment": "Monthly oil production in barrels",
    },
    {
        "name": "field",
        "sql_type": "string",
        "comment": "Basin / field — Permian, Bakken, EagleFord, etc.",
    },
    {
        "name": "operator",
        "sql_type": "string",
        "comment": "Operating company name",
    },
    {
        "name": "depth_ft",
        "sql_type": "int",
        "comment": "True vertical depth in feet",
    },
]

FIELD_CHART_COLORS = {
    "Permian": "#0066b2",
    "Bakken": "#e31b23",
    "EagleFord": "#7c3aed",
    "Niobrara": "#0d7d4d",
}

# Low-cardinality string columns whose actual distinct values are injected into
# the LLM schema so generated filters match real data (e.g. "Permian", not
# "Permian Basin"). Only injected when distinct count stays under the cap.
CATEGORICAL_COLUMNS = ("field", "operator")
MAX_CATEGORICAL_VALUES = 60

PAGE_CACHE_TTL_SEC = int(os.getenv("QUERYMIND_PAGE_CACHE_SEC", "300"))
_page_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def clear_page_data_cache() -> None:
    """Invalidate cached schema/dashboard payloads (e.g. after CSV import)."""
    _page_cache.clear()


def _cached_page_data(cache_key: str, builder: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    now = time.time()
    entry = _page_cache.get(cache_key)
    if entry and (now - entry[0]) < PAGE_CACHE_TTL_SEC:
        return {**entry[1], "cached": True}

    payload = builder()
    _page_cache[cache_key] = (now, payload)
    return {**payload, "cached": False}


def get_table_name() -> str:
    return os.getenv("DATABRICKS_TABLE", DATABRICKS_TABLE)


def get_schema() -> str:
    """
    Return a human-readable schema string for the wells dataset, including
    column names, dtypes, sample rows, and the distinct values of categorical
    columns so the LLM filters on real values. Cached until the dataset changes.
    """
    return _cached_page_data("schema_prompt", _build_schema_string)["schema"]


def _build_schema_string() -> dict[str, Any]:
    if os.getenv("EXECUTOR", "local").lower() == "databricks":
        table = get_table_name()
        from executor import _execute_databricks_sql

        sample_df = _execute_databricks_sql(f"SELECT * FROM {table} LIMIT 2")
        bounds_df = _execute_databricks_sql(
            f"SELECT MIN(month) AS min_month, MAX(month) AS max_month FROM {table}"
        )
        min_month = bounds_df.iloc[0]["min_month"] if not bounds_df.empty else None
        max_month = bounds_df.iloc[0]["max_month"] if not bounds_df.empty else None
        schema = _format_schema(
            table_name=table,
            df=sample_df,
            min_month=min_month,
            max_month=max_month,
            categorical_values=_categorical_values_databricks(table),
        )
        return {"schema": schema}

    if not DATA_PATH.exists():
        raise FileNotFoundError(f"Sample data not found at {DATA_PATH}")

    df = pd.read_csv(DATA_PATH)
    schema = _format_schema(
        table_name="wells (local CSV)",
        df=df,
        min_month=str(df["month"].min()) if "month" in df.columns else None,
        max_month=str(df["month"].max()) if "month" in df.columns else None,
        categorical_values=_categorical_values_local(df),
    )
    return {"schema": schema}


def _categorical_values_local(df: pd.DataFrame) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for col in CATEGORICAL_COLUMNS:
        if col not in df.columns:
            continue
        values = sorted({str(v) for v in df[col].dropna().unique()})
        if 0 < len(values) <= MAX_CATEGORICAL_VALUES:
            out[col] = values
    return out


def _categorical_values_databricks(table: str) -> dict[str, list[str]]:
    from executor import _execute_databricks_sql

    out: dict[str, list[str]] = {}
    for col in CATEGORICAL_COLUMNS:
        try:
            distinct_df = _execute_databricks_sql(
                f"SELECT DISTINCT {col} AS v FROM {table} "
                f"WHERE {col} IS NOT NULL ORDER BY v LIMIT {MAX_CATEGORICAL_VALUES + 1}"
            )
            values = [str(v) for v in distinct_df["v"].tolist() if v is not None]
            if 0 < len(values) <= MAX_CATEGORICAL_VALUES:
                out[col] = values
        except Exception:
            # Distinct lookup is best-effort; skip on any failure.
            continue
    return out


def _load_schema_dataframe_from_databricks() -> pd.DataFrame:
    from executor import _execute_databricks_sql

    table = get_table_name()
    return _execute_databricks_sql(f"SELECT * FROM {table} LIMIT 2")


def _format_schema(
    table_name: str,
    df: pd.DataFrame,
    min_month: str | None = None,
    max_month: str | None = None,
    categorical_values: dict[str, list[str]] | None = None,
) -> str:

    lines: list[str] = []
    lines.append(f"Table: {table_name}")
    if min_month and max_month:
        lines.append(f"Data month range: {min_month} to {max_month}")
    lines.append("Columns and dtypes:")
    for col, dtype in df.dtypes.items():
        lines.append(f"- {col}: {dtype}")

    if categorical_values:
        lines.append("")
        lines.append(
            "Distinct values for categorical columns "
            "(filters MUST use one of these exact values):"
        )
        for col, values in categorical_values.items():
            lines.append(f"- {col}: {', '.join(values)}")

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


def _is_databricks_mode() -> bool:
    return os.getenv("EXECUTOR", "local").lower() == "databricks"


def _load_sample_rows(limit: int = 5) -> pd.DataFrame:
    if _is_databricks_mode():
        from executor import _execute_databricks_sql

        table = get_table_name()
        return _execute_databricks_sql(f"SELECT * FROM {table} LIMIT {int(limit)}")

    if not DATA_PATH.exists():
        raise FileNotFoundError(f"Sample data not found at {DATA_PATH}")
    return pd.read_csv(DATA_PATH).head(limit)


def _load_local_dataframe() -> pd.DataFrame:
    if not DATA_PATH.exists():
        raise FileNotFoundError(f"Sample data not found at {DATA_PATH}")
    return pd.read_csv(DATA_PATH)


def _display_table_name() -> str:
    if _is_databricks_mode():
        return get_table_name()
    return "wells (local CSV)"


def _build_schema_page_data() -> dict:
    """Structured schema + sample rows for the Schema Explorer page."""
    sample_df = _load_sample_rows(limit=5)
    table_name = _display_table_name()
    describe_query = f"DESCRIBE TABLE {get_table_name()};"

    columns = [
        {
            "name": meta["name"],
            "data_type": meta["sql_type"],
            "comment": meta["comment"],
        }
        for meta in SCHEMA_COLUMN_META
    ]

    sample_columns = [str(c) for c in sample_df.columns]
    sample_rows: list[dict[str, object]] = []
    for _, row in sample_df.iterrows():
        sample_rows.append(
            {str(k): _sample_cell_value(v) for k, v in row.items()}
        )

    stats = get_dataset_stats()
    return {
        "table_name": table_name,
        "describe_query": describe_query,
        "columns": columns,
        "column_count": len(columns),
        "row_count": stats["row_count"],
        "sample_columns": sample_columns,
        "sample_rows": sample_rows,
    }


def get_schema_page_data() -> dict:
    return _cached_page_data("schema", _build_schema_page_data)


def _as_int(value: object) -> int:
    """Coerce Databricks JSON values (often strings) to int."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return 0
    numeric = pd.to_numeric(value, errors="coerce")
    if pd.isna(numeric):
        return 0
    return int(numeric)


def _numeric_series(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce").fillna(0)


def _sample_cell_value(value: object) -> object:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value
    return str(value)


def _dashboard_from_dataframe(df: pd.DataFrame, stats: dict[str, int]) -> dict:
    if "production_bbl" not in df.columns:
        raise ValueError("Dataset is missing production_bbl column.")

    prod = _numeric_series(df["production_bbl"])
    df = df.assign(production_bbl=prod)
    total_bbl = int(prod.sum())
    monthly = (
        df.groupby("month", as_index=False)["production_bbl"]
        .sum()
        .sort_values("month")
    )
    avg_monthly = (
        int(round(_numeric_series(monthly["production_bbl"]).mean()))
        if not monthly.empty
        else 0
    )

    field_totals = (
        df.groupby("field")["production_bbl"]
        .sum()
        .sort_values(ascending=False)
    )
    operator_totals = (
        df.groupby("operator")["production_bbl"]
        .sum()
        .sort_values(ascending=False)
    )

    top_field_name = str(field_totals.index[0]) if len(field_totals) else "—"
    top_operator_name = str(operator_totals.index[0]) if len(operator_totals) else "—"

    return {
        "table_name": _display_table_name(),
        "well_count": stats["well_count"],
        "row_count": stats["row_count"],
        "total_production_bbl": total_bbl,
        "avg_monthly_production_bbl": avg_monthly,
        "top_field": {
            "name": top_field_name,
            "total_bbl": int(field_totals.iloc[0]) if len(field_totals) else 0,
        },
        "top_operator": {
            "name": top_operator_name,
            "total_bbl": int(operator_totals.iloc[0]) if len(operator_totals) else 0,
        },
        "monthly_trend": [
            {"month": str(row["month"]), "production_bbl": int(row["production_bbl"])}
            for _, row in monthly.iterrows()
        ],
        "by_field": [
            {
                "field": str(name),
                "production_bbl": int(value),
                "color": FIELD_CHART_COLORS.get(str(name), "#0066b2"),
            }
            for name, value in field_totals.items()
        ],
        "by_operator": [
            {"operator": str(name), "production_bbl": int(value)}
            for name, value in operator_totals.items()
        ],
    }


def _dashboard_from_databricks(table: str, stats: dict[str, int]) -> dict:
    from executor import _execute_databricks_sql

    total_df = _execute_databricks_sql(
        f"SELECT CAST(SUM(production_bbl) AS BIGINT) AS total_bbl FROM {table}"
    )
    total_bbl = _as_int(total_df.iloc[0]["total_bbl"])

    monthly = _execute_databricks_sql(
        f"""
        SELECT month, CAST(SUM(production_bbl) AS BIGINT) AS production_bbl
        FROM {table}
        GROUP BY month
        ORDER BY month
        """
    )
    avg_monthly = (
        int(round(_numeric_series(monthly["production_bbl"]).mean()))
        if not monthly.empty
        else 0
    )

    field_df = _execute_databricks_sql(
        f"""
        SELECT field, CAST(SUM(production_bbl) AS BIGINT) AS production_bbl
        FROM {table}
        GROUP BY field
        ORDER BY production_bbl DESC
        """
    )
    operator_df = _execute_databricks_sql(
        f"""
        SELECT operator, CAST(SUM(production_bbl) AS BIGINT) AS production_bbl
        FROM {table}
        GROUP BY operator
        ORDER BY production_bbl DESC
        """
    )

    top_field_name = (
        str(field_df.iloc[0]["field"]) if not field_df.empty else "—"
    )
    top_operator_name = (
        str(operator_df.iloc[0]["operator"]) if not operator_df.empty else "—"
    )

    return {
        "table_name": _display_table_name(),
        "well_count": stats["well_count"],
        "row_count": stats["row_count"],
        "total_production_bbl": total_bbl,
        "avg_monthly_production_bbl": avg_monthly,
        "top_field": {
            "name": top_field_name,
            "total_bbl": _as_int(field_df.iloc[0]["production_bbl"])
            if not field_df.empty
            else 0,
        },
        "top_operator": {
            "name": top_operator_name,
            "total_bbl": _as_int(operator_df.iloc[0]["production_bbl"])
            if not operator_df.empty
            else 0,
        },
        "monthly_trend": [
            {
                "month": str(row["month"]),
                "production_bbl": _as_int(row["production_bbl"]),
            }
            for _, row in monthly.iterrows()
        ],
        "by_field": [
            {
                "field": str(row["field"]),
                "production_bbl": _as_int(row["production_bbl"]),
                "color": FIELD_CHART_COLORS.get(str(row["field"]), "#0066b2"),
            }
            for _, row in field_df.iterrows()
        ],
        "by_operator": [
            {
                "operator": str(row["operator"]),
                "production_bbl": _as_int(row["production_bbl"]),
            }
            for _, row in operator_df.iterrows()
        ],
    }


def _build_dashboard_data() -> dict:
    stats = get_dataset_stats()
    if _is_databricks_mode():
        return _dashboard_from_databricks(get_table_name(), stats)
    return _dashboard_from_dataframe(_load_local_dataframe(), stats)


def get_dashboard_data() -> dict:
    return _cached_page_data("dashboard", _build_dashboard_data)


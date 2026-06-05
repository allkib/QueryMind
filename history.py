"""
Lightweight SQLite log of every query, powering the "recent queries" sidebar.

SQLite was chosen deliberately: it is zero-config, file-based, and ships with
Python, which fits a single-instance demo/portfolio app far better than running
a separate database server. Each call records the question, generated code, a
short human-readable result preview, and success/failure — enough to repopulate
the sidebar and demonstrate the agentic retry loop without storing full results.

Note: in a multi-process gunicorn deployment this file-backed log is per-instance;
swapping ``DB_PATH`` for a shared database would be the upgrade path if history
ever needs to be global.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

DB_PATH = Path(__file__).parent / "query_history.db"


def init_db() -> None:
    """Create the ``query_log`` table if it does not exist (idempotent)."""
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS query_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                question TEXT NOT NULL,
                generated_code TEXT,
                result_preview TEXT,
                success INTEGER NOT NULL
            )
            """
        )
        conn.commit()


def _result_preview(result: Optional[Dict[str, Any]], error: Optional[str]) -> str:
    """Build a short (<=240 char) human-readable summary of a result for the sidebar."""
    if error:
        return error[:240]
    if not result:
        return "No result"
    rows = result.get("rows") or []
    if not rows:
        return "0 rows returned"
    columns = result.get("columns") or []
    if len(rows) == 1:
        parts = [f"{k}={v}" for k, v in list(rows[0].items())[:4]]
        return ", ".join(parts)[:240]
    col_hint = ", ".join(columns[:3]) if columns else ""
    return f"{len(rows)} rows" + (f" · {col_hint}" if col_hint else "")


def save_history(
    question: str,
    generated_code: str,
    result: Optional[Dict[str, Any]],
    *,
    success: bool,
    error: Optional[str] = None,
) -> None:
    """Persist one query attempt (success or failure) to the log."""
    init_db()
    preview = _result_preview(result, error)
    ts = datetime.now(timezone.utc).isoformat()

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO query_log (timestamp, question, generated_code, result_preview, success)
            VALUES (?, ?, ?, ?, ?)
            """,
            (ts, question, generated_code or "", preview, 1 if success else 0),
        )
        conn.commit()


def get_history(limit: int = 10) -> List[Dict[str, Any]]:
    """Return the most recent queries, newest first (limit clamped to 1-50)."""
    init_db()
    limit = max(1, min(int(limit), 50))

    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT id, timestamp, question, generated_code, result_preview, success
            FROM query_log
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return [
        {
            "id": row["id"],
            "timestamp": row["timestamp"],
            "question": row["question"],
            "generated_code": row["generated_code"],
            "result_preview": row["result_preview"],
            "success": bool(row["success"]),
        }
        for row in rows
    ]


def clear_history() -> None:
    """Delete all rows from the query log (the sidebar "Clear" action)."""
    init_db()
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM query_log")
        conn.commit()

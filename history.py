from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

DB_PATH = Path(__file__).parent / "query_history.db"


def init_db() -> None:
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

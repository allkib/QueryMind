import io
import os
import math
from datetime import date, datetime
from typing import Any, Dict

from flask import Flask, jsonify, render_template, request, send_file
from flask_cors import CORS
from dotenv import load_dotenv

from executor import (
    databricks_healthcheck,
    ensure_warehouse_running,
    get_executor_mode,
    get_warehouse_state,
)
from data_io import import_wells_csv, result_to_csv_bytes
from history import get_history, init_db, save_history
from prompts import generate_with_retry
from schema import get_schema

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

    @app.route("/", methods=["GET"])
    def index() -> Any:
        return render_template("index.html")

    @app.route("/query", methods=["POST"])
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

        try:
            code, exec_result, retry_count, _attempt_errors = generate_with_retry(
                question, schema
            )
            response_result = _json_safe_result(exec_result)
            save_history(question, code, response_result, success=True)
            return jsonify(
                {
                    "code": code,
                    "result": response_result,
                    "error": None,
                    "retry_count": retry_count,
                    "attempts": retry_count + 1,
                }
            )
        except Exception as e:
            err_msg = str(e)
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

    @app.route("/import/csv", methods=["POST"])
    def import_csv() -> Any:
        upload = request.files.get("file")
        try:
            info = import_wells_csv(upload)
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

    @app.route("/health", methods=["GET"])
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

        try:
            warehouse_state = str(get_warehouse_state().get("state", "UNKNOWN"))
            if warehouse_state != "RUNNING":
                ensure_warehouse_running()
            health = databricks_healthcheck()
            return jsonify(
                {
                    "ok": True,
                    "mode": mode,
                    **health,
                }
            )
        except Exception as e:
            warehouse_state = "UNKNOWN"
            try:
                warehouse_state = str(get_warehouse_state().get("state", "UNKNOWN"))
            except Exception:
                pass
            return (
                jsonify(
                    {
                        "ok": False,
                        "mode": mode,
                        "warehouse_state": warehouse_state,
                        "error": str(e),
                    }
                ),
                503,
            )

    return app


app = create_app()


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)


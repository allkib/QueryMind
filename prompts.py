from __future__ import annotations

import json
import os
import re
from textwrap import dedent
from typing import Any, Dict, List, Tuple

import pandas as pd
from openai import OpenAI

from executor import execute_code


SYSTEM_PROMPT = dedent(
    """
    You are QueryMind, an expert energy-analytics assistant. You turn plain-English
    questions from non-technical oil & gas stakeholders into correct, idiomatic
    Python pandas code that analyzes a DataFrame called `df`.

    Think before you write: silently identify (1) the time window, (2) the filters,
    (3) the grouping dimension, and (4) the metric + aggregation the question implies.
    Then write the smallest correct pandas expression.

    Hard rules:
    - The DataFrame is already loaded as `df` from the wells dataset; never reload files.
    - Always assign the final answer to a variable called `result`.
    - `result` must be a pandas DataFrame or a scalar (int/float/str).
    - Do NOT use print(), display(), or logging; only assign to `result`.
    - Do NOT import modules other than pandas or numpy.
    - Do NOT read/write files, access the network, or spawn subprocesses.
    - Do NOT use eval, exec, __import__, or dunder attributes.
    - Limit `result` to at most 500 rows (e.g. via head()).

    Quality rules (make output business-friendly):
    - Use idiomatic pandas: groupby, agg, sort_values, query, nlargest, etc.
    - Give output columns clear, human-readable names via .rename() or named aggregations
      (e.g. 'total_production_bbl', 'avg_depth_ft') instead of leaving raw/auto names.
    - For "top N" questions, sort descending and head(N). For trends, sort by month ascending.
    - Round floats to a sensible precision (e.g. .round(0) for barrels, .round(1) for ratios).
    - Reset the index so the grouping key is a real column the UI can display.
    - The `month` column is a string like 'YYYY-MM'. For relative time questions
      (last quarter, recent, last 6 months) anchor to the LATEST month in the data
      shown in the schema below — never today's date — unless the user names a year.

    Value matching (critical — avoids empty results):
    - For any filter on a categorical column, you MUST use one of the exact values
      listed under "Distinct values" in the schema. Map the user's wording to the
      closest real value (e.g. "Permian Basin" -> "Permian", "Conoco" ->
      "ConocoPhillips", "eagleford" -> "Eagle Ford").
    - If no listed value clearly matches, fall back to a case-insensitive contains
      match, e.g. df[df['field'].str.contains('permian', case=False, na=False)],
      rather than an exact string that may return zero rows.

    Dataset schema (columns, dtypes, distinct values, and sample rows):
    {schema}

    Return ONLY executable Python code — no surrounding quotes, no markdown fences,
    no comments explaining the code.
    """
).strip()

SYSTEM_PROMPT_DATABRICKS_SQL = dedent(
    """
    You are QueryMind, a senior analytics engineer writing Databricks SQL for
    non-technical oil & gas stakeholders. Convert each question into ONE query.

    Think before you write: silently identify (1) the time window, (2) the filters,
    (3) the grouping dimension, and (4) the metric + aggregation the question implies.

    Hard rules:
    - The table is `{table}` (Unity Catalog three-level name). Use this exact name.
    - Use only SELECT / CTE SQL (WITH ... SELECT ...).
    - Never use INSERT/UPDATE/DELETE/MERGE/DROP/ALTER/TRUNCATE/CREATE.
    - Limit output rows to 500.

    Quality rules (make output business-friendly):
    - Always alias output columns with clear, human-readable names
      (e.g. total_production_bbl, avg_depth_ft, well_count).
    - For "top N" questions use ORDER BY ... DESC LIMIT N. For trends ORDER BY month ASC.
    - Round aggregates sensibly (ROUND(...)) so numbers read cleanly.
    - The `month` column is a string like 'YYYY-MM'. For relative time questions
      (last quarter, recent, last 6 months) anchor to the LATEST month in the dataset
      described below — do NOT use CURRENT_DATE() unless the user names a year.

    Value matching (critical — avoids empty results):
    - For any filter on a categorical column, you MUST use one of the exact values
      listed under "Distinct values" in the schema. Map the user's wording to the
      closest real value (e.g. "Permian Basin" -> "Permian", "Conoco" ->
      "ConocoPhillips", "eagleford" -> "Eagle Ford").
    - If no listed value clearly matches, use a case-insensitive contains match,
      e.g. WHERE lower(field) LIKE '%permian%', rather than an exact equality that
      may return zero rows.

    Dataset schema (columns, dtypes, distinct values, and sample rows):
    {schema}

    Return only raw SQL text with no markdown fences and no explanation.
    """
).strip()

FIX_PROMPT_LOCAL = dedent(
    """
    You fix Python pandas code that failed during execution.

    Original user question:
    {question}

    Available columns and dtypes:
    {schema}

    Failed code:
    {failed_code}

    Execution error (exact message):
    {error}

    Return ONLY corrected executable Python code. Assign the final answer to `result`.
    Do not use print(). No markdown fences.
    """
).strip()

FIX_PROMPT_DATABRICKS_SQL = dedent(
    """
    You fix Databricks SQL that failed during execution.

    Original user question:
    {question}

    Table: `{table}` (use this exact name).
    Columns available:
    {schema}

    Failed SQL:
    {failed_code}

    Execution error (exact message):
    {error}

    Return ONLY corrected SQL (single SELECT or WITH...SELECT). No markdown fences.
    """
).strip()


def _get_client() -> OpenAI:
    api_key = os.getenv("DUKE_API_KEY")
    if not api_key:
        raise RuntimeError("DUKE_API_KEY is not set in the environment.")

    return OpenAI(
        api_key=api_key,
        base_url=os.getenv("DUKE_BASE_URL", "https://litellm.oit.duke.edu"),
    )


def _strip_code_fences(code: str) -> str:
    cleaned = code.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.lstrip("`")
        for prefix in ("python", "sql"):
            if cleaned.startswith(prefix):
                cleaned = cleaned[len(prefix) :].lstrip()
        if "```" in cleaned:
            cleaned = cleaned.split("```", 1)[0].strip()
    return cleaned


def _llm_completion(system_prompt: str, user_prompt: str) -> str:
    client = _get_client()
    response = client.chat.completions.create(
        model=os.getenv("LLM_MODEL", "gpt-5.5"),
        max_tokens=800,
        temperature=0.0,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    )
    message_content = response.choices[0].message.content
    return _strip_code_fences(message_content or "")


def _executor_mode() -> str:
    return os.getenv("EXECUTOR", "local").lower()


def _databricks_table() -> str:
    return os.getenv("DATABRICKS_TABLE", "workspace.querymind.wells")


def generate_code(question: str, schema: str) -> str:
    """
    Generate executable code for the active executor mode.
    """
    if _executor_mode() == "databricks":
        table = _databricks_table()
        system_prompt = SYSTEM_PROMPT_DATABRICKS_SQL.format(schema=schema, table=table)
        user_prompt = (
            f"User question:\n{question}\n\n"
            "Write ONLY Databricks SQL. Must be a single SELECT query (CTEs allowed)."
        )
    else:
        system_prompt = SYSTEM_PROMPT.format(schema=schema)
        user_prompt = (
            f"User question:\n{question}\n\n"
            "Write ONLY Python pandas code that follows the rules."
        )
    return _llm_completion(system_prompt, user_prompt)


def fix_code(question: str, failed_code: str, error: str, schema: str) -> str:
    """
    Ask the LLM to repair code/SQL using the exact execution error.
    """
    if _executor_mode() == "databricks":
        table = _databricks_table()
        system_prompt = FIX_PROMPT_DATABRICKS_SQL.format(
            question=question,
            schema=schema,
            table=table,
            failed_code=failed_code,
            error=error,
        )
        user_prompt = "Return only the corrected Databricks SQL."
    else:
        system_prompt = FIX_PROMPT_LOCAL.format(
            question=question,
            schema=schema,
            failed_code=failed_code,
            error=error,
        )
        user_prompt = "Return only the corrected Python pandas code."
    return _llm_completion(system_prompt, user_prompt)


def generate_with_retry(
    question: str,
    schema: str,
    max_retries: int | None = None,
) -> Tuple[str, pd.DataFrame | Any, int, List[str]]:
    """
    Generate code, execute, and on failure ask the LLM to fix using the error message.

    Returns: (final_code, result, retry_count, error_messages_from_failed_attempts)
    retry_count is 0 when the first attempt succeeds.
    """
    if max_retries is None:
        max_retries = int(os.getenv("MAX_QUERY_RETRIES", "3"))

    max_retries = max(1, max_retries)
    errors: List[str] = []
    code = generate_code(question, schema)

    for attempt in range(max_retries):
        try:
            result = execute_code(code)
            return code, result, attempt, errors
        except Exception as exc:
            error_text = str(exc)
            errors.append(error_text)
            if attempt >= max_retries - 1:
                break
            code = fix_code(question, code, error_text, schema)

    raise RuntimeError(
        f"Could not generate valid code after {max_retries} attempt(s). "
        f"Last error: {errors[-1] if errors else 'unknown'}"
    )


EXPLAIN_PROMPT = dedent(
    """
    You are QueryMind's "Explain" assistant. A user asked a plain-English analytics
    question and the system already generated and successfully ran the code/SQL below.
    Your job is to explain — for a NON-TECHNICAL business reader — what the analysis
    actually did, in plain language. Do not mention pandas, SQL, or code syntax.

    Return STRICT JSON (no markdown, no prose outside the JSON) with this exact shape:
    {{
      "summary": "one or two sentences describing what the query does, in plain English",
      "confidence": <integer 0-100, how confident the analysis answers the question>,
      "assumptions": [
        {{"label": "Time range", "value": "..."}},
        {{"label": "Filters", "value": "..."}},
        {{"label": "Aggregation", "value": "..."}}
      ],
      "steps": ["short step phrases describing the data pipeline, 3-5 items"]
    }}

    Guidance:
    - "assumptions" should surface interpretation choices the system made: the time
      window used, which rows were filtered in, and how values were aggregated.
      Use 2-4 assumptions; omit ones that do not apply. Keep each value under ~8 words.
    - "steps" should read like a pipeline: load -> filter -> aggregate -> sort/limit.
      Use the row-count facts provided so the numbers are accurate.
    - confidence: 90-99 when the code clearly answers the question, lower if the
      question is ambiguous or the result is empty.

    User question:
    {question}

    Dataset facts:
    - Input rows available: {input_rows}
    - Rows returned by the analysis: {result_rows}
    - Result columns: {result_columns}

    Dataset schema:
    {schema}

    Generated {lang} that was executed:
    {code}
    """
).strip()


def _extract_json(text: str) -> Dict[str, Any] | None:
    """Best-effort parse of a JSON object from an LLM response."""
    if not text:
        return None
    cleaned = _strip_code_fences(text).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            return None
    return None


def _confidence_label(score: int) -> str:
    if score >= 85:
        return "High confidence"
    if score >= 60:
        return "Medium confidence"
    return "Low confidence"


def _fallback_explanation(
    question: str,
    code: str,
    input_rows: int | None,
    result_rows: int | None,
    result_columns: List[str],
) -> Dict[str, Any]:
    """Deterministic explanation used when the LLM call is unavailable/unparsable."""
    lowered = code.lower()
    is_sql = _executor_mode() == "databricks"
    filter_count = lowered.count(" where ") if is_sql else lowered.count("[df[")
    has_group = "group by" in lowered if is_sql else "groupby" in lowered
    has_sort = "order by" in lowered if is_sql else "sort_values" in lowered

    steps: List[str] = []
    if input_rows is not None:
        steps.append(f"Loaded {input_rows:,} rows from the wells dataset")
    else:
        steps.append("Loaded the wells dataset")
    if filter_count:
        steps.append("Applied filters to narrow the rows")
    if has_group:
        steps.append("Grouped and aggregated the matching rows")
    if result_rows is not None:
        steps.append(f"Returned {result_rows:,} result row{'' if result_rows == 1 else 's'}")
    if has_sort:
        steps.append("Sorted by the primary metric")

    summary_bits = []
    if filter_count:
        summary_bits.append("filters the production data")
    if has_group:
        summary_bits.append("groups and aggregates it")
    if has_sort:
        summary_bits.append("sorts by the key metric")
    summary = (
        "This analysis " + ", ".join(summary_bits) + " to answer your question."
        if summary_bits
        else "This analysis reads the production data to answer your question."
    )

    confidence = 80 if result_rows else 55
    return {
        "summary": summary,
        "confidence": confidence,
        "confidence_label": _confidence_label(confidence),
        "assumptions": [],
        "steps": steps or ["Ran the analysis on the wells dataset"],
        "source": "fallback",
    }


def explain_query(
    question: str,
    code: str,
    schema: str,
    *,
    input_rows: int | None = None,
    result_rows: int | None = None,
    result_columns: List[str] | None = None,
) -> Dict[str, Any]:
    """
    Produce a structured, non-technical explanation of what a generated query does.

    Combines an LLM narrative with deterministic facts. Always returns a dict; on
    any failure it degrades gracefully to a deterministic explanation.
    """
    result_columns = result_columns or []
    lang = "Databricks SQL" if _executor_mode() == "databricks" else "Python pandas code"

    try:
        prompt = EXPLAIN_PROMPT.format(
            question=question,
            input_rows=input_rows if input_rows is not None else "unknown",
            result_rows=result_rows if result_rows is not None else "unknown",
            result_columns=", ".join(result_columns) or "n/a",
            schema=schema,
            lang=lang,
            code=code,
        )
        raw = _llm_completion(
            "You explain data analyses to non-technical readers and reply only with JSON.",
            prompt,
        )
        parsed = _extract_json(raw)
    except Exception:
        parsed = None

    if not parsed or not isinstance(parsed, dict):
        return _fallback_explanation(question, code, input_rows, result_rows, result_columns)

    try:
        confidence = int(parsed.get("confidence", 85))
    except (TypeError, ValueError):
        confidence = 85
    confidence = max(0, min(100, confidence))

    assumptions_raw = parsed.get("assumptions") or []
    assumptions: List[Dict[str, str]] = []
    if isinstance(assumptions_raw, list):
        for item in assumptions_raw:
            if isinstance(item, dict) and item.get("label") and item.get("value"):
                assumptions.append(
                    {"label": str(item["label"]), "value": str(item["value"])}
                )

    steps_raw = parsed.get("steps") or []
    steps = [str(s) for s in steps_raw if str(s).strip()] if isinstance(steps_raw, list) else []
    if not steps:
        steps = _fallback_explanation(
            question, code, input_rows, result_rows, result_columns
        )["steps"]

    summary = str(parsed.get("summary") or "").strip()
    if not summary:
        summary = _fallback_explanation(
            question, code, input_rows, result_rows, result_columns
        )["summary"]

    return {
        "summary": summary,
        "confidence": confidence,
        "confidence_label": _confidence_label(confidence),
        "assumptions": assumptions,
        "steps": steps,
        "source": "ai",
    }


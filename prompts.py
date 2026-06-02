from __future__ import annotations

import os
from textwrap import dedent
from typing import Any, List, Tuple

import pandas as pd
from openai import OpenAI

from executor import execute_code


SYSTEM_PROMPT = dedent(
    """
    You are a data analyst assistant. You convert natural language questions
    into Python pandas code that analyzes a DataFrame called `df`.

    Rules:
    - The DataFrame is already loaded as `df` from wells.csv; do not reload files.
    - Always assign the final answer to a variable called `result`.
    - `result` must be either:
      - a pandas DataFrame, or
      - a scalar (int/float/str) that can be shown to the user.
    - Do NOT use print(), display(), or logging; only assign to `result`.
    - Do NOT import modules other than pandas or numpy.
    - Do NOT read or write files, use network access, or spawn subprocesses.
    - Do NOT use eval, exec, __import__, or any attribute starting with double underscores.
    - Prefer idiomatic pandas operations (groupby, agg, sort_values, query, etc.).
    - Limit the number of rows in `result` to at most 500 (e.g., via head()).
    - The `month` column is like 'YYYY-MM'. For relative time questions, use the
      latest month in the data (see schema), not today's date.
    - The available columns and dtypes are:
      {schema}
    - Assume the user is a non-technical business stakeholder; answer their question faithfully.

    Return ONLY executable Python code, with no surrounding quotes or markdown fences.
    """
).strip()

SYSTEM_PROMPT_DATABRICKS_SQL = dedent(
    """
    You are a senior analytics engineer for Databricks SQL.
    Convert each user question into ONE Databricks SQL query.

    Rules:
    - The table is `{table}` (Unity Catalog three-level name). Always use this exact name in SQL.
    - Columns available:
      {schema}
    - Use only SELECT/CTE SQL (WITH ... SELECT ...).
    - Never use INSERT/UPDATE/DELETE/MERGE/DROP/ALTER/TRUNCATE/CREATE.
    - Prefer clear aliases for business-readable output columns.
    - Limit output rows to 500.
    - The `month` column is a string like 'YYYY-MM'. For relative time questions
      (last quarter, last 6 months, recent, etc.), anchor to the latest month in
      the dataset described in the schema — do NOT use CURRENT_DATE() unless the
      user names a specific calendar year.
    - Return only raw SQL text with no markdown fences and no explanation.
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


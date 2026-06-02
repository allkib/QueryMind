let chartInstance = null;

const CHEVRON_BLUE = "#0066b2";
const CHEVRON_BLUE_LIGHT = "rgba(0, 102, 178, 0.15)";

const questionInput = document.getElementById("questionInput");
const runBtn = document.getElementById("runBtn");
const statusText = document.getElementById("statusText");
const codeOutput = document.getElementById("codeOutput");
const resultTableWrap = document.getElementById("resultTableWrap");
const errorBox = document.getElementById("errorBox");
const emptyState = document.getElementById("emptyState");
const chartSection = document.getElementById("chartSection");
const resultChartCanvas = document.getElementById("resultChart");
const chipContainer = document.getElementById("exampleChips");
const healthBadge = document.getElementById("healthBadge");
const resultsSection = document.getElementById("resultsSection");
const historyList = document.getElementById("historyList");
const csvFileInput = document.getElementById("csvFileInput");
const importCsvBtn = document.getElementById("importCsvBtn");
const importStatus = document.getElementById("importStatus");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const exportCodeBtn = document.getElementById("exportCodeBtn");

let lastQueryResult = null;
let lastGeneratedCode = "";

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function resultToCsvText(result) {
  const columns = result.columns || [];
  const rows = result.rows || [];
  const lines = [columns.map(csvEscape).join(",")];
  rows.forEach((row) => {
    lines.push(columns.map((col) => csvEscape(row[col])).join(","));
  });
  return lines.join("\n");
}

function setImportStatus(message, tone = "default") {
  if (!importStatus) {
    return;
  }
  importStatus.textContent = message || "";
  importStatus.classList.remove("import-status--ok", "import-status--error");
  if (tone === "success") {
    importStatus.classList.add("import-status--ok");
  } else if (tone === "error") {
    importStatus.classList.add("import-status--error");
  }
}

function updateExportButtons() {
  const hasResult =
    lastQueryResult &&
    lastQueryResult.columns &&
    (lastQueryResult.rows || []).length > 0;
  if (exportCsvBtn) {
    exportCsvBtn.disabled = !hasResult;
  }
  if (exportCodeBtn) {
    exportCodeBtn.disabled = !lastGeneratedCode.trim();
  }
}

function setStatus(message, tone = "default") {
  statusText.textContent = message;
  statusText.classList.remove("status--success", "status--error");
  if (tone === "success") {
    statusText.classList.add("status--success");
  } else if (tone === "error") {
    statusText.classList.add("status--error");
  }
}

function setError(message) {
  if (!message) {
    errorBox.textContent = "";
    errorBox.classList.add("hidden");
    return;
  }
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderCode(code) {
  lastGeneratedCode = code || "";
  codeOutput.textContent = lastGeneratedCode;
  if (window.hljs && typeof window.hljs.highlightElement === "function") {
    window.hljs.highlightElement(codeOutput);
  }
  updateExportButtons();
}

function showResultsArea(hasTable) {
  if (hasTable) {
    emptyState.classList.add("hidden");
    resultTableWrap.classList.remove("hidden");
  } else {
    emptyState.classList.remove("hidden");
    resultTableWrap.classList.add("hidden");
    resultTableWrap.innerHTML = "";
  }
}

function renderTable(result) {
  lastQueryResult = result || null;
  updateExportButtons();
  resultTableWrap.innerHTML = "";
  if (!result || !result.columns) {
    showResultsArea(false);
    return;
  }

  const rows = result.rows || [];
  if (!rows.length) {
    showResultsArea(true);
    const notice = document.createElement("p");
    notice.className = "empty-result-notice";
    notice.textContent =
      "Query succeeded but returned 0 rows. The filters may not match any data in the table (check date ranges in the generated SQL).";
    resultTableWrap.appendChild(notice);

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    result.columns.forEach((col) => {
      const th = document.createElement("th");
      th.textContent = col;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);
    resultTableWrap.appendChild(table);
    return;
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  result.columns.forEach((col) => {
    const th = document.createElement("th");
    th.textContent = col;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  result.rows.forEach((row) => {
    const tr = document.createElement("tr");
    result.columns.forEach((col) => {
      const td = document.createElement("td");
      const value = row[col];
      td.innerHTML = value === null || value === undefined ? "" : escapeHtml(value);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  resultTableWrap.appendChild(table);
  showResultsArea(true);
}

function pickChartColumns(result) {
  if (!result || !result.columns || result.columns.length < 2) {
    return null;
  }

  const columns = result.columns;
  const rows = result.rows || [];
  if (!rows.length) {
    return null;
  }

  let labelCol = null;
  let valueCol = null;

  for (const col of columns) {
    const firstNonNull = rows.find((r) => r[col] !== null && r[col] !== undefined)?.[col];
    if (firstNonNull === undefined) {
      continue;
    }
    if (typeof firstNonNull === "string" && labelCol === null) {
      labelCol = col;
    }
    if (typeof firstNonNull === "number" && valueCol === null) {
      valueCol = col;
    }
  }

  if (!labelCol) {
    labelCol = columns[0];
  }
  if (!valueCol) {
    valueCol = columns.find((col) =>
      rows.some((r) => !Number.isNaN(Number(r[col])) && r[col] !== "" && r[col] !== null)
    );
  }

  if (!labelCol || !valueCol || labelCol === valueCol) {
    return null;
  }

  return { labelCol, valueCol };
}

function renderChart(result) {
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  const columns = pickChartColumns(result);
  if (!columns) {
    chartSection.classList.add("hidden");
    return;
  }

  const points = result.rows
    .map((row) => ({
      label: row[columns.labelCol],
      value: row[columns.valueCol]
    }))
    .filter((point) => point.label !== null && point.label !== undefined)
    .map((point) => ({
      label: String(point.label),
      value: Number(point.value)
    }))
    .filter((point) => Number.isFinite(point.value));

  if (!points.length) {
    chartSection.classList.add("hidden");
    return;
  }

  chartSection.classList.remove("hidden");

  const labels = points.map((point) => point.label);
  const values = points.map((point) => point.value);
  const chartType = points.length > 12 ? "line" : "bar";

  chartInstance = new Chart(resultChartCanvas, {
    type: chartType,
    data: {
      labels,
      datasets: [
        {
          label: columns.valueCol,
          data: values,
          borderColor: CHEVRON_BLUE,
          backgroundColor: chartType === "line" ? CHEVRON_BLUE_LIGHT : CHEVRON_BLUE,
          borderWidth: chartType === "line" ? 2 : 0,
          fill: chartType === "line",
          tension: 0.25,
          borderRadius: chartType === "bar" ? 4 : 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: "#5c6670",
            font: { family: "'Source Sans 3', sans-serif", size: 12 }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#5c6670", font: { family: "'Source Sans 3', sans-serif" } },
          grid: { color: "rgba(0, 45, 98, 0.06)" }
        },
        y: {
          ticks: { color: "#5c6670", font: { family: "'Source Sans 3', sans-serif" } },
          grid: { color: "rgba(0, 45, 98, 0.08)" }
        }
      }
    }
  });
}

function formatHistoryTime(isoTimestamp) {
  if (!isoTimestamp) {
    return "";
  }
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return isoTimestamp;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

async function loadHistory() {
  if (!historyList) {
    return;
  }

  try {
    const response = await fetch("/history?limit=10");
    const data = await response.json();
    const items = data.history || [];

    historyList.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "history-empty";
      empty.textContent = "No queries yet — run your first question above.";
      historyList.appendChild(empty);
      return;
    }

    items.forEach((item) => {
      const li = document.createElement("li");
      li.className = `history-item ${item.success ? "history-item--ok" : "history-item--fail"}`;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.question = item.question || "";
      btn.dataset.code = item.generated_code || "";

      const q = document.createElement("span");
      q.className = "history-question";
      q.textContent = item.question || "(no question)";

      const meta = document.createElement("span");
      meta.className = "history-meta";
      meta.textContent = `${item.success ? "Success" : "Failed"} · ${formatHistoryTime(item.timestamp)}`;

      const preview = document.createElement("span");
      preview.className = "history-preview";
      preview.textContent = item.result_preview || "";

      btn.appendChild(q);
      btn.appendChild(meta);
      btn.appendChild(preview);
      li.appendChild(btn);
      historyList.appendChild(li);
    });
  } catch (error) {
    console.error("History load error:", error);
  }
}

historyList?.addEventListener("click", (event) => {
  const target = event.target;
  const button = target instanceof Element ? target.closest("button[data-question]") : null;
  if (!button) {
    return;
  }
  questionInput.value = button.dataset.question || "";
  if (button.dataset.code) {
    renderCode(button.dataset.code);
  }
  questionInput.focus();
});

async function refreshHealthBadge() {
  if (!healthBadge) {
    return;
  }

  healthBadge.className = "health-badge health-badge--loading";
  healthBadge.textContent = "Checking data platform…";

  try {
    const healthResponse = await fetch("/health");
    const health = await healthResponse.json();

    if (health.mode !== "databricks") {
      healthBadge.className = "health-badge health-badge--ok";
      healthBadge.textContent = "Local mode · sample CSV";
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 150000);
    const dbResponse = await fetch("/health/databricks", { signal: controller.signal });
    window.clearTimeout(timeoutId);
    const data = await dbResponse.json();

    if (data.ok && data.latency_ms !== undefined) {
      healthBadge.className = "health-badge health-badge--ok";
      const wh = data.warehouse_state ? ` · ${data.warehouse_state}` : "";
      healthBadge.textContent = `Databricks connected · ${data.latency_ms}ms${wh}`;
      return;
    }

    healthBadge.className = "health-badge health-badge--error";
    const wh = data.warehouse_state ? ` (${data.warehouse_state})` : "";
    healthBadge.textContent = (data.error || "Databricks unreachable") + wh;
  } catch (error) {
    healthBadge.className = "health-badge health-badge--error";
    if (error && error.name === "AbortError") {
      healthBadge.textContent = "Databricks timeout — start warehouse";
    } else {
      healthBadge.textContent = "Platform check failed";
    }
  }
}

async function runQuery() {
  const question = questionInput.value.trim();
  if (!question) {
    setError("Enter a question before running a query.");
    return;
  }

  setError("");
  setStatus("Running query…");
  runBtn.disabled = true;
  let timeoutId = null;

  try {
    const controller = new AbortController();
    const timeoutMs = 180000;
    timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch("/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
      signal: controller.signal
    });

    const rawBody = await response.text();
    let data = null;
    try {
      data = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      setError(`Server returned non-JSON response (${response.status}).`);
      setStatus("Query failed.", "error");
      return;
    }

    try {
      renderCode(data.code || "");
    } catch (codeRenderError) {
      console.error("Code render error:", codeRenderError);
    }

    if (!response.ok || data.error) {
      setError(data.error || "Query failed.");
      setStatus("Query failed.", "error");
      return;
    }

    try {
      renderTable(data.result);
      renderChart(data.result);
      resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (renderError) {
      console.error("Render error:", renderError);
      setError(`Result rendered partially: ${renderError.message || renderError}`);
      setStatus("Done with render warning.", "error");
      return;
    }

    const retries = data.retry_count ?? 0;
    if (retries > 0) {
      setStatus(`Analysis complete · auto-fixed after ${retries} retr${retries === 1 ? "y" : "ies"}`, "success");
    } else {
      setStatus("Analysis complete.", "success");
    }
  } catch (error) {
    if (error && error.name === "AbortError") {
      setError(
        "Query timed out after 90s. The data warehouse may be starting — retry in a moment."
      );
      setStatus("Query timed out.", "error");
      return;
    }
    setError(`Network or server error: ${error.message}`);
    setStatus("Query failed.", "error");
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
    runBtn.disabled = false;
    loadHistory();
  }
}

csvFileInput?.addEventListener("change", () => {
  const file = csvFileInput.files?.[0];
  if (importCsvBtn) {
    importCsvBtn.disabled = !file;
  }
  if (file) {
    setImportStatus(`Selected: ${file.name}`);
  } else {
    setImportStatus("");
  }
});

importCsvBtn?.addEventListener("click", async () => {
  const file = csvFileInput?.files?.[0];
  if (!file) {
    setImportStatus("Choose a CSV file first.", "error");
    return;
  }

  setImportStatus("Importing…");
  importCsvBtn.disabled = true;

  const formData = new FormData();
  formData.append("file", file);

  try {
    const response = await fetch("/import/csv", {
      method: "POST",
      body: formData
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      setImportStatus(data.error || "Import failed.", "error");
      return;
    }
    setImportStatus(data.message || `Imported ${data.rows} rows.`, "success");
    csvFileInput.value = "";
    importCsvBtn.disabled = true;
    refreshHealthBadge();
  } catch (error) {
    setImportStatus(`Import failed: ${error.message}`, "error");
  } finally {
    if (csvFileInput?.files?.[0]) {
      importCsvBtn.disabled = false;
    }
  }
});

exportCsvBtn?.addEventListener("click", () => {
  if (!lastQueryResult || !lastQueryResult.columns) {
    setError("No results to export. Run a query first.");
    return;
  }
  if (!lastQueryResult.rows?.length) {
    setError("No rows to export.");
    return;
  }
  const csv = resultToCsvText(lastQueryResult);
  downloadBlob(csv, "querymind-results.csv", "text/csv;charset=utf-8");
});

exportCodeBtn?.addEventListener("click", () => {
  if (!lastGeneratedCode.trim()) {
    setError("No generated code to export.");
    return;
  }
  const isSql = /^\s*(WITH|SELECT)\b/i.test(lastGeneratedCode);
  const ext = isSql ? "sql" : "py";
  downloadBlob(lastGeneratedCode, `querymind-query.${ext}`, "text/plain;charset=utf-8");
});

runBtn.addEventListener("click", runQuery);

questionInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    runQuery();
  }
});

chipContainer.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  questionInput.value = target.textContent || "";
  questionInput.focus();
});

renderCode("# Generated code will appear here");
setStatus("Ready to analyze.");
updateExportButtons();
refreshHealthBadge();
loadHistory();

let chartInstance = null;
let activeView = "chart";
let lastQueryStart = null;

const CHEVRON_BLUE = "#0066b2";
const CHEVRON_BLUE_LIGHT = "rgba(0, 102, 178, 0.15)";

const questionInput = document.getElementById("questionInput");
const runBtn = document.getElementById("runBtn");
const statusText = document.getElementById("statusText");
const codeOutput = document.getElementById("codeOutput");
const resultTableWrap = document.getElementById("resultTableWrap");
const errorBox = document.getElementById("errorBox");
const emptyState = document.getElementById("emptyState");
const resultChartCanvas = document.getElementById("resultChart");
const chipContainer = document.getElementById("exampleChips");
const healthBadge = document.getElementById("healthBadge");
const historyList = document.getElementById("historyList");
const csvFileInput = document.getElementById("csvFileInput");
const importStatus = document.getElementById("importStatus");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const exportCodeBtn = document.getElementById("exportCodeBtn");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const rowBadge = document.getElementById("rowBadge");
const rowCountBadge = document.getElementById("rowCountBadge");
const successBar = document.getElementById("successBar");
const successSummary = document.getElementById("successSummary");
const elapsedLabel = document.getElementById("elapsedLabel");
const chartNoData = document.getElementById("chartNoData");
const tabTable = document.getElementById("tabTable");
const tabChart = document.getElementById("tabChart");
const tabCode = document.getElementById("tabCode");
const panelTable = document.getElementById("panelTable");
const panelChart = document.getElementById("panelChart");
const panelCode = document.getElementById("panelCode");
const chartWrap = document.querySelector(".chart-wrap");

const metricRows = document.getElementById("metricRows");
const metricFields = document.getElementById("metricFields");
const metricOperators = document.getElementById("metricOperators");
const metricWells = document.getElementById("metricWells");

let lastQueryResult = null;
let lastGeneratedCode = "";
let chartAvailable = false;

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

function formatCount(n) {
  if (n === null || n === undefined || Number.isNaN(n)) {
    return "—";
  }
  return Number(n).toLocaleString();
}

function setImportStatus(message, tone = "default") {
  if (!importStatus) {
    return;
  }
  importStatus.textContent = message || "";
  importStatus.classList.remove("hidden", "import-toast--ok", "import-toast--error");
  if (!message) {
    importStatus.classList.add("hidden");
    return;
  }
  importStatus.classList.remove("hidden");
  if (tone === "success") {
    importStatus.classList.add("import-toast--ok");
  } else if (tone === "error") {
    importStatus.classList.add("import-toast--error");
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
  if (!statusText) {
    return;
  }
  statusText.textContent = message;
  statusText.classList.remove("sidebar-status--success", "sidebar-status--error");
  if (tone === "success") {
    statusText.classList.add("sidebar-status--success");
  } else if (tone === "error") {
    statusText.classList.add("sidebar-status--error");
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

function setActiveView(view) {
  activeView = view;
  const tabs = [
    { tab: tabTable, panel: panelTable, id: "table" },
    { tab: tabChart, panel: panelChart, id: "chart" },
    { tab: tabCode, panel: panelCode, id: "code" }
  ];
  tabs.forEach(({ tab, panel, id }) => {
    const on = id === view;
    tab?.classList.toggle("view-tab--active", on);
    tab?.setAttribute("aria-selected", on ? "true" : "false");
    panel?.classList.toggle("hidden", !on);
  });
}

function showResultsChrome(hasData) {
  emptyState?.classList.toggle("hidden", hasData);
  if (!hasData) {
    [panelTable, panelChart, panelCode].forEach((panel) => panel?.classList.add("hidden"));
    successBar?.classList.add("hidden");
    rowCountBadge?.classList.add("hidden");
  } else {
    successBar?.classList.remove("hidden");
  }
}

function buildSuccessSummary(result) {
  const rows = result?.rows || [];
  const cols = result?.columns || [];
  if (!rows.length) {
    return "Query completed — 0 rows returned. Check date filters in generated code.";
  }
  if (rows.length === 1 && cols.length <= 4) {
    const parts = cols.slice(0, 3).map((c) => {
      const v = rows[0][c];
      if (typeof v === "number" && Math.abs(v) >= 1000) {
        return `${c}: ${(v / 1000).toFixed(1)}K`;
      }
      return `${c}: ${v}`;
    });
    return parts.join(" · ");
  }
  return `${rows.length} row${rows.length === 1 ? "" : "s"} · ${cols.length} column${cols.length === 1 ? "" : "s"}`;
}

function updateRowCountBadge(result) {
  const count = (result?.rows || []).length;
  if (!rowCountBadge) {
    return;
  }
  rowCountBadge.textContent = `${count} row${count === 1 ? "" : "s"}`;
  rowCountBadge.classList.remove("hidden");
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

function renderTable(result) {
  lastQueryResult = result || null;
  updateExportButtons();
  resultTableWrap.innerHTML = "";
  if (!result || !result.columns) {
    return;
  }

  const rows = result.rows || [];
  if (!rows.length) {
    const notice = document.createElement("p");
    notice.className = "empty-result-notice";
    notice.textContent =
      "Query succeeded but returned 0 rows. Filters may not match data (check date ranges in generated code).";
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

  chartAvailable = false;
  const columns = pickChartColumns(result);
  if (!columns) {
    chartNoData?.classList.remove("hidden");
    chartWrap?.classList.add("hidden");
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
    chartNoData?.classList.remove("hidden");
    chartWrap?.classList.add("hidden");
    return;
  }

  chartAvailable = true;
  chartNoData?.classList.add("hidden");
  chartWrap?.classList.remove("hidden");

  const labels = points.map((point) => point.label);
  const values = points.map((point) => point.value);
  const chartType = points.length > 12 ? "line" : "bar";
  const yTitle = columns.valueCol.replace(/_/g, " ");

  chartInstance = new Chart(resultChartCanvas, {
    type: chartType,
    data: {
      labels,
      datasets: [
        {
          label: yTitle,
          data: values,
          borderColor: CHEVRON_BLUE,
          backgroundColor: chartType === "line" ? CHEVRON_BLUE_LIGHT : CHEVRON_BLUE,
          borderWidth: chartType === "line" ? 2 : 0,
          fill: chartType === "line",
          tension: 0.25,
          borderRadius: chartType === "bar" ? 6 : 0,
          maxBarThickness: 80
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          title: {
            display: true,
            text: columns.labelCol.replace(/_/g, " "),
            font: { family: "Inter, sans-serif", size: 12, weight: "600" },
            color: "#5c6670"
          },
          ticks: { color: "#5c6670", font: { family: "Inter, sans-serif", size: 11 } },
          grid: { display: false }
        },
        y: {
          title: {
            display: true,
            text: yTitle,
            font: { family: "Inter, sans-serif", size: 12, weight: "600" },
            color: "#5c6670"
          },
          ticks: {
            color: "#5c6670",
            font: { family: "Inter, sans-serif", size: 11 },
            callback(value) {
              const n = Number(value);
              if (n >= 1000) {
                return `${n / 1000}K`;
              }
              return n;
            }
          },
          grid: { color: "rgba(10, 37, 64, 0.06)" }
        }
      }
    }
  });
}

function pickDefaultView(result) {
  if (pickChartColumns(result)) {
    setActiveView("chart");
  } else {
    setActiveView("table");
  }
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
      empty.textContent = "No queries yet.";
      historyList.appendChild(empty);
      return;
    }

    items.forEach((item) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.question = item.question || "";
      btn.dataset.code = item.generated_code || "";

      const label = document.createElement("span");
      label.textContent = item.question || "(no question)";

      const meta = document.createElement("span");
      meta.className = "history-meta";
      meta.textContent = `${item.success ? "Success" : "Failed"} · ${formatHistoryTime(item.timestamp)}`;

      btn.appendChild(label);
      btn.appendChild(meta);
      li.appendChild(btn);
      historyList.appendChild(li);
    });
  } catch (error) {
    console.error("History load error:", error);
  }
}

async function loadDatasetStats() {
  try {
    const response = await fetch("/dataset/stats");
    const data = await response.json();
    if (!data.ok) {
      return;
    }
    const rows = data.row_count;
    if (metricRows) {
      metricRows.textContent = formatCount(rows);
    }
    if (metricFields) {
      metricFields.textContent = formatCount(data.field_count);
    }
    if (metricOperators) {
      metricOperators.textContent = formatCount(data.operator_count);
    }
    if (metricWells) {
      metricWells.textContent = formatCount(data.well_count);
    }
    if (rowBadge) {
      rowBadge.textContent = `~${formatCount(rows)} rows`;
    }
  } catch (error) {
    console.error("Dataset stats error:", error);
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

clearHistoryBtn?.addEventListener("click", async () => {
  try {
    await fetch("/history", { method: "DELETE" });
    loadHistory();
  } catch (error) {
    console.error("Clear history error:", error);
  }
});

async function refreshHealthBadge() {
  if (!healthBadge) {
    return;
  }

  healthBadge.className = "connection-pill connection-pill--loading";
  healthBadge.innerHTML =
    '<span class="connection-dot" aria-hidden="true"></span>Checking…';

  try {
    const healthResponse = await fetch("/health");
    const health = await healthResponse.json();

    if (health.mode !== "databricks") {
      healthBadge.className = "connection-pill connection-pill--ok";
      healthBadge.innerHTML =
        '<span class="connection-dot" aria-hidden="true"></span>Local · CSV';
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 150000);
    const dbResponse = await fetch("/health/databricks", { signal: controller.signal });
    window.clearTimeout(timeoutId);
    const data = await dbResponse.json();

    if (data.ok) {
      healthBadge.className = "connection-pill connection-pill--ok";
      healthBadge.innerHTML =
        '<span class="connection-dot" aria-hidden="true"></span>Connected';
      return;
    }

    healthBadge.className = "connection-pill connection-pill--error";
    healthBadge.innerHTML = `<span class="connection-dot" aria-hidden="true"></span>${escapeHtml(
      (data.error || "Unreachable").slice(0, 40)
    )}`;
  } catch (error) {
    healthBadge.className = "connection-pill connection-pill--error";
    const msg =
      error && error.name === "AbortError" ? "Timeout" : "Check failed";
    healthBadge.innerHTML = `<span class="connection-dot" aria-hidden="true"></span>${msg}`;
  }
}

async function runQuery() {
  const question = questionInput.value.trim();
  if (!question) {
    setError("Enter a question before running analysis.");
    return;
  }

  setError("");
  setStatus("Generating and running analysis…");
  runBtn.disabled = true;
  lastQueryStart = performance.now();
  let timeoutId = null;

  try {
    const controller = new AbortController();
    timeoutId = window.setTimeout(() => controller.abort(), 180000);

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
      setStatus("Analysis failed.", "error");
      return;
    }

    try {
      renderCode(data.code || "");
    } catch (codeRenderError) {
      console.error("Code render error:", codeRenderError);
    }

    if (!response.ok || data.error) {
      setError(data.error || "Query failed.");
      setStatus("Analysis failed.", "error");
      showResultsChrome(false);
      return;
    }

    const elapsedMs =
      data.elapsed_ms ?? Math.round(performance.now() - (lastQueryStart || performance.now()));

    try {
      renderTable(data.result);
      renderChart(data.result);
      pickDefaultView(data.result);
      showResultsChrome(true);
      updateRowCountBadge(data.result);
      if (successSummary) {
        successSummary.textContent = buildSuccessSummary(data.result);
      }
      if (elapsedLabel) {
        elapsedLabel.textContent = `${(elapsedMs / 1000).toFixed(1)}s`;
      }
    } catch (renderError) {
      console.error("Render error:", renderError);
      setError(`Result rendered partially: ${renderError.message || renderError}`);
      setStatus("Done with warnings.", "error");
      return;
    }

    const retries = data.retry_count ?? 0;
    if (retries > 0) {
      setStatus(`Complete · auto-fixed after ${retries} retr${retries === 1 ? "y" : "ies"}`, "success");
    } else {
      setStatus("Analysis complete.", "success");
    }
  } catch (error) {
    if (error && error.name === "AbortError") {
      setError("Query timed out. The warehouse may be starting — try again shortly.");
      setStatus("Timed out.", "error");
      return;
    }
    setError(`Network or server error: ${error.message}`);
    setStatus("Analysis failed.", "error");
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
    runBtn.disabled = false;
    loadHistory();
  }
}

async function importCsvFile(file) {
  if (!file) {
    return;
  }

  setImportStatus("Importing…");
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
    loadDatasetStats();
    refreshHealthBadge();
    window.setTimeout(() => setImportStatus(""), 6000);
  } catch (error) {
    setImportStatus(`Import failed: ${error.message}`, "error");
  }
}

csvFileInput?.addEventListener("change", () => {
  const file = csvFileInput.files?.[0];
  if (file) {
    importCsvFile(file);
  }
});

exportCsvBtn?.addEventListener("click", () => {
  if (!lastQueryResult?.rows?.length) {
    setError("No results to export.");
    return;
  }
  downloadBlob(resultToCsvText(lastQueryResult), "querymind-results.csv", "text/csv;charset=utf-8");
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

runBtn?.addEventListener("click", runQuery);

questionInput?.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    runQuery();
  }
});

chipContainer?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  questionInput.value = target.textContent || "";
  questionInput.focus();
});

tabTable?.addEventListener("click", () => setActiveView("table"));
tabChart?.addEventListener("click", () => setActiveView("chart"));
tabCode?.addEventListener("click", () => setActiveView("code"));

renderCode("");
setStatus("Ready — ask a question or try an example.");
showResultsChrome(false);
updateExportButtons();
refreshHealthBadge();
loadDatasetStats();
loadHistory();

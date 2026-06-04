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
const historyList = document.getElementById("historyList");
const exportReportBtn = document.getElementById("exportReportBtn");
const exportCodeBtn = document.getElementById("exportCodeBtn");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const rowCountBadge = document.getElementById("rowCountBadge");
const successBar = document.getElementById("successBar");
const successSummary = document.getElementById("successSummary");
const elapsedLabel = document.getElementById("elapsedLabel");
const chartNoData = document.getElementById("chartNoData");
const tabTable = document.getElementById("tabTable");
const tabChart = document.getElementById("tabChart");
const tabExplain = document.getElementById("tabExplain");
const tabCode = document.getElementById("tabCode");
const panelTable = document.getElementById("panelTable");
const panelChart = document.getElementById("panelChart");
const panelExplain = document.getElementById("panelExplain");
const panelCode = document.getElementById("panelCode");
const chartWrap = document.querySelector(".chart-wrap");

const confidenceBadge = document.getElementById("confidenceBadge");
const confidenceText = document.getElementById("confidenceText");
const explainSource = document.getElementById("explainSource");
const explainSummary = document.getElementById("explainSummary");
const explainAssumptions = document.getElementById("explainAssumptions");
const explainSteps = document.getElementById("explainSteps");
const queryProgress = document.getElementById("queryProgress");

const metricRows = document.getElementById("metricRows");
const metricFields = document.getElementById("metricFields");
const metricOperators = document.getElementById("metricOperators");
const metricWells = document.getElementById("metricWells");
const resultsSection = document.getElementById("resultsSection");
const mobileResultsMq = window.matchMedia("(max-width: 960px)");

let lastQueryResult = null;
let lastGeneratedCode = "";
let lastQuestionText = "";
let chartAvailable = false;
let lastChartType = "";
let hasQueryResults = false;
let mobileResultsOpen = false;
let explainRequestId = 0;
let progressTimers = [];

function isMobileLayout() {
  return mobileResultsMq.matches;
}

function updateMobileResultsPanel() {
  if (!resultsSection) {
    return;
  }
  const showOnMobile = mobileResultsOpen;
  resultsSection.classList.toggle("results-panel--show", showOnMobile);
}

function openMobileResultsPanel(scrollIntoView = false) {
  if (!isMobileLayout()) {
    return;
  }
  mobileResultsOpen = true;
  updateMobileResultsPanel();
  if (scrollIntoView) {
    window.requestAnimationFrame(() => {
      resultsSection?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}

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
  const formatted = window.QueryMind?.formatCount?.(n);
  if (formatted === null || formatted === undefined) {
    return "";
  }
  return formatted;
}

function setImportStatus(message, tone = "default") {
  window.QueryMind?.setImportStatus(message, tone);
}

function updateExportButtons() {
  const hasResult =
    lastQueryResult &&
    lastQueryResult.columns &&
    (lastQueryResult.rows || []).length > 0;
  if (exportReportBtn) {
    exportReportBtn.disabled = !hasResult;
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
    { tab: tabExplain, panel: panelExplain, id: "explain" },
    { tab: tabCode, panel: panelCode, id: "code" }
  ];
  tabs.forEach(({ tab, panel, id }) => {
    const on = hasQueryResults && id === view;
    tab?.classList.toggle("view-tab--active", on);
    tab?.setAttribute("aria-selected", on ? "true" : "false");
    tab?.toggleAttribute("disabled", !hasQueryResults);
    panel?.classList.toggle("hidden", !on);
  });
  if (!hasQueryResults) {
    emptyState?.classList.remove("hidden");
  }
}

function showResultsChrome(hasData) {
  hasQueryResults = hasData;
  emptyState?.classList.toggle("hidden", hasData || isMobileLayout());
  document.querySelector(".view-tabs")?.classList.toggle("view-tabs--idle", !hasData);
  if (!hasData) {
    [panelTable, panelChart, panelExplain, panelCode].forEach((panel) =>
      panel?.classList.add("hidden")
    );
    [tabTable, tabChart, tabExplain, tabCode].forEach((tab) => {
      tab?.classList.remove("view-tab--active");
      tab?.setAttribute("aria-selected", "false");
      tab?.setAttribute("disabled", "");
    });
    successBar?.classList.add("hidden");
    rowCountBadge?.classList.add("hidden");
  } else {
    successBar?.classList.remove("hidden");
    [tabTable, tabChart, tabExplain, tabCode].forEach((tab) =>
      tab?.removeAttribute("disabled")
    );
    setActiveView(activeView);
    if (isMobileLayout()) {
      openMobileResultsPanel(true);
    }
  }
  updateMobileResultsPanel();
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

function pickDefaultView(result) {
  const chartable =
    window.QueryMindCharts?.canRenderChart(result, lastQuestionText) ?? false;
  setActiveView(chartable ? "chart" : "table");
}

function formatAxisTick(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return value;
  }
  if (Math.abs(n) >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(n) >= 1000) {
    return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  }
  return n;
}

function buildCartesianScales(spec, valueLabel) {
  const isHorizontal = spec.indexAxis === "y";
  const categoryAxis = isHorizontal ? "y" : "x";
  const valueAxis = isHorizontal ? "x" : "y";
  const categoryTitle = spec.labelCol.replace(/_/g, " ");

  return {
    [categoryAxis]: {
      title: {
        display: true,
        text: categoryTitle,
        font: { family: "Inter, sans-serif", size: 12, weight: "600" },
        color: "#5c6670"
      },
      ticks: { color: "#5c6670", font: { family: "Inter, sans-serif", size: 11 } },
      grid: { display: false }
    },
    [valueAxis]: {
      title: {
        display: true,
        text: valueLabel,
        font: { family: "Inter, sans-serif", size: 12, weight: "600" },
        color: "#5c6670"
      },
      ticks: {
        color: "#5c6670",
        font: { family: "Inter, sans-serif", size: 11 },
        callback: formatAxisTick
      },
      grid: { color: "rgba(10, 37, 64, 0.06)" }
    }
  };
}

function renderChart(result, question = lastQuestionText) {
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  chartAvailable = false;
  lastChartType = "";
  const spec = window.QueryMindCharts?.inferChartSpec(result, question);
  if (!spec) {
    chartNoData?.classList.remove("hidden");
    chartWrap?.classList.add("hidden");
    return;
  }

  chartAvailable = true;
  lastChartType = spec.chartType || "";
  chartNoData?.classList.add("hidden");
  chartWrap?.classList.remove("hidden");

  const chartType = spec.chartType;
  const isPie = chartType === "pie" || chartType === "doughnut";
  const isScatter = chartType === "scatter";
  const isLine = chartType === "line";

  let config;

  if (isScatter) {
    const xTitle = spec.xCol.replace(/_/g, " ");
    const yTitle = spec.yCol.replace(/_/g, " ");
    config = {
      type: "scatter",
      data: {
        datasets: [
          {
            label: `${yTitle} vs ${xTitle}`,
            data: spec.points,
            backgroundColor: CHEVRON_BLUE,
            borderColor: CHEVRON_BLUE,
            pointRadius: 5,
            pointHoverRadius: 7
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            title: {
              display: true,
              text: xTitle,
              font: { family: "Inter, sans-serif", size: 12, weight: "600" },
              color: "#5c6670"
            },
            ticks: { color: "#5c6670", callback: formatAxisTick },
            grid: { color: "rgba(10, 37, 64, 0.06)" }
          },
          y: {
            title: {
              display: true,
              text: yTitle,
              font: { family: "Inter, sans-serif", size: 12, weight: "600" },
              color: "#5c6670"
            },
            ticks: { color: "#5c6670", callback: formatAxisTick },
            grid: { color: "rgba(10, 37, 64, 0.06)" }
          }
        }
      }
    };
  } else if (spec.multiSeries) {
    const valueLabel =
      spec.valueCols.length === 1
        ? spec.valueCols[0].replace(/_/g, " ")
        : "Value";
    config = {
      type: chartType,
      data: {
        labels: spec.labels,
        datasets: spec.datasets.map((ds) => ({
          label: ds.label,
          data: ds.data,
          borderColor: ds.color,
          backgroundColor: isLine ? ds.color + "2e" : ds.color,
          borderWidth: isLine ? 2 : 0,
          fill: false,
          tension: 0.25,
          borderRadius: chartType === "bar" ? 4 : 0,
          maxBarThickness: 56
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: spec.indexAxis === "y" ? "y" : "x",
        plugins: {
          legend: {
            display: spec.legend,
            position: "bottom",
            labels: { font: { family: "Inter, sans-serif", size: 11 } }
          }
        },
        scales: buildCartesianScales(spec, valueLabel)
      }
    };
  } else if (isPie) {
    const labels = spec.points.map((p) => p.label);
    const values = spec.points.map((p) => p.value);
    const colors = window.QueryMindCharts.SERIES_COLORS;
    config = {
      type: chartType,
      data: {
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: labels.map((_, i) => colors[i % colors.length]),
            borderWidth: 1,
            borderColor: "#fff"
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: spec.legend,
            position: "right",
            labels: { font: { family: "Inter, sans-serif", size: 11 } }
          }
        }
      }
    };
  } else {
    const labels = spec.points.map((p) => p.label);
    const values = spec.points.map((p) => p.value);
    const valueLabel = spec.valueCols[0].replace(/_/g, " ");
    config = {
      type: chartType,
      data: {
        labels,
        datasets: [
          {
            label: valueLabel,
            data: values,
            borderColor: CHEVRON_BLUE,
            backgroundColor: isLine ? CHEVRON_BLUE_LIGHT : CHEVRON_BLUE,
            borderWidth: isLine ? 2 : 0,
            fill: isLine,
            tension: 0.25,
            borderRadius: chartType === "bar" ? 6 : 0,
            maxBarThickness: 80
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: spec.indexAxis === "y" ? "y" : "x",
        plugins: { legend: { display: false } },
        scales: buildCartesianScales(spec, valueLabel)
      }
    };
  }

  chartInstance = new Chart(resultChartCanvas, config);
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
      empty.textContent = "No recent queries yet. Your history will appear here.";
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

async function loadWorkspaceDatasetStats() {
  await window.QueryMind?.loadDatasetStats?.();
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

function parseInputRowCount() {
  const text = metricRows?.textContent || "";
  const n = Number(text.replace(/[^0-9]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clearProgressTimers() {
  progressTimers.forEach((id) => window.clearTimeout(id));
  progressTimers = [];
}

function markProgressStep(stepKey, state) {
  const step = queryProgress?.querySelector(`.qp-step[data-step="${stepKey}"]`);
  if (!step) {
    return;
  }
  step.classList.remove("qp-step--active", "qp-step--done");
  if (state) {
    step.classList.add(`qp-step--${state}`);
  }
}

function startQueryProgress() {
  if (!queryProgress) {
    return;
  }
  clearProgressTimers();
  queryProgress.classList.remove("hidden");
  ["understand", "generate", "run", "render"].forEach((key) =>
    markProgressStep(key, null)
  );
  markProgressStep("understand", "active");
  // Advance through the visible pipeline on a gentle timeline; the final
  // "render" step completes when real results arrive.
  progressTimers.push(
    window.setTimeout(() => {
      markProgressStep("understand", "done");
      markProgressStep("generate", "active");
    }, 600)
  );
  progressTimers.push(
    window.setTimeout(() => {
      markProgressStep("generate", "done");
      markProgressStep("run", "active");
    }, 1600)
  );
}

function completeQueryProgress() {
  clearProgressTimers();
  ["understand", "generate", "run"].forEach((key) => markProgressStep(key, "done"));
  markProgressStep("render", "done");
  if (queryProgress) {
    progressTimers.push(
      window.setTimeout(() => queryProgress.classList.add("hidden"), 350)
    );
  }
}

function stopQueryProgress() {
  clearProgressTimers();
  queryProgress?.classList.add("hidden");
}

function setExplainSkeleton() {
  if (confidenceBadge) {
    confidenceBadge.className = "confidence-badge confidence-badge--loading";
  }
  if (confidenceText) {
    confidenceText.textContent = "Analyzing…";
  }
  if (explainSource) {
    explainSource.textContent = "";
  }
  if (explainSummary) {
    explainSummary.innerHTML =
      '<span class="skeleton-line"></span><span class="skeleton-line skeleton-line--short"></span>';
  }
  if (explainAssumptions) {
    explainAssumptions.innerHTML =
      '<div class="assumption-card assumption-card--ghost"></div>'.repeat(3);
  }
  if (explainSteps) {
    explainSteps.innerHTML =
      '<li class="step-item step-item--ghost"><span class="skeleton-line"></span></li>'.repeat(3);
  }
}

function applyConfidence(score, label) {
  if (!confidenceBadge || !confidenceText) {
    return;
  }
  const value = Number.isFinite(score) ? Math.round(score) : null;
  let tone = "high";
  if (value !== null && value < 60) {
    tone = "low";
  } else if (value !== null && value < 85) {
    tone = "medium";
  }
  confidenceBadge.className = `confidence-badge confidence-badge--${tone}`;
  const text = label || "Confidence";
  confidenceText.textContent = value !== null ? `${text} · ${value}%` : text;
}

function renderExplanation(explanation) {
  if (!explanation) {
    return;
  }

  applyConfidence(explanation.confidence, explanation.confidence_label);

  if (explainSource) {
    explainSource.textContent =
      explanation.source === "fallback" ? "Heuristic summary" : "AI-generated explanation";
  }

  if (explainSummary) {
    explainSummary.textContent =
      explanation.summary || "This analysis ran successfully on your dataset.";
  }

  if (explainAssumptions) {
    const assumptions = explanation.assumptions || [];
    if (!assumptions.length) {
      explainAssumptions.innerHTML =
        '<p class="assumption-empty">No special assumptions — the analysis used your full dataset.</p>';
    } else {
      explainAssumptions.innerHTML = "";
      assumptions.forEach((item) => {
        const card = document.createElement("div");
        card.className = "assumption-card";
        const label = document.createElement("p");
        label.className = "assumption-label";
        label.textContent = item.label || "";
        const value = document.createElement("p");
        value.className = "assumption-value";
        value.textContent = item.value || "";
        card.appendChild(label);
        card.appendChild(value);
        explainAssumptions.appendChild(card);
      });
    }
  }

  if (explainSteps) {
    const steps = explanation.steps || [];
    explainSteps.innerHTML = "";
    steps.forEach((step) => {
      const li = document.createElement("li");
      li.className = "step-item";
      const text = document.createElement("span");
      text.className = "step-text";
      text.textContent = step;
      li.appendChild(text);
      explainSteps.appendChild(li);
    });
  }
}

function renderProvisionalExplain(result) {
  // Instant, client-derived steps so the Explain tab never feels empty while the
  // richer AI explanation is still loading.
  const inputRows = parseInputRowCount();
  const resultRows = (result?.rows || []).length;
  const steps = [];
  if (inputRows) {
    steps.push(`Loaded ${inputRows.toLocaleString()} rows from the wells dataset`);
  } else {
    steps.push("Loaded the wells dataset");
  }
  steps.push("Generated and ran analysis code");
  steps.push(`Returned ${resultRows.toLocaleString()} result row${resultRows === 1 ? "" : "s"}`);

  if (explainSteps) {
    explainSteps.innerHTML = "";
    steps.forEach((step) => {
      const li = document.createElement("li");
      li.className = "step-item step-item--provisional";
      const text = document.createElement("span");
      text.className = "step-text";
      text.textContent = step;
      li.appendChild(text);
      explainSteps.appendChild(li);
    });
  }
}

async function requestExplanation(question, code, result) {
  const requestId = ++explainRequestId;
  setExplainSkeleton();
  renderProvisionalExplain(result);

  try {
    const response = await fetch("/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        code,
        result_row_count: (result?.rows || []).length,
        result_columns: result?.columns || []
      })
    });
    const data = await response.json();
    if (requestId !== explainRequestId) {
      return;
    }
    if (data.ok && data.explanation) {
      renderExplanation(data.explanation);
    } else if (confidenceText) {
      confidenceText.textContent = "Explanation unavailable";
      if (confidenceBadge) {
        confidenceBadge.className = "confidence-badge confidence-badge--low";
      }
    }
  } catch (error) {
    if (requestId !== explainRequestId) {
      return;
    }
    console.error("Explain load error:", error);
    if (confidenceText) {
      confidenceText.textContent = "Explanation unavailable";
    }
    if (confidenceBadge) {
      confidenceBadge.className = "confidence-badge confidence-badge--low";
    }
  }
}

async function runQuery() {
  const question = questionInput.value.trim();
  if (!question) {
    setError("Enter a question before running analysis.");
    return;
  }
  lastQuestionText = question;

  setError("");
  setStatus("Generating and running analysis…");
  emptyState?.classList.add("hidden");
  startQueryProgress();
  openMobileResultsPanel(true);
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
      stopQueryProgress();
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
      stopQueryProgress();
      window.QueryMind?.clearHealthCache?.();
      window.QueryMind?.refreshHealthBadge?.({ force: true, probe: "full" });
      setError(data.error || "Query failed.");
      setStatus("Analysis failed.", "error");
      showResultsChrome(false);
      openMobileResultsPanel(true);
      return;
    }

    completeQueryProgress();

    const elapsedMs =
      data.elapsed_ms ?? Math.round(performance.now() - (lastQueryStart || performance.now()));

    try {
      renderTable(data.result);
      renderChart(data.result, question);
      pickDefaultView(data.result);
      showResultsChrome(true);
      updateRowCountBadge(data.result);
      requestExplanation(question, data.code || lastGeneratedCode, data.result);
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
      openMobileResultsPanel(true);
      return;
    }

    const retries = data.retry_count ?? 0;
    if (retries > 0) {
      setStatus(`Complete · auto-fixed after ${retries} retr${retries === 1 ? "y" : "ies"}`, "success");
    } else {
      setStatus("Analysis complete.", "success");
    }
  } catch (error) {
    stopQueryProgress();
    if (error && error.name === "AbortError") {
      setError("Query timed out. The warehouse may be starting — try again shortly.");
      setStatus("Timed out.", "error");
      openMobileResultsPanel(true);
      return;
    }
    setError(`Network or server error: ${error.message}`);
    setStatus("Analysis failed.", "error");
    openMobileResultsPanel(true);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
    runBtn.disabled = false;
    loadHistory();
  }
}

function captureChartImage() {
  if (!chartInstance || !chartAvailable) {
    return null;
  }
  try {
    // White background so the PNG isn't transparent in Excel.
    return chartInstance.toBase64Image("image/png", 1);
  } catch (error) {
    console.error("Chart capture error:", error);
    return null;
  }
}

exportReportBtn?.addEventListener("click", async () => {
  if (!lastQueryResult?.rows?.length) {
    setError("No results to export.");
    return;
  }

  const originalLabel = exportReportBtn.textContent;
  exportReportBtn.disabled = true;
  exportReportBtn.textContent = "Preparing…";
  setError("");

  try {
    const response = await fetch("/export/xlsx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: lastQuestionText,
        code: lastGeneratedCode,
        result: lastQueryResult,
        chart_image: captureChartImage(),
        chart_type: lastChartType
      })
    });

    if (!response.ok) {
      let message = `Export failed (${response.status}).`;
      try {
        const data = await response.json();
        message = data.error || message;
      } catch {
        /* non-JSON error body */
      }
      setError(message);
      return;
    }

    const blob = await response.blob();
    downloadBlob(
      blob,
      "querymind-report.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  } catch (error) {
    setError(`Export failed: ${error.message || error}`);
  } finally {
    exportReportBtn.textContent = originalLabel;
    updateExportButtons();
  }
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
tabExplain?.addEventListener("click", () => setActiveView("explain"));
tabCode?.addEventListener("click", () => setActiveView("code"));

function applyQuestionFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const q = params.get("q");
  if (q && questionInput) {
    questionInput.value = q;
    questionInput.focus();
  }
}

renderCode("");
setStatus("");
showResultsChrome(false);
updateMobileResultsPanel();
updateExportButtons();
loadWorkspaceDatasetStats();
loadHistory();
applyQuestionFromUrl();

window.addEventListener("querymind:dataset-updated", loadWorkspaceDatasetStats);

mobileResultsMq.addEventListener("change", () => {
  if (!isMobileLayout()) {
    mobileResultsOpen = false;
  }
  updateMobileResultsPanel();
  emptyState?.classList.toggle("hidden", hasQueryResults || isMobileLayout());
});

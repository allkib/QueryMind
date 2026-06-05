/**
 * Dashboard page — renders pre-built KPIs and Chart.js visuals.
 *
 * Pulls one aggregated payload from GET /dashboard/data (computed server-side in
 * schema.py, in whichever executor mode is active) and paints the KPI cards plus
 * the monthly-trend, by-field, and by-operator charts. No LLM involved — these
 * are deterministic summaries so the page loads instantly and consistently.
 */
const NAVY = "#0a2540";
const BLUE = "#0066b2";
const BLUE_FILL = "rgba(0, 102, 178, 0.18)";

let trendChart = null;
let fieldChart = null;
let operatorChart = null;

function formatBbl(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) {
    return "—";
  }
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(2)}M bbl`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K bbl`;
  }
  return `${num.toLocaleString()} bbl`;
}

function formatMonthLabel(month) {
  const parts = String(month).split("-");
  if (parts.length !== 2) {
    return month;
  }
  const year = parts[0].slice(-2);
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];
  const idx = parseInt(parts[1], 10) - 1;
  if (idx < 0 || idx > 11) {
    return month;
  }
  return `${monthNames[idx]} '${year}`;
}

function destroyChart(instance) {
  if (instance) {
    instance.destroy();
  }
  return null;
}

function renderTrendChart(points) {
  const canvas = document.getElementById("trendChart");
  if (!canvas) {
    return;
  }
  trendChart = destroyChart(trendChart);

  trendChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: points.map((p) => formatMonthLabel(p.month)),
      datasets: [
        {
          label: "Production (bbl)",
          data: points.map((p) => p.production_bbl),
          borderColor: BLUE,
          backgroundColor: BLUE_FILL,
          borderWidth: 2,
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointBackgroundColor: BLUE
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: "#5c6670", maxRotation: 45, minRotation: 0 },
          grid: { display: false }
        },
        y: {
          ticks: {
            color: "#5c6670",
            callback(value) {
              const n = Number(value);
              if (n >= 1000) {
                return `${(n / 1000).toFixed(1)}K`;
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

function renderFieldChart(rows) {
  const canvas = document.getElementById("fieldChart");
  if (!canvas) {
    return;
  }
  fieldChart = destroyChart(fieldChart);

  fieldChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: rows.map((r) => r.field),
      datasets: [
        {
          data: rows.map((r) => r.production_bbl),
          backgroundColor: rows.map((r) => r.color || BLUE),
          borderRadius: 6,
          maxBarThickness: 72
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#5c6670" } },
        y: {
          ticks: {
            color: "#5c6670",
            callback(value) {
              const n = Number(value);
              if (n >= 1_000_000) {
                return `${(n / 1_000_000).toFixed(1)}M`;
              }
              if (n >= 1000) {
                return `${(n / 1000).toFixed(0)}K`;
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

function renderOperatorChart(rows) {
  const canvas = document.getElementById("operatorChart");
  if (!canvas) {
    return;
  }
  operatorChart = destroyChart(operatorChart);

  const top = rows.slice(0, 8);
  operatorChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: top.map((r) => r.operator),
      datasets: [
        {
          data: top.map((r) => r.production_bbl),
          backgroundColor: NAVY,
          borderRadius: 6,
          maxBarThickness: 48
        }
      ]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: {
            color: "#5c6670",
            callback(value) {
              const n = Number(value);
              if (n >= 1000) {
                return `${(n / 1000).toFixed(0)}K`;
              }
              return n;
            }
          },
          grid: { color: "rgba(10, 37, 64, 0.06)" }
        },
        y: {
          grid: { display: false },
          ticks: { color: "#5c6670", font: { size: 11 } }
        }
      }
    }
  });
}

function showError(message) {
  const el = document.getElementById("dashboardError");
  if (!el) {
    return;
  }
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

function renderDashboard(data) {
  const subtitle = document.getElementById("dashboardSubtitle");
  if (subtitle) {
    subtitle.innerHTML = `Pre-built KPIs across all wells in <span class="table-path">${data.table_name}</span>.`;
  }

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = text;
    }
  };

  setText("kpiWells", formatCount(data.well_count));
  setText("kpiRecords", `${formatCount(data.row_count)} production records`);
  setText(
    "kpiAvgMonthly",
    formatBbl(data.avg_monthly_production_bbl).replace(" bbl", "")
  );
  setText("kpiTotalProd", `Total: ${formatBbl(data.total_production_bbl)}`);
  setText("kpiTopField", data.top_field?.name || "");
  setText("kpiTopFieldVol", formatBbl(data.top_field?.total_bbl));
  setText("kpiTopOperator", data.top_operator?.name || "");
  setText("kpiTopOperatorVol", formatBbl(data.top_operator?.total_bbl));

  renderTrendChart(data.monthly_trend || []);
  renderFieldChart(data.by_field || []);
  renderOperatorChart(data.by_operator || []);
}

async function refreshDashboard({ force = false } = {}) {
  const cached = !force ? window.QueryMindData?.readDashboard?.() : null;
  if (cached) {
    showError("");
    renderDashboard(cached);
  }

  try {
    const result = await window.QueryMindData?.loadDashboard?.({ force });
    if (!result?.data) {
      if (!cached) {
        showError("Failed to load dashboard.");
      }
      return;
    }
    showError("");
    if (!cached || !result.fromCache) {
      renderDashboard(result.data);
    }
  } catch (error) {
    showError(
      cached
        ? `Showing cached dashboard — refresh failed: ${error.message}`
        : `Failed to load dashboard: ${error.message}`
    );
  }
}

function formatCount(n) {
  return window.QueryMind?.formatCount(n) ?? String(n);
}

const cachedDashboardOnLoad = window.QueryMindData?.readDashboard?.();
if (cachedDashboardOnLoad) {
  showError("");
  renderDashboard(cachedDashboardOnLoad);
}

refreshDashboard();
window.addEventListener("querymind:dataset-updated", () => refreshDashboard({ force: true }));

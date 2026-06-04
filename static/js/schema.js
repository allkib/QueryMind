function escapeHtml(value) {
  return window.QueryMind?.escapeHtml(value) ?? String(value);
}

function formatCell(col, value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (col === "production_bbl" && typeof value === "number") {
    return value.toLocaleString();
  }
  if (col === "depth_ft" && typeof value === "number") {
    return `${value.toLocaleString()} ft`;
  }
  return escapeHtml(value);
}

function showError(message) {
  const el = document.getElementById("schemaError");
  if (!el) {
    return;
  }
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

function renderSchema(data) {
  const queryEl = document.getElementById("schemaQueryText");
  if (queryEl) {
    queryEl.textContent = data.describe_query || "";
  }

  const tableName = document.getElementById("schemaTableName");
  if (tableName) {
    tableName.textContent = data.table_name || "";
  }

  const meta = document.getElementById("schemaMeta");
  if (meta) {
    meta.textContent = `${data.column_count} columns · ${data.row_count} rows`;
  }

  const body = document.getElementById("schemaColumnsBody");
  if (body) {
    body.innerHTML = "";
    (data.columns || []).forEach((col) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="schema-col-name">
          <button type="button" data-column="${escapeHtml(col.name)}" title="Use in a workspace question">
            ${escapeHtml(col.name)}
          </button>
        </td>
        <td><span class="type-pill">${escapeHtml(col.data_type)}</span></td>
        <td>${escapeHtml(col.comment)}</td>
      `;
      body.appendChild(tr);
    });
  }

  const head = document.getElementById("sampleRowsHead");
  const sampleBody = document.getElementById("sampleRowsBody");
  if (head && sampleBody) {
    head.innerHTML = "";
    sampleBody.innerHTML = "";
    const cols = data.sample_columns || [];
    const headerRow = document.createElement("tr");
    cols.forEach((col) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = col.replace(/_/g, " ").toUpperCase();
      headerRow.appendChild(th);
    });
    head.appendChild(headerRow);

    (data.sample_rows || []).forEach((row) => {
      const tr = document.createElement("tr");
      cols.forEach((col) => {
        const td = document.createElement("td");
        td.innerHTML = formatCell(col, row[col]);
        tr.appendChild(td);
      });
      sampleBody.appendChild(tr);
    });
  }
}

async function refreshSchema({ force = false } = {}) {
  const cached = !force ? window.QueryMindData?.readSchema?.() : null;
  if (cached) {
    showError("");
    renderSchema(cached);
  }

  try {
    const result = await window.QueryMindData?.loadSchema?.({ force });
    if (!result?.data) {
      if (!cached) {
        showError("Failed to load schema.");
      }
      return;
    }
    showError("");
    if (!cached || !result.fromCache) {
      renderSchema(result.data);
    }
  } catch (error) {
    if (!cached) {
      showError(`Failed to load schema: ${error.message}`);
    }
  }
}

document.getElementById("schemaColumnsBody")?.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-column]");
  if (!btn) {
    return;
  }
  const col = btn.dataset.column;
  window.location.href = `/workspace?q=${encodeURIComponent(`Show ${col} by month`)}`;
});

document.getElementById("copySchemaQueryBtn")?.addEventListener("click", async () => {
  const text = document.getElementById("schemaQueryText")?.textContent || "";
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById("copySchemaQueryBtn");
    const original = btn?.innerHTML;
    if (btn) {
      btn.textContent = "Copied!";
      window.setTimeout(() => {
        if (btn && original) {
          btn.innerHTML = original;
        }
      }, 2000);
    }
  } catch {
    showError("Could not copy to clipboard.");
  }
});

const cachedSchemaOnLoad = window.QueryMindData?.readSchema?.();
if (cachedSchemaOnLoad) {
  showError("");
  renderSchema(cachedSchemaOnLoad);
}

refreshSchema();
window.addEventListener("querymind:dataset-updated", () => refreshSchema({ force: true }));

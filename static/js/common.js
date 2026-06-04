/**
 * Shared header: dataset badge, connection status, CSV import.
 * Persists health, stats, and page payloads across navigations (sessionStorage).
 */
(function () {
  const healthBadge = document.getElementById("healthBadge");
  const rowBadge = document.getElementById("rowBadge");
  const csvFileInput = document.getElementById("csvFileInput");
  const importCsvPrimary = document.getElementById("importCsvPrimary");
  const importCsvOptional = document.getElementById("importCsvOptional");
  const importStatus = document.getElementById("importStatus");

  const HEALTH_STORAGE_KEY = "querymind.databricks.health";
  const HEALTH_CLIENT_TTL_MS = 5 * 60 * 1000;
  const HEALTH_BACKGROUND_INTERVAL_MS = 2 * 60 * 1000;

  let healthCheckInFlight = null;
  let cachedExecutorMode = null;

  function formatCount(n) {
    if (n === null || n === undefined || Number.isNaN(n)) {
      return null;
    }
    return Number(n).toLocaleString();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function applyDatasetStats(stats) {
    if (!stats) {
      return;
    }
    const wells = formatCount(stats.well_count);
    const rows = formatCount(stats.row_count);
    if (rowBadge && wells) {
      rowBadge.textContent = `${wells} wells`;
      rowBadge.title = rows ? `${rows} production records` : "Dataset size";
      rowBadge.classList.remove("row-badge--pending");
    }
    document.querySelectorAll("[data-qm-stat='rows']").forEach((el) => {
      if (rows) {
        el.textContent = rows;
      }
    });
    document.querySelectorAll("[data-qm-stat='fields']").forEach((el) => {
      const v = formatCount(stats.field_count);
      if (v) {
        el.textContent = v;
      }
    });
    document.querySelectorAll("[data-qm-stat='operators']").forEach((el) => {
      const v = formatCount(stats.operator_count);
      if (v) {
        el.textContent = v;
      }
    });
    document.querySelectorAll("[data-qm-stat='wells']").forEach((el) => {
      if (wells) {
        el.textContent = wells;
      }
    });
  }

  function applyExecutorMode(mode) {
    cachedExecutorMode = mode || "local";
    const isDatabricks = cachedExecutorMode === "databricks";
    document.body.classList.toggle("qm-mode-databricks", isDatabricks);
    document.body.classList.toggle("qm-mode-local", !isDatabricks);
    if (importCsvPrimary) {
      importCsvPrimary.classList.toggle("hidden", isDatabricks);
    }
    if (importCsvOptional) {
      importCsvOptional.classList.toggle("hidden", !isDatabricks);
      importCsvOptional.title = isDatabricks
        ? "Optional: replace the local sample CSV only. Queries still use your Databricks table."
        : "";
    }
  }

  function hydrateFromSessionCache() {
    const stats = window.QueryMindData?.readStats?.();
    if (stats) {
      applyDatasetStats(stats);
    }
    const appMeta = window.QueryMindData?.readAppMeta?.();
    if (appMeta?.mode) {
      applyExecutorMode(appMeta.mode);
    }
    const cachedHealth = readHealthCache();
    if (cachedHealth?.ok) {
      applyHealthBadge({ ok: true, cached: true, error: cachedHealth.error });
    } else if (appMeta?.mode && appMeta.mode !== "databricks") {
      applyHealthBadge("local");
    }
  }

  function readHealthCache() {
    try {
      const raw = sessionStorage.getItem(HEALTH_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (!parsed?.checkedAt) {
        return null;
      }
      if (Date.now() - parsed.checkedAt > HEALTH_CLIENT_TTL_MS) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function writeHealthCache(payload) {
    try {
      sessionStorage.setItem(
        HEALTH_STORAGE_KEY,
        JSON.stringify({ ...payload, checkedAt: Date.now() })
      );
    } catch {
      /* private mode / quota */
    }
  }

  function clearHealthCache() {
    try {
      sessionStorage.removeItem(HEALTH_STORAGE_KEY);
    } catch {
      /* ignore */
    }
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

  function applyHealthBadge(state) {
    if (!healthBadge) {
      return;
    }
    if (state === "checking") {
      healthBadge.className = "connection-pill connection-pill--loading";
      healthBadge.innerHTML =
        '<span class="connection-dot" aria-hidden="true"></span>Checking…';
      return;
    }
    if (state === "local") {
      healthBadge.className = "connection-pill connection-pill--ok";
      healthBadge.innerHTML =
        '<span class="connection-dot" aria-hidden="true"></span>Local · CSV';
      return;
    }
    if (state.ok) {
      healthBadge.className = "connection-pill connection-pill--ok";
      healthBadge.innerHTML =
        '<span class="connection-dot" aria-hidden="true"></span>Connected';
      healthBadge.title = state.cached
        ? "Databricks warehouse (cached status)"
        : "Databricks warehouse";
      return;
    }
    healthBadge.className = "connection-pill connection-pill--error";
    healthBadge.innerHTML = `<span class="connection-dot" aria-hidden="true"></span>${escapeHtml(
      (state.error || "Unreachable").slice(0, 40)
    )}`;
    healthBadge.title = state.error || "";
  }

  async function fetchDatabricksHealth({ probe = "light", force = false } = {}) {
    const params = new URLSearchParams({ probe });
    if (force) {
      params.set("force", "1");
    }
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 150000);
    try {
      const dbResponse = await fetch(`/health/databricks?${params}`, {
        signal: controller.signal
      });
      const data = await dbResponse.json();
      return { responseOk: dbResponse.ok, data };
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function refreshHealthBadge(options = {}) {
    if (!healthBadge) {
      return;
    }

    const force = Boolean(options.force);
    const probe = options.probe || (force ? "full" : "light");

    if (healthCheckInFlight && !force) {
      return healthCheckInFlight;
    }

    const run = async () => {
      const cached = !force ? readHealthCache() : null;

      try {
        const metaResult = await window.QueryMindData?.loadAppMeta?.({ force });
        const health = metaResult?.data;
        if (health?.mode) {
          applyExecutorMode(health.mode);
        }

        if (health?.mode !== "databricks") {
          clearHealthCache();
          applyHealthBadge("local");
          return;
        }

        if (cached) {
          applyHealthBadge({ ok: cached.ok, cached: true, error: cached.error });
        } else {
          applyHealthBadge("checking");
        }

        const { responseOk, data } = await fetchDatabricksHealth({ probe, force });
        const payload = {
          ok: responseOk && data.ok,
          error: data.error || null,
          mode: "databricks",
          probe: data.probe || probe
        };
        writeHealthCache(payload);
        applyHealthBadge({
          ok: payload.ok,
          cached: Boolean(data.cached),
          error: payload.error
        });

        if (!payload.ok && !force) {
          window.setTimeout(() => {
            refreshHealthBadge({ force: true, probe: "full" });
          }, 0);
        }
      } catch (error) {
        const stillCached = readHealthCache();
        if (stillCached && !force) {
          applyHealthBadge({ ok: stillCached.ok, cached: true, error: stillCached.error });
          return;
        }
        const msg =
          error && error.name === "AbortError" ? "Timeout" : "Check failed";
        applyHealthBadge({ ok: false, error: msg });
        writeHealthCache({ ok: false, error: msg, mode: "databricks" });
      }
    };

    healthCheckInFlight = run().finally(() => {
      healthCheckInFlight = null;
    });
    return healthCheckInFlight;
  }

  async function loadDatasetStats(options = {}) {
    try {
      const result = await window.QueryMindData?.loadStats?.(options);
      const data = result?.data;
      if (!data?.ok) {
        return null;
      }
      applyDatasetStats(data);
      return data;
    } catch (error) {
      console.error("Dataset stats error:", error);
      const stale = window.QueryMindData?.readStats?.();
      if (stale) {
        applyDatasetStats(stale);
        return stale;
      }
      return null;
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
      if (csvFileInput) {
        csvFileInput.value = "";
      }
      await loadDatasetStats({ force: true });
      await refreshHealthBadge({ force: true, probe: "full" });
      window.QueryMindData?.clearAll?.();
      window.QueryMindData?.prefetchAll?.({ force: true });
      window.dispatchEvent(new CustomEvent("querymind:dataset-updated"));
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

  importCsvOptional?.addEventListener("click", () => {
    csvFileInput?.click();
  });

  hydrateFromSessionCache();

  function prefetchNavOnHover() {
    const prefetch = () => window.QueryMindData?.prefetchAll?.();
    document.querySelectorAll('.topnav-link[href="/schema"]').forEach((link) => {
      link.addEventListener("mouseenter", prefetch, { passive: true });
      link.addEventListener("focus", prefetch, { passive: true });
    });
    document.querySelectorAll('.topnav-link[href="/dashboard"]').forEach((link) => {
      link.addEventListener("mouseenter", prefetch, { passive: true });
      link.addEventListener("focus", prefetch, { passive: true });
    });
    document.querySelectorAll('.topnav-link[href="/workspace"]').forEach((link) => {
      link.addEventListener("mouseenter", prefetch, { passive: true });
      link.addEventListener("focus", prefetch, { passive: true });
    });
    document.querySelectorAll('.topnav-link[href="/"]').forEach((link) => {
      link.addEventListener("mouseenter", prefetch, { passive: true });
      link.addEventListener("focus", prefetch, { passive: true });
    });
  }

  prefetchNavOnHover();
  window.QueryMindData?.prefetchAll?.().then(() => {
    hydrateFromSessionCache();
    loadDatasetStats();
  });
  refreshHealthBadge();

  window.setInterval(() => {
    refreshHealthBadge({ probe: "light" });
  }, HEALTH_BACKGROUND_INTERVAL_MS);

  window.addEventListener("pageshow", (event) => {
    hydrateFromSessionCache();
    if (event.persisted) {
      refreshHealthBadge({ probe: "light" });
      window.QueryMindData?.prefetchAll?.();
    }
  });

  window.addEventListener("querymind:dataset-updated", () => {
    window.QueryMindData?.prefetchAll?.({ force: true });
  });

  window.QueryMind = {
    formatCount,
    escapeHtml,
    setImportStatus,
    applyDatasetStats,
    loadDatasetStats,
    refreshHealthBadge,
    importCsvFile,
    clearHealthCache,
    getExecutorMode: () => cachedExecutorMode
  };
})();

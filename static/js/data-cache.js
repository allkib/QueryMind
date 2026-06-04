/**
 * Prefetch and cache schema/dashboard API payloads across page navigations.
 */
(function () {
  const SCHEMA_KEY = "querymind.page.schema";
  const DASHBOARD_KEY = "querymind.page.dashboard";
  const STATS_KEY = "querymind.page.stats";
  const APP_KEY = "querymind.app.meta";
  const TTL_MS = 5 * 60 * 1000;

  const inflight = {
    schema: null,
    dashboard: null,
    all: null
  };

  function readEntry(key) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (!parsed?.cachedAt || !parsed?.data) {
        return null;
      }
      if (Date.now() - parsed.cachedAt > TTL_MS) {
        sessionStorage.removeItem(key);
        return null;
      }
      return parsed.data;
    } catch {
      return null;
    }
  }

  function writeEntry(key, data) {
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({ cachedAt: Date.now(), data })
      );
    } catch {
      /* quota / private mode */
    }
  }

  function clearAll() {
    try {
      sessionStorage.removeItem(SCHEMA_KEY);
      sessionStorage.removeItem(DASHBOARD_KEY);
      sessionStorage.removeItem(STATS_KEY);
    } catch {
      /* ignore */
    }
  }

  async function fetchEndpoint(url) {
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok || !data.ok) {
      const err = new Error(data.error || `Failed to load ${url}`);
      err.status = response.status;
      throw err;
    }
    return data;
  }

  async function loadSchema({ force = false } = {}) {
    if (!force) {
      const cached = readEntry(SCHEMA_KEY);
      if (cached) {
        return { data: cached, fromCache: true };
      }
    }
    if (inflight.schema && !force) {
      return inflight.schema;
    }

    const task = fetchEndpoint("/schema/info")
      .then((data) => {
        writeEntry(SCHEMA_KEY, data);
        return { data, fromCache: false };
      })
      .finally(() => {
        inflight.schema = null;
      });

    inflight.schema = task;
    return task;
  }

  async function loadDashboard({ force = false } = {}) {
    if (!force) {
      const cached = readEntry(DASHBOARD_KEY);
      if (cached) {
        return { data: cached, fromCache: true };
      }
    }
    if (inflight.dashboard && !force) {
      return inflight.dashboard;
    }

    const task = fetchEndpoint("/dashboard/data")
      .then((data) => {
        writeEntry(DASHBOARD_KEY, data);
        return { data, fromCache: false };
      })
      .finally(() => {
        inflight.dashboard = null;
      });

    inflight.dashboard = task;
    return task;
  }

  let inflightStats = null;
  let inflightApp = null;

  async function loadStats({ force = false } = {}) {
    if (!force) {
      const cached = readEntry(STATS_KEY);
      if (cached) {
        return { data: cached, fromCache: true };
      }
    }
    if (inflightStats && !force) {
      return inflightStats;
    }

    const task = fetch("/dataset/stats")
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok) {
          const err = new Error(data.error || "Failed to load dataset stats");
          err.status = 500;
          throw err;
        }
        writeEntry(STATS_KEY, data);
        return { data, fromCache: false };
      })
      .finally(() => {
        inflightStats = null;
      });

    inflightStats = task;
    return task;
  }

  async function loadAppMeta({ force = false } = {}) {
    if (!force) {
      const cached = readEntry(APP_KEY);
      if (cached) {
        return { data: cached, fromCache: true };
      }
    }
    if (inflightApp && !force) {
      return inflightApp;
    }

    const task = fetch("/health")
      .then((r) => r.json())
      .then((data) => {
        const meta = {
          ok: Boolean(data.ok),
          mode: data.mode || "local",
          databricks_configured: Boolean(data.databricks_configured)
        };
        writeEntry(APP_KEY, meta);
        return { data: meta, fromCache: false };
      })
      .finally(() => {
        inflightApp = null;
      });

    inflightApp = task;
    return task;
  }

  function prefetchAll({ force = false } = {}) {
    if (inflight.all && !force) {
      return inflight.all;
    }
    inflight.all = Promise.all([
      loadAppMeta({ force }),
      loadStats({ force }),
      loadSchema({ force }),
      loadDashboard({ force })
    ]).finally(() => {
      inflight.all = null;
    });
    return inflight.all;
  }

  window.QueryMindData = {
    readSchema: () => readEntry(SCHEMA_KEY),
    readDashboard: () => readEntry(DASHBOARD_KEY),
    readStats: () => readEntry(STATS_KEY),
    readAppMeta: () => readEntry(APP_KEY),
    loadSchema,
    loadDashboard,
    loadStats,
    loadAppMeta,
    prefetchAll,
    clearAll
  };
})();

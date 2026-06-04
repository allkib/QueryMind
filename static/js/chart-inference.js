/**
 * Infer Chart.js type and axes from query result shape + optional question text.
 */
(function () {
  const SERIES_COLORS = [
    "#0066b2",
    "#e31b23",
    "#7c3aed",
    "#0d7d4d",
    "#c2410c",
    "#0891b2",
    "#b45309",
    "#64748b"
  ];

  const TEMPORAL_NAME =
    /\b(month|months|date|dates|period|time|year|years|quarter|quarters|week|weeks|day|days|timestamp|yr|mo|fiscal)\b/i;
  const CATEGORY_NAME =
    /\b(field|fields|operator|operators|well|wells|well_id|basin|category|categories|name|names|label|region|company|companies)\b/i;
  const METRIC_NAME =
    /\b(production|prod|bbl|barrel|total|sum|avg|average|mean|count|depth|rate|volume|output|amount|value|pct|percent|share)\b/i;
  const ID_NAME = /^well_id$|^id$/i;

  const TIME_QUESTION =
    /\b(trend|over\s+time|time\s+series|monthly|quarterly|yearly|annual|per\s+month|by\s+month|each\s+month|timeline|historical|history|evolution|growth\s+over|progression|seasonal|sequential)\b/i;
  const COMPARE_QUESTION =
    /\b(top|bottom|compare|comparison|rank|ranking|breakdown|versus|vs\.?|by\s+field|by\s+operator|by\s+well|highest|lowest|best|worst)\b/i;
  const SHARE_QUESTION =
    /\b(share|proportion|percentage|percent|distribution|mix|split|composition|breakdown\s+of\s+total)\b/i;
  const CORREL_QUESTION =
    /\b(correlat|relationship|scatter|vs\.?\s|against|depth\s+vs|versus)\b/i;

  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const QUARTER_RE = /^\d{4}-Q[1-4]$/i;

  function normalizeCol(name) {
    return String(name).toLowerCase().replace(/\s+/g, "_");
  }

  function isFiniteNumber(value) {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n);
  }

  function columnValues(rows, col) {
    return rows
      .map((r) => r[col])
      .filter((v) => v !== null && v !== undefined && v !== "");
  }

  function numericRatio(values) {
    if (!values.length) {
      return 0;
    }
    let n = 0;
    values.forEach((v) => {
      if (isFiniteNumber(v)) {
        n += 1;
      }
    });
    return n / values.length;
  }

  function stringRatio(values) {
    if (!values.length) {
      return 0;
    }
    let n = 0;
    values.forEach((v) => {
      if (typeof v === "string" && !isFiniteNumber(v)) {
        n += 1;
      }
    });
    return n / values.length;
  }

  function temporalValueRatio(values) {
    if (!values.length) {
      return 0;
    }
    let n = 0;
    values.forEach((v) => {
      if (looksLikeTimeLabel(v)) {
        n += 1;
      }
    });
    return n / values.length;
  }

  function looksLikeTimeLabel(value) {
    const text = String(value).trim();
    if (MONTH_RE.test(text) || DATE_RE.test(text) || QUARTER_RE.test(text)) {
      return true;
    }
    if (/^\d{4}$/.test(text)) {
      return true;
    }
    if (
      /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+['']?\d{2,4}$/i.test(
        text
      )
    ) {
      return true;
    }
    // Only accept delimiter-based dates (avoid Date.parse on arbitrary labels).
    if (/^\d{1,4}[-/.]\d{1,2}([-/.]\d{1,4})?/.test(text) && text.length <= 32) {
      return !Number.isNaN(Date.parse(text));
    }
    return false;
  }

  function timeSortKey(label) {
    const text = String(label).trim();
    if (MONTH_RE.test(text)) {
      return text;
    }
    if (DATE_RE.test(text)) {
      return text;
    }
    if (QUARTER_RE.test(text)) {
      const [y, q] = text.toUpperCase().split("-Q");
      return `${y}-Q${q}`;
    }
    if (/^\d{4}$/.test(text)) {
      return `${text}-01`;
    }
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
    return text;
  }

  function analyzeColumn(col, rows) {
    const values = columnValues(rows, col);
    const norm = normalizeCol(col);
    const numRatio = numericRatio(values);
    const strRatio = stringRatio(values);
    const timeRatio = temporalValueRatio(values);

    const isNumeric = numRatio >= 0.8;
    const isTemporal =
      TEMPORAL_NAME.test(norm) || timeRatio >= 0.6 || (timeRatio >= 0.4 && strRatio >= 0.5);
    const isCategory =
      !isNumeric &&
      (CATEGORY_NAME.test(norm) || strRatio >= 0.6 || (!isTemporal && strRatio >= 0.3));
    const isMetric = isNumeric && METRIC_NAME.test(norm);
    const isId = ID_NAME.test(norm);

    return {
      name: col,
      norm,
      values,
      isNumeric,
      isTemporal,
      isCategory,
      isMetric,
      isId,
      metricScore: isMetric ? 2 : isNumeric && !isId ? 1 : 0
    };
  }

  function pickLabelColumn(analyses, question) {
    const nonNumeric = analyses.filter((a) => !a.isNumeric || a.isTemporal);
    const temporal = nonNumeric.filter((a) => a.isTemporal);
    if (temporal.length) {
      return temporal[0].name;
    }
    if (TIME_QUESTION.test(question)) {
      const byValues = nonNumeric.find((a) => temporalValueRatio(a.values) >= 0.4);
      if (byValues) {
        return byValues.name;
      }
    }
    const category = nonNumeric.filter((a) => a.isCategory && !a.isId);
    if (category.length) {
      return category[0].name;
    }
    const anyString = analyses.find((a) => !a.isNumeric);
    if (anyString) {
      return anyString.name;
    }
    return analyses[0]?.name ?? null;
  }

  function pickValueColumns(analyses, labelCol) {
    const candidates = analyses
      .filter((a) => a.name !== labelCol && a.isNumeric && !a.isId)
      .sort((a, b) => b.metricScore - a.metricScore);
    return candidates.map((a) => a.name);
  }

  function buildPoints(rows, labelCol, valueCol) {
    return rows
      .map((row) => ({
        label: row[labelCol],
        value: Number(row[valueCol])
      }))
      .filter((p) => p.label !== null && p.label !== undefined && Number.isFinite(p.value));
  }

  function sortPoints(points, mode, labelCol, analyses) {
    const copy = [...points];
    if (mode === "chrono") {
      copy.sort((a, b) => {
        const ka = timeSortKey(a.label);
        const kb = timeSortKey(b.label);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      return copy;
    }
    if (mode === "valueDesc") {
      copy.sort((a, b) => b.value - a.value);
      return copy;
    }
    if (mode === "valueAsc") {
      copy.sort((a, b) => a.value - b.value);
      return copy;
    }
    const col = analyses.find((a) => a.name === labelCol);
    if (col?.isTemporal) {
      return sortPoints(copy, "chrono", labelCol, analyses);
    }
    return copy;
  }

  function avgLabelLength(points) {
    if (!points.length) {
      return 0;
    }
    const total = points.reduce((sum, p) => sum + String(p.label).length, 0);
    return total / points.length;
  }

  function allPositive(points) {
    return points.every((p) => p.value > 0);
  }

  function inferSingleSeriesChart(points, labelCol, valueCol, analyses, question) {
    const labelAnalysis = analyses.find((a) => a.name === labelCol);
    const labelTimeRatio = temporalValueRatio(points.map((p) => p.label));
    const isTime =
      labelAnalysis?.isTemporal ||
      (!labelAnalysis?.isCategory && labelTimeRatio >= 0.6) ||
      (TIME_QUESTION.test(question) && labelTimeRatio >= 0.4);

    let sort = "none";
    if (isTime) {
      sort = "chrono";
    } else if (COMPARE_QUESTION.test(question)) {
      sort = "valueDesc";
    }

    const sorted = sortPoints(points, sort, labelCol, analyses);
    const n = sorted.length;
    const avgLen = avgLabelLength(sorted);

    if (isTime) {
      return {
        chartType: "line",
        indexAxis: "x",
        sort,
        points: sorted,
        labelCol,
        valueCols: [valueCol],
        legend: false
      };
    }

    if (SHARE_QUESTION.test(question) && n >= 2 && n <= 10 && allPositive(sorted)) {
      return {
        chartType: n <= 6 ? "pie" : "doughnut",
        indexAxis: "x",
        sort,
        points: sorted,
        labelCol,
        valueCols: [valueCol],
        legend: n > 5
      };
    }

    const shareCol = /\b(share|percent|pct|proportion)\b/i.test(normalizeCol(valueCol));
    if (shareCol && n >= 2 && n <= 10 && allPositive(sorted)) {
      return {
        chartType: n <= 6 ? "pie" : "doughnut",
        indexAxis: "x",
        sort,
        points: sorted,
        labelCol,
        valueCols: [valueCol],
        legend: n > 5
      };
    }

    if (n > 12 || avgLen > 16) {
      return {
        chartType: "bar",
        indexAxis: "y",
        sort: COMPARE_QUESTION.test(question) ? "valueDesc" : sort,
        points: sortPoints(sorted, COMPARE_QUESTION.test(question) ? "valueDesc" : sort, labelCol, analyses),
        labelCol,
        valueCols: [valueCol],
        legend: false
      };
    }

    if (n > 8 && avgLen > 10) {
      return {
        chartType: "bar",
        indexAxis: "y",
        sort: COMPARE_QUESTION.test(question) ? "valueDesc" : sort,
        points: sortPoints(sorted, COMPARE_QUESTION.test(question) ? "valueDesc" : sort, labelCol, analyses),
        labelCol,
        valueCols: [valueCol],
        legend: false
      };
    }

    return {
      chartType: "bar",
      indexAxis: "x",
      sort,
      points: sorted,
      labelCol,
      valueCols: [valueCol],
      legend: false
    };
  }

  function inferMultiSeriesChart(rows, labelCol, valueCols, analyses, question) {
    const labelAnalysis = analyses.find((a) => a.name === labelCol);
    const labels = [];
    const seen = new Set();
    rows.forEach((row) => {
      const label = row[labelCol];
      if (label === null || label === undefined) {
        return;
      }
      const key = String(label);
      if (!seen.has(key)) {
        seen.add(key);
        labels.push(label);
      }
    });

    const labelTimeRatio = temporalValueRatio(labels);
    const isTime =
      labelAnalysis?.isTemporal ||
      (!labelAnalysis?.isCategory && labelTimeRatio >= 0.6) ||
      (TIME_QUESTION.test(question) && labelTimeRatio >= 0.4);

    let orderedLabels = [...labels];
    if (isTime) {
      orderedLabels.sort((a, b) => {
        const ka = timeSortKey(a);
        const kb = timeSortKey(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
    } else if (COMPARE_QUESTION.test(question)) {
      const totals = orderedLabels.map((label) => {
        const row = rows.find((r) => String(r[labelCol]) === String(label));
        const sum = valueCols.reduce((s, col) => s + Number(row?.[col] || 0), 0);
        return { label, sum };
      });
      totals.sort((a, b) => b.sum - a.sum);
      orderedLabels = totals.map((t) => t.label);
    }

    const datasets = valueCols.map((col, idx) => ({
      label: col.replace(/_/g, " "),
      col,
      color: SERIES_COLORS[idx % SERIES_COLORS.length],
      data: orderedLabels.map((label) => {
        const row = rows.find((r) => String(r[labelCol]) === String(label));
        const v = Number(row?.[col]);
        return Number.isFinite(v) ? v : null;
      })
    }));

    const n = orderedLabels.length;
    const avgLen =
      orderedLabels.reduce((s, l) => s + String(l).length, 0) / Math.max(orderedLabels.length, 1);

    let chartType = "bar";
    let indexAxis = "x";
    if (isTime) {
      chartType = "line";
    } else if (n > 10 || avgLen > 14) {
      indexAxis = "y";
    }

    return {
      chartType,
      indexAxis,
      sort: isTime ? "chrono" : COMPARE_QUESTION.test(question) ? "valueDesc" : "none",
      labels: orderedLabels.map(String),
      labelCol,
      valueCols,
      datasets,
      legend: valueCols.length > 1,
      multiSeries: true
    };
  }

  function inferScatterChart(rows, xCol, yCol) {
    const points = rows
      .map((row) => ({
        x: Number(row[xCol]),
        y: Number(row[yCol])
      }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

    if (points.length < 2) {
      return null;
    }

    return {
      chartType: "scatter",
      indexAxis: "x",
      points,
      labelCol: xCol,
      valueCols: [yCol],
      xCol,
      yCol,
      legend: false,
      multiSeries: false
    };
  }

  function inferChartSpec(result, question = "") {
    if (!result?.columns || result.columns.length < 2) {
      return null;
    }

    const rows = result.rows || [];
    if (!rows.length) {
      return null;
    }

    const q = String(question || "");
    const analyses = result.columns.map((col) => analyzeColumn(col, rows));
    const valueCols = pickValueColumns(analyses, null);

    if (valueCols.length >= 2 && CORREL_QUESTION.test(q)) {
      const scatter = inferScatterChart(rows, valueCols[0], valueCols[1]);
      if (scatter) {
        return scatter;
      }
    }

    if (valueCols.length >= 2 && !analyses.some((a) => a.isTemporal || a.isCategory)) {
      const scatter = inferScatterChart(rows, valueCols[0], valueCols[1]);
      if (scatter && rows.length >= 3) {
        return scatter;
      }
    }

    const labelCol = pickLabelColumn(analyses, q);
    if (!labelCol) {
      return null;
    }

    const metrics = pickValueColumns(analyses, labelCol);
    if (!metrics.length) {
      return null;
    }

    if (metrics.length >= 2) {
      const multi = inferMultiSeriesChart(rows, labelCol, metrics.slice(0, 4), analyses, q);
      if (multi?.labels?.length >= 2 || multi?.datasets?.[0]?.data?.filter((v) => v !== null).length >= 2) {
        return multi;
      }
    }

    const points = buildPoints(rows, labelCol, metrics[0]);
    if (points.length < 2) {
      return null;
    }

    return inferSingleSeriesChart(points, labelCol, metrics[0], analyses, q);
  }

  function canRenderChart(result, question = "") {
    return inferChartSpec(result, question) !== null;
  }

  window.QueryMindCharts = {
    inferChartSpec,
    canRenderChart,
    SERIES_COLORS
  };
})();

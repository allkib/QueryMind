// Lightweight, dependency-free guided tour: dim backdrop, spotlight cutout on a
// target element, and a tooltip with Back / Next / Skip. Per-page step lists are
// defined in TOURS, keyed by the body's data-page attribute. Auto-starts once on
// a visitor's first session; the header "Tutorial" button replays anytime.
(function () {
  "use strict";

  const TOURS = {
    home: [
      {
        title: "Welcome to QueryMind",
        body: "QueryMind turns plain-English questions into live energy analytics. Here's a 30-second tour of the platform.",
      },
      {
        target: ".hero-actions",
        title: "Jump right in",
        body: "Open the Workspace to ask questions, or view the Dashboard for pre-built KPIs.",
      },
      {
        target: ".hero-stats",
        title: "Live dataset stats",
        body: "These numbers update from the live wells table powering every answer.",
      },
      {
        target: ".try-queries",
        title: "Try a sample question",
        body: "Click any example to open the Workspace pre-filled and ready to run.",
      },
      {
        target: ".topnav",
        title: "Find your way around",
        body: "Switch between Dashboard, Workspace, and Schema from the header anytime.",
      },
      {
        title: "You're all set",
        body: "Open the Workspace to ask your first question. You can replay this tour from the Tutorial button up top.",
      },
    ],
    workspace: [
      {
        title: "This is the Workspace",
        body: "Ask anything about your wells in plain English — QueryMind writes the code, runs it, and shows the results.",
      },
      {
        target: "#questionInput",
        title: "Ask in plain English",
        body: "Type a question like \"Top 5 wells by production in 2024\". No SQL or schemas required.",
      },
      {
        target: "#runBtn",
        title: "Run the analysis",
        body: "Click Run Analysis (or press \u2318 / Ctrl + Enter) and QueryMind generates and executes the query.",
      },
      {
        target: "#exampleChips",
        title: "Not sure where to start?",
        body: "Pick an example question to drop it straight into the box.",
      },
      {
        target: ".view-tabs",
        title: "Explore your results",
        body: "After a run, switch between the data Table, an auto-built Chart, a plain-English Explain, and the generated Code.",
      },
      {
        target: "#historyList",
        title: "Your recent queries",
        body: "Past questions are saved here so you can revisit or rerun them.",
      },
      {
        target: ".topbar-import",
        title: "Bring your own data",
        body: "Import a CSV to analyze your own dataset with the same natural-language workflow.",
      },
      {
        title: "Ask away",
        body: "That's it — type a question and hit Run. Replay this tour anytime from the Tutorial button.",
      },
    ],
    schema: [
      {
        title: "Schema Explorer",
        body: "See exactly what data powers QueryMind — the table, its columns, and real sample rows.",
      },
      {
        target: ".schema-table",
        title: "Every column explained",
        body: "Each column's name, data type, and description. Click a column to use it in a question.",
      },
      {
        target: ".sample-section",
        title: "Preview the data",
        body: "The first few rows give you a feel for the actual values you can ask about.",
      },
      {
        target: "#copySchemaQueryBtn",
        title: "Copy the query",
        body: "Grab the exact query used to describe the table for your own reference.",
      },
      {
        title: "Ready to analyze",
        body: "Head to the Workspace and ask a question using any of these columns.",
      },
    ],
    dashboard: [
      {
        title: "Production Dashboard",
        body: "Pre-built KPIs and charts across every well in your dataset — no query needed.",
      },
      {
        target: "#kpiGrid",
        title: "Headline KPIs",
        body: "Total wells, average production, and your top field and operator at a glance.",
      },
      {
        target: ".chart-card--wide",
        title: "Production over time",
        body: "The monthly production trend across the whole dataset.",
      },
      {
        target: ".chart-row",
        title: "Breakdowns",
        body: "Compare production by field and by operator side by side.",
      },
      {
        title: "Go deeper",
        body: "Want a custom view? Open the Workspace and ask for exactly what you need.",
      },
    ],
  };

  const page = (document.body.getAttribute("data-page") || "").trim();
  const steps = TOURS[page];
  const tourBtn = document.getElementById("tourBtn");

  // No tour for this page: hide the launcher and bail.
  if (!steps || !steps.length) {
    if (tourBtn) tourBtn.style.display = "none";
    return;
  }

  const PAD = 8;
  const SEEN_KEY = "qm_tour_seen_v1";
  let index = 0;
  let active = false;
  let els = null;

  function store(key, val) {
    try {
      if (val === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, val);
    } catch (e) {
      return null;
    }
  }

  function buildDom() {
    const root = document.createElement("div");
    root.className = "tour-root";
    root.innerHTML =
      '<div class="tour-backdrop"></div>' +
      '<div class="tour-highlight" aria-hidden="true"></div>' +
      '<div class="tour-tooltip" role="dialog" aria-modal="true" aria-labelledby="tourTitle">' +
      '  <button class="tour-skip" type="button" aria-label="End tour">' +
      '    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
      "  </button>" +
      '  <p class="tour-step-count"></p>' +
      '  <h3 class="tour-title display-serif" id="tourTitle"></h3>' +
      '  <p class="tour-body"></p>' +
      '  <div class="tour-dots" aria-hidden="true"></div>' +
      '  <div class="tour-actions">' +
      '    <button class="text-btn tour-back" type="button">Back</button>' +
      '    <button class="btn btn-primary tour-next" type="button">Next</button>' +
      "  </div>" +
      "</div>";
    document.body.appendChild(root);
    return {
      root: root,
      backdrop: root.querySelector(".tour-backdrop"),
      highlight: root.querySelector(".tour-highlight"),
      tooltip: root.querySelector(".tour-tooltip"),
      count: root.querySelector(".tour-step-count"),
      title: root.querySelector(".tour-title"),
      body: root.querySelector(".tour-body"),
      dots: root.querySelector(".tour-dots"),
      back: root.querySelector(".tour-back"),
      next: root.querySelector(".tour-next"),
      skip: root.querySelector(".tour-skip"),
    };
  }

  function renderDots() {
    els.dots.innerHTML = "";
    steps.forEach(function (_, i) {
      const dot = document.createElement("span");
      dot.className = "tour-dot" + (i === index ? " tour-dot--active" : "");
      els.dots.appendChild(dot);
    });
  }

  function position() {
    const step = steps[index];
    const target = step.target ? document.querySelector(step.target) : null;
    const tip = els.tooltip;

    if (!target) {
      // Centered, no-spotlight step.
      els.highlight.style.opacity = "0";
      els.root.classList.add("tour-root--center");
      tip.style.left = "";
      tip.style.top = "";
      return;
    }

    els.root.classList.remove("tour-root--center");
    const r = target.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    els.highlight.style.opacity = "1";
    els.highlight.style.top = r.top - PAD + "px";
    els.highlight.style.left = r.left - PAD + "px";
    els.highlight.style.width = r.width + PAD * 2 + "px";
    els.highlight.style.height = r.height + PAD * 2 + "px";

    const tipRect = tip.getBoundingClientRect();
    const tipW = tipRect.width || 320;
    const tipH = tipRect.height || 180;
    const gap = 14;

    let top;
    if (vh - r.bottom > tipH + gap + 12) {
      top = r.bottom + gap; // below
    } else if (r.top > tipH + gap + 12) {
      top = r.top - tipH - gap; // above
    } else {
      top = Math.max(12, (vh - tipH) / 2); // fallback: vertical center
    }

    let left = r.left + r.width / 2 - tipW / 2;
    left = Math.max(12, Math.min(left, vw - tipW - 12));

    tip.style.left = left + "px";
    tip.style.top = Math.max(12, Math.min(top, vh - tipH - 12)) + "px";
  }

  function render() {
    const step = steps[index];
    els.count.textContent = "Step " + (index + 1) + " of " + steps.length;
    els.title.textContent = step.title;
    els.body.textContent = step.body;
    els.back.style.visibility = index === 0 ? "hidden" : "visible";
    els.next.textContent = index === steps.length - 1 ? "Finish" : "Next";
    renderDots();

    const target = step.target ? document.querySelector(step.target) : null;
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(position, 320);
    } else {
      position();
    }
  }

  function go(delta) {
    const nextIndex = index + delta;
    if (nextIndex < 0) return;
    if (nextIndex >= steps.length) {
      end();
      return;
    }
    index = nextIndex;
    render();
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === "Escape") end();
    else if (e.key === "ArrowRight" || e.key === "Enter") go(1);
    else if (e.key === "ArrowLeft") go(-1);
  }

  function onReposition() {
    if (active) position();
  }

  function start() {
    if (active) return;
    index = 0;
    active = true;
    if (!els) els = buildDom();
    els.next.addEventListener("click", function () {
      go(1);
    });
    els.back.addEventListener("click", function () {
      go(-1);
    });
    els.skip.addEventListener("click", end);
    els.backdrop.addEventListener("click", end);
    document.body.classList.add("tour-active");
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    window.requestAnimationFrame(render);
  }

  function end() {
    if (!active) return;
    active = false;
    document.body.classList.remove("tour-active");
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onReposition);
    window.removeEventListener("scroll", onReposition, true);
    if (els && els.root) els.root.remove();
    els = null;
    store(SEEN_KEY, "1");
    if (tourBtn) tourBtn.focus();
  }

  if (tourBtn) tourBtn.addEventListener("click", start);

  // Auto-start once for first-time visitors (any page), after the UI settles.
  if (!store(SEEN_KEY)) {
    window.setTimeout(function () {
      if (!active) start();
    }, 900);
  }

  window.QMTour = { start: start, end: end };
})();

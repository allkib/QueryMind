(function () {
  const featureBlurb = document.getElementById("featureDataBlurb");

  function renderFeatureBlurb(stats, tableName) {
    if (!featureBlurb || !stats?.row_count) {
      return;
    }
    const wells = stats.well_count ?? 0;
    featureBlurb.textContent = `Connected to ${tableName} with ${Number(stats.row_count).toLocaleString()}+ records across ${wells} wells.`;
  }

  async function updateFeatureBlurb() {
    if (!featureBlurb) {
      return;
    }
    const cachedStats = window.QueryMindData?.readStats?.();
    const cachedSchema = window.QueryMindData?.readSchema?.();
    if (cachedStats && cachedSchema) {
      renderFeatureBlurb(cachedStats, cachedSchema.table_name || "wells");
    }

    try {
      const [statsResult, schemaResult] = await Promise.all([
        window.QueryMindData?.loadStats?.() ?? Promise.resolve(null),
        window.QueryMindData?.loadSchema?.() ?? Promise.resolve(null)
      ]);
      const stats = statsResult?.data;
      const schema = schemaResult?.data;
      if (!stats?.ok || !schema) {
        return;
      }
      renderFeatureBlurb(stats, schema.table_name || "wells");
    } catch (error) {
      console.error("Home feature blurb error:", error);
    }
  }

  updateFeatureBlurb();
  window.addEventListener("querymind:dataset-updated", updateFeatureBlurb);

  // Scroll-reveal: progressively fade sections in. Always resolves to visible
  // (reduced-motion or missing IntersectionObserver reveal immediately) so
  // content is never stuck hidden.
  function initReveal() {
    const items = Array.from(document.querySelectorAll("[data-reveal]"));
    if (!items.length) {
      return;
    }

    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    const revealAll = () => items.forEach((el) => el.classList.add("is-revealed"));

    if (prefersReduced || !("IntersectionObserver" in window)) {
      revealAll();
      return;
    }

    const observer = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-revealed");
            obs.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );

    items.forEach((el) => observer.observe(el));
    // Safety net: ensure everything is visible shortly after load.
    window.setTimeout(revealAll, 1600);
  }

  initReveal();
})();

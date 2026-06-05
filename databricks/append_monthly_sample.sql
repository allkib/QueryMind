-- QueryMind — back-history backfill job (optional, finite)
-- ---------------------------------------------------------------------------
-- Appends ONE new month of production for every existing well, derived from the
-- table itself so it always matches the live schema
-- (well_id, month, production_bbl, field, operator, depth_ft).
--
-- Each run advances every well by one month past its current latest month, but
-- NEVER past the current real month (the final WHERE cap) — so dates can never
-- move into the future. Use this to richly fill the time series for all wells
-- until the table catches up to today; after that it inserts nothing.
--
-- Production follows a gentle decline-with-noise curve; depth drifts a few feet.
-- The LEFT ANTI JOIN plus the date cap make the job idempotent and bounded:
-- re-running creates no duplicate (well_id, month) rows and never overshoots now.
--
-- For PERPETUAL hourly growth once caught up, pair this with spawn_new_well.sql.
-- Schedule from Databricks Workflows as a SQL task (cron `0 0 * * * ?` = hourly).
-- See docs/DATABRICKS-SAMPLE-DATA.md for setup + cost notes.
--
-- The table name matches DATABRICKS_TABLE in the app (.env). Change all three
-- references below if you use a different catalog.schema.table.
-- ---------------------------------------------------------------------------

INSERT INTO workspace.querymind.wells (well_id, month, production_bbl, field, operator, depth_ft)
WITH latest AS (
    -- Most recent row per well (rn = 1), carrying its attributes forward.
    SELECT
        well_id,
        field,
        operator,
        depth_ft,
        production_bbl,
        month,
        ROW_NUMBER() OVER (PARTITION BY well_id ORDER BY month DESC) AS rn
    FROM workspace.querymind.wells
),
next_rows AS (
    SELECT
        well_id,
        -- 'YYYY-MM' string -> next month as 'YYYY-MM'
        date_format(add_months(to_date(month || '-01'), 1), 'yyyy-MM') AS month,
        -- Decline-with-noise: ~0.97x to ~1.02x of last month, floored at 500 bbl.
        CAST(GREATEST(500, ROUND(production_bbl * (0.97 + rand() * 0.05))) AS BIGINT) AS production_bbl,
        field,
        operator,
        -- Depth wanders up to +20 ft (wells deepen slightly over time).
        CAST(depth_ft + CAST(ROUND(rand() * 20) AS INT) AS INT) AS depth_ft
    FROM latest
    WHERE rn = 1
)
SELECT
    n.well_id,
    n.month,
    n.production_bbl,
    n.field,
    n.operator,
    n.depth_ft
FROM next_rows n
-- Skip wells whose next month already exists (keeps the job safe to re-run).
LEFT ANTI JOIN workspace.querymind.wells w
    ON w.well_id = n.well_id
   AND w.month = n.month
-- Hard cap: never insert a month beyond the current real month.
WHERE n.month <= date_format(current_date(), 'yyyy-MM');

-- QueryMind — "new well" job (RECOMMENDED hourly, perpetual)
-- ---------------------------------------------------------------------------
-- Adds ONE brand-new well stamped at the CURRENT REAL MONTH, so the dataset
-- keeps growing forever without the time dimension ever moving into the future.
-- The new well borrows a real field/operator pairing and typical production/
-- depth from existing data, so it stays consistent with the schema and the
-- categorical values the LLM already knows about.
--
-- Why this is the optimal "every hour" job: each run adds new rows (new wells)
-- but always dated `date_format(current_date(), 'yyyy-MM')` — which by
-- definition can never surpass today. No schema change, runs indefinitely.
--
-- Schedule hourly in Databricks Workflows (cron `0 0 * * * ?`). To add more than
-- one well per run, raise LIMIT in the `pick` CTE and the `new_id` logic would
-- need a sequence — keep it at 1 for steady, realistic growth.
-- See docs/DATABRICKS-SAMPLE-DATA.md.
-- ---------------------------------------------------------------------------

INSERT INTO workspace.querymind.wells (well_id, month, production_bbl, field, operator, depth_ft)
WITH new_id AS (
    -- Next sequential id, e.g. max 'W067' -> 'W068' (zero-padded to 3 digits).
    SELECT 'W' || lpad(CAST(MAX(CAST(substr(well_id, 2) AS INT)) + 1 AS STRING), 3, '0') AS well_id
    FROM workspace.querymind.wells
),
target_month AS (
    -- The current real month. New wells are always dated "now", never the future.
    SELECT date_format(current_date(), 'yyyy-MM') AS month
),
pick AS (
    -- A random real field/operator pairing with its typical production & depth.
    SELECT
        field,
        operator,
        AVG(production_bbl) AS avg_prod,
        AVG(depth_ft) AS avg_depth
    FROM workspace.querymind.wells
    GROUP BY field, operator
    ORDER BY rand()
    LIMIT 1
)
SELECT
    new_id.well_id,
    target_month.month,
    CAST(GREATEST(500, ROUND(pick.avg_prod * (0.8 + rand() * 0.4))) AS BIGINT) AS production_bbl,
    pick.field,
    pick.operator,
    CAST(ROUND(pick.avg_depth + (rand() - 0.5) * 400) AS INT) AS depth_ft
FROM new_id
CROSS JOIN target_month
CROSS JOIN pick;

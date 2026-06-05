# Growing the Databricks dataset over time

QueryMind can keep its Databricks `wells` table growing **every hour**, so the
Dashboard and Workspace stay alive without any manual work. This is done entirely
**on Databricks** with scheduled SQL — the Flask app just reads the table.

Two hard guarantees, both baked into the SQL:

- **No schema change** — every job only ever inserts the existing six columns
  (`well_id, month, production_bbl, field, operator, depth_ft`).
- **Dates never surpass the real date** — both jobs cap the inserted `month` at
  `date_format(current_date(), 'yyyy-MM')`, so the time dimension can never move
  into the future.

SQL lives in [`../databricks/`](../databricks):

| File | What it does | Role |
|------|--------------|------|
| `spawn_new_well.sql` | Adds **one brand-new well** stamped at the **current real month**, reusing a real field/operator pairing. | **Primary, perpetual** — schedule hourly |
| `append_monthly_sample.sql` | Advances **every existing well** by one month, **capped at the current real month**. | Optional **back-history backfill** — finite |

### Why this is the optimal "every hour" setup

Because the time grain is monthly (`YYYY-MM`) and dates may never pass today, you
can't keep inventing new *future* months forever. The way to add data every hour
**indefinitely** without future dates is to add new **wells** at the current
month — that's `spawn_new_well.sql`, and it's the perpetual engine.

`append_monthly_sample.sql` is a one-time **catch-up**: if your table currently
ends in (say) 2024-12 while the real date is later, run it hourly too and it will
fill one month per run for *all* wells until the series reaches today — then it
naturally inserts nothing (the date cap stops it). Result: a full, continuous
back-history that climbs to "now" and stops, while new wells keep arriving hourly.

Both jobs are **idempotent**: the backfill uses a `LEFT ANTI JOIN` + the date cap
so it never duplicates `(well_id, month)` rows or overshoots the current month.

---

## Does this cost money on Databricks Free Edition?

**No — Databricks Free Edition is free, with no credit card and no billing.** It
is a no-cost, serverless-only offering subject to a **fair-usage quota** rather
than charges. If you ever exceed the daily/monthly compute limit, your warehouse
is simply **paused until the limit resets** — you are never billed.
(See the official [Free Edition limitations](https://learn.microsoft.com/en-us/azure/databricks/getting-started/free-edition-limitations).)

A tiny hourly insert is negligible against that quota. Relevant Free Edition
limits, none of which these jobs come close to:

- One serverless SQL warehouse (`2X-Small`) — enough for these queries.
- Max 5 concurrent job tasks per account — this uses 1–2.
- The warehouse auto-stops when idle and resumes in seconds, so a short hourly
  query uses very little compute.

> **Hourly cadence note:** running every hour wakes the warehouse 24×/day. That
> is still free, but it consumes more of your daily fair-usage quota than a daily
> job. If you ever hit the quota, the warehouse just pauses until reset — no
> charge. If that becomes a nuisance, drop to every few hours.
>
> If you instead use a paid workspace or the 14-day **Free trial**, serverless
> SQL does consume credits/DBUs while running — but a few-second scheduled query
> is a fraction of a cent. The cost concern only applies to paid accounts.

---

## One-time setup

The SQL targets `workspace.querymind.wells` — the same table as `DATABRICKS_TABLE`
in your `.env`. If your catalog/schema/table differ, update the three references
in each `.sql` file first.

## Schedule it hourly (Databricks Workflows)

Set up the perpetual job first; add the backfill if you want a fuller history.

**1. Test once.** In **SQL Editor**, paste `databricks/spawn_new_well.sql` and run
it — you should see "1 row affected" and a new well appear. **Save** it as a query
(e.g. `QueryMind – new well`). Do the same for `databricks/append_monthly_sample.sql`
if you want the backfill.

**2. Create the job.** Go to **Workflows → Jobs → Create job** and add a task:
- **Type:** SQL → **SQL query**
- **SQL query:** the saved `new well` query
- **SQL warehouse:** your serverless `2X-Small` warehouse

**3. Schedule hourly.** Under **Schedule & triggers**, add a **Scheduled** trigger
with the cron:

```
0 0 * * * ?
```

(top of every hour). The new-well job runs forever and never future-dates.

**4. (Optional) Add the backfill.** Add a second task/job for the saved
`append_monthly_sample` query on the same hourly cron. It fills one month per run
for all wells until the series reaches today, then stops on its own.

The jobs run on the serverless warehouse, which starts on demand and stops when idle.

> Prefer fewer clicks? You can also schedule directly from the **SQL Editor**:
> open the saved query → **Schedule** → set hourly and pick the warehouse.

---

## Verify it's working

Run this in the SQL Editor (or just open the QueryMind **Dashboard** / **Schema**
pages):

```sql
SELECT MAX(month) AS latest_month,
       COUNT(*)   AS total_rows,
       COUNT(DISTINCT well_id) AS wells
FROM workspace.querymind.wells;
```

`total_rows` and `wells` increase every hour as new wells arrive; `latest_month`
climbs toward the current month (while the backfill runs) and then holds there —
it never goes past today.

> **App caching:** QueryMind caches schema/dashboard payloads server-side for a
> few minutes (`QUERYMIND_PAGE_CACHE_SEC`, default 300s). New data appears in the
> UI after that TTL, or immediately after a CSV import / app restart.

---

## How it ties into the app

- With `EXECUTOR=databricks`, every `/query`, the Dashboard, and the Schema page
  read this table live — so as the job appends data, the whole app reflects it.
- The generator is **schema-driven**: it reads field/operator/depth/production
  from existing rows, so generated rows always use values the LLM already knows
  about (the distinct categorical values injected into the prompt), keeping
  natural-language filters accurate.

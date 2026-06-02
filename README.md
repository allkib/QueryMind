# QueryMind

**Type a question in plain English, get instant analytics on your data — no SQL or PySpark required.**

QueryMind is an NL-to-analytics engine: business users ask questions like *"Show me production decline by well over the last 6 months"* and the app generates, runs, and visualizes pandas/PySpark code against oil-well production data.

| | |
|---|---|
| **Stack** | Python, Flask, Claude API, pandas → PySpark on Databricks → Azure |
| **Phase 1** | Local CSV + pandas (no cloud) |
| **Phase 2** | Databricks Delta + agentic retry loop |
| **Phase 3** | Docker + Azure App Service |

Full implementation guide, prompts, safety rules, and day-by-day checklists: **[CLAUDE.md](./CLAUDE.md)**.

---

## Phased Plan (Summary)

### Phase 1 — Local MVP (Days 1–3)

Zero cloud. Flask receives a question → Claude returns pandas code → execute on `sample_data/wells.csv` → table + Chart.js in the browser.

| Day | Deliverable |
|-----|-------------|
| 1 | Project scaffold, Claude integration, `/query` API, sandboxed pandas executor |
| 2 | UI: input, code panel (highlight.js), results table, charts |
| 3 | Error handling, 6 demo question chips, `requirements.txt` |

### Phase 2 — Databricks (Days 4–7)

| Day | Deliverable |
|-----|-------------|
| 4 | Free workspace, Delta table `wells`, PAT + SDK |
| 5 | PySpark prompts, Databricks SQL execution |
| 6 | Query history (SQLite or Firestore), sidebar |
| 7 | Agentic retry: feed execution errors back to Claude (up to 3 attempts) |

### Phase 3 — Azure (Days 8–10)

| Day | Deliverable |
|-----|-------------|
| 8 | Dockerfile + gunicorn |
| 9 | Azure App Service (F1), secrets in app settings |
| 10 | README GIF, architecture diagram, public GitHub |

---

## Quick Start (after Phase 1 is built)

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # set DUKE_API_KEY
flask run
```

Open `http://127.0.0.1:5000` and try an example question.

---

## Roadmap

| Version | Focus |
|---------|--------|
| v1 | Single-table NL → PySpark |
| v2 | Multi-table joins, schema detection |
| v3 | Scheduled email/Slack reports |
| v4 | Customer Databricks workspaces |
| v5 | RBAC + audit logs |

---

## Status

**Planning** — repository scaffold and build plan in place. Phase 1 implementation not started.

See [CLAUDE.md](./CLAUDE.md) for agents and contributors.

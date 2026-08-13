# Dashboard

Streamlit + Plotly, on-brand per spec Section 10. Business-facing "Overview" tab plus
a separate "Technical detail" tab for agent-level metrics.

## Run it

```bash
pip install -r dashboard/requirements.txt
streamlit run dashboard/app.py
```

Opens at `http://localhost:8501`.

## Data source

Reads `dashboard/data/pipeline_log.json` — generated, not hand-written, by:

```bash
node scripts/export_dashboard_data.mjs
```

That script runs `scripts/simulate_workflow.mjs`'s `execute()` against the *actual
committed* `n8n/workflows/complaint_triage_orchestrator.json`, so the dashboard is
always showing output from the real workflow graph, not a separately-maintained copy
of the pipeline logic. Re-run it any time the workflow changes; `pipeline_log.json` is
committed so the dashboard runs out of the box without that step, but it will go stale
if the workflow changes and this isn't re-run.

**Why only 3 records.** Phase 7 (the mock-to-real Claude API swap) hasn't happened —
every live ticket the Schedule/Manual trigger fetches still dead-ends at "Live Ticket
(Awaiting Phase 7)." The three Section 6 fixture tickets are the only ones with a
genuine, fully-processed pipeline decision, so that's what the dashboard shows. It does
not pad the log with invented tickets to make the charts look fuller — see the
in-app note under the KPI row, and `app.py`'s module docstring.

## KPIs: what's real, what's honestly deferred

Of Section 9's five metrics, three are computed directly from the pipeline log
(Citation accuracy, Escalation agreement, Category agreement) and two show "Awaiting
Phase 7" instead of a number (Hours saved/ticket, SLA compliance) — both require a
real, timed production run to measure honestly, which doesn't exist yet, only manual
test-harness executions. See each `kpi_*` function in `app.py` for the exact
computation and reasoning. Escalation agreement in particular is expected to read `0%`
here — see the ground-truth section of the main README before treating that as a bug.

## Swapping in a live Google Sheets read later

`app.py`'s only coupling to the local-file data source is `load_pipeline_log()`.
When storage (spec Section 11) gets wired, replacing that one function with a Sheets
read is the whole change — every KPI/chart function downstream already takes a plain
list of record dicts and doesn't know or care where they came from.

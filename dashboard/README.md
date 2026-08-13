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

**Why only 3 decided records.** Phase 7 (the mock-to-real Claude API swap) hasn't
happened — every live ticket the Schedule/Manual trigger fetches still dead-ends at
"Live Ticket (Awaiting Phase 7)." The three Section 6 fixture tickets are the only ones
with a genuine, fully-processed pipeline decision, so `records` (what every KPI/chart
reads) is just those 3. It does not pad the log with invented tickets to make the
charts look fuller — see the in-app note under the KPI row, and `app.py`'s module
docstring.

**A second array, `awaiting_records`, holds real undecided tickets, kept fully
separate.** Pull a real batch (real CFPB fetch, real synthetic CRM, capped at 25 per
spec Section 5) with:

```bash
node scripts/export_dashboard_data.mjs --live-batch
```

Without `--live-batch`, re-running the export script only regenerates `records` from
the fixtures and leaves whatever `awaiting_records` batch is already in the file alone
— it does not silently re-fetch or wipe it on every routine regen. The dashboard
renders this batch in a collapsed expander ("N real tickets fetched live, awaiting
Phase 7") right under the intro note — real company names, real issues, real dates,
zero agent output, and explicitly excluded from every KPI/chart, which read `records`
only. This was also the first time `scripts/simulate_workflow.mjs` executed the live
Schedule/Manual trigger path at all (`Get Watermark`, the real `CFPB Complaint Search`
HTTP call, `Cap Batch & Advance Watermark`) — every previous verification only ever
exercised the fixture-trigger path, so this incidentally closed a real gap in Phase 1's
own test coverage, four phases later.

## KPIs: what's real, what's honestly deferred

Of Section 9's five metrics, three are computed directly from the pipeline log
(Citation accuracy, Escalation agreement, Category agreement) and two show "Awaiting
Phase 7" instead of a number (Hours saved/ticket, SLA compliance) — both require a
real, timed production run to measure honestly, which doesn't exist yet, only manual
test-harness executions. See each `kpi_*` function in `app.py` for the exact
computation and reasoning. Escalation agreement in particular is expected to read `0%`
here — see the ground-truth section of the main README before treating that as a bug.

## Queue view: escalated vs. auto-resolved

A `st.segmented_control` ("Escalated to human" / "Auto-resolved") right below the
decision-breakdown chart switches which table renders underneath — `render_queue_table`
or the newer `render_auto_resolved_table`. Defaults to the escalated queue.

**What was tried first and dropped:** click-a-bar-to-filter, using
`st.plotly_chart(..., on_select="rerun", selection_mode="points")`. This never worked
in testing — neither a plain click nor a box-select drag ever produced a non-empty
`chart_state.selection.points`, tried with and without `clickmode="event+select"` and
`dragmode="select"` set explicitly on the figure. Bar-trace click-selection is known to
be finicky in Plotly.js, and there's no confidence this would reliably fire for a real
user's mouse either, automation or not. Rather than ship an interaction that might
silently do nothing, it was replaced with the segmented control — same practical
outcome (choose which queue to look at), a widget that's guaranteed to work. If you
want to take another run at the chart-click version, the removed code (and the debug
`st.write(chart_state)` that showed empty selections) is in the git history around this
commit.

`render_auto_resolved_table` currently always renders its "no auto-resolved tickets
yet" empty state, since none of the 3 real fixtures auto-resolve (same expected
imbalance as the KPIs) — verified against a temporary 1-escalate/1-auto-resolve test
fixture swapped into `pipeline_log.json` and back, not against real data, since no real
data with that shape exists yet.

## Before a production / client-facing launch

Right now the UI cites the spec directly in a few places — `"(spec Section 8)"`,
`"spec Phase 3"`, `"Section 6 fixture tickets"`, `"(spec Section 14)"`, `"(spec Section
3c)"` — deliberately, since during development that's the fastest way to trace an
on-screen claim back to the exact requirement it satisfies. **A real user has no reason
to know what "spec Section 8" means and it'll just read as unfinished or confusing.**
Find every instance with:

```bash
grep -n "spec Section\|spec Phase\|Section 6 fixture" dashboard/app.py
```

(Comments and docstrings can keep the references — they're for developers, not
end users. Only the strings actually inside `st.markdown`/`md_html`/`render_kpi_card`
calls need rewriting.) As of this build, the user-visible occurrences are:

- The escalation-agreement KPI's sub-label ("...directional signal, not accuracy
  (Section 8)")
- The "3 ticket(s) processed to date" note under the KPI row ("spec Phase 3", "Section
  6 fixture tickets")
- The Technical detail tab's caption ("(spec Section 10)")
- The "Other required disclosures (spec Section 14)" expander title
- The disclosure banner's text ("(spec Section 3c)")

Rewrite each in plain language that stands on its own (e.g. "directional signal, not a
certified accuracy score" instead of "(Section 8)") before this dashboard is shown to
anyone who isn't reading the spec alongside it.

## Swapping in a live Google Sheets read later

`app.py`'s only coupling to the local-file data source is `load_pipeline_log()`. The
n8n side of storage now exists (`Google Sheets: Log Decision`, see the main README's
"Storage and dedup" — still untested against a live Sheets, but structurally wired),
so once that's confirmed working, replacing this one function with a Sheets read is
the whole dashboard-side change — every KPI/chart function downstream already takes a
plain list of record dicts and doesn't know or care where they came from. Column names
in the row this dashboard would read match `scripts/build_workflow.js`'s
`flattenForSheets()` output, not `pipeline_log.json`'s current nested shape — the flat
`agent1_severity`/`agent2_citation`/etc. columns, not `agents.agent1.output.severity`
— so `load_pipeline_log()`'s replacement needs to reshape those flat columns back into
the nested form every other function in this file expects, or those functions need
updating to match. Not a large change, just not a completely free one.

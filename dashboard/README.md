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

**`records` holds every genuinely decided ticket.** As of Phase 7 (the mock-to-real
Claude API swap), that's not just the fixtures: a live ticket the Schedule/Manual
trigger fetches now flows through the real Product path (real Agent 1-4) instead of
dead-ending, so it gets a genuine decision too. It does not pad the log with invented
tickets to make the charts look fuller — see the in-app note under the KPI row, and
`app.py`'s module docstring.

**History: before Phase 7, there was a second array, `awaiting_records`, for real
tickets fetched live but not yet decided.** Early in this build, a live-fetched ticket
genuinely had nowhere to go — mock Agent 1-4 only had hand-verified answers for the
fixtures, and no real Agent existed yet to decide anything else — so
`export_dashboard_data.mjs --live-batch` fetched a real batch (real CFPB fetch, real
synthetic CRM, capped at 25 per spec Section 5) and the dashboard rendered it
separately, explicitly excluded from every KPI/chart, so undecided tickets could never
contaminate a metric. That pull was also the first time `scripts/simulate_workflow.mjs`
executed the live Schedule/Manual trigger path at all (`Get Watermark`, the real
`CFPB Complaint Search` HTTP call, `Cap Batch & Advance Watermark`) — every earlier
verification pass only ever exercised the fixture-trigger path, incidentally closing a
real gap in Phase 1's own test coverage, four phases later. Once Phase 7 shipped and
replaced the dead-end with the real Product path, a "fetched but undecided" state
became impossible to honestly produce again, so `awaiting_records` and the
`--live-batch` flag were removed rather than left as dead code pointing at a node that
no longer exists (`n8n/workflows/`'s "Live Ticket (Awaiting Phase 7)").

**Five of that first 25-ticket batch were promoted to real fixtures (Tickets D-H),
staying mock-first the whole way.** Rather than spend real Claude API credits (Phase 7
is still explicitly deferred) or invent decisions for them, five tickets were
hand-verified the same way the original three were: real CFPB taxonomy tool lookup,
real regulation-index search against this build's five cached regulations, real
deterministic synthetic CRM. `FIXTURE_TICKETS`/`FIXTURE_IDS`/`AGENT1-4_FIXTURES` in
`scripts/build_workflow.js` now hold 8 tickets, not 3. Only 1 of the 5 new tickets
(24158082) got a real regulation citation back from the tool — the other 4 genuinely
exercise the "drafts/scores without a citation" branches that were structurally wired
since Phase 3 but never taken by any fixture until now. Once these 5 IDs joined
`FIXTURE_IDS`, `Route: Fixture or Live?` automatically stopped sending them to `Live
Ticket (Awaiting Phase 7)` on the next live fetch — `awaiting_records` dropped from 25
to 20 on its own, no special-case filtering code needed. This pass also caught a real
bug: `computeGroundTruthAgreement`'s `/monetary relief/i` regex misread CFPB's distinct
"Closed with non-monetary relief" category as monetary relief (the substring is right
there) — fixed with a negative lookbehind once ticket 24157609 exercised that response
value for the first time.

**Two more (Tickets I/J) were added specifically to close the opposite gap: every
fixture through H escalates.** That pattern held up under scrutiny — deliberately
severe original fixtures (A/B/C) plus five tickets picked for having a narrative or a
notable category (D-H) both skew away from routine — but it also meant `AUTO_RESOLVE`
had never once been reached by a real, hand-verified ticket, only a synthetic
self-test placeholder. Tickets I/J (24157195, 24157240) were picked from the *rest* of
the original 25-ticket batch specifically for being unremarkable: the single most
common debt-collection sub-issue ("Debt is not yours"), no narrative, zero prior
complaints, no special-population flag, nothing that trips any of the six real
escalation signals. Same hand-verification rigor as every other fixture, just applied
to a quiet ticket instead of a notable one — and it holds: both genuinely clear Agent
4's 0.7 confidence threshold with no other signal firing, so `computeEscalationSignals`
returns `escalate: false` for real, not by construction. `FIXTURE_TICKETS` now holds 10
tickets (8 escalate, 2 auto-resolve); `awaiting_records` dropped to 18. This is also the
first time `agrees_with_ground_truth` reads `true` anywhere in the fixture set — I/J's
routine ground-truth reading actually lines up with the pipeline's own routine
decision, closing out the self-test's ground-truth loop in both directions.

Hitting exactly 10 records also caught a second small bug: the "N ticket(s) processed
to date" honesty banner was gated on `len(records) < 10`, so it silently disappeared
the moment `records` reached 10 -- an accidental boundary, not a deliberate "the sample
is big enough now" decision. Bumped to `< 50` so it doesn't flicker off at round
numbers; caught by loading the app in a browser after this batch, not by the code
compiling.

## KPIs: what's real, what's honestly deferred

All five of Section 9's metrics are now real: three computed directly from the
pipeline log on every page load (Citation accuracy, Escalation agreement, Category
agreement), and two (Hours saved/ticket, SLA compliance) from a single real timed
production run — n8n execution #240→#241, complaint 24332933, 16.829s end-to-end
against the sourced ~10 min manual baseline. See each `kpi_*` function in `app.py`
for the exact computation and reasoning, and the main README's Phase 7 section for
the full story of that run (including a Google Sheets credential failure recovered
without a second real API spend). Escalation agreement reads `17%` (2/12) as of this
build, not because the pipeline is graded against CFPB's coarse label and mostly
fails it — see the ground-truth section of the main README before treating that
number itself as meaningful beyond "directional."

## Queue view: escalated vs. auto-resolved

A `st.segmented_control` ("Escalated to human" / "Auto-resolved") switches which table
renders underneath — `render_queue_table` or `render_auto_resolved_table`. Defaults to
the escalated queue. As of Tickets I/J (above), the auto-resolved queue genuinely
renders two real rows instead of always showing its empty state.

**Re-skinned as tabs attached to the table, not a separate button group floating above
it.** The default `st.segmented_control` reads as two standalone pill buttons with a
visible gap before the table — raised as feedback since it doesn't look connected to
what it controls. Both now live inside one bordered white card
(`st.container(key="queue_card")`): the tab strip sits flush at the top on a light-grey
background, the active tab's background matches the white card body below it (so it
reads as "open"), with a navy underline for a second cue. Getting there took three real
CSS fixes against Streamlit's actual rendered DOM (inspected live, not guessed):
1. The segmented control's own element-container ships with an inline shrink-to-fit
   width rather than stretching to its parent — overridden via `.st-key-queue_view {
   width: 100% !important }`.
2. Both buttons share ONE wrapper div (not one each) as the real flex child of the
   button group, and that wrapper ships with `max-width: fit-content`, which caps it at
   its own content size and defeats `flex-grow` before it can do anything — overridden
   with `max-width: none`.
3. The button text has `white-space: nowrap; text-overflow: ellipsis` by default, which
   truncated "Escalated to human" once the tabs were forced to split width evenly —
   overridden to allow wrapping.

**Clicking a bar in the "Escalate vs. auto-resolve" chart jumps straight to its table**
— re-verified live twice before landing on this design:

1. *First attempt, dropped:* click-a-bar-to-filter via
   `st.plotly_chart(..., on_select="rerun", selection_mode="points")`. Never worked
   reliably in testing — neither a plain click nor a box-select drag ever produced a
   non-empty `chart_state.selection.points`, tried with and without
   `clickmode="event+select"` / `dragmode="select"`. Replaced with the segmented control
   above as a guaranteed-to-work fallback.
2. *Re-investigated later* (a user request specifically asked for "click bar -> jump to
   table"): re-tested the same on_select approach live with real clicks and current
   library versions. Found it *flaky*, not cleanly broken — a click sometimes registered
   a real selection point, but one click behind (only visible on the *next* rerun), and
   a click on the other bar sometimes left the state completely unchanged. That's worse
   than a clean failure: it would look like it works, then silently doesn't. Confirmed
   the original call to drop it was correct, not just untried.
3. *What's shipped instead:* two invisible `<a href="?queue_view=...#queue-section">`
   links absolutely-positioned over each bar (`decision_chart_wrap`, a keyed
   `st.container()` for CSS scoping), each pointing at a real URL query param + anchor
   — a genuine browser navigation, not a Streamlit rerun event, so it doesn't depend on
   the flaky Python-JS selection bridge at all. `main()` seeds
   `st.session_state["queue_view"]` from `st.query_params` before the segmented control
   instantiates, so a bar click and a manual toggle click drive the exact same state.
   Positioning them took a real CSS debugging pass: Streamlit wraps every element
   (including the overlay's own `st.markdown` call) in its own `position: relative,
   height: 0` container, which becomes the nearest positioned ancestor and steals the
   containing-block role before the overlay's `top`/`bottom` percentages can resolve
   against the intended wrapper — fixed with a `.stElementContainer { position: static }`
   override scoped to `decision_chart_wrap`. The anchor jump itself needed a second fix:
   the browser tries to scroll to `#queue-section` before Streamlit has finished
   rendering that element, so the native jump silently misses — a small
   `components.v1.html` snippet (the one place Streamlit actually executes injected
   `<script>` tags, since `st.markdown(unsafe_allow_html=True)` sets HTML via
   `innerHTML` and doesn't run scripts) polls for the element and calls
   `scrollIntoView()` once it exists, gated to fire only right after a query-param
   navigation, not on every rerun.

`render_auto_resolved_table` now genuinely renders two real rows (Tickets I/J above)
instead of its "no auto-resolved tickets yet" empty state. Originally verified only
against a temporary 1-escalate/1-auto-resolve test fixture swapped into
`pipeline_log.json` and back, since no real data with that shape existed yet; that gap
is now closed with real, hand-verified tickets.

## Retrieval grounding: badges and the footnote

Real regulation retrieval (Phase 9's restructure — see the main README) exists in
exactly 5 of this build's 17 real records: the 12 that predate it (10 fixtures plus two
earlier real, non-fixture tickets — SoFi 24246633, CITIBANK 24332933) were decided
before retrieval ran at all, so they carry no candidate data and no grounding verdict.
The Retrieval column (`retrieval_badge_html`) reads that absence honestly rather than
guessing: no semantic *and* no lexical candidate on record means "No retrieval used," a
distinct state from every other badge, not a blank cell.

For the 5 tickets that did go through retrieval, the badge reports whether Agent 2's
citation is grounded in what retrieval actually surfaced, not whether the two search
strategies agreed with each other — **Grounded** (citation matches a retrieved
candidate), **No regulation applies** (Agent 2 judged none of the candidates fit),
**Flagged** (Agent 2 cited something neither tool surfaced or explicitly outside the
cached corpus, auto-escalated rather than shipped unverified), or a defensive **Not
verified** fallback for a citation that somehow never got a grounding check at all
(currently unreachable — every real Product-path ticket has one). Of the 5: 1
(25183526) got **No regulation applies** — both retrieval tools surfaced Reg Z
§1026.13, and Agent 2 correctly declined to cite it, since nothing in the record shows
a formal billing-error dispute (see "Verified against one real execution" in the main
README's Phase 9 section); the other 4 (25210852, 25184341, 25183345, 25183930) are
**Flagged**. None are currently **Grounded** — this pilot's still-small reference
corpus hasn't yet produced a Product-path ticket where a real citation matches what
retrieval surfaced. The footnote above the queue
(`build_retrieval_grounding_footnote_html`) reports the same split in one sentence
(0 grounded, 4 flagged, 1 declined), scoped to just these 5 real tickets, and
deliberately doesn't lead with that "0" — see the messaging fix below for why that
mattered.

**Two real bugs found by asking a direct question about one ticket, not by test
coverage.** Asked why 25184341 showed as "Grounded" when lexical and semantic
retrieval had drawn two different conclusions, two independent defects turned up in
the same data path:
1. `retrieval_badge_html` treated "grounding was never checked"
   (`outside_cached_corpus` and `citation_not_in_retrieval` both `null`) the same as
   "checked and clean," defaulting straight to "Grounded." Fixed by adding the
   explicit "Not verified" branch above.
2. `dashboard/sheets_source.py`'s live-fetch path — the code actually serving the
   deployed dashboard — never mapped `agent2_outside_cached_corpus`,
   `agent2_citation_not_in_retrieval`, `escalate_outside_cached_corpus`, or
   `escalate_citation_ungrounded` out of the raw Sheet row at all, regardless of what
   was genuinely stored there. `scripts/export_dashboard_data.mjs`'s equivalent
   `reshapeSheetRow()` had these mapped correctly — the two reshaping
   implementations had quietly drifted apart. Both bugs meant the same four flagged
   tickets displayed as falsely verified wherever the live Sheet was actually read
   from; the static snapshot path happened to mask bug 2, since it was regenerated
   (and thus correctly reshaped) less often than the live dashboard was viewed.

**Backfilled the 4 historical rows that predated grounding, rather than leaving them
null forever.** Those four flagged tickets' `citation_not_in_retrieval` field had
genuinely never been computed and written — not lost, just never run. Recomputed with
the exact same `isCitationGroundedInRetrieval()` formula the live pipeline uses
(verified against each ticket's real stored candidate JSON in a standalone script
first) and wrote `TRUE` directly to the real Sheet's `agent2_citation_not_in_retrieval`
and `escalate_citation_ungrounded` columns for all four. `outside_cached_corpus` was
deliberately left blank for these four — it's Agent 2's own self-report from the
original run, and there's no honest way to reconstruct after the fact what Agent 2
itself did or didn't flag.

**"Phase 7" / "Phase 9" are internal build vocabulary now kept off every user-facing
dashboard string**, including badge tooltips, the column caption, and the footnote —
this dashboard's actual reader is a business/compliance reviewer with no reason to know
what those numbers mean, and prior copy that used them read as confusing rather than
informative. The terms are still fine in code comments, docstrings, and the main
README, since those readers are developers.

## Category filter

A "Filter by product category" `st.multiselect` sits above the two Overview charts and
cascades to everything data-dependent on both tabs: the 5 KPI cards, the "Escalate vs.
auto-resolve" chart, the Overview queue table, both Technical detail charts, the raw
pipeline log, and the Technical detail tab's own label (`"Technical detail (Credit
card)"` once a filter is active — empty selection falls back to "all", matching the tab
label back to plain `"Technical detail"`). `main()` computes `filtered_records` once,
before `st.tabs()` runs, and every downstream KPI/chart/table call takes that instead of
the raw `records` list.

**Why a dropdown instead of clicking the donut chart directly:** that was the original
ask, tested and ruled out first. `st.plotly_chart(chart_category_breakdown(records),
on_select="rerun", selection_mode="points")` was wired up and clicked live — 0 of 5 real
slice clicks registered a selection, worse than the bar chart's already-flaky results
(see "Queue view" above). Legend clicks are worse than flaky: they're structurally
incapable of reaching Python at all. Clicking a Plotly legend entry only toggles that
trace's client-side visibility (the "double-click to isolate" tooltip is native
Plotly.js), which Streamlit's `on_select` never observes — confirmed live, the debug
selection state stayed empty even while the chart visibly changed. A first pass shipped
color-matched pill buttons (one per category, toggling membership in a
`st.session_state` set) as a reliable alternative; replaced with `st.multiselect` on
follow-up feedback, since Streamlit's own removable-tag rendering already gives the same
"see what's selected, click an × to remove" affordance without hand-rolling chip CSS.

**The donut chart itself stays built from the unfiltered `records`, with only the
selected slice(s) at full color and the rest dimmed to `LIGHT_GREY`** — it's the filter
control's own visual echo, so it shows the whole picture with the current selection
highlighted, not a recomputed subset (recomputing it would make a single-category
selection always render as a trivial 100% donut, which is correct but useless as a
filter UI).

**Two real Streamlit-internal CSS issues surfaced building this, unrelated to the filter
logic itself:**
- The empty-state message ("No results") that Streamlit's multiselect dropdown shows
  when every option is already selected reads as clutter here, since there's never
  anything meaningful left to add with only two categories — hidden globally via
  `[data-testid="stSelectboxVirtualDropdownEmpty"] { display: none }`.
- The 5 KPI cards didn't align to equal height despite `.kpi-card { height: 100% }` —
  measured live at 126px-197px depending on each card's sub-label line count. The chain
  from `st.columns()`'s flex row down to `.kpi-card` passes through an unnamed
  Streamlit-internal centering `<div>` (`display: flex; align-items: center`, no
  `data-testid`) that doesn't propagate the stretched height down to its child, so
  `height: 100%` resolves against a shrink-wrapped ancestor instead of the row's tallest
  card. Fixed with a `min-height: 200px` floor sized to the longest current sub-label
  (Escalation agreement's four-line text) — simpler and more robust than chasing
  undocumented internal DOM structure to fix the propagation itself.

## Before a production / client-facing launch

Right now the UI cites the spec directly in a few places — `"(spec Section 8)"`,
`"spec Phase 3"`, `"(spec Section 14)"`, `"(spec Section 3c)"` — deliberately, since
during development that's the fastest way to trace an on-screen claim back to the exact
requirement it satisfies. **A real user has no reason to know what "spec Section 8"
means and it'll just read as unfinished or confusing.** Find every instance with:

```bash
grep -n "spec Section\|spec Phase" dashboard/app.py
```

(Comments and docstrings can keep the references — they're for developers, not
end users. Only the strings actually inside `st.markdown`/`md_html`/`render_kpi_card`
calls need rewriting.) As of this build, the user-visible occurrences are:

- The escalation-agreement KPI's sub-label ("...directional signal, not accuracy
  (Section 8)")
- The "N ticket(s) processed to date" note under the KPI row ("spec Phase 3")
- The Technical detail tab's caption ("(spec Section 10)")
- The "Other required disclosures (spec Section 14)" expander title
- The disclosure banner's text ("(spec Section 3c)")

Rewrite each in plain language that stands on its own (e.g. "directional signal, not a
certified accuracy score" instead of "(Section 8)") before this dashboard is shown to
anyone who isn't reading the spec alongside it.

## Sourcing `records` from the real Google Sheet

`app.py` itself is unchanged from the local-file design: its only coupling to the data
source is `load_pipeline_log()`, which just reads `dashboard/data/pipeline_log.json` —
every KPI/chart function downstream takes a plain list of record dicts and doesn't know
or care where they came from. What changed is how that JSON file gets generated.

`scripts/export_dashboard_data.mjs --from-sheets` reads
`dashboard/data/sheets_snapshot.json` — a point-in-time snapshot of what's genuinely
stored in the real "Pipeline Log" Google Sheet, fetched via an authenticated Sheets API
read — and reshapes each flat row (`agent1_severity`, `agent2_citation`, etc., matching
`scripts/build_workflow.js`'s `flattenForSheets()` output exactly) back into the nested
shape (`agents.agent1.output.severity`, etc.) every function in this file expects. See
`reshapeSheetRow()` in that script for the transform, including two disclosed inference
rules for fields the flat schema doesn't store at all (`agent3`/`agent4` `tool_used`,
`agent3.tool_result.found` — reconstructed from a verified architectural invariant, not
guessed; the function's own comment explains why it's provably correct).

This is a real, working data path, verified live in the dashboard. `sheets_snapshot.json`
and this script remain the fallback path: the deployed dashboard now reads the real
Sheet live, on every page load, via a dedicated OAuth 2.0 credential
(`dashboard/sheets_source.py`, cached 5 minutes) — falling back to this static snapshot
only when no credential is configured or the live call fails. See the main README's
"Live dashboard data source" section for the full mechanism, including why a service
account wasn't an option (the Google Cloud org this project runs under enforces
`iam.disableServiceAccountKeyCreation`) and the scope tradeoff that comes with OAuth
instead.

Consequence worth knowing: the real Sheet only ever contains whatever has actually been
written to it by a genuine n8n execution or direct write — as of this build, that's the
10 fixture tickets, two further real non-fixture tickets from before the Phase 9
retrieval restructure (SoFi, complaint 24246633; CITIBANK, complaint 24332933), and five
real Product-path tickets decided after that restructure shipped (25183526, 25210852,
25184341, 25183345, 25183930) — so `--from-sheets` now produces `n=17` against the
simulator-driven default's `n=10`. Both stay real in their own way: the simulator proves
the pipeline *logic*, `--from-sheets` (and now the live read) prove the *storage* layer,
and neither one is padded or fabricated — the ten fixtures agree with the simulator's
own decisions exactly, and the other seven simply don't exist in the simulator's fixture
set at all. See "Retrieval grounding: badges and the footnote" below for what
distinguishes the last five from the first twelve.

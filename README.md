# Complaint Triage Orchestrator (S2.3)

A workflow automation + multi-agent AI orchestration pilot: real CFPB complaint data,
real federal regulation text, a disclosed synthetic CRM layer, and four genuine
conditional-tool-use LLM agents (n8n native AI/LLM agent nodes) feeding a deterministic
escalation gate. Full spec: `../Docs/Complaint_Triage_Orchestrator_Spec.md`.

**Status: Phase 5 of 7 complete.** See Section 15 of the spec for the full phase list.
(Phase 4's escalation gate was built during Phase 3 — see that section below.)

## Field-claim verification pass (Section 3a/3b, post-v8)

Requested after the disputed-flag finding (Phase 5) surfaced a real inaccuracy in the
spec: rather than assume the rest of Section 3a/3b's factual claims were solid because
two errors had already turned up through separate paths, every checkable field claim
was re-verified directly against live sources.

- **Tickets A (9999970) and B (9999975):** every field in Section 3a's table — product,
  sub-product, issue, sub-issue, company, state, tags, date received, timely, company
  response — confirmed to match the live record exactly, via direct complaint-record
  lookup (not aggregation sampling).
- **Ticket C (9999983):** confirmed real and matching, after an initial false negative.
  A broad, unscoped search across all of 2024-09-03's ~11,000 complaints didn't surface
  it — but that search relied on Elasticsearch `frm`/`size` pagination sorted on
  `created_date_asc`, a field with many tied timestamps across a huge result set, which
  is a known way to non-deterministically skip records during paging. A tightly-scoped
  query (product + company + narrow date range, small enough to return in one page, no
  pagination risk) found it immediately, exact match on every field except one: Section
  3a's table says sub-product `"General-purpose credit card"`; the live record says
  `"General-purpose credit card or charge card"` — Section 3a's version was truncated.
  Fixed in this repo's fixture data (`scripts/build_workflow.js`); worth a look if you
  want to correct Section 3a's table too. Surfacing this near-miss rather than quietly
  discarding the failed search: the methodology error was caught and corrected before
  being reported, not after.
- **Fixture precision:** while verifying, also updated all three fixtures'
  `date_received` from a midnight placeholder to the real live timestamps
  (`2024-09-03T22:24:41Z` / `22:28:25Z` / `22:07:34Z`) — doesn't change any escalation
  logic (still the same calendar date), just tightens fidelity to the real record now
  that it's directly confirmed.
- **Section 3b's five regulation citations/topics:** all confirmed exact matches
  against `reference_data/regulations/*.json`'s `_meta` blocks — no drift.
- **One documentation gap, not a data error:** Section 3b names eCFR as Regulation Z's
  source; Phase 1 actually used Cornell LII's CFR mirror because eCFR's direct URL
  blocked automated access. The regulatory *text* was already independently verified
  against the real statute in Phase 1 — only the source *label* had drifted from what
  was actually fetched. Documented in
  [`reference_data/README.md`](reference_data/README.md).

The Section 6 taxonomy-sibling discrepancy flagged in Phase 1 remains open in the spec
as of v8 (unrelated to this pass, which was scoped to 3a/3b) — still tracked in
[`reference_data/README.md`](reference_data/README.md).

## Phase 1 — access, trigger, reference data

- [`n8n/workflows/complaint_triage_orchestrator.json`](n8n/workflows/complaint_triage_orchestrator.json)
  — dual trigger (Schedule every 15 min + Manual), watermark-based fetch against the
  live CFPB Consumer Complaint Database API, capped at 25 complaints/run, scoped to the
  pilot's two products (Debt collection, Credit card).
- [`reference_data/taxonomy/cfpb_taxonomy.json`](reference_data/taxonomy/cfpb_taxonomy.json)
  — the CFPB's own product/issue/sub-issue tree, scoped to the pilot, pulled live and
  cached. Backs Agent 1's taxonomy lookup tool (spec Section 6).
- [`reference_data/regulations/`](reference_data/regulations/) — five static reference
  files with verbatim federal statute/regulation text (FDCPA §1692g, §1692e; FCRA
  §1681c-2; Regulation Z §1026.13; CFPB's 15-day company-response rule), sourced from
  Cornell LII and CFPB directly (spec Section 3b).
- [`scripts/fetch_taxonomy.py`](scripts/fetch_taxonomy.py),
  [`scripts/fetch_regulations.py`](scripts/fetch_regulations.py) — the sourcing scripts
  that generated the two reference-data sets above. Both hit public, unauthenticated
  endpoints (no API key anywhere in this project) and are safe to re-run to refresh a
  cached snapshot.

**Read [`reference_data/README.md`](reference_data/README.md) before Phase 2** — it
documents a real discrepancy found between the spec's Section 6 taxonomy claim and the
live CFPB data pulled during this phase.

### Workflow logic, as built

1. **Schedule Trigger** (15 min) or **Manual Trigger** → both feed **Get Watermark**.
2. **Get Watermark** (Code node) reads `lastWatermarkDate` from n8n workflow static
   data. First run only: falls back to `today − 30 days`, not `today − 1 day` — CFPB
   only publishes a complaint once the company has responded or 15 days have passed
   (the 15-day rule itself, cached in this same phase), so a 1-day lookback would
   mostly return nothing on a fresh workflow.
3. **CFPB Complaint Search** (HTTP Request) — `GET` against
   `consumerfinance.gov/data-research/consumer-complaints/search/api/v1/` with
   `product=Debt collection`, `product=Credit card` (confirmed live: repeated params
   OR, not the last one winning), `date_received_min=<watermark>`, `size=25`,
   `sort=created_date_asc`, `no_aggs=true`.
4. **Cap Batch & Advance Watermark** (Code node) — defensive second cap at 25,
   flattens each Elasticsearch hit down to the spec's Section 3a fields, and advances
   `lastWatermarkDate` to the latest `date_received` actually seen.

Phase 1 stops at step 4's output: a capped, flattened batch of tickets.

5. **Generate Synthetic CRM Record** (Code node) — adds a `crm` object per ticket per
   the Section 3c schema. Deterministic: seeded from `complaint_id` (mulberry32 PRNG),
   so re-processing the same ticket always yields the same synthetic record instead of
   a new random one each run — important given the watermark overlap noted below can
   legitimately hand the same ticket to this node more than once. Every `crm` field is
   synthetic **except** `linked_complaint_id` (the real CFPB complaint ID) and
   `servicemember_flag` / `special_population_flag`, which carry forward CFPB's own
   real `tags` field where present (`"Servicemember"`, `"Older American"`, or both) —
   the hybrid rule from spec Section 3c/12. No agents, no escalation gate, no storage
   yet — those are Phases 3–7.

### Phase 2 design note: the generator vs. the Section 6 fixtures

This generator produces synthetic data for whatever real tickets Phase 1 fetches live
— it does **not** try to reproduce the exact CRM values in spec Section 6's worked
Ticket A/B/C table (tenure 6/1/3yrs, 1/1/2 products, $2,340/$0/$0 balance). Those three
are fixed fixtures for Phase 3's mock-agent testing, from a fixed historical CFPB
snapshot (complaint IDs in the 9999970s) that a live poll today won't encounter — Phase
3 will hardcode them directly rather than asking this generator to special-case three
IDs. Same schema either way, so the fixtures stay a drop-in match for what production
data will actually look like once the mock-to-real swap happens (Section 15 Phase 7).

`special_population_flag` folds in the Servicemember tag, not just Older American —
confirmed as intended in spec v5, which also formalizes the consequence: Agent 2's CRM
lookup tool (Phase 3, not yet built) must always populate `special_population_flag` on
every ticket regardless of whether the broader CRM-context lookup (tenure, balance,
prior-complaint history) runs. Nothing changes here in Phase 2 — this generator already
computes the flag unconditionally on every synthetic CRM record, independent of any
downstream agent's decision to use the rest of the record. What v5 adds is a Phase 3
requirement: Agent 2's tool interface and output schema need to expose the flag on its
own (`special_population_flag: bool`, not folded into free-text `customer_context`),
separately from the discretionary broader lookup — see spec Section 6's structured
hand-off schema and the twelve updated fixtures.

### A build-time finding worth flagging before Phase 2

CFPB's `date_received_min` filter only accepts date granularity (`YYYY-MM-DD`) — the
live API rejects sub-day timestamps (confirmed by testing, not assumed). That means a
same-day poll can legitimately re-return complaints already fetched earlier that day.
This workflow does **not** dedup — by design, per spec Section 11, dedup-by-complaint-ID
belongs to the storage layer (Google Sheets Append-or-Update), which isn't wired until a
later phase. Whichever phase wires Google Sheets needs to actually implement that dedup;
it's load-bearing, not a nice-to-have, given this watermark behavior.

### How to import into n8n

1. In n8n: **Workflows → Import from File** → select
   `n8n/workflows/complaint_triage_orchestrator.json`.
2. No credentials required — the CFPB API is public and unauthenticated.
3. Run **Manual Trigger** once to test end-to-end before activating the schedule.

### Verified during this phase, against the live API (not assumed from docs)

- Base endpoint returns Elasticsearch-shaped JSON directly (no `/complaints` sub-path).
- Repeated `product=` query params act as an OR filter, not last-value-wins.
- `date_received_min` requires `YYYY-MM-DD`; sub-day timestamps 400.
- `no_aggs=true` drops the (large) `aggregations` block from the response.
- `issue` → `sub_issue.raw` nested aggregation buckets exist and are un-truncated for
  the pilot's two products (confirmed `sum_other_doc_count: 0`), so the cached taxonomy
  file is complete, not a sample.

## Phase 3 — four agents, mock-first, plus the escalation gate

Spec Section 15 groups the escalation gate into the same Phase 3 verification pass as
the agents ("Build and debug the full orchestration, tool-use branching, and escalation
gate against known-good fixture data") — you can't validate end-to-end orchestration
without it, so it's built here rather than held back for Phase 4. Flagging that
explicitly rather than quietly declaring Phase 4 done without saying so.

**How this is built, and why:** every Code node's logic is a real, tested JS function
defined once in [`scripts/build_workflow.js`](scripts/build_workflow.js), unit-tested
against the three spec fixtures (plus a negative control) in that same script's
self-test section, then embedded into the n8n workflow JSON via
`Function.prototype.toString()`. The code that's tested and the code that ships inside
the workflow are byte-identical — no hand-retyping into a JSON string, no risk of the
two drifting apart. The script refuses to write the workflow file if any assertion
fails. Re-run it any time with:

```bash
node scripts/build_workflow.js
```

It owns and idempotently regenerates every Phase 3 node/connection; Phase 1/2 nodes are
left untouched.

**Verification beyond the self-test:** [`scripts/simulate_workflow.mjs`](scripts/simulate_workflow.mjs)
is a minimal n8n execution simulator — it loads the *committed* workflow JSON and
executes it node-by-node following its actual `connections` graph, including real
IF-node branching, exactly as n8n would. This proves the exported file itself works,
not just the generator's in-memory logic. Run it with:

```bash
node scripts/simulate_workflow.mjs
```

All three fixtures reach the real escalation-gate IF node and escalate; a non-fixture
ticket correctly dead-ends instead of fabricating a decision; Ticket A's Agent 3/4 tool
calls independently pulled the real, matching §1692g(b) verbatim text from the cached
regulation corpus; Ticket C's Agent 1 taxonomy tool call reproduced the exact Phase 1
finding live (confirms the real sub-issue, and its siblings do **not** include an
"identity theft or fraud" entry).

### Architecture

**Fixture test harness** (new): a second Manual Trigger, `Fixture Test Trigger (A/B/C)`,
feeds the three literal Section 3a/3c tickets — bypassing the live CFPB fetch and
random CRM generation — into `Route: Fixture or Live?` → `IF: Is Fixture Ticket?`, the
same gate the live pipeline's output passes through. Phase 3's mock agents only have
known-good fixture data for Tickets A/B/C; anything else (i.e. every live ticket Phase
1 actually fetches) routes to `Live Ticket (Awaiting Phase 7)` — a clearly-labelled
dead end — rather than fabricating a result. **This means the live Schedule/Manual
trigger path doesn't produce real triage decisions yet; only the fixture path is fully
exercised until Phase 7's Claude API swap.**

**Per agent, the same repeating shape:** `Agent N: Mock Decision` (Code node — the
mocked reasoning layer, keyed by `complaint_id` against the exact Section 6/v5 fixture
outputs) → `IF: Agent N Tool Used?` → the real tool, when the fixture says the agent
used it, or a direct pass-through when it didn't. Every tool actually runs against the
real cached reference data (Phase 1) and the real synthetic CRM record (Phase 2) — only
the reasoning/decision layer is mocked, not the tools. That conditional branching is a
real IF node on the n8n canvas for each agent, not logic buried inside one opaque Code
node, since the spec calls that conditionality "the actual point of the build."

| Agent | Tool(s) | Real tool logic |
|---|---|---|
| 1 Classification | CFPB taxonomy lookup | Searches both issue- and sub-issue-level names in the cached taxonomy; returns real siblings |
| 2 Research | Special-population check (**always**, spec v5) + regulation-index search (**always**) + broader CRM context (discretionary) | Special-population: direct deterministic CRM read. Regulation index: keyword + light synonym search across the five regulations' cached topics — not semantic search, see limitation below. Broader CRM: raw tenure/tier/holdings/balance/prior-complaints pull |
| 3 Drafting | Exact regulation clause fetch | Parses a citation like `15 U.S.C. §1692g(b)`, extracts just that lettered subsection from the cached verbatim text |
| 4 QA/scoring | Re-verify clause + CRM fact | Re-runs the same clause-fetch independently, plus re-reads the raw CRM field Agent 2's `customer_context` referenced — catches drift between a draft's paraphrase and the actual record |

**Escalation gate:** `Compute Escalation Signals` (Code node — the deterministic
Section 7 compound-OR logic, explicitly *not* a fifth agent call, over the four agents'
already-produced structured outputs) → `IF: Escalate?` → `Final: Escalate to Human
Queue` or `Final: Auto-Resolve`. Both final nodes retain every agent's mocked output
*and* the real tool-call result alongside it, so a reviewer can cross-check what the
mock claimed against what the real cached data actually says — most of Phase 3's
audit value lives in that side-by-side, not in the mocked reasoning itself.

### The two interpretation calls — resolved in spec v6/v7, implementation updated to match

1. **"Stated monetary exposure exceeds $500" — narrative-extracted only, `crm.outstanding_balance_usd` excluded (v7).**
   The Phase 3 build originally read this as `crm.outstanding_balance_usd`; rejected.
   Reason: balance already has its own independent trigger via `isHighValueAccount`
   (`outstanding_balance_usd ≥ $10,000`), so reusing the same field here would
   double-count one number under two labels. `Compute Escalation Signals` now runs a
   best-effort dollar-figure regex (`\$\s?[\d,]+(?:\.\d{1,2})?`) against
   `complaint_what_happened` and takes the largest match; if the narrative states no
   amount, this condition simply doesn't fire — the ticket still has four other
   independent escalation paths. None of the three fixture narratives state a dollar
   figure, so `exceedsMonetaryThreshold` is `false` for all three post-fix — Ticket A
   now escalates on `requires_human` alone, matching the spec's own per-ticket
   annotation exactly (previously the CRM-balance interpretation added an extra,
   spec-uncited reason). A positive control (`"$750 that I never authorized"` on an
   otherwise clean ticket) and a negative control (a clean ticket with a **$9,000 CRM
   balance**, confirming that balance no longer leaks into this trigger) are both in
   the self-test.
2. **"High-risk issue type" — explicit list drawn from the real cached taxonomy, plus a citation marker (v6).**
   Replaced the original loose keyword-substring match (`"fraud"`, `"threat"`,
   `"elder"`, ...) with `HIGH_RISK_ISSUES`, an explicit set of real issue/sub-issue
   strings pulled directly from `reference_data/taxonomy/cfpb_taxonomy.json` —
   FDCPA threat/harassment sub-issues (e.g. `"Threatened to arrest you or take you to
   jail if you do not pay"`, `"Used obscene, profane, or other abusive language"`) and
   identity-theft issues/sub-issues (`"Identity theft / Fraud / Embezzlement"`, `"Debt
   was result of identity theft"`). Checked only against Agent 1's classified
   issue/sub_issue value — never the raw narrative — per spec Section 7's explicit
   instruction not to repeat Ticket C's original failure mode of pattern-matching
   surface wording instead of trusting the structured classification. Tickets B and C
   don't actually match this list by issue text (their classified issues are
   `"Attempts to collect debt not owed"` and `"Card opened without my consent or
   knowledge"`, neither of which is itself taxonomy-labelled as identity-theft) — they
   trigger instead via `HIGH_RISK_CITATION_MARKERS` (`"1681c-2"`, FCRA's identity-theft
   block procedure citation), the "and/or Agent 2's citation" half of the spec's rule.
   A positive control confirms the issue-list path independently (a threat-issue
   ticket with an unrelated citation still trips `isHighRiskIssue`).

### The regulation-index tool: a real, acknowledged limitation — now partially mitigated (v6)

Agent 2's "always used" regulation search is keyword + synonym, not real semantic
search — confirmed as a genuine limitation, not a false alarm. Two responses, both
implemented:

- **Phrase-level synonym seeding from the fixtures' own language.** The original
  single-token synonym map couldn't handle short/contraction-heavy phrases like `"not
  mine"` or `"don't recognize"` (splitting on `'` shreds `"don't"` into `"don"` + `"t"`,
  both too short to match). `REGULATION_SEARCH_PHRASE_SYNONYMS` now does substring
  phrase matching instead: `"fraudulent"` / `"not mine"` / `"don't recognize"` /
  `"identity theft"` / `"unauthorized"` → adds `identity-theft`; `"didn't receive"` /
  `"never got"` / `"no notice"` / `"without notice"` → adds `validation`. Seeded
  directly from spec Section 9's examples, not invented in the abstract.
- **Documented, not smoothed over.** The tool remains lexical; a real Claude-backed
  tool call at Phase 7 would do this better without a bespoke phrase table. Per spec
  v6, the Phase 6 dashboard's citation-accuracy metric will need the explicit caveat
  that its ceiling is bounded by this tool's vocabulary coverage, not purely by agent
  reasoning quality — noted here for whichever phase builds that metric, since Phase 3
  doesn't reach the dashboard.

### Untested branches — consolidated into one Phase 7 checklist, with cause traced (v6)

Three branches share one root cause, now stated as a single checklist rather than
three separate notes: **the Ticket C compound-issue fix (spec Section 6) is what
removed the fixtures' only examples of Agent 3 and Agent 4 skipping their tools** — the
original, incorrect version of Ticket C didn't cite a regulation; correcting it gave
Ticket C a citation too, which is correct for Ticket C's classification but had the
side effect of eliminating the only fixture that exercised those two `false` branches.
Confirm all three against a real ticket at Phase 7, not just against A/B/C:

- Agent 2's broader CRM-context lookup being skipped (only the always-on
  `special_population_flag` check is guaranteed across all three fixtures).
- Agent 3 drafting without citing a regulation.
- Agent 4 scoring without verifying a claim.

All three are structurally present and correctly wired in the workflow (`IF: Agent 2/3/4
Tool Used?`'s `false` output each routes correctly) — they're just never taken by the
current fixture set.

### How to run

1. Import [`n8n/workflows/complaint_triage_orchestrator.json`](n8n/workflows/complaint_triage_orchestrator.json)
   into n8n (Workflows → Import from File) — no credentials needed.
2. Run **Fixture Test Trigger (A/B/C)** manually. All three items should reach `Final:
   Escalate to Human Queue`.
3. Running **Manual Trigger** (the live path) will currently route everything to `Live
   Ticket (Awaiting Phase 7)` unless a fetched complaint_id happens to be one of the
   three fixtures (it won't be — those are a historical snapshot).

## Phase 5 — ground-truth comparison

Spec Section 8 defines the methodology; Section 15 Phase 5 asks to "pull CFPB's own
outcome fields, log pipeline decisions alongside them." A new node, `Compute
Ground-Truth Agreement`, sits between `Compute Escalation Signals` and `IF: Escalate?`
and attaches a `ground_truth` block to every final record (both escalate and
auto-resolve paths).

### A build-time finding worth flagging: the "disputed flag" doesn't exist

Section 8 names three CFPB outcome fields to compare against: company response
category, timely flag, disputed flag. Live API inspection during this phase (fetching
real complaint records and printing every field, not assuming from the spec text)
confirms the third one **does not exist** — CFPB discontinued the "Consumer disputed?"
field from the public Consumer Complaint Database API some years back. A live record
has exactly: `company_response`, `timely`, plus the ticket fields already in Section
3a. No `disputed` or `consumer_disputed` key anywhere in the schema, and it doesn't
appear in the aggregation buckets either (checked during Phase 1's taxonomy work).

`ground_truth.cfpb_disputed_flag` is set to an explicit `"unavailable — CFPB
discontinued this field from the public API"` string on every record — reported as
missing, not silently dropped or worked around with a fabricated substitute.

### The comparison methodology, built from what's actually available

With only two of the three named fields real, `computeGroundTruthAgreement` uses a
deliberately coarse directional proxy — consistent with Section 8's own instruction
that this must be reported as "X% agreement," never accuracy:

- **`timely === "No"`** → the company missed CFPB's own 15-day response standard — a
  real signal the case likely needed more than routine handling.
- **`company_response` mentions "monetary relief"** → CFPB confirms the company paid
  the consumer something — a real signal the complaint had substance.
- Anything else (`"Closed with explanation"` + timely) reads as **`"routine"`**.

`agrees_with_ground_truth` is true when an `"elevated"` reading pairs with
`ESCALATE_TO_HUMAN`, or a `"routine"` reading pairs with `AUTO_RESOLVE`.

### A finding worth sitting with, not smoothing over

All three fixtures share `company_response: "Closed with explanation"` and
`timely: "Yes"` — both read as `"routine"` under this proxy. All three pipeline
decisions are `ESCALATE_TO_HUMAN`. **So `agrees_with_ground_truth` is `false` for all
three fixtures.** This is asserted explicitly in the self-test (not just tolerated) —
a future change that silently flips it to `true` should be treated as a regression to
investigate, not a fix to celebrate.

This isn't the pipeline being wrong. It's a direct demonstration of exactly why Section
8 insists on "directional signal, never accuracy": CFPB's own outcome-category field is
a coarse administrative label (essentially "the company closed the case and gave an
explanation," true of the overwhelming majority of complaints regardless of severity),
while the pipeline's escalation decision draws on the narrative, the real regulation
text, and the CRM record. A real pilot run's aggregate agreement rate (once storage
accumulates enough tickets to be meaningful — not yet wired, see Phase 1's dedup note)
should be read as "how often does CFPB's coarse label happen to line up with a
richer decision," not as ground truth the pipeline is being graded against.

### Testing

Positive controls confirm the proxy actually discriminates: an untimely response
correctly reads `"elevated"` and agrees with an escalate decision; `"Closed with
monetary relief"` correctly reads `"elevated"`; a routine outcome paired with
auto-resolve correctly agrees. All covered in `scripts/build_workflow.js`'s self-test
and re-verified end-to-end against the committed workflow JSON by
`scripts/simulate_workflow.mjs`.

## Not yet built (Phases 6–7)

Streamlit + Plotly dashboard · verification, including the mock-to-real Claude API
swap (Phase 7) and the storage/dedup layer flagged in Phase 1. The dashboard (Phase 6)
is also where an aggregate "% agreement" rollup across accumulated tickets would live,
once storage exists to accumulate them.

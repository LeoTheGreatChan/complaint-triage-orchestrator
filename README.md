# Complaint Triage Orchestrator (S2.3)

A workflow automation + multi-agent AI orchestration pilot: real CFPB complaint data,
real federal regulation text, a disclosed synthetic CRM layer, and four genuine
conditional-tool-use LLM agents (n8n native AI/LLM agent nodes) feeding a deterministic
escalation gate. Full spec: `../Docs/Complaint_Triage_Orchestrator_Spec.md`.

**Status: Phase 3 of 7 complete.** See Section 15 of the spec for the full phase list.

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

### Two interpretation calls made building the gate — worth confirming against intent

Spec Section 7 names five OR conditions but doesn't pin down two of them to specific
data fields:

1. **"Stated monetary exposure exceeds $500"** is read as `crm.outstanding_balance_usd`
   — the only concrete dollar figure the pipeline has in structured form, rather than
   parsing the free-text narrative for a dollar amount (which would need an LLM, not a
   deterministic IF-node, contradicting the "not a fifth agent call" requirement).
   Ticket A ($2,340 balance) hits this threshold on top of `requires_human`/low
   confidence, which is consistent with the spec's own note that none of the three
   trigger the *high-value* path specifically — it doesn't say none trigger monetary
   exposure.
2. **"High-risk issue type"** is detected via keyword match against Agent 1's classified
   issue text and Agent 2's regulation citation, plus a direct check for the FCRA
   §1681c-2 citation itself as a high-risk marker (since that section *is* the
   identity-theft block procedure) — not a fresh re-read of the narrative.

### An honest limitation: the regulation-index tool is lexical, not semantic

Agent 2's "always used" regulation search is keyword + a small hand-written synonym map
(`fraud`/`fraudulent`/`identity`/`theft`/`unauthorized` → `identity-theft`, etc.), not
real semantic search. Without the synonym step it doesn't reliably surface FCRA
§1681c-2 from narrative language like "believed fraudulent" — the topic string itself
says "Identity-theft block procedure," not "fraudulent." Documented rather than
smoothed over: a real Claude-backed tool call at Phase 7 would do this better without
a bespoke synonym table.

### Known untested branches — same honesty standard as the spec's own flagged gap

Spec v5 itself flags that all three worked tickets warrant Agent 2's broader CRM
lookup, so no fixture exercises the "flag checked, broader lookup skipped" case
(Section 6, "One honest gap"). Building on that same standard: **Agent 3's and Agent
4's tool-skip branches are equally untested** here — all three fixtures cite a
regulation and make a checkable claim, so the `false` output of `IF: Agent 3/4 Tool
Used?` is structurally present in the workflow (and will work correctly, per its own
logic) but never exercised end-to-end by the current fixture set. Same Phase 7
verification item as the spec's own flagged gap — worth testing against a real ticket
that doesn't hit these paths, not just against A/B/C.

### How to run

1. Import [`n8n/workflows/complaint_triage_orchestrator.json`](n8n/workflows/complaint_triage_orchestrator.json)
   into n8n (Workflows → Import from File) — no credentials needed.
2. Run **Fixture Test Trigger (A/B/C)** manually. All three items should reach `Final:
   Escalate to Human Queue`.
3. Running **Manual Trigger** (the live path) will currently route everything to `Live
   Ticket (Awaiting Phase 7)` unless a fetched complaint_id happens to be one of the
   three fixtures (it won't be — those are a historical snapshot).

## Not yet built (Phases 4–7)

Ground-truth comparison · Streamlit + Plotly dashboard · verification, including the
mock-to-real Claude API swap (Phase 7) and the storage/dedup layer flagged in Phase 1.

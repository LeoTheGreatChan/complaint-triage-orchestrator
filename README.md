# Complaint Triage Orchestrator (S2.3)

A workflow automation + multi-agent AI orchestration pilot: real CFPB complaint data,
real federal regulation text, a disclosed synthetic CRM layer, and four genuine
conditional-tool-use LLM agents (n8n native AI/LLM agent nodes) feeding a deterministic
escalation gate. Full spec: `../Docs/Complaint_Triage_Orchestrator_Spec.md`.

**Status: Phase 2 of 7 complete.** See Section 15 of the spec for the full phase list.

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

## Not yet built (Phases 3–7)

Four LLM agents (mock-first against the Section 6 fixtures, then a real Claude API
swap) · deterministic escalation gate · ground-truth comparison · Streamlit + Plotly
dashboard · verification.

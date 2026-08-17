# Field-claim verification pass (Section 3a/3b, post-v8)

Detailed chronology, extracted from the main [README](../README.md) to keep that file
readable as a first-screen pitch rather than a forensic audit log. The evidence itself
is unchanged — this is exactly what was there before, just moved.

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
  [`reference_data/README.md`](../reference_data/README.md).

The Section 6 taxonomy-sibling discrepancy flagged in Phase 1 was outside this pass's
scope (3a/3b only) and was still sitting uncorrected in the spec as of v8, three
versions after being flagged — fixed in v11 after being raised again explicitly.
**Update, post-v10:** a full diff of every discrepancy flagged anywhere in this repo
(both READMEs, workflow node notes, script comments) against the current spec text
found no other gaps — every item flagged through Phase 5 and both verification passes
is now reflected in spec v11. This paragraph itself was the one piece of stale
documentation the diff turned up (it previously said the Section 6 issue "remains open
as of v8," which stopped being true once v11 shipped) — worth noting that keeping this
file in sync is exactly the kind of thing that needs deliberate re-checking, not
just the spec.

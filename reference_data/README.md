# Reference data

Static, build-time-cached files. Both categories are pulled once (spec Section 3b / 6)
by the scripts in [`../scripts`](../scripts), not re-fetched per ticket by the n8n
workflow. Re-run the relevant script to refresh a snapshot.

## `taxonomy/cfpb_taxonomy.json`

The CFPB Consumer Complaint Database's own product → issue → sub-issue tree, scoped to
the pilot's two products (Debt collection, Credit card). Backs Agent 1 (Classification)'s
taxonomy lookup tool. Source: CFPB's public, unauthenticated search API aggregations.

**Known discrepancy vs. spec v4 Section 6:** the spec states that `Card opened without
my consent or knowledge` sits as a sibling sub-issue to `Card opened as result of
identity theft or fraud` under Credit card → Getting a credit card. The live taxonomy
pulled here does not bear that out — under `Getting a credit card` the real sub-issues
are `Card opened without my consent or knowledge`, `Application denied`, `Sent card you
never applied for`, `Delay in processing application`, and `Problem getting a working
replacement card`. No sub-issue anywhere in the real Credit card taxonomy is literally
named `Card opened as result of identity theft or fraud`. Flagged here rather than
silently edited into the cached file or quietly dropped, in the same spirit as the
spec's own correction of the Ticket C misread (Section 6) — this is exactly the kind of
unverified taxonomy claim v4 was meant to close out.

This doesn't undermine Ticket C's High-severity call: the consumer's own filed sub-issue
is `Card opened without my consent or knowledge`, which is itself a real, consumer-chosen
CFPB category (not invented), and the rubric's identity-theft/fraud signal is separately
supported by the narrative's "fraudulent case application" language — it just isn't
supported by a literal sibling-category match the way Section 6 currently describes it.

## `regulations/*.json`

Five files, one per regulation section in spec Section 3b:

| File | Citation | Topic |
|---|---|---|
| `fdcpa_1692g.json` | 15 U.S.C. §1692g | Debt validation notice |
| `fdcpa_1692e.json` | 15 U.S.C. §1692e | False or misleading representations |
| `fcra_1681c-2.json` | 15 U.S.C. §1681c-2 | Identity-theft block procedure |
| `reg_z_1026_13.json` | 12 CFR §1026.13 | Billing-error resolution procedure |
| `cfpb_15day_rule.json` | Dodd-Frank company-response standard | Company response deadline |

Each file's `text` field is the verbatim public-domain statutory/regulatory text (Cornell
LII for the four US Code/CFR sections; CFPB's own process page for the 15-day rule), with
a `_meta` block carrying citation, topic, source URL, retrieval date, and pilot relevance.
This is a technical demonstration, not legal advice (spec Section 14, disclosure 4).

**Source substitution, undocumented until now:** spec Section 3b's table names
`ecfr.gov/current/title-12/.../section-1026.13` as Regulation Z's source. During Phase 1
sourcing, eCFR's direct URL redirected to a bot-detection page (`unblock.federalregister.gov`)
and refused automated access. `reg_z_1026_13.json` was sourced from Cornell LII's CFR
mirror (`law.cornell.edu/cfr/text/12/1026.13`) instead — the same authoritative federal
regulatory text, republished by the same institution already used for the four US Code
sections, just not the exact URL Section 3b names. Caught during a v8 verification pass
of every field claim in Section 3a/3b; the text itself was already independently
verified in Phase 1 (fetched and cross-checked against the real statute), only the
documented-source label had drifted from what was actually used.

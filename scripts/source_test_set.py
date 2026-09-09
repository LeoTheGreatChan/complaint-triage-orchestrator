"""
Sources the ~15-20 ticket held-out test set for Phase 8's KPI measurement
(addendum Section 7, build phase 5) -- real CFPB tickets that were never used
to seed the lexical regulation-search tool, the semantic corpus, or the three
Section 3a/3c fixtures, and were never fetched by the live pipeline.

"Never used to seed either tool": the lexical tool's synonym/stopword lists
and the eight real fixture tickets (D-H plus the three synthetic A-C) were
all built by hand well before this script exists, and the semantic corpus
(rag/corpus/regulation_chunks.json) is built from five regulation TEXTS, not
tickets, so there is no ticket-level overlap risk there at all. The one real
contamination risk is the live n8n pipeline itself: it polls the CFPB API
forward from a watermark (Get Watermark node's $getWorkflowStaticData) and
could, in principle, have already fetched and processed some of the same
tickets a naive test-set query would return.

The fix used here is structural, not a best-effort dedup pass: query only
tickets with date_received strictly AFTER the live pipeline's own watermark.
The pipeline only ever moves that watermark forward (Cap Batch & Advance
Watermark), so anything after it is, by construction, a ticket the pipeline
has never had the chance to see -- not "probably hasn't seen," but genuinely
cannot have seen. WATERMARK_DATE below is a snapshot of the live n8n
instance's staticData.lastWatermarkDate (checked via its REST API) at the
time this script was written -- re-check it against the live instance and
bump this constant if a real run has advanced it since, otherwise this
script's own held-out guarantee is stale.

The fixture complaint_ids are also excluded explicitly, belt-and-braces --
this is expected to be a no-op today (every fixture predates the watermark
by weeks or months) but costs nothing to keep.

Filters to has_narrative=true (a real, server-side CFPB API query parameter,
confirmed by testing -- not a client-side guess) because a narrative-less
ticket has no text for the semantic tool to embed or the lexical tool to
search: retrieval-quality KPIs need tickets where retrieval actually has
something to do. Narrative publication itself lags date_received by several
weeks (CFPB's own consent/redaction review) -- confirmed empirically during
this script's build by querying has_narrative=true directly and observing
the most recent hit trailing "now" by ~6 weeks, not by testing sub-day-old
tickets and wrongly concluding narratives don't exist.

Usage:
    python scripts/source_test_set.py

Output: eval/held_out_test_set.json -- one entry per ticket, with a blank
`ground_truth` block (`applicable_regulation`, `citation`, `notes`) for a
human to hand-verify before Phase 8 build phase 6 (KPI measurement) can run
against it. This script does not and should not fill that in -- ground
truth here means a person's judgment of what actually applies, not another
model's guess.
"""
import json
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

API_BASE = "https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/"
PILOT_PRODUCTS = ["Debt collection", "Credit card"]
OUT_PATH = Path(__file__).resolve().parent.parent / "eval" / "held_out_test_set.json"

# Snapshot of the live n8n instance's staticData.lastWatermarkDate, checked
# via GET /rest/workflows/{id} on 2026-09-09 -- see module docstring. Keeps
# the held-out guarantee only as current as this snapshot; re-check before
# relying on it if significant time has passed since.
WATERMARK_DATE = "2026-07-17"

# Belt-and-braces exclusion of the ten fixture complaint_ids (three
# synthetic A/B/C plus seven real tickets among D-H's region) hardcoded in
# scripts/build_workflow.js's FIXTURE_TICKETS -- all predate WATERMARK_DATE
# already, so this is expected to remove nothing, not a load-bearing filter.
FIXTURE_COMPLAINT_IDS = {
    "9999970", "9999975", "9999983",
    "24158082", "24157871", "24157473", "24157200", "24157609", "24157195", "24157240",
}

TARGET_COUNT = 18
FETCH_SIZE = 150  # headroom for the exclusion filter and product interleaving


def watermark_exclusive_start() -> str:
    """One day after the watermark -- date_received_min is inclusive of the
    day given, so this guarantees strict exclusion of the watermark date
    itself, not just an off-by-one risk left implicit."""
    wm = datetime.strptime(WATERMARK_DATE, "%Y-%m-%d").date()
    return (wm + timedelta(days=1)).isoformat()


def fetch_candidates() -> list[dict]:
    params = [
        ("product", PILOT_PRODUCTS[0]),
        ("product", PILOT_PRODUCTS[1]),
        ("has_narrative", "true"),
        ("date_received_min", watermark_exclusive_start()),
        ("size", str(FETCH_SIZE)),
        ("sort", "created_date_asc"),
        ("no_aggs", "true"),
    ]
    url = f"{API_BASE}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=30) as resp:
        doc = json.load(resp)
    return [hit["_source"] for hit in doc["hits"]["hits"]], doc["hits"]["total"]["value"]


def select_mixed_sample(candidates: list[dict], target_count: int) -> list[dict]:
    """Round-robin across the two pilot products so the held-out set isn't
    accidentally all one product just because it happened to sort first --
    real-world availability may still make the split uneven, and that's
    reported honestly rather than forced to a fake 50/50."""
    by_product: dict[str, list[dict]] = {p: [] for p in PILOT_PRODUCTS}
    for c in candidates:
        if c["product"] in by_product:
            by_product[c["product"]].append(c)

    selected = []
    i = 0
    while len(selected) < target_count and any(by_product.values()):
        for product in PILOT_PRODUCTS:
            if i < len(by_product[product]) and len(selected) < target_count:
                selected.append(by_product[product][i])
        i += 1
    return selected


def to_output_record(ticket: dict) -> dict:
    return {
        "complaint_id": ticket["complaint_id"],
        "product": ticket["product"],
        "sub_product": ticket.get("sub_product"),
        "issue": ticket["issue"],
        "sub_issue": ticket.get("sub_issue"),
        "company": ticket["company"],
        "state": ticket.get("state"),
        "date_received": ticket["date_received"],
        "timely": ticket.get("timely"),
        "company_response": ticket.get("company_response"),
        "complaint_what_happened": ticket["complaint_what_happened"],
        # Hand-verification target for build phase 5 -- left blank on
        # purpose. A person fills this in by reading the narrative and
        # judging which federal regulation, if any, genuinely applies;
        # phase 6's KPI measurement (lexical vs. semantic retrieval@k,
        # citation accuracy) compares each tool's output against this.
        "ground_truth": {
            "applicable_regulation": None,
            "citation": None,
            "verified_by": None,
            "verified_at": None,
            "notes": "",
        },
    }


def main():
    candidates, total_available = fetch_candidates()

    before_exclusion = len(candidates)
    candidates = [c for c in candidates if c["complaint_id"] not in FIXTURE_COMPLAINT_IDS]
    excluded_count = before_exclusion - len(candidates)

    selected = select_mixed_sample(candidates, TARGET_COUNT)
    records = [to_output_record(t) for t in selected]

    product_counts = {p: sum(1 for r in records if r["product"] == p) for p in PILOT_PRODUCTS}

    out = {
        "_meta": {
            "description": (
                "Phase 8 addendum Section 7 build phase 5: held-out test set for "
                "lexical-vs-semantic retrieval KPI measurement (recall@k, paraphrase "
                "robustness, downstream citation accuracy, false-positive rate)."
            ),
            "sourced_at": date.today().isoformat(),
            "source": f"{API_BASE} (live CFPB Consumer Complaint Database API, no auth required)",
            "query": {
                "product": PILOT_PRODUCTS,
                "has_narrative": True,
                "date_received_min": watermark_exclusive_start(),
                "sort": "created_date_asc",
            },
            "held_out_guarantee": (
                f"Every ticket has date_received > {WATERMARK_DATE} (the live n8n "
                "pipeline's watermark at sourcing time, read from its own "
                "staticData) -- the pipeline can structurally never have already "
                "fetched or processed any of these, not just 'probably hasn't.' "
                f"{excluded_count} candidate(s) additionally matched a hardcoded "
                "fixture complaint_id and were excluded belt-and-braces (expected "
                "to be 0 given the watermark filter already covers it)."
            ),
            "total_candidates_matching_query": total_available,
            "candidates_fetched_this_run": before_exclusion,
            "selected_count": len(records),
            "product_mix": product_counts,
            "next_step": (
                "Hand-verify ground_truth.applicable_regulation/citation for each "
                "ticket below (read complaint_what_happened, judge what actually "
                "applies among this pilot's five cached regulations or null if "
                "none clearly does) before running Phase 8 build phase 6's KPI "
                "measurement against this set."
            ),
        },
        "tickets": records,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {OUT_PATH} ({len(records)} tickets, product mix: {product_counts})")
    print(f"Next: hand-verify ground_truth for each ticket before KPI measurement (build phase 6).")


if __name__ == "__main__":
    main()

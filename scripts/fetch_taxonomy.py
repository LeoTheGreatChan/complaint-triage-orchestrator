"""
Pull the CFPB Consumer Complaint Database's product/issue/sub-issue taxonomy for the
S2.3 pilot's two in-scope products (Debt collection, Credit card) and cache it as a
static JSON file.

This is a ONE-TIME build-time sourcing script, not something the n8n workflow calls
per-ticket -- per spec Section 6, "the taxonomy doesn't change often enough to need
re-fetching per ticket." Re-run manually if the pilot scope changes (Section 17) or
the cached snapshot needs refreshing.

No API key required -- this is CFPB's public, unauthenticated search API.

Usage:
    python scripts/fetch_taxonomy.py
"""
import json
import urllib.parse
import urllib.request
from datetime import date, timezone
from pathlib import Path

API_BASE = "https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/"
PILOT_PRODUCTS = ["Debt collection", "Credit card"]
OUT_PATH = Path(__file__).resolve().parent.parent / "reference_data" / "taxonomy" / "cfpb_taxonomy.json"


def fetch_aggregations(product: str) -> dict:
    """size=0 -> hits are suppressed, only the aggregation buckets (product/sub_product,
    issue/sub_issue, etc.) for the given product filter come back."""
    params = {"product": product, "size": "0"}
    url = f"{API_BASE}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.load(resp)


def build_product_taxonomy(agg_doc: dict, product_name: str) -> dict:
    aggs = agg_doc["aggregations"]

    sub_products = []
    for bucket in aggs["product"]["product"]["buckets"]:
        if bucket["key"] == product_name:
            sub_products = [
                {"name": sb["key"], "doc_count": sb["doc_count"]}
                for sb in bucket["sub_product.raw"]["buckets"]
            ]
            break

    issues = []
    for bucket in aggs["issue"]["issue"]["buckets"]:
        sub_issues = [
            {"name": sb["key"], "doc_count": sb["doc_count"]}
            for sb in bucket.get("sub_issue.raw", {}).get("buckets", [])
        ]
        issues.append({
            "name": bucket["key"],
            "doc_count": bucket["doc_count"],
            "sub_issues": sorted(sub_issues, key=lambda x: -x["doc_count"]),
        })

    return {
        "product": product_name,
        "total_complaints_in_scope": aggs["has_narrative"]["doc_count"],
        "sub_products": sorted(sub_products, key=lambda x: -x["doc_count"]),
        "issues": sorted(issues, key=lambda x: -x["doc_count"]),
    }


def main():
    products = [build_product_taxonomy(fetch_aggregations(p), p) for p in PILOT_PRODUCTS]

    taxonomy = {
        "_meta": {
            "description": (
                "CFPB Consumer Complaint Database product/issue/sub-issue taxonomy, "
                "scoped to the S2.3 pilot categories (Debt collection, Credit card). "
                "Backs Agent 1 (Classification)'s taxonomy lookup tool -- spec Section 6."
            ),
            "source": f"{API_BASE} (live aggregations query, no auth required)",
            "retrieved_date": date.today().isoformat(),
            "scope_note": (
                "Pulled once at build time per spec Section 6 / Section 15 Phase 1 -- "
                "cached static lookup, not re-fetched per ticket."
            ),
        },
        "products": products,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(taxonomy, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {OUT_PATH} ({OUT_PATH.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

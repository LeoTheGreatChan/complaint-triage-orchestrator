"""
Pull the six regulation sections the S2.3 pilot's agents cite (spec Section 3b) from
their public sources and cache them as static JSON reference files with full verbatim
text plus source/retrieval metadata.

ONE-TIME build-time sourcing script -- per spec Section 3b, this is "stable statutory
text, not something that needs re-fetching per ticket." Re-run manually only if a
source amends the underlying law/regulation.

No API key required -- Cornell LII (law.cornell.edu) publishes US Code and CFR text
as plain public-domain government text. The CFPB 15-day rule is CFPB's own published
complaint-handling standard, sourced from consumerfinance.gov directly.

Usage:
    python scripts/fetch_regulations.py
"""
import html as ihtml
import json
import re
import urllib.request
from datetime import date
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "reference_data" / "regulations"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; complaint-triage-orchestrator research script)"}

BLOCK_TAGS = r"(p|div|li|h1|h2|h3|h4|h5|h6|br|tr|section)"
STOP_MARKERS = ["editorial notes", "statutory notes", "u.s. code toolbox", "lii has no control"]
START_PATTERN = re.compile(r"^\d+ U\.S\. Code|^12 CFR")


def fetch_html(url: str) -> str:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def extract_cornell_section_text(raw_html: str) -> str:
    """Cornell LII wraps every defined term (e.g. 'consumer', 'debt') in its own
    inline tooltip span. Naively replacing every tag with a newline shatters the
    text into one word per line; naively dropping tags with no replacement joins
    adjacent words ('contentsWithin'). The fix: block-level tag boundaries become
    newlines (preserve paragraph/subsection structure), everything else becomes a
    single space (preserve word boundaries) -- then collapse whitespace."""
    match = re.search(r'id="content"(.*)', raw_html, re.S)
    chunk = match.group(1)
    chunk = re.sub(r"<script.*?</script>", "", chunk, flags=re.S)
    chunk = re.sub(r"<style.*?</style>", "", chunk, flags=re.S)
    chunk = re.sub(r"</?%s[^>]*>" % BLOCK_TAGS, "\n", chunk, flags=re.I)
    chunk = re.sub(r"<[^>]+>", " ", chunk)
    text = ihtml.unescape(chunk)

    lines = [re.sub(r"[ \t]+", " ", l).strip() for l in text.split("\n")]
    lines = [re.sub(r"\s+([,.;:])", r"\1", l) for l in lines]
    # Cornell wraps possessive "'s" in its own inline span, so it picks up a stray
    # space on one side or the other (e.g. "consumer 's" / "consumer' s") -- rejoin.
    lines = [re.sub(r"(’|')\s+s\b", r"\1s", l) for l in lines]
    lines = [re.sub(r"\s+(’|')s\b", r"\1s", l) for l in lines]
    lines = [l for l in lines if l]

    start_idx = next((i for i, l in enumerate(lines) if START_PATTERN.match(l)), 0)
    end_idx = len(lines)
    for i in range(start_idx, len(lines)):
        if any(marker in lines[i].lower() for marker in STOP_MARKERS):
            end_idx = i
            break

    return "\n".join(lines[start_idx:end_idx])


REGULATIONS = [
    {
        "id": "fdcpa_1692g",
        "regulation": "FDCPA",
        "citation": "15 U.S.C. §1692g",
        "topic": "Debt validation notice",
        "source_url": "https://www.law.cornell.edu/uscode/text/15/1692g",
        "extractor": "cornell",
        "pilot_relevance": "Ticket A (Aargon Agency) -- 30-day validation dispute.",
    },
    {
        "id": "fdcpa_1692e",
        "regulation": "FDCPA",
        "citation": "15 U.S.C. §1692e",
        "topic": "False or misleading representations",
        "source_url": "https://www.law.cornell.edu/uscode/text/15/1692e",
        "extractor": "cornell",
        "pilot_relevance": "Ticket B (Equifax) -- alongside FCRA §605B for a debt-not-owed / identity-theft-profile claim.",
    },
    {
        "id": "fcra_1681c-2",
        "regulation": "FCRA",
        "citation": "15 U.S.C. §1681c-2",
        "topic": "Identity-theft block procedure",
        "source_url": "https://www.law.cornell.edu/uscode/text/15/1681c-2",
        "extractor": "cornell",
        "pilot_relevance": "Ticket B (Equifax) and Ticket C (Chase) -- identity-theft / unauthorized-account block requests.",
    },
    {
        "id": "reg_z_1026_13",
        "regulation": "Regulation Z (FCBA)",
        "citation": "12 CFR §1026.13",
        "topic": "Billing-error resolution procedure",
        "source_url": "https://www.law.cornell.edu/cfr/text/12/1026.13",
        "extractor": "cornell",
        "pilot_relevance": "Credit-card billing disputes (pilot scope, Section 4) -- not cited in the three worked Section 6 tickets.",
    },
]

CFPB_15DAY_RULE = {
    "id": "cfpb_15day_rule",
    "regulation": "CFPB complaint rule",
    "citation": "Dodd-Frank Act company-response standard",
    "topic": "Company response deadline",
    "source_url": "https://www.consumerfinance.gov/compliance/consumer-complaint-program/company-process/",
    "pilot_relevance": "Applies to every complaint in the pilot -- backs the SLA compliance metric (spec Section 9).",
    "text": (
        "The Dodd-Frank Wall Street Reform and Consumer Protection Act requires the CFPB to collect, "
        "investigate, and respond to consumer complaints about financial products and services. Once the "
        "CFPB sends a complaint to a company, the company reviews the information, communicates with the "
        "consumer as needed, and determines what action to take in response.\n\n"
        "Company responds: your company provides a response within 15 calendar days.\n\n"
        "If your response is not final, let us know. Your company will then have up to 60 calendar days "
        "to provide a final response.\n\n"
        "Complaints are typically published on the Consumer Complaint Database after the company responds, "
        "or after 15 days, whichever comes first, and the consumer is given the opportunity to review the "
        "company's response."
    ),
}


def build_record(spec: dict) -> dict:
    raw_html = fetch_html(spec["source_url"])
    text = extract_cornell_section_text(raw_html)
    return {
        "_meta": {
            "regulation": spec["regulation"],
            "citation": spec["citation"],
            "topic": spec["topic"],
            "source_url": spec["source_url"],
            "retrieved_date": date.today().isoformat(),
            "pilot_relevance": spec["pilot_relevance"],
            "sourcing_note": (
                "Verbatim public-domain statutory/regulatory text as published by Cornell "
                "Legal Information Institute (law.cornell.edu). Cached once at build time per "
                "spec Section 3b -- stable statutory text, not re-fetched per ticket. Not legal "
                "advice; this is a technical demonstration (spec Section 14, disclosure 4)."
            ),
        },
        "text": text,
    }


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for spec in REGULATIONS:
        record = build_record(spec)
        out_path = OUT_DIR / f"{spec['id']}.json"
        out_path.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Wrote {out_path} ({out_path.stat().st_size} bytes)")

    rule_record = {
        "_meta": {
            "regulation": CFPB_15DAY_RULE["regulation"],
            "citation": CFPB_15DAY_RULE["citation"],
            "topic": CFPB_15DAY_RULE["topic"],
            "source_url": CFPB_15DAY_RULE["source_url"],
            "retrieved_date": date.today().isoformat(),
            "pilot_relevance": CFPB_15DAY_RULE["pilot_relevance"],
            "sourcing_note": (
                "CFPB's own published complaint-handling standard, quoted from its official "
                "process page. Cached once at build time per spec Section 3b."
            ),
        },
        "text": CFPB_15DAY_RULE["text"],
    }
    out_path = OUT_DIR / f"{CFPB_15DAY_RULE['id']}.json"
    out_path.write_text(json.dumps(rule_record, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

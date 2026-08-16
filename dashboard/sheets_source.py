"""
Live Google Sheets read path for the dashboard (optional).

Reads the real "Pipeline Log" sheet directly via a read-only OAuth 2.0
credential (not a service account -- this org enforces
iam.disableServiceAccountKeyCreation, so no service-account key can exist),
reshaping rows into the same nested record shape
scripts/export_dashboard_data.mjs's reshapeSheetRow() produces from
dashboard/data/sheets_snapshot.json -- this is the Python port of that same,
disclosed inverse of flattenForSheets(). Deliberately fallback-first: any
missing credential or API error returns None so app.py falls back to the
committed static snapshot instead of crashing the page on a live-data hiccup.

Credential setup (see the main README's "Live dashboard data source"
section for the full walkthrough): a dedicated OAuth 2.0 Client ID (Desktop
app type, Internal consent screen), scoped to spreadsheets.readonly, with
a refresh token minted once via scripts/get_google_oauth_refresh_token.py.
Locally, its fields go in .streamlit/secrets.toml (git-ignored -- see
.streamlit/secrets.toml.example for the shape); in production, the same
fields go into the hosting platform's own secret-management UI (Streamlit
Community Cloud's "Secrets" panel, Render's "Secret Files", etc.) -- never
into a committed file. This module never writes to the Sheet: the scope
below is spreadsheets.readonly, and even a leaked token can't touch the
real n8n workflow's own separate write credential.
"""

import gspread
import streamlit as st
from google.oauth2.credentials import Credentials

SPREADSHEET_ID = "1WdVNgJYgoBqzxPlvfueSYoviBNjmI3naXoqmlCL_uFw"
SHEET_NAME = "Pipeline Log"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
TOKEN_URI = "https://oauth2.googleapis.com/token"


def _parse_bool(v):
    return v == "TRUE" or v is True


def _parse_number(v):
    if v in ("", None):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _reshape_row(row: dict) -> dict:
    raw_cites = row.get("agent3_cites_regulation", "")
    cites_regulation = None if raw_cites == "" else _parse_bool(raw_cites)
    agent3_tool_used = cites_regulation is True
    return {
        "complaint_id": row.get("complaint_id"),
        "company": row.get("company"),
        "product": row.get("product"),
        "issue": row.get("issue"),
        "sub_issue": row.get("sub_issue") or None,
        "decision": row.get("decision"),
        "draft": (row.get("agent3_draft") or None) if row.get("decision") == "AUTO_RESOLVE" else None,
        "agents": {
            "agent1": {
                "tool_used": _parse_bool(row.get("agent1_tool_used")),
                "output": {
                    "issue": row.get("issue"),
                    "severity": row.get("agent1_severity") or None,
                    "confidence": _parse_number(row.get("agent1_confidence")),
                },
            },
            "agent2": {
                "broader_crm_lookup_used": _parse_bool(row.get("agent2_broader_crm_lookup_used")),
                "output": {
                    "applicable_regulation": row.get("agent2_applicable_regulation") or None,
                    "citation": row.get("agent2_citation") or None,
                    "special_population_flag": _parse_bool(row.get("agent2_special_population_flag")),
                },
            },
            "agent3": {
                "tool_used": agent3_tool_used,
                "output": {
                    "draft": row.get("agent3_draft") or None,
                    "cites_regulation": cites_regulation,
                },
                "tool_result": {"found": True} if agent3_tool_used else None,
            },
            "agent4": {
                "tool_used": agent3_tool_used,  # same invariant as agent3 -- see export_dashboard_data.mjs
                "output": {
                    "confidence": _parse_number(row.get("agent4_confidence")),
                    "requires_human": _parse_bool(row.get("agent4_requires_human")),
                    "reason": row.get("agent4_reason") or None,
                },
            },
        },
        "escalation_signals": {
            "requiresHuman": _parse_bool(row.get("escalate_requires_human")),
            "lowConfidence": _parse_bool(row.get("escalate_low_confidence")),
            "isHighRiskIssue": _parse_bool(row.get("escalate_high_risk_issue")),
            "isRepeatComplainant": _parse_bool(row.get("escalate_repeat_complainant")),
            "isHighValueAccount": _parse_bool(row.get("escalate_high_value_account")),
            "exceedsMonetaryThreshold": _parse_bool(row.get("escalate_monetary_threshold")),
            "statedMonetaryExposure": _parse_number(row.get("escalate_stated_monetary_exposure")),
        },
        "ground_truth": {
            "cfpb_company_response": row.get("cfpb_company_response") or None,
            "cfpb_timely": row.get("cfpb_timely") or None,
            "cfpb_disputed_flag": row.get("cfpb_disputed_flag") or None,
            "ground_truth_signal": row.get("ground_truth_signal") or None,
            "agrees_with_ground_truth": _parse_bool(row.get("agrees_with_ground_truth")),
        },
        "crm_summary": {
            "account_tier": row.get("crm_account_tier") or None,
            "tenure_years": _parse_number(row.get("crm_tenure_years")),
            "special_population_flag": _parse_bool(row.get("crm_special_population_flag")),
        },
        "source": "google_sheets_live",
    }


def fetch_live_pipeline_log():
    """Returns the same {"_meta", "records"} shape app.py's static-file path
    produces, fetched live from the real Sheet -- or None if no credential
    is configured or the API call fails for any reason.
    """
    try:
        if "gcp_oauth_client" not in st.secrets:
            return None
        oauth = st.secrets["gcp_oauth_client"]
        creds = Credentials(
            token=None,
            refresh_token=oauth["refresh_token"],
            token_uri=TOKEN_URI,
            client_id=oauth["client_id"],
            client_secret=oauth["client_secret"],
            scopes=SCOPES,
        )
        client = gspread.authorize(creds)
        values = client.open_by_key(SPREADSHEET_ID).worksheet(SHEET_NAME).get_all_values()
    except Exception as e:
        # Fail open for the viewer (static snapshot still renders), but log
        # server-side so a real misconfiguration isn't silently invisible.
        print(f"[sheets_source] live fetch failed, falling back to static snapshot: {e!r}")
        return None

    if not values:
        return None
    header, *data_rows = values
    records = [_reshape_row(dict(zip(header, cells))) for cells in data_rows]
    return {
        "_meta": {
            "description": "Pipeline decision log -- fetched live from the real Google Sheet on this page load.",
            "records_source": "google_sheets_live",
            "record_count": len(records),
        },
        "records": records,
    }

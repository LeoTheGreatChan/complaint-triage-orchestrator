#!/usr/bin/env python3
"""
One-time local helper: mints a refresh token for the dashboard's read-only
Google Sheets access and writes it straight into .streamlit/secrets.toml.

Why this exists: dashboard/sheets_source.py reads the real "Pipeline Log"
Sheet live via OAuth 2.0, not a service account -- the Google Cloud org this
project runs under enforces iam.disableServiceAccountKeyCreation, so a
service-account key can't be created at all. OAuth needs one interactive
consent step to produce a long-lived refresh token; this script is that one
step. It has to be run once, locally, by a human with a browser -- it can't
be run by an agent or automated, since it requires an actual Google sign-in.

Usage:
    pip install google-auth-oauthlib
    python scripts/get_google_oauth_refresh_token.py path/to/client_secret.json

`client_secret.json` is the file Google Cloud Console gives you when you
create an OAuth 2.0 Client ID (Application type: Desktop app) -- see the
main README's "Live dashboard data source" section for the full walkthrough
of creating that client and its Internal consent screen.

Deliberately never prints client_id/client_secret/refresh_token to the
terminal -- writes them straight to .streamlit/secrets.toml (already
git-ignored) instead, so the values never land in shell history, logs, or
anywhere else they could be copy-pasted into an unsafe place.
"""

import sys
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
REPO_ROOT = Path(__file__).resolve().parent.parent
SECRETS_PATH = REPO_ROOT / ".streamlit" / "secrets.toml"


def _write_secrets_block(client_id, client_secret, refresh_token):
    block = (
        "[gcp_oauth_client]\n"
        f'client_id = "{client_id}"\n'
        f'client_secret = "{client_secret}"\n'
        f'refresh_token = "{refresh_token}"\n'
    )

    SECRETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    existing = SECRETS_PATH.read_text(encoding="utf-8") if SECRETS_PATH.exists() else ""

    # Strip any previous [gcp_oauth_client] section (up to the next
    # top-level section or end of file) so re-running this script replaces
    # it cleanly instead of leaving a stale duplicate block behind.
    kept = []
    skipping = False
    for line in existing.splitlines(keepends=True):
        if line.strip() == "[gcp_oauth_client]":
            skipping = True
            continue
        if skipping and line.startswith("[") and line.strip() != "[gcp_oauth_client]":
            skipping = False
        if not skipping:
            kept.append(line)

    new_content = "".join(kept).rstrip("\n")
    new_content = (new_content + "\n\n" if new_content else "") + block
    SECRETS_PATH.write_text(new_content, encoding="utf-8")


def main():
    if len(sys.argv) != 2:
        print("Usage: python scripts/get_google_oauth_refresh_token.py path/to/client_secret.json")
        sys.exit(1)

    client_secret_path = Path(sys.argv[1])
    if not client_secret_path.exists():
        print(f"File not found: {client_secret_path}")
        sys.exit(1)

    flow = InstalledAppFlow.from_client_secrets_file(str(client_secret_path), scopes=SCOPES)
    # access_type="offline" + prompt="consent" guarantee a refresh_token
    # comes back -- Google only issues one on the very first consent for a
    # given client otherwise, which silently breaks a second run.
    creds = flow.run_local_server(port=0, access_type="offline", prompt="consent")

    if not creds.refresh_token:
        print(
            "No refresh token returned. Revoke this app's access at "
            "https://myaccount.google.com/permissions and run this script again."
        )
        sys.exit(1)

    _write_secrets_block(creds.client_id, creds.client_secret, creds.refresh_token)
    print(f"Wrote gcp_oauth_client credentials to {SECRETS_PATH} (values not shown here).")
    print("Restart the dashboard (or wait up to 5 min for its cache to expire) to pick up the live Sheet.")


if __name__ == "__main__":
    main()

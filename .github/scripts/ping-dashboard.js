// Visits the live dashboard with a real headless browser to keep the
// Streamlit Community Cloud app awake.
//
// Why not a plain curl request (what this replaced): tested directly --
// curl -L against the app URL loops between the app and
// share.streamlit.io's auth redirect (`/-/auth/app?redirect_uri=...`)
// until it hits curl's max-redirects limit and fails with exit code 47,
// regardless of User-Agent. A real browser hits the same URL and gets a
// clean 200 with no redirect loop, confirmed by testing both directly --
// whatever gate Streamlit Cloud puts in front of the app requires a
// JS-capable client to get through, not just a bearer of valid cookies.
// The app itself is genuinely public to real visitors; this is a client
// capability issue, not an access-control one.
const { chromium } = require("playwright");

const DASHBOARD_URL = "https://complaint-triage-orchestrator-2v8axupydgbjue7scerxww.streamlit.app/";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const response = await page.goto(DASHBOARD_URL, { waitUntil: "networkidle", timeout: 60000 });
  const status = response ? response.status() : null;
  const finalUrl = page.url();
  await browser.close();

  console.log(`status=${status} final_url=${finalUrl}`);

  if (status !== 200 || !finalUrl.startsWith(DASHBOARD_URL)) {
    console.error("Ping did not land on the dashboard as expected.");
    process.exit(1);
  }
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

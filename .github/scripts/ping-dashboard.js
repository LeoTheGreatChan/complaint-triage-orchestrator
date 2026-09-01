// Visits the live dashboard with a real headless browser to keep the
// Streamlit Community Cloud app awake -- and, critically, actually wakes it
// back up if it's already asleep, rather than just confirming the sleep
// screen loaded.
//
// History of why this script looks the way it does, found by testing
// directly against the real app rather than guessed:
//
// 1. A plain curl request doesn't work at all: curl -L against the app URL
//    loops between the app and share.streamlit.io's auth redirect
//    (`/-/auth/app?redirect_uri=...`) until it hits curl's max-redirects
//    limit and fails with exit code 47, regardless of User-Agent. A real
//    browser hits the same URL and gets a clean 200 with no redirect loop
//    -- whatever gate Streamlit Cloud puts in front of the app requires a
//    JS-capable client, not just a bearer of valid cookies. That's why
//    this uses Playwright instead of curl.
//
// 2. A real browser visit alone isn't enough either: once a Streamlit
//    Community Cloud app has actually gone to sleep from inactivity, its
//    URL serves an interstitial "Zzzz -- this app has gone to sleep"
//    page with a "Yes, get this app back up!" button -- and that page
//    itself returns a normal 200 at the correct URL. The first version of
//    this script only checked HTTP status and final URL, so it silently
//    reported success on every run while actually just looking at the
//    sleep screen, never clicking through -- confirmed by checking 65
//    straight "successful" scheduled runs against the app being asleep
//    in practice. Fixed by detecting the sleep screen's own marker text
//    and clicking its wake button when present.
const { chromium } = require("playwright");

const DASHBOARD_URL = "https://complaint-triage-orchestrator-2v8axupydgbjue7scerxww.streamlit.app/";
const SLEEP_MARKER_TEXT = "gone to sleep";
const WAKE_BUTTON_TEXT = "Yes, get this app back up!";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const response = await page.goto(DASHBOARD_URL, { waitUntil: "networkidle", timeout: 60000 });
  const status = response ? response.status() : null;

  if (status !== 200) {
    console.error(`Unexpected status ${status} loading the dashboard.`);
    await browser.close();
    process.exit(1);
  }

  const isAsleep = await page.getByText(SLEEP_MARKER_TEXT).isVisible().catch(() => false);

  if (isAsleep) {
    console.log("App is asleep -- clicking the wake button.");
    await page.getByText(WAKE_BUTTON_TEXT).click();
    // Wait for the sleep notice to clear rather than for specific
    // dashboard content: Streamlit hydrates the real page over a
    // WebSocket after the initial load, which makes waiting on a
    // particular piece of text flaky. The sleep notice disappearing is
    // the real, direct signal that the wake sequence actually fired.
    await page.getByText(SLEEP_MARKER_TEXT).waitFor({ state: "hidden", timeout: 90000 });
    console.log("Wake sequence completed -- sleep notice is gone.");
  } else {
    console.log("App was already awake.");
  }

  await browser.close();
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

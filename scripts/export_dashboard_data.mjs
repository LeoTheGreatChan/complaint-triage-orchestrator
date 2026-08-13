/**
 * Generates dashboard/data/pipeline_log.json -- the Streamlit dashboard's only
 * data source (spec Section 15 Phase 6).
 *
 * Two separate arrays in the output, never merged:
 *   - `records`: tickets with a genuine, fully-processed pipeline DECISION.
 *     Every KPI and chart in the dashboard is computed from this array only.
 *   - `awaiting_records`: real tickets fetched live from CFPB (Phase 1's
 *     actual HTTP call) and given a real synthetic CRM record (Phase 2),
 *     but with NO agent decision -- no severity, no draft, no escalation
 *     call. Real ticket data, honestly labeled as undecided, kept
 *     completely separate so it can never accidentally feed a KPI.
 *
 * `records` can come from either of two genuinely different sources:
 *   - The simulator (default): reuses scripts/simulate_workflow.mjs's
 *     execute(), which runs the ACTUAL committed n8n workflow JSON
 *     node-by-node. Proves the pipeline LOGIC is correct; doesn't touch
 *     real storage.
 *   - The real Google Sheet (--from-sheets): reshapes
 *     dashboard/data/sheets_snapshot.json, a point-in-time fetch of what's
 *     genuinely stored in the real "Pipeline Log" sheet (spec Section 11),
 *     back into the nested shape the dashboard expects. Proves the STORAGE
 *     layer is correct -- this is only ever whatever has actually been
 *     written there for real, so it can legitimately hold fewer tickets
 *     than the simulator can produce (only tickets actually run through a
 *     real n8n execution have a real Sheets row).
 *
 * Usage:
 *   node scripts/export_dashboard_data.mjs
 *     Regenerates `records` from the fixtures via the simulator (fast, no
 *     network call). Leaves `awaiting_records` as whatever was already in
 *     the file -- does NOT silently re-fetch or wipe it.
 *   node scripts/export_dashboard_data.mjs --from-sheets
 *     Regenerates `records` from dashboard/data/sheets_snapshot.json
 *     instead -- what's really in the real Google Sheet, not the simulator.
 *     See that file's _meta.how_to_refresh for how to update the snapshot;
 *     there's no standalone Google API credential wired up yet for this
 *     script to fetch it unattended (see the main README).
 *   node scripts/export_dashboard_data.mjs --live-batch
 *     Also runs the real live trigger path (a real CFPB API call, capped at
 *     25 per spec Section 5) and replaces `awaiting_records` with that
 *     fresh batch. Independent of --from-sheets -- can be combined.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "./simulate_workflow.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = path.join(REPO_ROOT, "dashboard/data/pipeline_log.json");
const SHEETS_SNAPSHOT_PATH = path.join(REPO_ROOT, "dashboard/data/sheets_snapshot.json");
const INCLUDE_LIVE_BATCH = process.argv.includes("--live-batch");
const FROM_SHEETS = process.argv.includes("--from-sheets");

function parseSheetBool(v) {
  return v === "TRUE" || v === true;
}
function parseSheetNumber(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// Inverse of scripts/build_workflow.js's flattenForSheets(). Real Sheets
// storage (spec Section 11) only keeps single-level columns, so this
// reconstructs the nested shape every dashboard KPI/chart function expects.
//
// Two things genuinely can't be read back from the flat schema at all --
// there's no agent3_tool_used/agent4_tool_used column, and no
// agent3.tool_result.found column. Reconstructed from a real, disclosed
// architectural invariant of this build rather than guessed: Agent 3's
// exact-clause-fetch tool runs exactly when it cites a regulation, and
// Agent 4's re-verify tool runs exactly when there's a cited clause to
// re-verify -- true for all ten hand-verified fixtures (see
// scripts/build_workflow.js's AGENT3_FIXTURES/AGENT4_FIXTURES). tool_result
// .found reconstructs to `true` for a citing ticket because the
// simulator's self-test already independently proves every fixture's
// citation resolves against the real cached regulation corpus -- this
// isn't invented, it's re-deriving a fact already verified elsewhere, not
// a live tool call made at read time.
//
// One real, accepted loss: Ticket C's compound multi-issue Agent 1 output
// (a primary issue plus a secondary "service failure" issue) collapses to
// just its primary issue once flattened -- flattenForSheets already
// resolves to the primary issue's own severity/confidence, so there's no
// secondary-issue detail left in the sheet to read back.
function reshapeSheetRow(row) {
  const citesRegulation = row.agent3_cites_regulation === "" ? null : parseSheetBool(row.agent3_cites_regulation);
  const agent3ToolUsed = citesRegulation === true;
  return {
    complaint_id: row.complaint_id,
    company: row.company,
    product: row.product,
    issue: row.issue,
    sub_issue: row.sub_issue || null,
    decision: row.decision,
    draft: row.decision === "AUTO_RESOLVE" ? (row.agent3_draft || null) : null,
    agents: {
      agent1: {
        tool_used: parseSheetBool(row.agent1_tool_used),
        output: { issue: row.issue, severity: row.agent1_severity || null, confidence: parseSheetNumber(row.agent1_confidence) },
      },
      agent2: {
        broader_crm_lookup_used: parseSheetBool(row.agent2_broader_crm_lookup_used),
        output: {
          applicable_regulation: row.agent2_applicable_regulation || null,
          citation: row.agent2_citation || null,
          special_population_flag: parseSheetBool(row.agent2_special_population_flag),
        },
      },
      agent3: {
        tool_used: agent3ToolUsed,
        output: { draft: row.agent3_draft || null, cites_regulation: citesRegulation },
        tool_result: agent3ToolUsed ? { found: true } : null,
      },
      agent4: {
        tool_used: agent3ToolUsed, // same invariant as agent3 -- see comment above
        output: {
          confidence: parseSheetNumber(row.agent4_confidence),
          requires_human: parseSheetBool(row.agent4_requires_human),
          reason: row.agent4_reason || null,
        },
      },
    },
    escalation_signals: {
      requiresHuman: parseSheetBool(row.escalate_requires_human),
      lowConfidence: parseSheetBool(row.escalate_low_confidence),
      isHighRiskIssue: parseSheetBool(row.escalate_high_risk_issue),
      isRepeatComplainant: parseSheetBool(row.escalate_repeat_complainant),
      isHighValueAccount: parseSheetBool(row.escalate_high_value_account),
      exceedsMonetaryThreshold: parseSheetBool(row.escalate_monetary_threshold),
      statedMonetaryExposure: parseSheetNumber(row.escalate_stated_monetary_exposure),
    },
    ground_truth: {
      cfpb_company_response: row.cfpb_company_response || null,
      cfpb_timely: row.cfpb_timely || null,
      cfpb_disputed_flag: row.cfpb_disputed_flag || null,
      ground_truth_signal: row.ground_truth_signal || null,
      agrees_with_ground_truth: parseSheetBool(row.agrees_with_ground_truth),
    },
    crm_summary: {
      account_tier: row.crm_account_tier || null,
      tenure_years: parseSheetNumber(row.crm_tenure_years),
      special_population_flag: parseSheetBool(row.crm_special_population_flag),
    },
    source: "google_sheets",
  };
}

function loadRecordsFromSheets() {
  const snapshot = JSON.parse(fs.readFileSync(SHEETS_SNAPSHOT_PATH, "utf-8"));
  return snapshot.rows.map((cells) => {
    const row = Object.fromEntries(snapshot.header.map((col, i) => [col, cells[i]]));
    return reshapeSheetRow(row);
  });
}

async function main() {
  let records;
  let escalatedCount;
  let autoResolvedCount;

  if (FROM_SHEETS) {
    records = loadRecordsFromSheets();
    escalatedCount = records.filter((r) => r.decision === "ESCALATE_TO_HUMAN").length;
    autoResolvedCount = records.filter((r) => r.decision === "AUTO_RESOLVE").length;
  } else {
    // "Load Fixture Tickets" is its own entry point now, not behind a
    // dedicated trigger -- see the comment in simulate_workflow.mjs for why
    // (a real n8n instance silently drops a workflow's second manualTrigger
    // node; confirmed by live import testing).
    const { trace } = await execute("Load Fixture Tickets", [{}]);
    const escalated = trace["Final: Escalate to Human Queue"] || [];
    const autoResolved = trace["Final: Auto-Resolve"] || [];
    records = [...escalated, ...autoResolved].map((r) => ({ ...r, source: "pilot_fixture" }));
    // Stable order: chronological by the real date_received timestamps (the
    // final record shape doesn't carry date_received, so this is a lookup
    // table into FIXTURE_TICKETS's own order rather than a live sort) --
    // C (2024-09-03T22:07) -> A (22:24) -> B (22:28) -> F (2026-07-14T00:02)
    // -> G (00:03) -> I (00:04) -> J (00:06) -> H (00:11) -> D (00:13) -> E (00:17).
    const order = { "9999983": 0, "9999970": 1, "9999975": 2, "24157473": 3, "24157200": 4, "24157195": 5, "24157240": 6, "24157609": 7, "24158082": 8, "24157871": 9 };
    records.sort((a, b) => (order[a.complaint_id] ?? 99) - (order[b.complaint_id] ?? 99));
    escalatedCount = escalated.length;
    autoResolvedCount = autoResolved.length;
  }

  // Preserve whatever live batch already exists unless explicitly asked to
  // refresh it -- a routine "I changed the workflow, regenerate the fixture
  // records" run shouldn't silently make a network call or wipe real data
  // that was deliberately fetched earlier.
  let awaitingRecords = [];
  if (fs.existsSync(OUT_PATH)) {
    try {
      awaitingRecords = JSON.parse(fs.readFileSync(OUT_PATH, "utf-8")).awaiting_records || [];
    } catch {
      awaitingRecords = [];
    }
  }

  if (INCLUDE_LIVE_BATCH) {
    const liveRun = await execute("Manual Trigger", [{}]);
    awaitingRecords = (liveRun.terminal["Live Ticket (Awaiting Phase 7)"] || []).map((r) => ({ ...r, source: "live_fetch" }));
  }

  const log = {
    _meta: {
      description: "Pipeline decision log -- spec Section 15 Phase 5/6. Generated by scripts/export_dashboard_data.mjs, either from the real committed n8n workflow JSON via the simulator, or (--from-sheets) reshaped from a real snapshot of the actual Google Sheet.",
      generated_at: new Date().toISOString(),
      records_source: FROM_SHEETS ? "google_sheets" : "simulator",
      record_count: records.length,
      awaiting_record_count: awaitingRecords.length,
      scope_note: "records: tickets with a genuine pipeline decision. awaiting_records: real tickets fetched live from CFPB with a real synthetic CRM record but NO agent decision -- kept fully separate so KPIs are never computed from undecided tickets.",
    },
    records,
    awaiting_records: awaitingRecords,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(log, null, 2) + "\n", "utf-8");
  console.log(`Wrote ${OUT_PATH} (${records.length} decided records [source: ${log._meta.records_source}]: ${escalatedCount} escalated, ${autoResolvedCount} auto-resolved; ${awaitingRecords.length} awaiting-Phase-7 records${INCLUDE_LIVE_BATCH ? " -- refreshed via live fetch" : " -- carried forward, not refreshed"})`);
}

main().catch((err) => {
  console.error("EXPORT FAILED:", err);
  process.exit(1);
});

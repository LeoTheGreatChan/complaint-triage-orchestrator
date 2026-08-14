/**
 * Minimal n8n execution simulator: loads the ACTUAL committed workflow JSON
 * (not scripts/build_workflow.js's in-memory functions) and executes it
 * node-by-node following its real `connections` graph, respecting IF-node
 * true/false branching and each Code node's `mode` (runOnceForAllItems vs
 * runOnceForEachItem). This is the strongest test available without a live
 * n8n instance: it proves the exact bytes checked into the repo execute
 * correctly, not just the logic that generated them.
 *
 * Only understands the node types this workflow actually uses (manual/schedule
 * trigger, code, if, httpRequest, googleSheets) -- it is not a general n8n
 * runtime. httpRequest makes a REAL network call (only this workflow's one
 * use of it -- the CFPB Complaint Search node -- is supported, via a small
 * special-cased query-parameter builder, not a general n8n expression
 * evaluator).
 *
 * Run: node scripts/simulate_workflow.mjs
 * Exits non-zero if any assertion fails.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = path.join(REPO_ROOT, "n8n/workflows/complaint_triage_orchestrator.json");
const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, "utf-8"));
const nodesByName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));

function runCodeNode(node, items, staticDataStore) {
  const { mode, jsCode } = node.parameters;
  // n8n's workflow static data is scoped per-node and persists across
  // executions within a run -- Get Watermark reads/writes it. A plain
  // in-memory object keyed by node name is a faithful stand-in for the
  // lifetime of one execute() call (a fresh Node process = a fresh workflow
  // run, matching "first run, no watermark yet" semantics correctly).
  const $getWorkflowStaticData = () => (staticDataStore[node.name] ||= {});
  if (mode === "runOnceForAllItems") {
    const $input = { all: () => items.map((it) => ({ json: it })), first: () => ({ json: items[0] }) };
    const fn = new Function("$input", "$getWorkflowStaticData", jsCode);
    return fn($input, $getWorkflowStaticData).map((r) => r.json);
  }
  // runOnceForEachItem: n8n calls the code once per item, each time with
  // $input.item bound to that single item.
  return items.map((it) => {
    const $input = { item: { json: it } };
    const fn = new Function("$input", "$getWorkflowStaticData", jsCode);
    return fn($input, $getWorkflowStaticData).json;
  });
}

// Resolves the one n8n expression shape this workflow's query parameters
// actually use: "={{ $json.fieldName }}". Not a general expression
// evaluator -- there's exactly one real use (CFPB Complaint Search's
// date_received_min), and this deliberately doesn't try to be more than that.
function resolveExpression(value, item) {
  if (typeof value !== "string") return value;
  const match = value.match(/^=\{\{\s*\$json\.(\w+)\s*\}\}$/);
  return match ? item[match[1]] : value;
}

// Allowlist, not a denylist -- this free, automated simulator must NEVER
// make a real call to a paid API (Phase 7's Anthropic agent nodes) under
// any circumstance, including a test path reaching them by surprise (this
// happened once already: the self-test's synthetic live-ticket injection
// started reaching "Real Agent 1" the moment the Product path replaced
// "Live Ticket (Awaiting Phase 7)", and this function attempted a real,
// malformed fetch to api.anthropic.com before this guard existed). Only
// the CFPB endpoint -- free, public, unauthenticated -- is allowed through.
const REAL_HTTP_CALLS_ALLOWED = new Set([
  "https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/",
]);

async function runHttpRequestNode(node, items) {
  const { url, queryParameters } = node.parameters;
  if (!REAL_HTTP_CALLS_ALLOWED.has(url)) {
    // A Phase 7 real-agent call (or anything else not explicitly
    // allowlisted): the simulator can't fake a real model response, and
    // must not spend real money automatically. Stub it as a pass-through --
    // downstream nodes will fail loudly if they need fields only a real
    // response would provide, which is the correct behavior for a free
    // regression test that was never meant to reach this node for real.
    return items;
  }
  // Safe (and correct) to skip the real fetch on zero items regardless of
  // URL -- but still RETURN an empty array rather than being skipped by the
  // caller entirely, so a Merge node downstream still sees this as "this
  // branch delivered, with nothing," not "this branch never ran."
  if (items.length === 0) return [];
  const params = new URLSearchParams();
  for (const p of queryParameters?.parameters || []) {
    params.append(p.name, resolveExpression(p.value, items[0] || {}));
  }
  const resp = await fetch(`${url}?${params.toString()}`);
  if (!resp.ok) throw new Error(`CFPB API returned HTTP ${resp.status} for ${url}?${params}`);
  const body = await resp.json();
  return [body]; // n8n's HTTP Request node returns the parsed response as one item.
}

function runIfNode(node, items) {
  // Every IF node in this workflow checks a single boolean field via a
  // leftValue expression like "={{ $json.foo }}".
  const expr = node.parameters.conditions.conditions[0].leftValue;
  const fieldMatch = expr.match(/\$json\.(\w+)/);
  if (!fieldMatch) throw new Error(`Simulator can't parse IF condition: ${expr}`);
  const field = fieldMatch[1];
  return [items.filter((it) => it[field] === true), items.filter((it) => it[field] !== true)];
}

// Concatenates whatever's been buffered on each of a Merge node's expected
// input indices, in ascending index order -- matches n8n's "Append" mode
// (plain concatenation, no field matching).
function runMergeNode(buffers, expectedIndices) {
  return [...expectedIndices].sort((a, b) => a - b).flatMap((i) => buffers[i] || []);
}

/**
 * Execute starting from a given node, following connections.
 *
 * Returns { trace, terminal }:
 *   - trace[nodeName]: every item that ever passed THROUGH that node
 *     (accumulated across however many times it was invoked -- a node fed
 *     by two upstream branches, like the shared Sheets-prep step here, runs
 *     once per branch, and both runs' items land in the same trace entry).
 *   - terminal[nodeName]: same accumulation, but only for nodes with no
 *     outgoing connection -- the actual end-of-graph results.
 * Most callers want `trace` for a specific node's rich output shape;
 * `terminal` is for "what came out the end of the whole graph."
 *
 * Merge nodes (n8n-nodes-base.merge, "append" mode) need to know which of
 * their input ports to actually wait for: a Merge node fed by a genuinely
 * unreachable branch in THIS run (e.g. the live-fetch branch when starting
 * from the fixture harness, or vice versa -- see build_workflow.js's
 * mergeNode() comment) must not wait forever for a delivery that will never
 * come. Reachability is computed once, per call, by a plain forward graph
 * walk from startNodeName -- independent of node-type semantics, so it's
 * accurate regardless of which node this particular call starts from.
 */
export async function execute(startNodeName, initialItems) {
  const trace = {};
  const terminal = {};
  const staticDataStore = {};

  const reachable = new Set([startNodeName]);
  {
    const stack = [startNodeName];
    while (stack.length > 0) {
      const n = stack.pop();
      for (const outArr of (workflow.connections[n] || { main: [] }).main) {
        for (const c of outArr || []) {
          if (!reachable.has(c.node)) { reachable.add(c.node); stack.push(c.node); }
        }
      }
    }
  }
  // nodeName -> [target input index, ...] for every incoming edge whose
  // source is reachable in this run.
  const incomingReachable = {};
  for (const [from, conn] of Object.entries(workflow.connections)) {
    if (!reachable.has(from)) continue;
    for (const outArr of conn.main || []) {
      for (const c of outArr || []) {
        (incomingReachable[c.node] ||= []).push(c.index ?? 0);
      }
    }
  }
  const mergeBuffers = {}; // nodeName -> { inputIndex: items[] }
  const mergeEmitted = new Set();

  const queue = [[startNodeName, initialItems, 0]];

  while (queue.length > 0) {
    const [nodeName, items, targetIndex] = queue.shift();
    const node = nodesByName[nodeName];
    if (!node) throw new Error(`Unknown node in connections: ${nodeName}`);
    const outgoing = (workflow.connections[nodeName] || { main: [] }).main;

    if (node.type === "n8n-nodes-base.merge") {
      // Register this delivery -- even an empty one, since "the branch ran
      // and produced nothing" is a real, complete delivery, not "hasn't
      // arrived yet." A node upstream of a Merge must always be allowed to
      // deliver zero items (see the removed blanket empty-items skip below).
      const buf = (mergeBuffers[nodeName] ||= {});
      buf[targetIndex] = (buf[targetIndex] || []).concat(items);
      const expected = new Set(incomingReachable[nodeName] || [0]);
      const gotAll = [...expected].every((i) => buf[i] !== undefined);
      if (!gotAll || mergeEmitted.has(nodeName)) continue;
      mergeEmitted.add(nodeName);
      const outItems = runMergeNode(buf, expected);
      trace[nodeName] = (trace[nodeName] || []).concat(outItems);
      if (!outgoing[0] || outgoing[0].length === 0) {
        terminal[nodeName] = (terminal[nodeName] || []).concat(outItems);
      } else {
        for (const conn of outgoing[0]) queue.push([conn.node, outItems, conn.index ?? 0]);
      }
      continue;
    }

    // manualTrigger/scheduleTrigger are the only node types left that don't
    // safely handle zero items on their own (if/code/httpRequest/
    // googleSheets all do, and Merge is handled above) -- but a trigger is
    // always the very first node in a queue entry with real initialItems,
    // never a zero-item delivery, so this is a defensive no-op in practice,
    // not a load-bearing skip.
    if (items.length === 0 && (node.type === "n8n-nodes-base.manualTrigger" || node.type === "n8n-nodes-base.scheduleTrigger")) {
      continue;
    }

    if (node.type === "n8n-nodes-base.manualTrigger" || node.type === "n8n-nodes-base.scheduleTrigger") {
      for (const conn of outgoing[0] || []) queue.push([conn.node, items, conn.index ?? 0]);
      continue;
    }
    if (node.type === "n8n-nodes-base.if") {
      const [trueItems, falseItems] = runIfNode(node, items);
      trace[nodeName] = (trace[nodeName] || []).concat(trueItems, falseItems);
      for (const conn of outgoing[0] || []) queue.push([conn.node, trueItems, conn.index ?? 0]);
      for (const conn of outgoing[1] || []) queue.push([conn.node, falseItems, conn.index ?? 0]);
      continue;
    }
    if (node.type === "n8n-nodes-base.code") {
      const outItems = runCodeNode(node, items, staticDataStore);
      trace[nodeName] = (trace[nodeName] || []).concat(outItems);
      if (!outgoing[0] || outgoing[0].length === 0) {
        terminal[nodeName] = (terminal[nodeName] || []).concat(outItems);
      } else {
        for (const conn of outgoing[0]) queue.push([conn.node, outItems, conn.index ?? 0]);
      }
      continue;
    }
    if (node.type === "n8n-nodes-base.httpRequest") {
      const outItems = await runHttpRequestNode(node, items);
      trace[nodeName] = (trace[nodeName] || []).concat(outItems);
      if (!outgoing[0] || outgoing[0].length === 0) {
        terminal[nodeName] = (terminal[nodeName] || []).concat(outItems);
      } else {
        for (const conn of outgoing[0]) queue.push([conn.node, outItems, conn.index ?? 0]);
      }
      continue;
    }
    if (node.type === "n8n-nodes-base.googleSheets") {
      // Can't actually call the Sheets API here (no live credentials, no
      // live n8n) -- treat as a terminal that records what WOULD be
      // written, same shape as any other terminal Code node. This proves
      // the right rows reach the node, not that the write itself works;
      // the write is untested, see the code comment above
      // googleSheetsNode() in build_workflow.js.
      trace[nodeName] = (trace[nodeName] || []).concat(items);
      terminal[nodeName] = (terminal[nodeName] || []).concat(items);
      continue;
    }
    throw new Error(`Simulator doesn't know how to run node type: ${node.type} (node "${nodeName}")`);
  }

  return { trace, terminal };
}

async function main() {
  const failures = [];

  // "Load Fixture Tickets" is its own entry point, not behind a dedicated
  // trigger node -- a real n8n instance silently drops a workflow's second
  // n8n-nodes-base.manualTrigger node (confirmed by live import testing),
  // so the redundant "Fixture Test Trigger (A/B/C)" trigger was removed;
  // this node needs no real input and is run directly via "Execute step".
  const { trace, terminal } = await execute("Load Fixture Tickets", [{}]);
  const escalated = trace["Final: Escalate to Human Queue"] || [];
  const autoResolved = trace["Final: Auto-Resolve"] || [];
  // Since Phase 7, a live (non-fixture) ticket routes to the Product path's
  // "Real Agent 1: Classification" instead of the old "Live Ticket
  // (Awaiting Phase 7)" dead end -- fixture tickets should never reach it.
  const stuck = trace["Real Agent 1: Classification"] || [];
  const sheetsRows = terminal["Google Sheets: Log Decision"] || [];

  console.log(`Fixture run: ${escalated.length} escalated, ${autoResolved.length} auto-resolved, ${stuck.length} reaching the Product path, ${sheetsRows.length} rows reaching Google Sheets.`);

  const expectedEscalateIds = ["9999970", "9999975", "9999983", "24158082", "24157871", "24157473", "24157200", "24157609"];
  for (const id of expectedEscalateIds) {
    if (!escalated.some((e) => e.complaint_id === id)) failures.push(`Ticket ${id} did not reach Final: Escalate to Human Queue`);
  }
  const expectedAutoResolveIds = ["24157195", "24157240"];
  for (const id of expectedAutoResolveIds) {
    if (!autoResolved.some((e) => e.complaint_id === id)) failures.push(`Ticket ${id} did not reach Final: Auto-Resolve`);
  }
  if (stuck.length !== 0) failures.push(`Fixture tickets should never route to the Product path's "Real Agent 1: Classification", but ${stuck.length} did`);

  // Exactly one of the five real "escalate" tickets added after A/B/C (D)
  // genuinely trips the real regulation-index search tool; four (E/F/G/H)
  // genuinely don't -- verify the tool ran and returned exactly what's
  // documented, not a silently-stale or hand-typed value drifting from the
  // real function.
  const dResult = escalated.find((e) => e.complaint_id === "24158082");
  if (!dResult || !dResult.agents.agent3.tool_result?.found) {
    failures.push("Ticket D (24158082) should have a real, found FDCPA §1692g(b) clause fetched by Agent 3's tool");
  }
  for (const noCitationId of ["24157871", "24157473", "24157200", "24157609"]) {
    const r = escalated.find((e) => e.complaint_id === noCitationId);
    if (!r) continue;
    if (r.agents.agent3.tool_used !== false || r.agents.agent3.output.cites_regulation !== false) {
      failures.push(`Ticket ${noCitationId} should draft without citing a regulation (real regulation-index search found no match), got tool_used=${r.agents.agent3.tool_used}`);
    }
  }

  const cResult = escalated.find((e) => e.complaint_id === "9999983");
  if (cResult) {
    const siblings = cResult.agents.agent1.tool_result?.sibling_sub_issues || [];
    if (siblings.some((s) => s.toLowerCase().includes("identity theft"))) {
      failures.push("Ticket C's real taxonomy tool result unexpectedly includes an identity-theft sibling (contradicts the Phase 1 finding)");
    }
  }

  // Phase 5 ground-truth field must be present and carry the documented
  // "routine but escalated anyway" finding for all three fixtures -- not
  // silently dropped or quietly flipped.
  for (const item of escalated) {
    const gt = item.ground_truth;
    if (!gt) { failures.push(`${item.complaint_id}: missing ground_truth field on final record`); continue; }
    if (gt.cfpb_disputed_flag !== "unavailable — CFPB discontinued this field from the public API") {
      failures.push(`${item.complaint_id}: ground_truth.cfpb_disputed_flag should explicitly say the field is unavailable, got "${gt.cfpb_disputed_flag}"`);
    }
    if (gt.ground_truth_signal !== "routine" || gt.agrees_with_ground_truth !== false) {
      failures.push(`${item.complaint_id}: expected ground_truth_signal="routine" and agrees_with_ground_truth=false, got ${JSON.stringify(gt)}`);
    }
  }

  // Non-fixture ticket must route to the real Product path, not fabricate a
  // decision or dead-end. A genuine execute() run can't verify this any
  // further than confirming routing -- "Real Agent 1: Classification" makes
  // a real, paid API call the free simulator must never trigger on its own
  // (this happened once already, see the guard in runHttpRequestNode()), so
  // this is a static check of the committed connection graph instead of a
  // runtime one.
  const isFixtureFalseOutput = (workflow.connections["IF: Is Fixture Ticket?"]?.main || [])[1] || [];
  if (!isFixtureFalseOutput.some((c) => c.node === "Real Agent 1: Classification")) {
    failures.push('"IF: Is Fixture Ticket?"\'s false branch should route to "Real Agent 1: Classification", not a dead end');
  }

  // Google Sheets dedup row (spec Section 11): every processed ticket --
  // escalated or not -- must reach the Sheets node with complaint_id
  // present (the Append-or-Update matching column) and a flat, primitive
  // shape (no nested objects a real Sheets cell can't hold).
  if (sheetsRows.length !== escalated.length + autoResolved.length) {
    failures.push(`Expected ${escalated.length + autoResolved.length} rows reaching Google Sheets (all processed tickets), got ${sheetsRows.length}`);
  }
  for (const row of sheetsRows) {
    if (!row.complaint_id) failures.push(`Sheets row missing complaint_id (the dedup key): ${JSON.stringify(row)}`);
    for (const [key, val] of Object.entries(row)) {
      if (val !== null && typeof val === "object") failures.push(`Sheets row field "${key}" is a nested object, not a flat value -- Sheets can't store this: ${JSON.stringify(val)}`);
    }
  }

  if (failures.length > 0) {
    console.error("SIMULATION FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("PASS: workflow JSON, executed exactly as n8n would run it, produces the expected fixture escalations, correctly stops at the live-ticket boundary, and every processed ticket reaches Google Sheets as a flat, keyed row.");
}

main().catch((err) => {
  console.error("SIMULATION FAILED (uncaught):", err);
  process.exit(1);
});


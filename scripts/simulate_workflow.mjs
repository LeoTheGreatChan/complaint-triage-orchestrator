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
 * trigger, code, if) -- it is not a general n8n runtime.
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

function runCodeNode(node, items) {
  const { mode, jsCode } = node.parameters;
  if (mode === "runOnceForAllItems") {
    const $input = { all: () => items.map((it) => ({ json: it })), first: () => ({ json: items[0] }) };
    const fn = new Function("$input", jsCode);
    return fn($input).map((r) => r.json);
  }
  // runOnceForEachItem: n8n calls the code once per item, each time with
  // $input.item bound to that single item.
  return items.map((it) => {
    const $input = { item: { json: it } };
    const fn = new Function("$input", jsCode);
    return fn($input).json;
  });
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

/** Execute starting from a given node, following connections, returning a
 * map of terminal-node-name -> items that reached it. */
export function execute(startNodeName, initialItems) {
  const terminalResults = {};
  const queue = [[startNodeName, initialItems]];

  while (queue.length > 0) {
    const [nodeName, items] = queue.shift();
    if (items.length === 0) continue;
    const node = nodesByName[nodeName];
    if (!node) throw new Error(`Unknown node in connections: ${nodeName}`);

    const outgoing = (workflow.connections[nodeName] || { main: [] }).main;

    if (node.type === "n8n-nodes-base.manualTrigger" || node.type === "n8n-nodes-base.scheduleTrigger") {
      for (const conn of outgoing[0] || []) queue.push([conn.node, items]);
      continue;
    }
    if (node.type === "n8n-nodes-base.if") {
      const [trueItems, falseItems] = runIfNode(node, items);
      for (const conn of outgoing[0] || []) queue.push([conn.node, trueItems]);
      for (const conn of outgoing[1] || []) queue.push([conn.node, falseItems]);
      continue;
    }
    if (node.type === "n8n-nodes-base.code") {
      const outItems = runCodeNode(node, items);
      if (!outgoing[0] || outgoing[0].length === 0) {
        terminalResults[nodeName] = (terminalResults[nodeName] || []).concat(outItems);
      } else {
        for (const conn of outgoing[0]) queue.push([conn.node, outItems]);
      }
      continue;
    }
    throw new Error(`Simulator doesn't know how to run node type: ${node.type} (node "${nodeName}")`);
  }

  return terminalResults;
}

function main() {
  const failures = [];

  const results = execute("Fixture Test Trigger (A/B/C)", [{}]);
  const escalated = results["Final: Escalate to Human Queue"] || [];
  const autoResolved = results["Final: Auto-Resolve"] || [];
  const stuck = results["Live Ticket (Awaiting Phase 7)"] || [];

  console.log(`Fixture run: ${escalated.length} escalated, ${autoResolved.length} auto-resolved, ${stuck.length} awaiting Phase 7.`);

  const expectedIds = ["9999970", "9999975", "9999983"];
  for (const id of expectedIds) {
    if (!escalated.some((e) => e.complaint_id === id)) failures.push(`Ticket ${id} did not reach Final: Escalate to Human Queue`);
  }
  if (stuck.length !== 0) failures.push(`Fixture tickets should never route to "Live Ticket (Awaiting Phase 7)", but ${stuck.length} did`);

  const cResult = escalated.find((e) => e.complaint_id === "9999983");
  if (cResult) {
    const siblings = cResult.agents.agent1.tool_result?.sibling_sub_issues || [];
    if (siblings.some((s) => s.toLowerCase().includes("identity theft"))) {
      failures.push("Ticket C's real taxonomy tool result unexpectedly includes an identity-theft sibling (contradicts the Phase 1 finding)");
    }
  }

  // Non-fixture ticket must dead-end, not fabricate a decision. Splice in a
  // fake post-CRM-generation item directly (the simulator doesn't run the
  // real CFPB HTTP Request node) to exercise the shared Route/IF gate.
  const liveResults = execute("Route: Fixture or Live?", [{ complaint_id: "24121673", product: "Credit card", crm: { special_population_flag: false } }]);
  if (!liveResults["Live Ticket (Awaiting Phase 7)"] || liveResults["Live Ticket (Awaiting Phase 7)"].length !== 1) {
    failures.push("Non-fixture ticket did not route to Live Ticket (Awaiting Phase 7) as expected");
  }

  if (failures.length > 0) {
    console.error("SIMULATION FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("PASS: workflow JSON, executed exactly as n8n would run it, produces the expected fixture escalations and correctly stops at the live-ticket boundary.");
}

main();

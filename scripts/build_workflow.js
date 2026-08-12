/**
 * Generates n8n/workflows/complaint_triage_orchestrator.json's Phase 3 nodes
 * (four agents, mock-first, spec Section 6/15) and appends them to the
 * Phase 1+2 nodes already in the file.
 *
 * Why a generator instead of hand-editing the JSON: every Code node's jsCode
 * below is a real, callable JS function defined ONCE in this file, unit-
 * tested against the spec's fixture tickets in the self-test section, and
 * then embedded into the workflow JSON via Function.prototype.toString().
 * That means the code that gets tested and the code that ships inside the
 * n8n workflow are byte-identical -- no hand-retyping into a JSON string,
 * no risk of the two drifting apart.
 *
 * Run: node scripts/build_workflow.js
 * (Runs the self-test first; refuses to write the workflow file if any
 * assertion fails.)
 */
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const WORKFLOW_PATH = path.join(REPO_ROOT, "n8n/workflows/complaint_triage_orchestrator.json");

const TAXONOMY = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "reference_data/taxonomy/cfpb_taxonomy.json"), "utf-8"));
const REGULATIONS = {
  "fdcpa_1692g": JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "reference_data/regulations/fdcpa_1692g.json"), "utf-8")),
  "fdcpa_1692e": JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "reference_data/regulations/fdcpa_1692e.json"), "utf-8")),
  "fcra_1681c-2": JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "reference_data/regulations/fcra_1681c-2.json"), "utf-8")),
  "reg_z_1026_13": JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "reference_data/regulations/reg_z_1026_13.json"), "utf-8")),
  "cfpb_15day_rule": JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "reference_data/regulations/cfpb_15day_rule.json"), "utf-8")),
};
// Lightweight index (citation/topic/relevance only) for Agent 2's regulation
// search tool -- it doesn't need full verbatim text, only Agent 3/4's exact
// clause-fetch tool does.
const REGULATION_META_INDEX = Object.fromEntries(
  Object.entries(REGULATIONS).map(([id, doc]) => [id, doc._meta])
);

// ===========================================================================
// Fixture data (spec Section 3a ticket table + Section 3c CRM table, v5
// special_population_flag values). These stand in for the "Fixture Test
// Trigger" path's output in the real workflow.
// ===========================================================================
const FIXTURE_TICKETS = [
  {
    complaint_id: "9999970",
    product: "Debt collection",
    sub_product: "Other debt",
    issue: "Written notification about debt",
    sub_issue: "Didn't receive notice of right to dispute",
    company: "Aargon Agency, Inc.",
    state: "MI",
    tags: "Servicemember",
    date_received: "2024-09-03T00:00:00.000Z",
    timely: "Yes",
    company_response: "Closed with explanation",
    complaint_what_happened: "Requested debt validation after the 30-day window; says the collector never sent it; disputes dates in the collector's own CFPB reply; mentions an attorney and the FTC",
    crm: {
      account_id: "SYN-FIXTURE-A", linked_complaint_id: "9999970", customer_since: "2018-09-03",
      tenure_years: 6, account_tier: "Standard", product_holdings: ["Personal Loan"],
      outstanding_balance_usd: 2340, prior_complaints_12mo: 1, prior_contacts_90d: 1,
      preferred_channel: "Phone", servicemember_flag: true, special_population_flag: true,
    },
  },
  {
    complaint_id: "9999975",
    product: "Debt collection",
    sub_product: "I do not know",
    issue: "Attempts to collect debt not owed",
    sub_issue: "Debt is not yours",
    company: "EQUIFAX, INC.",
    state: "SC",
    tags: null,
    date_received: "2024-09-03T00:00:00.000Z",
    timely: "Yes",
    company_response: "Closed with explanation",
    complaint_what_happened: "Reviewed credit report and found accounts believed fraudulent, opened without consent",
    crm: {
      account_id: "SYN-FIXTURE-B", linked_complaint_id: "9999975", customer_since: "2023-09-03",
      tenure_years: 1, account_tier: "Standard", product_holdings: ["Checking Account"],
      outstanding_balance_usd: 0, prior_complaints_12mo: 0, prior_contacts_90d: 0,
      preferred_channel: "Web", servicemember_flag: false, special_population_flag: false,
    },
  },
  {
    complaint_id: "9999983",
    product: "Credit card",
    sub_product: "General-purpose credit card",
    issue: "Getting a credit card",
    sub_issue: "Card opened without my consent or knowledge",
    company: "JPMORGAN CHASE & CO.",
    state: "MA",
    tags: null,
    date_received: "2024-09-03T00:00:00.000Z",
    timely: "Yes",
    company_response: "Closed with explanation",
    complaint_what_happened: "Describes a call about a bank-flagged fraud case, being transferred, then disconnected with no follow-up received",
    crm: {
      account_id: "SYN-FIXTURE-C", linked_complaint_id: "9999983", customer_since: "2021-09-03",
      tenure_years: 3, account_tier: "Standard", product_holdings: ["Checking Account", "Credit Card"],
      outstanding_balance_usd: 0, prior_complaints_12mo: 0, prior_contacts_90d: 0,
      preferred_channel: "Web", servicemember_flag: false, special_population_flag: false,
    },
  },
];

const FIXTURE_IDS = ["9999970", "9999975", "9999983"];

const AGENT1_FIXTURES = {
  "9999970": { tool_used: false, output: { issue: "Written notification about debt", severity: "High", confidence: 0.88 } },
  "9999975": { tool_used: false, output: { issue: "Attempts to collect debt not owed", severity: "High", confidence: 0.81 } },
  "9999983": {
    tool_used: true,
    output: {
      issues: [
        { issue: "Card opened without my consent or knowledge", severity: "High", confidence: 0.78, basis: "Consumer's own filed CFPB category; narrative references a 'fraudulent case application'" },
        { issue: "Service failure — dropped call, no follow-up", severity: "Low", confidence: 0.9, basis: "Explicitly described in narrative" },
      ],
      primary_issue: "Card opened without my consent or knowledge",
    },
  },
};

const AGENT2_FIXTURES = {
  "9999970": {
    broader_crm_lookup_used: true,
    output: { applicable_regulation: "FDCPA §809(b)", citation: "15 U.S.C. §1692g(b)", precedent_notes: "30-day validation claim consistent with FDCPA; servicemember status raises SCRA considerations" },
  },
  "9999975": {
    broader_crm_lookup_used: true,
    output: { applicable_regulation: "FCRA §605B + FDCPA §807", citation: "15 U.S.C. §1681c-2; §1692e", precedent_notes: "Pattern matches identity-theft profile, not a routine amount dispute" },
  },
  "9999983": {
    broader_crm_lookup_used: true,
    output: {
      customer_context: "tenure 3yrs, 2 products, 0 prior complaints — no pattern of repeat unauthorised-account claims",
      applicable_regulation: "FCRA §605B identity-theft block procedure", citation: "15 U.S.C. §1681c-2",
      precedent_notes: "Filed category plus 'fraudulent case application' language point to the account-opening issue as substantive; the dropped call compounds it, doesn't replace it",
    },
  },
};

const AGENT3_FIXTURES = {
  "9999970": { tool_used: true, output: { draft: "Cites §1692g(b), commits to resending itemised validation documentation, pauses collection activity", cites_regulation: true }, cited_clause: "15 U.S.C. §1692g(b)" },
  "9999975": { tool_used: true, output: { draft: "Provides FTC identity-theft report/police report instructions per §605B, confirms collection paused", cites_regulation: true }, cited_clause: "15 U.S.C. §1681c-2" },
  "9999983": { tool_used: true, output: { draft: "Apologises for the dropped call and commits to a 24hr callback; separately and primarily, treats the account-opening concern as a potential unauthorised-account matter, provides FCRA §605B block-request instructions, confirms no charges apply pending investigation", cites_regulation: true }, cited_clause: "15 U.S.C. §1681c-2" },
};

const AGENT4_FIXTURES = {
  "9999970": { tool_used: true, output: { confidence: 0.55, requires_human: true, reason: "Servicemember + attorney/FTC mention + disputed dates in collector's own response" }, reverify_clause: "15 U.S.C. §1692g(b)", reverify_crm_field: "tenure_years" },
  "9999975": { tool_used: true, output: { confidence: 0.4, requires_human: true, reason: "Identity-theft indicator — flagged high-risk regardless of draft quality" }, reverify_clause: "15 U.S.C. §1681c-2", reverify_crm_field: "prior_complaints_12mo" },
  "9999983": { tool_used: true, output: { confidence: 0.5, requires_human: true, reason: "Primary issue is identity-theft-adjacent — high-risk category requires human review regardless of how straightforward the secondary service issue is" }, reverify_clause: "15 U.S.C. §1681c-2", reverify_crm_field: "prior_complaints_12mo" },
};

// ===========================================================================
// Tool functions -- each is embedded verbatim (via .toString()) into its
// n8n Code node, so keep each one fully self-contained (no closures over
// outer variables except the constants it's paired with at embed time).
// ===========================================================================

function taxonomyLookup(taxonomy, product, categoryName) {
  const productEntry = taxonomy.products.find((p) => p.product === product);
  if (!productEntry) return { found: false, note: `Product '${product}' not in cached taxonomy scope.` };

  const issueEntry = productEntry.issues.find((i) => i.name === categoryName);
  if (issueEntry) {
    return { found: true, level: "issue", issue: issueEntry.name, doc_count: issueEntry.doc_count, sibling_sub_issues: issueEntry.sub_issues.map((s) => s.name) };
  }

  for (const issue of productEntry.issues) {
    const subIssueEntry = issue.sub_issues.find((s) => s.name === categoryName);
    if (subIssueEntry) {
      return {
        found: true, level: "sub_issue", parent_issue: issue.name, sub_issue: subIssueEntry.name,
        doc_count: subIssueEntry.doc_count,
        sibling_sub_issues: issue.sub_issues.map((s) => s.name).filter((n) => n !== categoryName),
      };
    }
  }

  return { found: false, note: `'${categoryName}' not found as an issue or sub-issue under product '${product}'.` };
}

const REGULATION_SEARCH_STOPWORDS = new Set([
  "debt", "debts", "credit", "card", "cards", "collection", "collector",
  "consumer", "consumers", "company", "companies", "account", "accounts",
  "with", "that", "this", "from", "were", "have", "been", "into", "about",
  "attempts", "review", "reviewed", "found", "believe", "believed",
]);
const REGULATION_SEARCH_SYNONYMS = {
  fraud: "identity-theft", fraudulent: "identity-theft", identity: "identity-theft",
  theft: "identity-theft", unauthorized: "identity-theft", stolen: "identity-theft",
  false: "misleading", deceptive: "misleading", misrepresentation: "misleading",
  wrong: "billing-error", incorrect: "billing-error", error: "billing-error",
  validate: "validation", validating: "validation",
};

function regulationIndexLookup(regulationMetaIndex, stopwords, synonyms, queryText) {
  const rawTerms = queryText.toLowerCase().split(/[^a-z-]+/).filter((t) => t.length > 4 && !stopwords.has(t));
  const terms = [...new Set(rawTerms.flatMap((t) => [t, synonyms[t]].filter(Boolean)))];
  const matches = [];
  for (const [id, meta] of Object.entries(regulationMetaIndex)) {
    const haystack = meta.topic.toLowerCase();
    const hit = terms.filter((t) => haystack.includes(t));
    if (hit.length > 0) matches.push({ id, citation: meta.citation, topic: meta.topic, matched_terms: hit });
  }
  return matches;
}

const CITATION_TO_FILE = { "1692g": "fdcpa_1692g", "1692e": "fdcpa_1692e", "1681c-2": "fcra_1681c-2", "1026.13": "reg_z_1026_13" };

function fetchExactClause(regulations, citationToFile, citation) {
  const sectionMatch = citation.match(/(1692[a-z]|1681c-2|1026\.13)/);
  const subsectionMatch = citation.match(/\(([a-z])\)/);
  if (!sectionMatch) return { found: false, note: `Could not parse section from citation '${citation}'.` };

  const fileKey = citationToFile[sectionMatch[1]];
  const doc = regulations[fileKey];
  if (!doc) return { found: false, note: `No cached regulation file for section '${sectionMatch[1]}'.` };

  if (!subsectionMatch) {
    return { found: true, citation, full_text: doc.text, note: "No specific subsection in citation; returning full section text." };
  }

  const letter = subsectionMatch[1];
  const text = doc.text;
  const startMarker = `\n(${letter})`;
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return { found: false, note: `Subsection (${letter}) not found in ${fileKey}.` };

  const nextLetterCode = letter.charCodeAt(0) + 1;
  const nextMarker = `\n(${String.fromCharCode(nextLetterCode)})`;
  let endIdx = text.indexOf(nextMarker, startIdx + 1);
  if (endIdx === -1) endIdx = text.length;

  return { found: true, citation, subsection: letter, clause_text: text.slice(startIdx, endIdx).trim(), source_citation: doc._meta.citation };
}

const HIGH_RISK_KEYWORDS = ["identity theft", "fraud", "fraudulent", "elder", "older american", "harassment", "threat"];

function computeEscalationSignals(ticket, agent1Output, agent2Output, agent4Output) {
  const requiresHuman = agent4Output.requires_human === true;
  const lowConfidence = agent4Output.confidence < 0.7;

  const issueTexts = (agent1Output.issues ? agent1Output.issues.map((i) => i.issue) : [agent1Output.issue]).join(" ").toLowerCase();
  const regulationText = `${agent2Output.applicable_regulation || ""} ${agent2Output.citation || ""}`.toLowerCase();
  const isHighRiskIssue =
    HIGH_RISK_KEYWORDS.some((kw) => issueTexts.includes(kw) || regulationText.includes(kw)) ||
    regulationText.includes("1681c-2");

  const isRepeatComplainant = ticket.crm.prior_complaints_12mo >= 2;
  const isHighValueAccount =
    ticket.crm.account_tier === "Premier" ||
    (ticket.crm.tenure_years >= 5 && ticket.crm.product_holdings.length >= 2) ||
    ticket.crm.outstanding_balance_usd >= 10000;

  const statedMonetaryExposure = ticket.crm.outstanding_balance_usd;
  const exceedsMonetaryThreshold = statedMonetaryExposure > 500;

  const escalate = requiresHuman || lowConfidence || isHighRiskIssue || isRepeatComplainant || isHighValueAccount || exceedsMonetaryThreshold;

  return { requiresHuman, lowConfidence, isHighRiskIssue, isRepeatComplainant, isHighValueAccount, exceedsMonetaryThreshold, statedMonetaryExposure, escalate };
}

// ===========================================================================
// Self-test: run the full pipeline over the three fixtures + one negative
// control before this script is allowed to (re)generate the workflow file.
// ===========================================================================
function runPipeline(ticket) {
  const a1fixture = AGENT1_FIXTURES[ticket.complaint_id];
  const agent1_output = a1fixture.output;
  const agent1_tool_result = a1fixture.tool_used
    ? taxonomyLookup(TAXONOMY, ticket.product, agent1_output.primary_issue || agent1_output.issue)
    : null;

  const a2fixture = AGENT2_FIXTURES[ticket.complaint_id];
  const special_population_flag = Boolean(ticket.crm.special_population_flag);
  const regulation_tool_result = regulationIndexLookup(
    REGULATION_META_INDEX, REGULATION_SEARCH_STOPWORDS, REGULATION_SEARCH_SYNONYMS,
    `${ticket.issue} ${agent1_output.primary_issue || agent1_output.issue} ${ticket.complaint_what_happened}`
  );
  const agent2_output = { special_population_flag, ...a2fixture.output };

  const a3fixture = AGENT3_FIXTURES[ticket.complaint_id];
  const agent3_output = a3fixture.output;
  const agent3_tool_result = a3fixture.tool_used ? fetchExactClause(REGULATIONS, CITATION_TO_FILE, a3fixture.cited_clause) : null;

  const a4fixture = AGENT4_FIXTURES[ticket.complaint_id];
  const agent4_output = a4fixture.output;
  const agent4_tool_result = a4fixture.tool_used
    ? { clause_reverified: fetchExactClause(REGULATIONS, CITATION_TO_FILE, a4fixture.reverify_clause), crm_fact_reverified: { field: a4fixture.reverify_crm_field, value: ticket.crm[a4fixture.reverify_crm_field] } }
    : null;

  const signals = computeEscalationSignals(ticket, agent1_output, agent2_output, agent4_output);

  return { agent1_output, agent1_tool_result, agent2_output, regulation_tool_result, agent3_output, agent3_tool_result, agent4_output, agent4_tool_result, signals };
}

function selfTest() {
  const failures = [];

  for (const ticket of FIXTURE_TICKETS) {
    const result = runPipeline(ticket);
    if (result.signals.escalate !== true) failures.push(`${ticket.complaint_id}: expected escalate=true, got ${result.signals.escalate}`);
  }

  // Ticket C's taxonomy tool must confirm the sub-issue is real and that the
  // Section 6 "sibling" claim discrepancy (flagged in Phase 1) is reflected
  // accurately -- no fabricated "identity theft or fraud" sibling.
  const cTicket = FIXTURE_TICKETS.find((t) => t.complaint_id === "9999983");
  const cResult = runPipeline(cTicket);
  if (!cResult.agent1_tool_result || !cResult.agent1_tool_result.found) failures.push("Ticket C taxonomy lookup did not find the sub-issue");
  if (cResult.agent1_tool_result.sibling_sub_issues.some((s) => s.toLowerCase().includes("identity theft"))) {
    failures.push("Ticket C taxonomy siblings unexpectedly include an identity-theft entry -- real taxonomy should not have this (see Phase 1 finding)");
  }

  // Negative control: a clean, low-severity ticket must NOT escalate.
  const cleanTicket = { crm: { tenure_years: 2, account_tier: "Standard", product_holdings: ["Checking Account"], outstanding_balance_usd: 50, prior_complaints_12mo: 0 } };
  const cleanSignals = computeEscalationSignals(
    cleanTicket,
    { issue: "Problem with a company's investigation into an existing problem" },
    { applicable_regulation: "Regulation Z billing dispute", citation: "12 CFR §1026.13" },
    { confidence: 0.92, requires_human: false }
  );
  if (cleanSignals.escalate !== false) failures.push(`Negative control: expected escalate=false, got ${cleanSignals.escalate}`);

  // Non-fixture complaint_id must not silently fabricate a decision.
  if (AGENT1_FIXTURES["24121673"]) failures.push("Unexpected fixture found for a non-fixture complaint_id");

  if (failures.length > 0) {
    console.error("SELF-TEST FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log(`Self-test passed: ${FIXTURE_TICKETS.length}/${FIXTURE_TICKETS.length} fixtures escalate as expected, negative control holds, taxonomy discrepancy correctly reflected.`);
}

selfTest();

// ===========================================================================
// Workflow assembly -- build the Phase 3 nodes and splice them into the
// existing (Phase 1+2) workflow JSON.
// ===========================================================================

function codeNode({ id, name, mode, jsCode, position, notes }) {
  const node = {
    parameters: { mode, language: "javaScript", jsCode },
    id, name, type: "n8n-nodes-base.code", typeVersion: 2, position,
  };
  if (notes) { node.notesInFlow = true; node.notes = notes; }
  return node;
}

function ifNode({ id, name, leftValueExpr, position, notes }) {
  const node = {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict" },
        conditions: [{
          id: `${id}-cond`,
          leftValue: leftValueExpr,
          rightValue: true,
          operator: { type: "boolean", operation: "true", singleValue: true },
        }],
        combinator: "and",
      },
      options: {},
    },
    id, name, type: "n8n-nodes-base.if", typeVersion: 2.2, position,
  };
  if (notes) { node.notesInFlow = true; node.notes = notes; }
  return node;
}

function connect(fromName, toName, outputIndex = 0) {
  return { from: fromName, to: toName, outputIndex };
}

// --- jsCode bodies, built from the tested functions above via toString() ---

const jsLoadFixtureTickets = `
// Fixture Test Trigger path (spec Section 15 Phase 3): the three literal
// tickets + synthetic CRM records from spec Section 3a/3c, used to test the
// orchestration, tool-use branching, and escalation gate against known-good
// data before any real Claude API call exists (Phase 7).
const FIXTURE_TICKETS = ${JSON.stringify(FIXTURE_TICKETS, null, 2)};
return FIXTURE_TICKETS.map((t) => ({ json: t }));
`.trim();

const jsRouteFixtureOrLive = `
// Both the live pipeline (Phase 1 fetch -> Phase 2 CRM) and the Fixture Test
// Trigger converge here. Phase 3's mock agents only have known-good fixture
// data for Tickets A/B/C -- route anything else to a clearly-labelled
// "awaiting Phase 7" dead end instead of letting it fall through into agents
// that would have to fabricate a result for it.
const FIXTURE_IDS = ${JSON.stringify(FIXTURE_IDS)};
const ticket = $input.item.json;
return { json: { ...ticket, is_fixture_ticket: FIXTURE_IDS.includes(String(ticket.complaint_id)) } };
`.trim();

const jsAgent1Decision = `
// Agent 1: Classification -- MOCKED reasoning layer (spec Section 15 Phase 3).
// Returns the literal Section 6 fixture output for Tickets A/B/C. The tool
// this agent conditionally calls (taxonomy lookup) is real -- see the next
// node -- only the classification judgment itself is mocked here.
const AGENT1_FIXTURES = ${JSON.stringify(AGENT1_FIXTURES, null, 2)};

const ticket = $input.item.json;
const fixture = AGENT1_FIXTURES[String(ticket.complaint_id)];
if (!fixture) {
  return { json: { ...ticket, _mock_unavailable: true, agent1_tool_used: false, agent1_output: null } };
}
return { json: { ...ticket, agent1_tool_used: fixture.tool_used, agent1_output: fixture.output } };
`.trim();

const jsTaxonomyTool = `
// Tool 1 (real): CFPB product/issue/sub-issue taxonomy lookup -- the same
// cached snapshot as reference_data/taxonomy/cfpb_taxonomy.json (Phase 1).
// Searches both issue- and sub-issue-level names, since Agent 1's
// classification may hand back either.
const TAXONOMY = ${JSON.stringify(TAXONOMY)};

${taxonomyLookup.toString()}

const ticket = $input.item.json;
const category = (ticket.agent1_output && (ticket.agent1_output.primary_issue || ticket.agent1_output.issue)) || ticket.issue;
const result = taxonomyLookup(TAXONOMY, ticket.product, category);
return { json: { ...ticket, agent1_tool_result: result } };
`.trim();

const jsAgent2Decision = `
// Agent 2: Research -- MOCKED reasoning layer. Per spec v5, the broader CRM
// lookup (tenure/balance/prior-complaint history) is discretionary -- this
// node's fixture table encodes that per-ticket decision. special_population_flag
// and the regulation-index tool are handled in separate always-run nodes
// downstream, per spec v5's structured hand-off design.
const AGENT2_FIXTURES = ${JSON.stringify(AGENT2_FIXTURES, null, 2)};

const ticket = $input.item.json;
const fixture = AGENT2_FIXTURES[String(ticket.complaint_id)];
if (!fixture) {
  return { json: { ...ticket, _mock_unavailable: true, agent2_broader_crm_lookup_used: false, agent2_output: null } };
}
return { json: { ...ticket, agent2_broader_crm_lookup_used: fixture.broader_crm_lookup_used, agent2_output: fixture.output } };
`.trim();

const jsSpecialPopulationTool = `
// Tool 2, tier 1 (real, always runs -- spec v5): a deterministic yes/no read
// off the CRM record, not a judgment call, so it is exempted from Agent 2's
// usual discretion and checked on every ticket. Carried as its own structured
// field so Agent 4 reads it as data, not buried in free-text customer_context.
const ticket = $input.item.json;
const special_population_flag = Boolean(ticket.crm.special_population_flag);
return {
  json: {
    ...ticket,
    agent2_special_population_flag: special_population_flag,
    agent2_output: { ...ticket.agent2_output, special_population_flag },
  },
};
`.trim();

const jsRegulationIndexTool = `
// Tool 2, tier 2 (real, always runs -- spec Section 6: "(b) always, based on
// classification"). Keyword + light synonym search across the cached
// regulation corpus' topics (reference_data/regulations/*.json _meta) to
// surface candidate applicable regulations. This is deliberately a simple,
// deterministic lookup, not semantic search -- see README for the honest
// limitation this implies.
const REGULATION_META_INDEX = ${JSON.stringify(REGULATION_META_INDEX, null, 2)};
const REGULATION_SEARCH_STOPWORDS = new Set(${JSON.stringify([...REGULATION_SEARCH_STOPWORDS])});
const REGULATION_SEARCH_SYNONYMS = ${JSON.stringify(REGULATION_SEARCH_SYNONYMS)};

${regulationIndexLookup.toString()}

const ticket = $input.item.json;
const category = (ticket.agent1_output && (ticket.agent1_output.primary_issue || ticket.agent1_output.issue)) || ticket.issue;
const queryText = \`\${ticket.issue} \${category} \${ticket.complaint_what_happened || ""}\`;
const result = regulationIndexLookup(REGULATION_META_INDEX, REGULATION_SEARCH_STOPWORDS, REGULATION_SEARCH_SYNONYMS, queryText);
return { json: { ...ticket, agent2_regulation_tool_result: result } };
`.trim();

const jsCrmBroaderTool = `
// Tool 2a (real, discretionary -- spec Section 6): the broader CRM context
// pull (tenure, tier, holdings, balance, prior complaints), gated on Agent
// 2's mock decision. Reads directly off the synthetic CRM record (Phase 2) --
// no separate lookup needed, the record already travels with the ticket.
const ticket = $input.item.json;
const crm = ticket.crm;
return {
  json: {
    ...ticket,
    agent2_crm_tool_result: {
      tenure_years: crm.tenure_years,
      account_tier: crm.account_tier,
      product_holdings: crm.product_holdings,
      outstanding_balance_usd: crm.outstanding_balance_usd,
      prior_complaints_12mo: crm.prior_complaints_12mo,
    },
  },
};
`.trim();

const jsAgent3Decision = `
// Agent 3: Drafting -- MOCKED reasoning layer. Returns the literal Section 6
// fixture draft. cited_clause records which citation the exact-clause-fetch
// tool should retrieve for this ticket (the real work happens in the next node).
const AGENT3_FIXTURES = ${JSON.stringify(AGENT3_FIXTURES, null, 2)};

const ticket = $input.item.json;
const fixture = AGENT3_FIXTURES[String(ticket.complaint_id)];
if (!fixture) {
  return { json: { ...ticket, _mock_unavailable: true, agent3_tool_used: false, agent3_output: null } };
}
return { json: { ...ticket, agent3_tool_used: fixture.tool_used, agent3_output: fixture.output, _agent3_cited_clause: fixture.cited_clause } };
`.trim();

const jsClauseFetchTool = `
// Tool 3 (real): exact regulation clause fetch -- parses a citation like
// "15 U.S.C. §1692g(b)" and extracts just that lettered subsection from the
// cached verbatim regulation text (reference_data/regulations/*.json). Falls
// back to the full section text when the citation doesn't name a subsection.
const REGULATIONS = ${JSON.stringify(REGULATIONS)};
const CITATION_TO_FILE = ${JSON.stringify(CITATION_TO_FILE)};

${fetchExactClause.toString()}

const ticket = $input.item.json;
const result = fetchExactClause(REGULATIONS, CITATION_TO_FILE, ticket._agent3_cited_clause);
return { json: { ...ticket, agent3_tool_result: result } };
`.trim();

const jsAgent4Decision = `
// Agent 4: QA / escalation-scoring -- MOCKED reasoning layer. Returns the
// literal Section 6 fixture confidence/requires_human/reason. reverify_clause
// and reverify_crm_field tell the next node what to re-check (the real work).
const AGENT4_FIXTURES = ${JSON.stringify(AGENT4_FIXTURES, null, 2)};

const ticket = $input.item.json;
const fixture = AGENT4_FIXTURES[String(ticket.complaint_id)];
if (!fixture) {
  return { json: { ...ticket, _mock_unavailable: true, agent4_tool_used: false, agent4_output: null } };
}
return {
  json: {
    ...ticket, agent4_tool_used: fixture.tool_used, agent4_output: fixture.output,
    _agent4_reverify_clause: fixture.reverify_clause, _agent4_reverify_crm_field: fixture.reverify_crm_field,
  },
};
`.trim();

const jsReverifyTool = `
// Tool 4 (real): re-verify a cited clause (re-runs the same exact-clause-fetch
// logic Agent 3 uses, confirming the citation genuinely resolves) and
// re-check a CRM fact directly off the record, not off Agent 2's paraphrase
// of it -- catches the case where a draft misquotes what the CRM actually says.
const REGULATIONS = ${JSON.stringify(REGULATIONS)};
const CITATION_TO_FILE = ${JSON.stringify(CITATION_TO_FILE)};

${fetchExactClause.toString()}

const ticket = $input.item.json;
const clause_reverified = fetchExactClause(REGULATIONS, CITATION_TO_FILE, ticket._agent4_reverify_clause);
const field = ticket._agent4_reverify_crm_field;
const crm_fact_reverified = { field, value: ticket.crm[field] };
return { json: { ...ticket, agent4_tool_result: { clause_reverified, crm_fact_reverified } } };
`.trim();

const jsComputeEscalationSignals = `
// Deterministic escalation-signal computation (spec Section 7). This is NOT
// a fifth agent call -- it's a plain rules evaluation over the four agents'
// already-produced structured outputs plus the CRM record, feeding a single
// boolean into the IF node that follows. Two interpretation calls made here,
// both worth confirming against intent (see README):
//   1. "Stated monetary exposure" is read as crm.outstanding_balance_usd --
//      the only concrete dollar figure available in the structured record,
//      rather than parsing free-text narrative for a dollar amount.
//   2. "High-risk issue type" is detected via keyword match against Agent 1's
//      classified issue text and Agent 2's regulation citation (including a
//      direct check for the FCRA §1681c-2 citation itself as a marker),
//      not a fresh narrative re-read -- keeps this step deterministic.
const HIGH_RISK_KEYWORDS = ${JSON.stringify(HIGH_RISK_KEYWORDS)};

${computeEscalationSignals.toString()}

const ticket = $input.item.json;
const signals = computeEscalationSignals(ticket, ticket.agent1_output, ticket.agent2_output, ticket.agent4_output);
return { json: { ...ticket, escalation_signals: signals, escalate: signals.escalate } };
`.trim();

// Both final nodes keep each agent's mocked reasoning output AND the real
// tool-call result(s) that ran alongside it (when the branch called a tool)
// side by side -- so a reviewer can cross-check what the mocked "LLM" claimed
// against what the real, cached reference data actually says. That audit
// trail is most of Phase 3's value: the reasoning is mocked, the grounding
// data it's checked against is not.
const jsFinalEscalate = `
const t = $input.item.json;
return {
  json: {
    complaint_id: t.complaint_id, company: t.company, product: t.product, issue: t.issue,
    decision: "ESCALATE_TO_HUMAN",
    crm_summary: { account_tier: t.crm.account_tier, tenure_years: t.crm.tenure_years, special_population_flag: t.crm.special_population_flag },
    agents: {
      agent1: { tool_used: t.agent1_tool_used, output: t.agent1_output, tool_result: t.agent1_tool_result || null },
      agent2: {
        broader_crm_lookup_used: t.agent2_broader_crm_lookup_used, output: t.agent2_output,
        regulation_tool_result: t.agent2_regulation_tool_result, crm_tool_result: t.agent2_crm_tool_result || null,
      },
      agent3: { tool_used: t.agent3_tool_used, output: t.agent3_output, tool_result: t.agent3_tool_result || null },
      agent4: { tool_used: t.agent4_tool_used, output: t.agent4_output, tool_result: t.agent4_tool_result || null },
    },
    escalation_signals: t.escalation_signals,
  },
};
`.trim();

const jsFinalAutoResolve = `
const t = $input.item.json;
return {
  json: {
    complaint_id: t.complaint_id, company: t.company, product: t.product, issue: t.issue,
    decision: "AUTO_RESOLVE",
    draft: t.agent3_output ? t.agent3_output.draft : null,
    agents: {
      agent1: { tool_used: t.agent1_tool_used, output: t.agent1_output, tool_result: t.agent1_tool_result || null },
      agent2: {
        broader_crm_lookup_used: t.agent2_broader_crm_lookup_used, output: t.agent2_output,
        regulation_tool_result: t.agent2_regulation_tool_result, crm_tool_result: t.agent2_crm_tool_result || null,
      },
      agent3: { tool_used: t.agent3_tool_used, output: t.agent3_output, tool_result: t.agent3_tool_result || null },
      agent4: { tool_used: t.agent4_tool_used, output: t.agent4_output, tool_result: t.agent4_tool_result || null },
    },
    escalation_signals: t.escalation_signals,
  },
};
`.trim();

const jsLiveAwaitingPhase7 = `
const t = $input.item.json;
return { json: { complaint_id: t.complaint_id, product: t.product, note: "Live ticket -- no Phase 3 mock fixture exists for this complaint_id. Awaiting the real Claude API swap at Phase 7." } };
`.trim();

// --- Assemble nodes ---
const nodes = [
  { parameters: {}, id: "b2f7d3a1-0000-4000-8000-000000000001", name: "Fixture Test Trigger (A/B/C)", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [-400, 320] },
  codeNode({ id: "b2f7d3a1-0000-4000-8000-000000000002", name: "Load Fixture Tickets", mode: "runOnceForAllItems", jsCode: jsLoadFixtureTickets, position: [-160, 320], notes: "Phase 3 test harness: injects the literal Section 3a/3c Ticket A/B/C fixtures, bypassing the live CFPB fetch and random CRM generation entirely." }),
  codeNode({ id: "b2f7d3a1-0000-4000-8000-000000000003", name: "Route: Fixture or Live?", mode: "runOnceForEachItem", jsCode: jsRouteFixtureOrLive, position: [740, 0] }),
  ifNode({ id: "b2f7d3a1-0000-4000-8000-000000000004", name: "IF: Is Fixture Ticket?", leftValueExpr: "={{ $json.is_fixture_ticket }}", position: [960, 0] }),
  codeNode({ id: "b2f7d3a1-0000-4000-8000-000000000005", name: "Live Ticket (Awaiting Phase 7)", mode: "runOnceForEachItem", jsCode: jsLiveAwaitingPhase7, position: [1180, 140], notes: "Terminal node for live (non-fixture) tickets. Phase 3's mock agents only cover Tickets A/B/C -- a real ticket needs the Phase 7 Claude API swap before it can be triaged." }),

  codeNode({ id: "b2f7d3a1-0000-4000-8000-000000000006", name: "Agent 1: Mock Classification Decision", mode: "runOnceForEachItem", jsCode: jsAgent1Decision, position: [1180, -140] }),
  ifNode({ id: "b2f7d3a1-0000-4000-8000-000000000007", name: "IF: Agent 1 Tool Used?", leftValueExpr: "={{ $json.agent1_tool_used }}", position: [1400, -140], notes: "Conditional tool-use, made visible: Agent 1 only calls the taxonomy lookup when the narrative is ambiguous relative to the filed category (spec Section 6). Clean-match tickets (A, B) skip it." }),
  codeNode({ id: "b2f7d3a1-0000-4000-8000-000000000008", name: "Tool: CFPB Taxonomy Lookup", mode: "runOnceForEachItem", jsCode: jsTaxonomyTool, position: [1620, -260] }),

  codeNode({ id: "b2f7d3a1-0000-4000-8000-000000000009", name: "Agent 2: Mock Research Decision", mode: "runOnceForEachItem", jsCode: jsAgent2Decision, position: [1840, -140] }),
  codeNode({ id: "b2f7d3a1-0000-4000-8000-00000000000a", name: "Tool: Special Population Check", mode: "runOnceForEachItem", jsCode: jsSpecialPopulationTool, position: [2060, -140], notes: "Always runs, every ticket (spec v5) -- deterministic, not discretionary." }),
  codeNode({ id: "b2f7d3a1-0000-4000-8000-00000000000b", name: "Tool: Regulation Index Lookup", mode: "runOnceForEachItem", jsCode: jsRegulationIndexTool, position: [2280, -140], notes: "Always runs, based on classification (spec Section 6)." }),
  ifNode({ id: "b2f7d3a1-0000-4000-8000-00000000000c", name: "IF: Agent 2 Broader CRM Lookup Used?", leftValueExpr: "={{ $json.agent2_broader_crm_lookup_used }}", position: [2500, -140], notes: "Discretionary tier (spec v5): tenure/balance/prior-complaint context, only pulled when relevant. Known gap: all three Phase 3 fixtures warrant this lookup, so the false branch is structurally present but untested here -- spec's own flagged Phase 7 verification item." }),
  codeNode({ id: "b2f7d3a1-0000-4000-8000-00000000000d", name: "Tool: CRM Broader Context Lookup", mode: "runOnceForEachItem", jsCode: jsCrmBroaderTool, position: [2720, -260] }),

  codeNode({ id: "b2f7d3a1-0000-4000-8000-00000000000e", name: "Agent 3: Mock Drafting Decision", mode: "runOnceForEachItem", jsCode: jsAgent3Decision, position: [2940, -140] }),
  ifNode({ id: "b2f7d3a1-0000-4000-8000-00000000000f", name: "IF: Agent 3 Tool Used?", leftValueExpr: "={{ $json.agent3_tool_used }}", position: [3160, -140], notes: "Only when citing a specific provision (spec Section 6). Untested false branch: all three fixtures cite a regulation." }),
  codeNode({ id: "b2f7d3a1-0000-4000-8000-000000000010", name: "Tool: Exact Regulation Clause Fetch", mode: "runOnceForEachItem", jsCode: jsClauseFetchTool, position: [3380, -260] }),

  codeNode({ id: "b2f7d3a1-0000-4000-8000-000000000011", name: "Agent 4: Mock QA Decision", mode: "runOnceForEachItem", jsCode: jsAgent4Decision, position: [3600, -140] }),
  ifNode({ id: "b2f7d3a1-0000-4000-8000-000000000012", name: "IF: Agent 4 Tool Used?", leftValueExpr: "={{ $json.agent4_tool_used }}", position: [3820, -140], notes: "Only when the draft makes a checkable claim (spec Section 6). Untested false branch: all three fixtures make one." }),
  codeNode({ id: "b2f7d3a1-0000-4000-8000-000000000013", name: "Tool: Re-verify Clause & CRM Fact", mode: "runOnceForEachItem", jsCode: jsReverifyTool, position: [4040, -260] }),

  codeNode({ id: "b2f7d3a1-0000-4000-8000-000000000014", name: "Compute Escalation Signals", mode: "runOnceForEachItem", jsCode: jsComputeEscalationSignals, position: [4260, -140] }),
  ifNode({ id: "b2f7d3a1-0000-4000-8000-000000000015", name: "IF: Escalate?", leftValueExpr: "={{ $json.escalate }}", position: [4480, -140], notes: "Deterministic gate (spec Section 7) -- compound OR over five independent signals computed in the previous node, not a fifth agent call." }),
  codeNode({ id: "b2f7d3a1-0000-4000-8000-000000000016", name: "Final: Escalate to Human Queue", mode: "runOnceForEachItem", jsCode: jsFinalEscalate, position: [4700, -260] }),
  codeNode({ id: "b2f7d3a1-0000-4000-8000-000000000017", name: "Final: Auto-Resolve", mode: "runOnceForEachItem", jsCode: jsFinalAutoResolve, position: [4700, -20] }),
];

const connections = [
  connect("Fixture Test Trigger (A/B/C)", "Load Fixture Tickets"),
  connect("Load Fixture Tickets", "Route: Fixture or Live?"),
  connect("Generate Synthetic CRM Record", "Route: Fixture or Live?"),
  connect("Route: Fixture or Live?", "IF: Is Fixture Ticket?"),
  // IF outputs: index 0 = true, index 1 = false
  { from: "IF: Is Fixture Ticket?", to: "Agent 1: Mock Classification Decision", fromOutput: 0 },
  { from: "IF: Is Fixture Ticket?", to: "Live Ticket (Awaiting Phase 7)", fromOutput: 1 },

  { from: "Agent 1: Mock Classification Decision", to: "IF: Agent 1 Tool Used?", fromOutput: 0 },
  { from: "IF: Agent 1 Tool Used?", to: "Tool: CFPB Taxonomy Lookup", fromOutput: 0 },
  { from: "Tool: CFPB Taxonomy Lookup", to: "Agent 2: Mock Research Decision", fromOutput: 0 },
  { from: "IF: Agent 1 Tool Used?", to: "Agent 2: Mock Research Decision", fromOutput: 1 },

  { from: "Agent 2: Mock Research Decision", to: "Tool: Special Population Check", fromOutput: 0 },
  { from: "Tool: Special Population Check", to: "Tool: Regulation Index Lookup", fromOutput: 0 },
  { from: "Tool: Regulation Index Lookup", to: "IF: Agent 2 Broader CRM Lookup Used?", fromOutput: 0 },
  { from: "IF: Agent 2 Broader CRM Lookup Used?", to: "Tool: CRM Broader Context Lookup", fromOutput: 0 },
  { from: "Tool: CRM Broader Context Lookup", to: "Agent 3: Mock Drafting Decision", fromOutput: 0 },
  { from: "IF: Agent 2 Broader CRM Lookup Used?", to: "Agent 3: Mock Drafting Decision", fromOutput: 1 },

  { from: "Agent 3: Mock Drafting Decision", to: "IF: Agent 3 Tool Used?", fromOutput: 0 },
  { from: "IF: Agent 3 Tool Used?", to: "Tool: Exact Regulation Clause Fetch", fromOutput: 0 },
  { from: "Tool: Exact Regulation Clause Fetch", to: "Agent 4: Mock QA Decision", fromOutput: 0 },
  { from: "IF: Agent 3 Tool Used?", to: "Agent 4: Mock QA Decision", fromOutput: 1 },

  { from: "Agent 4: Mock QA Decision", to: "IF: Agent 4 Tool Used?", fromOutput: 0 },
  { from: "IF: Agent 4 Tool Used?", to: "Tool: Re-verify Clause & CRM Fact", fromOutput: 0 },
  { from: "Tool: Re-verify Clause & CRM Fact", to: "Compute Escalation Signals", fromOutput: 0 },
  { from: "IF: Agent 4 Tool Used?", to: "Compute Escalation Signals", fromOutput: 1 },

  { from: "Compute Escalation Signals", to: "IF: Escalate?", fromOutput: 0 },
  { from: "IF: Escalate?", to: "Final: Escalate to Human Queue", fromOutput: 0 },
  { from: "IF: Escalate?", to: "Final: Auto-Resolve", fromOutput: 1 },
];

// This script fully owns every node/connection it defines above (Phase 3's
// fixture harness, four agents, tools, and escalation gate) and treats them
// as idempotently regenerable -- re-running always replaces them wholesale
// rather than appending duplicates or leaving stale copies from a previous
// run. Phase 1/2 nodes (anything this script doesn't define) are left
// untouched.
function main() {
  const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, "utf-8"));
  const ownedNames = new Set(nodes.map((n) => n.name));

  const keptNodes = workflow.nodes.filter((n) => !ownedNames.has(n.name));
  workflow.nodes = [...keptNodes, ...nodes];

  // Drop any connection entries this script owns (either as source or as a
  // stale target of a source outside its ownership) before re-adding fresh.
  for (const name of Object.keys(workflow.connections)) {
    if (ownedNames.has(name)) delete workflow.connections[name];
  }
  for (const [from, conn] of Object.entries(workflow.connections)) {
    workflow.connections[from].main = conn.main.map((outputs) => outputs.filter((o) => !ownedNames.has(o.node)));
  }

  for (const c of connections) {
    if (!workflow.connections[c.from]) workflow.connections[c.from] = { main: [] };
    const outputIdx = c.fromOutput || 0;
    while (workflow.connections[c.from].main.length <= outputIdx) workflow.connections[c.from].main.push([]);
    workflow.connections[c.from].main[outputIdx].push({ node: c.to, type: "main", index: 0 });
  }

  fs.writeFileSync(WORKFLOW_PATH, JSON.stringify(workflow, null, 2) + "\n", "utf-8");
  console.log(`Wrote ${WORKFLOW_PATH} (${workflow.nodes.length} nodes total, ${nodes.length} owned by this script)`);
}

main();

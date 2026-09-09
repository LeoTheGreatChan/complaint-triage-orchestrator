/**
 * Phase 8 addendum Section 7 build phase 6: KPI measurement, lexical vs.
 * semantic retrieval, run against the hand-verified held-out set
 * (eval/held_out_test_set.json).
 *
 * Reuses the REAL production code for both tools rather than
 * reimplementing them -- regulationIndexLookup and its constants are
 * require()'d directly from scripts/build_workflow.js (the exact function
 * whose .toString() gets embedded into the live n8n "Tool: Real Regulation
 * Index Lookup" node), and semanticRetrieve from rag/retrieve.js (embedded
 * the same way into "Tool: Real Semantic Regulation Retrieval"). A pass or
 * fail here is evidence about the shipped tools, not a separate
 * reimplementation that could quietly drift from what's actually live.
 *
 * Query construction matches jsRegulationIndexTool's real formula exactly
 * (`${issue} ${category} ${complaint_what_happened}`, category falling back
 * to issue when there's no Agent 1 classification available -- true for
 * every held-out ticket here, since they were never run through the live
 * pipeline by design).
 *
 * Makes one real Voyage embedding call per ticket (input_type: query, same
 * as the live Voyage node) -- ~18 calls, throttled to one per ~21s by
 * rag/embed.mjs, so this takes several minutes to run. The lexical tool
 * makes no API calls at all.
 *
 * KPIs measured (addendum Section 3):
 *   1. Retrieval recall -- of tickets with a real applicable regulation
 *      (ground_truth.applicable_regulation is not null), % where the
 *      correct section appears in the tool's results (semantic: reported
 *      at k=1 and k=3, since it returns a ranked top-3; lexical: reported
 *      unranked, since regulationIndexLookup returns unordered matches with
 *      no score to rank by -- there's no meaningful "top-1" to isolate).
 *   2. Paraphrase robustness -- addendum Section 3 defines this as recall
 *      measured specifically on the held-out set. Since this script's ONLY
 *      test set already IS the held-out set, this is the SAME number as
 *      KPI 1 in this run, not a second measurement -- stated explicitly
 *      rather than silently duplicated as if it were independent evidence.
 *   3. Downstream citation-accuracy rate -- addendum Section 7 describes
 *      this as "re-measured with the new tool feeding Agent 2/3." That
 *      premise doesn't hold under the pipeline as actually built (see
 *      addendum Section 2 / this project's own Phase 8 build phase 2
 *      finding): Real Agent 2's own LLM call runs FIRST and produces
 *      applicable_regulation/citation from its own reasoning; BOTH the
 *      lexical and semantic tools run AFTER, as an independent post-hoc
 *      cross-check, and neither one's output is ever fed back into Agent
 *      2's or Agent 3's prompt. Swapping lexical for semantic therefore
 *      cannot change Agent 3's draft citation or the citation-accuracy
 *      number already reported for Phases 1-7 -- re-running the full
 *      4-agent pipeline on 18 tickets (real cost, ~70+ Claude calls) would
 *      only reconfirm that architectural fact, not produce a new one. This
 *      script reports that finding directly instead of spending real API
 *      cost to demonstrate something already knowable from the wiring.
 *   4. False-positive rate -- of tickets with NO real applicable regulation
 *      (ground_truth.applicable_regulation is null), % where the tool
 *      returned a confident result anyway. Lexical has no confidence score
 *      (any match is reported), so "false positive" there means "returned
 *      any match at all." Semantic always returns its top-k by construction
 *      (nearest-neighbor search never returns nothing), so "false positive"
 *      needs a similarity threshold -- this script reports the RAW top-1
 *      similarity distribution for both the true-positive and true-negative
 *      tickets in this run and derives a threshold from where they actually
 *      separate, rather than asserting an arbitrary cutoff decided before
 *      seeing the data.
 *
 * Usage:
 *   node eval/measure_kpis.mjs
 *
 * Output: eval/kpi_results.json (full per-ticket comparison + aggregates),
 * plus a human-readable summary printed to stdout.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { embed } from "../rag/embed.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const {
  REGULATION_META_INDEX,
  REGULATION_SEARCH_STOPWORDS,
  REGULATION_SEARCH_SYNONYMS,
  REGULATION_SEARCH_PHRASE_SYNONYMS,
  regulationIndexLookup,
} = require(path.join(REPO_ROOT, "scripts/build_workflow.js"));

const { semanticRetrieve } = require(path.join(REPO_ROOT, "rag/retrieve.js"));

const TEST_SET_PATH = path.join(REPO_ROOT, "eval/held_out_test_set.json");
const CORPUS_PATH = path.join(REPO_ROOT, "rag/corpus/regulation_chunks.json");
const OUT_PATH = path.join(REPO_ROOT, "eval/kpi_results.json");
const SEMANTIC_TOP_K = 3; // matches production's jsSemanticRegulationTool

function loadEnvFile() {
  const envPath = path.join(REPO_ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Same query-construction formula as jsRegulationIndexTool in
// scripts/build_workflow.js -- category falls back to ticket.issue because
// none of these held-out tickets carry an agent1_output (they were never
// run through the live pipeline).
function buildQueryText(ticket) {
  const category = ticket.issue;
  return `${ticket.issue} ${category} ${ticket.complaint_what_happened || ""}`;
}

// Pulls out the distinguishing section identifier (e.g. "1692g", "1681c-2",
// "1026.13") from a citation string, ignoring the "15 U.S.C. §" / "12 CFR §"
// prefix and any trailing sub-clause parenthetical -- lets a document-level
// lexical citation ("15 U.S.C. §1692g"), a clause-level semantic citation
// ("15 U.S.C. §1692g(a)"), and a prefix-omitting compound ground-truth
// citation ("15 U.S.C. §1692g; §1692e") all compare on the same key.
function sectionKey(citation) {
  if (!citation) return null;
  const m = citation.match(/(\d{3,4}(?:\.\d+)?[a-z]?(?:-\d+)?)/i);
  return m ? m[1].toLowerCase() : null;
}

function groundTruthSectionKeys(groundTruth) {
  if (!groundTruth.citation) return [];
  return [...new Set(groundTruth.citation.split(";").map((c) => sectionKey(c.trim())).filter(Boolean))];
}

async function main() {
  loadEnvFile();

  const testSet = JSON.parse(fs.readFileSync(TEST_SET_PATH, "utf-8"));
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf-8"));

  const perTicket = [];

  for (const ticket of testSet.tickets) {
    const gtKeys = groundTruthSectionKeys(ticket.ground_truth);
    const isPositive = gtKeys.length > 0;
    const queryText = buildQueryText(ticket);

    // --- Lexical (no API call, no ranking) ---
    const lexicalMatches = regulationIndexLookup(
      REGULATION_META_INDEX,
      REGULATION_SEARCH_STOPWORDS,
      REGULATION_SEARCH_SYNONYMS,
      REGULATION_SEARCH_PHRASE_SYNONYMS,
      queryText
    );
    const lexicalKeys = lexicalMatches.map((m) => sectionKey(m.citation));
    const lexicalHit = isPositive && lexicalKeys.some((k) => gtKeys.includes(k));

    // --- Semantic (real Voyage call) ---
    console.log(`[${ticket.complaint_id}] embedding query...`);
    const [queryEmbedding] = await embed([queryText], "query");
    const semanticResults = semanticRetrieve(corpus.chunks, queryEmbedding, ticket.date_received, SEMANTIC_TOP_K);
    const semanticKeys = semanticResults.map((r) => sectionKey(r.citation));
    const hitAt1 = isPositive && semanticKeys.length > 0 && gtKeys.includes(semanticKeys[0]);
    const hitAt3 = isPositive && semanticKeys.some((k) => gtKeys.includes(k));
    const top1Similarity = semanticResults.length > 0 ? semanticResults[0].similarity : null;

    perTicket.push({
      complaint_id: ticket.complaint_id,
      product: ticket.product,
      issue: ticket.issue,
      ground_truth: {
        applicable_regulation: ticket.ground_truth.applicable_regulation,
        citation: ticket.ground_truth.citation,
        section_keys: gtKeys,
      },
      is_positive: isPositive,
      lexical: {
        matches: lexicalMatches.map((m) => ({ citation: m.citation, topic: m.topic, matched_terms: m.matched_terms })),
        match_count: lexicalMatches.length,
        hit: isPositive ? lexicalHit : null,
        false_positive: !isPositive && lexicalMatches.length > 0,
      },
      semantic: {
        top3: semanticResults.map((r) => ({ citation: r.citation, topic: r.topic, similarity: r.similarity, effective_date: r.effective_date })),
        hit_at_1: isPositive ? hitAt1 : null,
        hit_at_3: isPositive ? hitAt3 : null,
        top1_similarity: top1Similarity,
      },
    });
  }

  const positives = perTicket.filter((t) => t.is_positive);
  const negatives = perTicket.filter((t) => !t.is_positive);

  const lexicalRecall = positives.length > 0 ? positives.filter((t) => t.lexical.hit).length / positives.length : null;
  const semanticRecallAt1 = positives.length > 0 ? positives.filter((t) => t.semantic.hit_at_1).length / positives.length : null;
  const semanticRecallAt3 = positives.length > 0 ? positives.filter((t) => t.semantic.hit_at_3).length / positives.length : null;

  const lexicalFalsePositiveRate = negatives.length > 0 ? negatives.filter((t) => t.lexical.false_positive).length / negatives.length : null;

  const positiveSimilarities = positives.filter((t) => t.semantic.hit_at_1).map((t) => t.semantic.top1_similarity);
  const negativeSimilarities = negatives.map((t) => t.semantic.top1_similarity);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  const summary = {
    generated_at: new Date().toISOString(),
    test_set: "eval/held_out_test_set.json",
    ticket_count: perTicket.length,
    positive_count: positives.length,
    negative_count: negatives.length,
    kpi_1_and_2_retrieval_recall_and_paraphrase_robustness: {
      note: "Addendum Section 3 defines KPI 1 (retrieval recall@k) and KPI 2 (paraphrase robustness) as recall on all tickets vs. recall specifically on the held-out set. This script's only test set IS the held-out set, so these collapse to the SAME number here -- not two independent measurements.",
      lexical_recall_unranked: lexicalRecall,
      lexical_note: "regulationIndexLookup returns unordered, unscored matches -- there is no meaningful top-1 to isolate, so lexical is reported as a single recall figure (correct citation anywhere in what it returned), not @1/@3.",
      semantic_recall_at_1: semanticRecallAt1,
      semantic_recall_at_3: semanticRecallAt3,
    },
    kpi_3_downstream_citation_accuracy: {
      measured: false,
      finding:
        "Not re-measured live. Real Agent 2's own LLM call produces applicable_regulation/citation from its own reasoning BEFORE either retrieval tool runs; both lexical and semantic tools run afterward as an independent post-hoc cross-check whose result is never fed back into Agent 2's or Agent 3's prompt (confirmed during Phase 8 build phase 2's live wiring work, and required by the addendum's own non-goal: no change to Phases 1-7's agent call structure). Swapping lexical for semantic therefore cannot change Agent 3's draft citation or the citation-accuracy number already reported for Phases 1-7 under the pipeline as actually built -- running the full 4-agent pipeline on this held-out set (real cost, ~70+ Claude calls across 18 tickets) would only reconfirm that architectural fact, not produce a new one.",
    },
    kpi_4_false_positive_rate: {
      lexical_false_positive_rate: lexicalFalsePositiveRate,
      lexical_note: "Lexical has no confidence score -- 'false positive' means it returned any match at all for a ticket with no real applicable regulation.",
      semantic_top1_similarity_on_true_positives: { mean: avg(positiveSimilarities), values: positiveSimilarities },
      semantic_top1_similarity_on_true_negatives: { mean: avg(negativeSimilarities), values: negativeSimilarities },
      semantic_note: "Semantic search always returns its top-k by construction (nearest-neighbor search never returns nothing), so a false-positive rate requires a similarity threshold. Reporting the raw distributions on both sides above rather than asserting a threshold decided before seeing this run's actual data -- see console output / README write-up for where they do or don't separate.",
    },
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify({ summary, tickets: perTicket }, null, 2) + "\n", "utf-8");

  console.log("\n=== KPI SUMMARY ===");
  console.log(`Tickets: ${perTicket.length} (${positives.length} positive / ${negatives.length} negative)`);
  console.log(`\nRetrieval recall / paraphrase robustness (same number, held-out-only test set):`);
  console.log(`  Lexical (unranked):     ${fmtPct(lexicalRecall)}`);
  console.log(`  Semantic recall@1:      ${fmtPct(semanticRecallAt1)}`);
  console.log(`  Semantic recall@3:      ${fmtPct(semanticRecallAt3)}`);
  console.log(`\nFalse-positive rate (of ${negatives.length} tickets with no real applicable regulation):`);
  console.log(`  Lexical (any match):    ${fmtPct(lexicalFalsePositiveRate)}`);
  console.log(`  Semantic top-1 similarity -- true positives: mean ${fmtNum(avg(positiveSimilarities))}, true negatives: mean ${fmtNum(avg(negativeSimilarities))}`);
  console.log(`\nDownstream citation-accuracy: not re-measured live -- see eval/kpi_results.json's kpi_3 finding (architectural: neither tool feeds Agent 2/3).`);
  console.log(`\nWrote ${OUT_PATH}`);
}

function fmtPct(x) {
  return x === null ? "n/a" : `${(x * 100).toFixed(1)}% (${x})`;
}
function fmtNum(x) {
  return x === null ? "n/a" : x.toFixed(3);
}

main().catch((err) => {
  console.error("KPI MEASUREMENT FAILED:", err);
  process.exit(1);
});

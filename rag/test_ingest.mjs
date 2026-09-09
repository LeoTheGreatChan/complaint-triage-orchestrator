/**
 * Verifies rag/ingest.mjs end-to-end: chunk + embed + supersede + the
 * effective-dated retrieval filter (rag/retrieve.js) actually flips the
 * selected chunk version at the right date boundary (addendum Section 5,
 * build phase 3).
 *
 * Runs against a throwaway temp corpus seeded with two clearly-synthetic
 * test fixtures ("TEST-ONLY -- not a real CFPB regulation" in every field
 * that could be mistaken for real text) -- never the real
 * reference_data/regulations/ texts or rag/corpus/regulation_chunks.json.
 * Same test/product separation this project already applies to fixture
 * tickets vs. live CFPB tickets.
 *
 * Calls the real ingest() and semanticRetrieve() functions (not
 * reimplementations), so a pass here is evidence the shipped code path
 * works, not just this test's own logic. Makes two real Voyage embedding
 * calls (v1 + v2 of the synthetic document) -- a fraction of a penny, per
 * addendum Section 8's own cost accounting.
 *
 * Usage: node rag/test_ingest.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingest } from "./ingest.mjs";
import { semanticRetrieve } from "./retrieve.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const DOC_ID = "test_only_synthetic_reg";

// v1: the "original" version, in force from 2020-01-01.
const DOC_V1 = {
  _meta: {
    document_id: DOC_ID,
    regulation: "TEST-ONLY -- not a real CFPB regulation",
    citation: "TEST §000.1 (v1)",
    topic: "Synthetic fixture for rag/test_ingest.mjs -- late fee notice timing",
    source_url: "https://example.invalid/not-a-real-regulation",
    effective_date: "2020-01-01",
  },
  text: "A servicer must mail a late fee notice within ten days of a missed payment.",
};

// v2: a synthetic "amendment" tightening the window, in force from
// 2024-06-01 -- must supersede v1, and only apply to tickets filed on or
// after that date.
const DOC_V2 = {
  _meta: {
    document_id: DOC_ID,
    regulation: "TEST-ONLY -- not a real CFPB regulation",
    citation: "TEST §000.1 (v2, amended)",
    topic: "Synthetic fixture for rag/test_ingest.mjs -- late fee notice timing",
    source_url: "https://example.invalid/not-a-real-regulation-amended",
    effective_date: "2024-06-01",
  },
  text: "A servicer must mail a late fee notice within five days of a missed payment.",
};

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
    console.log(`  FAIL: ${label}`);
    failures++;
  }
}

async function main() {
  loadEnvFile();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-test-ingest-"));
  const corpusPath = path.join(tmpDir, "corpus.json");
  const v1Path = path.join(tmpDir, "v1.json");
  const v2Path = path.join(tmpDir, "v2.json");

  fs.writeFileSync(corpusPath, JSON.stringify({ _meta: { chunk_count: 0 }, chunks: [] }, null, 2));
  fs.writeFileSync(v1Path, JSON.stringify(DOC_V1, null, 2));
  fs.writeFileSync(v2Path, JSON.stringify(DOC_V2, null, 2));

  console.log("--- Ingesting v1 (new document, nothing to supersede) ---");
  const result1 = await ingest({ docPath: v1Path, corpusPath, dryRun: false });
  check("v1 produced exactly one chunk", result1.newRecords.length === 1);
  check("v1 superseded nothing", result1.supersededIds.length === 0);
  check("v1 chunk has a real embedding vector", Array.isArray(result1.newRecords[0].embedding) && result1.newRecords[0].embedding.length > 0);

  console.log("--- Ingesting v2 (amendment -- must supersede v1) ---");
  const result2 = await ingest({ docPath: v2Path, corpusPath, dryRun: false });
  check("v2 produced exactly one chunk", result2.newRecords.length === 1);
  check("v2 superseded exactly the v1 chunk", result2.supersededIds.length === 1 && result2.supersededIds[0] === DOC_ID);

  console.log("--- Rejecting a backdated version ---");
  const backdatedPath = path.join(tmpDir, "backdated.json");
  fs.writeFileSync(backdatedPath, JSON.stringify({ ...DOC_V2, _meta: { ...DOC_V2._meta, effective_date: "2022-01-01" } }, null, 2));
  let backdatedRejected = false;
  try {
    await ingest({ docPath: backdatedPath, corpusPath, dryRun: true });
  } catch (err) {
    backdatedRejected = /not after the newest existing version/.test(err.message);
  }
  check("backdated effective_date is rejected", backdatedRejected);

  console.log("--- Effective-dated retrieval: version selection flips at the boundary ---");
  const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf-8"));
  const v1Chunk = corpus.chunks.find((c) => c.effective_date === "2020-01-01");
  const v2Chunk = corpus.chunks.find((c) => c.effective_date === "2024-06-01");

  check("v1 chunk is now marked superseded at v2's effective_date", v1Chunk.superseded_date === "2024-06-01");
  check("v2 chunk is not superseded", v2Chunk.superseded_date === null);

  // Use v2's own embedding as the query -- guarantees whichever chunk is
  // actually in force for a given ticket date ranks first by similarity,
  // isolating this assertion to the date filter rather than embedding noise.
  const queryEmbedding = v2Chunk.embedding;

  const beforeAmendment = semanticRetrieve(corpus.chunks, queryEmbedding, "2023-01-01", 5);
  check("a ticket filed before the amendment sees only the v1 chunk", beforeAmendment.length === 1 && beforeAmendment[0].effective_date === "2020-01-01");

  const onAmendmentDate = semanticRetrieve(corpus.chunks, queryEmbedding, "2024-06-01", 5);
  check("a ticket filed exactly on the amendment date sees only the v2 chunk", onAmendmentDate.length === 1 && onAmendmentDate[0].effective_date === "2024-06-01");

  const afterAmendment = semanticRetrieve(corpus.chunks, queryEmbedding, "2025-01-01", 5);
  check("a ticket filed after the amendment sees only the v2 chunk", afterAmendment.length === 1 && afterAmendment[0].effective_date === "2024-06-01");

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log("");
  if (failures === 0) {
    console.log(`Self-test passed: all checks green. Real production files untouched (test ran entirely in ${tmpDir}).`);
  } else {
    console.error(`Self-test FAILED: ${failures} check(s) did not pass.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("TEST FAILED:", err.message);
  process.exit(1);
});

/**
 * Runtime ingestion for the regulation corpus (Phase 8, addendum Section 5,
 * build phase 3). Appends one new document's chunks to
 * rag/corpus/regulation_chunks.json without a full rebuild -- the mechanic
 * that makes "the corpus can be updated at any time" true without ever
 * re-embedding chunks that haven't changed.
 *
 * Input document shape matches reference_data/regulations/*.json (same
 * _meta.regulation/citation/topic/source_url + text), with one addition
 * this addendum requires: _meta.effective_date. The original five documents
 * left this implicit (build_corpus.mjs applies a build-time placeholder,
 * see that file's docstring) because they predate this project by decades;
 * anything ingested through this script is a real update happening now, so
 * a real effective_date is mandatory, not inferred.
 *
 * Supersession (addendum Section 5, mechanic 2): if the corpus already has
 * an in-force chunk (superseded_date: null) for the SAME document_id, its
 * superseded_date is set to the new document's effective_date -- not
 * deleted, not overwritten. A ticket filed before the new effective_date
 * still resolves to the prior chunk's text; retrieve.js's filter
 * (effective_date <= ticket_date < superseded_date||now) is what enforces
 * that at query time, not this script (mechanic 4: "no re-indexing" of
 * already-processed tickets).
 *
 * Reuses chunk.mjs and embed.mjs verbatim -- the same chunk-and-embed
 * pipeline as the initial five-regulation corpus, just triggerable at any
 * time instead of only at build time (addendum Section 5, mechanic 1).
 *
 * Usage:
 *   node rag/ingest.mjs <new-document.json> [--dry-run] [--corpus <path>]
 *
 *   --dry-run        chunk + supersede + write metadata only, no embedding
 *                    API calls, no cost (embedding fields left null)
 *   --corpus <path>  operate on a corpus file other than the real
 *                    rag/corpus/regulation_chunks.json -- used by
 *                    rag/test_ingest.mjs so tests never touch production data
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunkClauses } from "./chunk.mjs";
import { embed } from "./embed.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CORPUS_PATH = path.join(REPO_ROOT, "rag/corpus/regulation_chunks.json");

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

function buildCitation(baseCitation, marker) {
  if (marker === null) return baseCitation;
  return `${baseCitation}(${marker})`;
}

function parseArgs(argv) {
  const positional = [];
  let dryRun = false;
  let corpusPath = DEFAULT_CORPUS_PATH;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") {
      dryRun = true;
    } else if (argv[i] === "--corpus") {
      corpusPath = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 1) {
    throw new Error("Usage: node rag/ingest.mjs <new-document.json> [--dry-run] [--corpus <path>]");
  }
  return { docPath: positional[0], dryRun, corpusPath };
}

export async function ingest({ docPath, corpusPath, dryRun }) {
  const doc = JSON.parse(fs.readFileSync(docPath, "utf-8"));
  const documentId = doc._meta.document_id || path.basename(docPath, ".json");
  const effectiveDate = doc._meta.effective_date;
  if (!effectiveDate) {
    throw new Error(
      `${docPath}: _meta.effective_date is required for runtime ingestion (addendum Section 5) -- ` +
        `every document uploaded through this script must carry a real effective date, unlike the ` +
        `original five-regulation corpus's build-time placeholder.`
    );
  }

  const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf-8"));

  // Guard: reject a version that isn't strictly newer than every existing
  // version of the same document -- retrieval history depends on versions
  // arriving in chronological order, not being backdated after the fact.
  const sameDocChunks = corpus.chunks.filter((c) => c.document_id === documentId);
  const latestExisting = sameDocChunks.reduce((max, c) => (c.effective_date > max ? c.effective_date : max), "0000-00-00");
  if (sameDocChunks.length > 0 && effectiveDate <= latestExisting) {
    throw new Error(
      `${docPath}: effective_date ${effectiveDate} is not after the newest existing version of ` +
        `"${documentId}" (${latestExisting}). Runtime updates must move forward in time -- backdating ` +
        `would corrupt retrieval for tickets already filed against later chunks.`
    );
  }

  const chunks = chunkClauses(doc.text);
  const newRecords = chunks.map((chunk) => ({
    chunk_id: chunk.marker === null ? documentId : `${documentId}#${chunk.marker}`,
    document_id: documentId,
    effective_date: effectiveDate,
    superseded_date: null,
    regulation: doc._meta.regulation,
    citation: buildCitation(doc._meta.citation, chunk.marker),
    topic: doc._meta.topic,
    clause_marker: chunk.marker,
    text: chunk.text,
    embedding: null,
  }));

  console.log(`Chunked "${docPath}" (document_id: ${documentId}, effective_date: ${effectiveDate}) into ${newRecords.length} clause-level chunk(s).`);

  // Supersede in place -- old chunk rows stay in the corpus (mechanic 4:
  // "no re-indexing"), only their superseded_date changes.
  const supersededIds = [];
  for (const c of corpus.chunks) {
    if (c.document_id === documentId && c.superseded_date === null) {
      c.superseded_date = effectiveDate;
      supersededIds.push(c.chunk_id);
    }
  }
  if (supersededIds.length > 0) {
    console.log(`Superseded ${supersededIds.length} prior chunk(s) of "${documentId}", effective ${effectiveDate}: ${supersededIds.join(", ")}`);
  } else {
    console.log(`No prior version of "${documentId}" in the corpus -- adding as a new document.`);
  }

  if (!dryRun) {
    console.log("Embedding new chunk(s) via Voyage (input_type: document)...");
    const embeddings = await embed(newRecords.map((r) => r.text), "document");
    newRecords.forEach((r, i) => {
      r.embedding = embeddings[i];
    });
    console.log(`Embedded ${newRecords.length} chunk(s).`);
  } else {
    console.log("--dry-run: skipped embedding API calls, embedding fields left null.");
  }

  corpus.chunks.push(...newRecords);
  corpus._meta.chunk_count = corpus.chunks.length;
  corpus._meta.ingestion_log = corpus._meta.ingestion_log || [];
  corpus._meta.ingestion_log.push({
    at: new Date().toISOString(),
    document_id: documentId,
    effective_date: effectiveDate,
    source_document: path.basename(docPath),
    new_chunk_ids: newRecords.map((r) => r.chunk_id),
    superseded_chunk_ids: supersededIds,
    dry_run: dryRun,
  });

  fs.writeFileSync(corpusPath, JSON.stringify(corpus, null, 2));
  console.log(`Wrote ${corpusPath} (${corpus.chunks.length} total chunks).`);

  return { newRecords, supersededIds, documentId, effectiveDate };
}

async function main() {
  loadEnvFile();
  const { docPath, dryRun, corpusPath } = parseArgs(process.argv.slice(2));
  await ingest({ docPath, corpusPath, dryRun });
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error("INGEST FAILED:", err.message);
    process.exit(1);
  });
}

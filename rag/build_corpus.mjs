/**
 * Builds rag/corpus/regulation_chunks.json -- the versioned, embedded
 * reference corpus Phase 8's semantic retrieval tool reads from (addendum
 * Section 7, build phase 1).
 *
 * Chunks the five existing reference_data/regulations/*.json files at
 * clause level (rag/chunk.mjs, verified against all five real texts
 * before being trusted here), embeds each chunk (rag/embed.mjs, Voyage
 * voyage-3-large), and writes out one record per chunk carrying
 * document_id/effective_date/superseded_date (addendum Section 5's
 * versioning fields) alongside the embedding vector.
 *
 * effective_date for this original five-regulation corpus is a deliberate
 * placeholder ("2000-01-01"), not a claim about each statute's actual
 * historical enactment date -- these are long-standing federal laws that
 * predate this project by decades, not newly-issued text. Using their
 * _meta.retrieved_date (Aug 2026) instead would be a real correctness bug:
 * the addendum's own retrieval filter is `effective_date <= ticket_date`,
 * and this project's own fixture tickets are dated 2024 -- an Aug-2026
 * effective_date would silently exclude the founding corpus from every
 * historical ticket's retrieval candidates. The placeholder is set safely
 * before any realistic CFPB complaint date instead.
 *
 * Usage:
 *   node rag/build_corpus.mjs --dry-run   # chunk + build metadata only,
 *                                         # no embedding API calls, no cost
 *   node rag/build_corpus.mjs             # full build, calls Voyage
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunkClauses } from "./chunk.mjs";
import { embed } from "./embed.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGULATIONS_DIR = path.join(REPO_ROOT, "reference_data/regulations");
const OUT_PATH = path.join(REPO_ROOT, "rag/corpus/regulation_chunks.json");
const DRY_RUN = process.argv.includes("--dry-run");

// Deliberate placeholder, not a real historical enactment date -- see the
// module docstring above.
const ORIGINAL_CORPUS_EFFECTIVE_DATE = "2000-01-01";

function buildCitation(baseCitation, marker) {
  if (marker === null) return baseCitation;
  return `${baseCitation}(${marker})`;
}

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

async function main() {
  loadEnvFile();

  const files = fs.readdirSync(REGULATIONS_DIR).filter((f) => f.endsWith(".json"));
  const records = [];

  for (const file of files) {
    const documentId = path.basename(file, ".json");
    const doc = JSON.parse(fs.readFileSync(path.join(REGULATIONS_DIR, file), "utf-8"));
    const chunks = chunkClauses(doc.text);

    for (const chunk of chunks) {
      records.push({
        chunk_id: chunk.marker === null ? documentId : `${documentId}#${chunk.marker}`,
        document_id: documentId,
        effective_date: ORIGINAL_CORPUS_EFFECTIVE_DATE,
        superseded_date: null,
        regulation: doc._meta.regulation,
        citation: buildCitation(doc._meta.citation, chunk.marker),
        topic: doc._meta.topic,
        clause_marker: chunk.marker,
        text: chunk.text,
        embedding: null,
      });
    }
  }

  console.log(`Chunked ${files.length} regulation documents into ${records.length} clause-level chunks.`);

  if (!DRY_RUN) {
    console.log("Embedding all chunks via Voyage (input_type: document)...");
    const embeddings = await embed(
      records.map((r) => r.text),
      "document"
    );
    records.forEach((r, i) => {
      r.embedding = embeddings[i];
    });
    console.log(`Embedded ${records.length} chunks (${embeddings[0].length}-dimensional vectors).`);
  } else {
    console.log("--dry-run: skipped embedding API calls, embedding fields left null.");
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        _meta: {
          description:
            "Versioned, clause-level regulation corpus for Phase 8 semantic retrieval (addendum Section 5/7). Regenerate with rag/build_corpus.mjs; runtime uploads (Section 5) append via rag/ingest.mjs instead of full rebuilds.",
          embedding_model: DRY_RUN ? null : "voyage-3-large",
          built_at: new Date().toISOString(),
          chunk_count: records.length,
        },
        chunks: records,
      },
      null,
      2
    )
  );
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("BUILD FAILED:", err.message);
  process.exit(1);
});

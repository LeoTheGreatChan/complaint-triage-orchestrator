/**
 * Voyage AI embeddings client -- a plain HTTP call, not an SDK, matching
 * this project's established reasoning for why the four Claude agents call
 * Anthropic's Messages API directly via httpRequest instead of a client
 * library (spec Section 13 / README "Why a plain HTTP Request node"):
 * one dependency-free call type doesn't need a package pulled in for it,
 * and it keeps this script runnable the same way inside or outside n8n.
 *
 * Anthropic does not offer an embeddings API -- Claude is text-generation
 * only (addendum Section 8) -- so this is necessarily a second, separate
 * provider. Voyage voyage-3-large chosen per the addendum's recommendation
 * (Anthropic's own suggested pairing for Claude-based RAG); cost is
 * immaterial at this corpus's scale either way (addendum Section 8).
 */

const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-3-large";

// Voyage caps accounts with no payment method on file to 3 requests/minute
// (confirmed live: a 429 mid-build named this exact limit) -- still free,
// just throttled. Rather than add a payment method, this project paces
// itself: one call at a time, spaced comfortably under the 20s/request
// average (21s), tracked per-process so every caller of embed() benefits
// automatically instead of each script remembering to add its own delay.
const MIN_INTERVAL_MS = 21000;
let lastCallAt = 0;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const elapsed = Date.now() - lastCallAt;
  if (elapsed < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - elapsed);
  }
  lastCallAt = Date.now();
}

/**
 * @param {string[]} texts - strings to embed, batched in one request.
 * @param {"document"|"query"} inputType - Voyage distinguishes embedding
 *   corpus documents (indexed once) from search queries (embedded at
 *   retrieval time) for better retrieval quality -- using the wrong one
 *   for either side of a comparison would quietly degrade cosine-similarity
 *   scores without erroring, so this is a required, not optional, param.
 * @returns {Promise<number[][]>} one embedding vector per input text, same order.
 */
export async function embed(texts, inputType) {
  if (inputType !== "document" && inputType !== "query") {
    throw new Error(`embed() requires inputType to be "document" or "query", got: ${inputType}`);
  }
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY is not set -- add it to .env (see rag/README.md)");
  }

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await throttle();

    const res = await fetch(VOYAGE_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: texts,
        model: MODEL,
        input_type: inputType,
      }),
    });

    if (res.status === 429 && attempt < maxAttempts) {
      // Belt-and-braces on top of the proactive throttle above -- e.g. if
      // something else already used part of the rate window this process
      // didn't know about. Back off a full window and retry.
      console.error(`  (rate-limited, waiting ${MIN_INTERVAL_MS / 1000}s and retrying -- attempt ${attempt}/${maxAttempts})`);
      await sleep(MIN_INTERVAL_MS);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Voyage embeddings request failed: ${res.status} ${res.statusText} -- ${body.slice(0, 500)}`);
    }

    const json = await res.json();
    // Voyage returns data items tagged with their input index -- sort
    // defensively rather than assume response order matches request order.
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

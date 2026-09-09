/**
 * Semantic retrieval core (Phase 8, addendum Section 7 build phase 2).
 *
 * Written standalone and tested here first, the same way
 * scripts/build_workflow.js's regulationIndexLookup() is -- these two
 * functions get embedded into the real n8n Code node via .toString() (see
 * scripts/build_workflow.js's jsSemanticRegulationTool), so what's tested
 * here is byte-for-byte what runs live, not a separate reimplementation.
 * Plain CommonJS (not the rest of rag/, which is ESM) specifically so
 * build_workflow.js can require() it directly -- .toString()-embedding
 * needs the literal function source, and a second, separately-typed copy
 * living inside build_workflow.js would be exactly the "two places drift
 * apart" risk that file's own header comment says this whole
 * generate-then-embed approach exists to avoid.
 *
 * Output contract note (addendum Section 2): this tool's own result shape
 * is new -- an array of {citation, topic, similarity, effective_date,
 * chunk_id} -- but Agent 2 (the Claude call downstream) is still
 * responsible for producing the same final applicable_regulation/
 * citation/precedent_notes structure every downstream node already
 * consumes. Swapping this tool's internals doesn't change that contract.
 */

function cosineSimilarity(a, b) {
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

/**
 * @param {object[]} corpusChunks - rag/corpus/regulation_chunks.json's `chunks` array.
 * @param {number[]} queryEmbedding - the ticket's query embedding (input_type: "query").
 * @param {string} ticketDate - the ticket's date_received (YYYY-MM-DD or full ISO), used
 *   for the effective-dating filter (addendum Section 5): a chunk is a candidate only if
 *   effective_date <= ticketDate < (superseded_date OR now).
 * @param {number} topK
 * @returns {{citation: string, topic: string, similarity: number, effective_date: string, chunk_id: string}[]}
 */
function semanticRetrieve(corpusChunks, queryEmbedding, ticketDate, topK) {
  const ticketDay = String(ticketDate).slice(0, 10);
  const inForce = corpusChunks.filter((c) => {
    if (c.effective_date > ticketDay) return false;
    if (c.superseded_date && c.superseded_date <= ticketDay) return false;
    return true;
  });

  return inForce
    .map((c) => ({
      chunk_id: c.chunk_id,
      citation: c.citation,
      topic: c.topic,
      effective_date: c.effective_date,
      similarity: cosineSimilarity(queryEmbedding, c.embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

module.exports = { cosineSimilarity, semanticRetrieve };

/**
 * Clause-level chunker for statutory/regulatory text (Phase 8, addendum
 * Section 7 build phase 1).
 *
 * Algorithm: find every "(marker)" that starts a line (a letter-run or a
 * digit-run). Determine the top-level marker TYPE and starting value from
 * the first marker found in the document. Walk all markers in document
 * order; a marker only starts a new top-level chunk if it's the same type
 * AND the next value in sequence from the last top-level marker
 * (a -> b -> c ..., 1 -> 2 -> 3 ...) -- anything else (roman numerals,
 * capital letters, restarted numbering inside a subsection) is nested
 * content, absorbed into whichever top-level chunk it falls inside.
 *
 * This generalizes across real CFR/USC nesting depths (a/1/i/A) without
 * hard-coding roman numerals specifically -- verified against all five of
 * this project's real regulation texts before being trusted for runtime
 * ingestion too (addendum Section 5's upload step reuses this same
 * function, not a second implementation): FCRA §1681c-2 correctly yields
 * top-level (a)-(f) despite nested (1)(2)(3) and (i)(ii) inside; FDCPA
 * §1692e correctly yields top-level (1)-(16) despite having no lettered
 * tier at all; the CFPB 15-day rule (no enumerated structure) correctly
 * yields a single whole-document chunk.
 */

function markerType(marker) {
  return /^\d+$/.test(marker) ? "digit" : "letter";
}

function nextInSequence(type, value) {
  if (type === "digit") return String(Number(value) + 1);
  // Single-letter sequence only (a -> z) -- this corpus never reaches
  // double letters at the top level; a real occurrence would just stop
  // matching and get absorbed as nested content, not crash.
  return String.fromCharCode(value.charCodeAt(0) + 1);
}

/**
 * @param {string} text - the full regulation/document text.
 * @returns {{marker: string|null, text: string}[]} one entry per clause-level
 *   chunk, in document order. `marker` is null when the text has no
 *   enumerated top-level structure at all (the whole text is one chunk).
 */
export function chunkClauses(text) {
  const markerRe = /\n\(([a-zA-Z]{1,2}|\d{1,3})\)\s/g;
  const matches = [...text.matchAll(markerRe)];

  if (matches.length === 0) {
    return [{ marker: null, text: text.trim() }];
  }

  const topType = markerType(matches[0][1]);
  let expected = matches[0][1];
  const boundaries = [];

  for (const m of matches) {
    const marker = m[1];
    if (markerType(marker) === topType && marker === expected) {
      boundaries.push({ index: m.index, marker });
      expected = nextInSequence(topType, marker);
    }
  }

  const chunks = [];
  // Preamble before the first top-level marker (title/heading text, or an
  // operative sentence like FDCPA §1692e's "A debt collector may not use
  // any false ... representation" that introduces a numbered list with no
  // marker of its own) is prepended to the first chunk rather than dropped.
  const preamble = text.slice(0, boundaries[0].index).trim();

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].index;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].index : text.length;
    let chunkText = text.slice(start, end).trim();
    if (i === 0 && preamble) {
      chunkText = preamble + "\n" + chunkText;
    }
    chunks.push({ marker: boundaries[i].marker, text: chunkText });
  }

  return chunks;
}

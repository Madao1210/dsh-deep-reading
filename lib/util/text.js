/**
 * Text normalization and small shared helpers.
 *
 * The normalization here is the load-bearing part of quote verification: a
 * quote is accepted when its *normalized* form occurs in the *normalized*
 * source. Normalization must therefore be aggressive about things that carry no
 * meaning (whitespace, full-width/half-width forms, quote glyphs) and
 * conservative about everything else — the moment it starts rewriting words it
 * stops being able to catch a paraphrase, which is the only thing it exists to
 * catch.
 */

import { createHash } from 'node:crypto';

/** Unicode full-width forms → their ASCII equivalents. */
const FULLWIDTH_MAP = new Map([
  ['　', ' '],
  ['！', '!'], ['＂', '"'], ['＃', '#'], ['＄', '$'], ['％', '%'], ['＆', '&'],
  ['＇', "'"], ['（', '('], ['）', ')'], ['＊', '*'], ['＋', '+'], ['，', ','],
  ['－', '-'], ['．', '.'], ['／', '/'], ['：', ':'], ['；', ';'], ['＜', '<'],
  ['＝', '='], ['＞', '>'], ['？', '?'], ['＠', '@'], ['［', '['], ['＼', '\\'],
  ['］', ']'], ['＾', '^'], ['＿', '_'], ['｀', '`'], ['｛', '{'], ['｜', '|'],
  ['｝', '}'], ['～', '~'],
]);

/** Every quote glyph the reader's language may reasonably produce. */
const QUOTE_GLYPHS = /[「」『』“”‘’"']/g;

/**
 * Normalize for comparison only. Never for display, never for storage: what is
 * written to disk is the source bytes verbatim.
 * @param {string} text
 */
export function normalizeForCompare(text) {
  let out = '';
  for (const char of text.normalize('NFKC')) {
    out += FULLWIDTH_MAP.get(char) ?? char;
  }
  return out
    .replace(QUOTE_GLYPHS, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** Normalize line endings and strip a UTF-8 BOM. */
export function normalizeSourceText(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** Split into lines without a trailing empty line. */
export function toLines(text) {
  const lines = normalizeSourceText(text).split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Character count of a line range (inclusive, 1-based), newlines excluded. */
export function rangeChars(lines, startLine, endLine) {
  let total = 0;
  for (let i = startLine - 1; i <= endLine - 1 && i < lines.length; i += 1) total += lines[i].length;
  return total;
}

/** The text of an inclusive 1-based line range. */
export function rangeText(lines, startLine, endLine) {
  return lines.slice(startLine - 1, endLine).join('\n');
}

export function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Small stable id from a hash — long enough to not collide, short enough to read. */
export function shortId(hex, length = 12) {
  return hex.slice(0, length);
}

export function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Count occurrences of each item, returning an object. */
export function countBy(items, keyOf = (x) => x) {
  const out = {};
  for (const item of items) {
    const key = keyOf(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

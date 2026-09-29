/**
 * Resolve and validate plugin configuration.
 *
 * A plugin that guesses its own storage location ends up writing two different
 * reading states for the same book, so the resolution order is explicit and the
 * resolved root is reported back by `reading_status`.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { configError } from './util/errors.js';

/**
 * @typedef {object} ResolvedConfig
 * @property {string} dataRoot      absolute directory holding `books/`
 * @property {string} dshHome
 * @property {number} maxSourceBytes
 * @property {number} chapterHeadingLevel
 * @property {number} minChapterChars
 * @property {number} maxCharsPerChunk
 * @property {number} maxChunksPerWave
 * @property {boolean} verifyQuotes
 * @property {number} minQuoteChars
 */

/** The split-rule version is part of the book id: changing it must yield a new book dir. */
export const SPLIT_RULE_VERSION = 'p1.0';

/**
 * @param {Record<string, unknown>} raw config as supplied by cordis
 * @returns {ResolvedConfig}
 */
export function resolveConfig(raw = {}) {
  const dshHome = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh');
  const configuredRoot = typeof raw.dataRoot === 'string' ? raw.dataRoot.trim() : '';
  const dataRoot = configuredRoot === '' ? join(dshHome, 'deep-reading') : configuredRoot;

  const config = {
    dataRoot,
    dshHome,
    maxSourceBytes: positiveInt(raw.maxSourceBytes, 64 * 1024 * 1024, 'maxSourceBytes'),
    chapterHeadingLevel: positiveInt(raw.chapterHeadingLevel, 1, 'chapterHeadingLevel'),
    minChapterChars: positiveInt(raw.minChapterChars, 400, 'minChapterChars'),
    maxCharsPerChunk: positiveInt(raw.maxCharsPerChunk, 12000, 'maxCharsPerChunk'),
    maxChunksPerWave: positiveInt(raw.maxChunksPerWave, 12, 'maxChunksPerWave'),
    verifyQuotes: raw.verifyQuotes !== false,
    minQuoteChars: positiveInt(raw.minQuoteChars, 4, 'minQuoteChars'),
  };
  if (config.minChapterChars > config.maxCharsPerChunk) {
    throw configError(
      `minChapterChars（${config.minChapterChars}）不能大于 maxCharsPerChunk（${config.maxCharsPerChunk}）：`
      + '否则每个章节都会在分块阶段被切成碎片。',
    );
  }
  return config;
}

/**
 * A wrong type in the patch file is a warning, never a startup failure: one
 * mistyped key must not take the whole profile down. (This is the reference
 * plugin's rule and it is the right one — the failure mode it prevents is a
 * plugin that refuses to load because of a comment in a YAML file.)
 */
function positiveInt(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    console.warn(`[dsh-deep-reading] 忽略配置 ${label}：需要正整数，收到 ${JSON.stringify(value)}`);
    return fallback;
  }
  return number;
}

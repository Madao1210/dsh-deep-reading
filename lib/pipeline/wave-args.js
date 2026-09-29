/**
 * Wave args and the Map / Model caches.
 *
 * Kept out of the tools so the workflow, the skill and the tests all describe a
 * wave the same way. The cache rule is the important part: an entry counts as
 * cached only if its file exists AND parses AND carries the fields that make it
 * usable. Anything else is simply not offered as a shortcut — a cache you cannot
 * trust is worse than no cache, because Reduce would build an archive on a
 * reading nobody ever checked.
 *
 * The field names checked here are the contract with MAP_SCHEMA / MODEL_SCHEMA.
 * When the Map schema moved from `findings` to `points`, this file kept checking
 * `findings` and the cache silently stopped hitting — every re-run re-read every
 * chunk while reporting success. That is why the drive test now asks the plugin
 * for the cache instead of assembling the args itself.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { bookDir, mapCacheDir, modelsCacheDir } from '../store/book.js';

/** Read and parse one cache entry, or null if it is not usable. */
function readCacheEntry(dir, file) {
  try {
    return JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {object} config
 * @param {object} book manifest
 * @param {string} promptRevision
 * @returns {string[]} chunk ids whose cached reading is trustworthy
 */
export function cachedChunkIds(config, book, promptRevision) {
  const dir = mapCacheDir(config, book.bookId);
  if (!existsSync(dir)) return [];
  const known = new Set(book.chunks.map((chunk) => chunk.id));
  const suffix = `.${promptRevision}.json`;
  const out = [];
  for (const file of readdirSync(dir)) {
    if (file.endsWith(suffix) === false) continue;
    const parsed = readCacheEntry(dir, file);
    if (typeof parsed?.chunkId !== 'string') continue;
    if (known.has(parsed.chunkId) === false) continue;
    // The shape a Map entry must have: the point list. A model entry lives in a
    // different directory, so there is no cross-contamination to guard against.
    if (Array.isArray(parsed.points) === false) continue;
    out.push(parsed.chunkId);
  }
  return out;
}

/**
 * Chapters whose mental model is already on disk.
 *
 * Worth caching separately from Map: the Model step reads the whole chapter, so
 * it is the most expensive single call in a wave, and re-running a wave after a
 * failure would otherwise pay for it again.
 *
 * @returns {string[]} chapter ids whose cached model is trustworthy
 */
export function cachedChapterModels(config, book, promptRevision) {
  const dir = modelsCacheDir(config, book.bookId);
  if (!existsSync(dir)) return [];
  const known = new Set(book.chapters.map((chapter) => chapter.id));
  const suffix = `.${promptRevision}.json`;
  const out = [];
  for (const file of readdirSync(dir)) {
    if (file.endsWith(suffix) === false) continue;
    const parsed = readCacheEntry(dir, file);
    if (typeof parsed?.chapterId !== 'string') continue;
    if (known.has(parsed.chapterId) === false) continue;
    if (typeof parsed.chapterModel !== 'string' || parsed.chapterModel.trim() === '') continue;
    if (Array.isArray(parsed.teachingOrder?.steps) === false) continue;
    out.push(parsed.chapterId);
  }
  return out;
}

/**
 * The literal `args` for one `workflow` call, plus the chapters it covers.
 * @param {{ config: object, book: object, wave: object, promptRevision: string }} input
 */
export function buildWaveArgs({ config, book, wave, promptRevision }) {
  const chapters = wave.chapterIds.map((chapterId) => {
    const chapter = book.chapters.find((entry) => entry.id === chapterId);
    return {
      id: chapter.id,
      title: chapter.title,
      startLine: chapter.startLine,
      endLine: chapter.endLine,
      chars: chapter.chars,
      chunks: book.chunks
        .filter((chunk) => chunk.chapterId === chapterId)
        .map((chunk) => ({ id: chunk.id, part: chunk.part, startLine: chunk.startLine, endLine: chunk.endLine, chars: chunk.chars })),
    };
  });

  return {
    bookId: book.bookId,
    bookDir: bookDir(config, book.bookId),
    sourcePath: book.sourcePath,
    title: book.title,
    chapters,
    cachedChunkIds: cachedChunkIds(config, book, promptRevision),
    cachedChapterModels: cachedChapterModels(config, book, promptRevision),
  };
}

/** Waves that still have at least one chapter without an archive. */
export function pendingWaves(book) {
  const archived = new Set(Object.keys(book.archives ?? {}));
  return book.waves.filter((wave) => wave.chapterIds.some((chapterId) => archived.has(chapterId) === false));
}

/** Chapters in a wave that have no archive yet. */
export function pendingChapterIds(book, wave) {
  const archived = new Set(Object.keys(book.archives ?? {}));
  return wave.chapterIds.filter((chapterId) => archived.has(chapterId) === false);
}

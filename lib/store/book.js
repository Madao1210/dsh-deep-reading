/**
 * Book store: the on-disk facts about one book.
 *
 * One directory per book, addressed by a content hash, containing the source
 * text verbatim plus a manifest. Everything the pipeline knows about a book is
 * in `manifest.json`; the source text sits next to it so that quote verification
 * has a ground truth that does not depend on the original file still existing or
 * still being byte-identical.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { notFoundError, sourceError } from '../util/errors.js';
import { toLines } from '../util/text.js';
import { buildSourceIndex } from '../archive/verify.js';

/** In-process caches. A book's source is immutable once written, so caching it is safe. */
const linesCache = new Map();
const indexCache = new Map();

export function booksRoot(config) {
  return join(config.dataRoot, 'books');
}

export function bookDir(config, bookId) {
  return join(booksRoot(config), bookId);
}

export function manifestPath(config, bookId) {
  return join(bookDir(config, bookId), 'manifest.json');
}

export function sourcePath(config, bookId) {
  return join(bookDir(config, bookId), 'source.txt');
}

export function archivePath(config, bookId, chapterId) {
  return join(bookDir(config, bookId), 'archives', `${chapterId}.md`);
}

export function mapCacheDir(config, bookId) {
  return join(bookDir(config, bookId), 'map');
}

/** Cached mental models, one file per chapter. Kept apart from the Map cache:
 *  a chapter model is a different shape and belongs to a different step. */
export function modelsCacheDir(config, bookId) {
  return join(bookDir(config, bookId), 'models');
}

/** @returns {object|null} */
export function readBook(config, bookId) {
  const path = manifestPath(config, bookId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw sourceError(`manifest.json 读不出来（${path}）：${error.message}`, { bookId });
  }
}

export function requireBook(config, bookId) {
  const book = readBook(config, bookId);
  if (book === null) {
    throw notFoundError(`没有这本书：${bookId}。已打开的书见 reading_status。`, { bookId });
  }
  return book;
}

/** Atomic write: a half-written manifest is worse than none. */
export function writeBook(config, book) {
  const dir = bookDir(config, book.bookId);
  mkdirSync(join(dir, 'archives'), { recursive: true });
  book.updatedAt = new Date().toISOString();
  const path = manifestPath(config, book.bookId);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(book, null, 2), 'utf8');
  renameSync(tmp, path);
  return book;
}

export function writeSource(config, bookId, text) {
  const dir = bookDir(config, bookId);
  mkdirSync(dir, { recursive: true });
  const path = sourcePath(config, bookId);
  writeFileSync(path, text, 'utf8');
  linesCache.delete(bookId);
  indexCache.delete(bookId);
  return path;
}

/** @returns {string[]} */
export function readSourceLines(config, bookId) {
  const cached = linesCache.get(bookId);
  if (cached !== undefined) return cached;
  const path = sourcePath(config, bookId);
  if (!existsSync(path)) throw sourceError(`这本书没有落盘的正文（${path}）`, { bookId });
  const lines = toLines(readFileSync(path, 'utf8'));
  linesCache.set(bookId, lines);
  return lines;
}

/**
 * The normalized source plus line index used by quote verification. Built once
 * per book per process; a 200k-character book would otherwise be re-normalized
 * on every archive submission.
 */
export function readSourceIndex(config, bookId) {
  const cached = indexCache.get(bookId);
  if (cached !== undefined) return cached;
  const index = buildSourceIndex(readSourceLines(config, bookId));
  indexCache.set(bookId, index);
  return index;
}

export function dropSourceCache(bookId) {
  linesCache.delete(bookId);
  indexCache.delete(bookId);
}

export function readArchive(config, bookId, chapterId) {
  const path = archivePath(config, bookId, chapterId);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export function writeArchive(config, bookId, chapterId, markdown) {
  const dir = join(bookDir(config, bookId), 'archives');
  mkdirSync(dir, { recursive: true });
  const path = archivePath(config, bookId, chapterId);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, markdown, 'utf8');
  renameSync(tmp, path);
  return path;
}

/**
 * Newest-first list of opened books, from their manifests.
 *
 * Manifests are cached by mtime, because this runs inside prompt assembly (the
 * projection needs the archive counts) and re-parsing every manifest on every
 * step of every turn is work that grows with the reader's library. Writes are
 * atomic renames, so an mtime match is an exact revision — not a heuristic.
 */
export function listBooks(config) {
  const root = booksRoot(config);
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root)) {
    const manifest = join(root, entry, 'manifest.json');
    if (!existsSync(manifest)) continue;
    try {
      const stat = statSync(manifest);
      const cached = manifestCache.get(manifest);
      if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) {
        out.push({ ...cached.book, mtime: stat.mtimeMs });
        continue;
      }
      const book = JSON.parse(readFileSync(manifest, 'utf8'));
      manifestCache.set(manifest, { mtimeMs: stat.mtimeMs, book });
      out.push({ ...book, mtime: stat.mtimeMs });
    } catch {
      // A corrupt manifest must not make the whole listing unusable.
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const manifestCache = new Map();

/** The book `reading_status` reports when the caller named none. */
export function latestBookId(config) {
  return listBooks(config)[0]?.bookId ?? null;
}

/**
 * Resolve a caller-supplied book id, or the most recent book.
 * @param {object} config
 * @param {string|undefined} requested
 */
export function resolveBookId(config, requested) {
  const trimmed = typeof requested === 'string' ? requested.trim() : '';
  if (trimmed !== '') return requireBook(config, trimmed);
  const latest = latestBookId(config);
  if (latest === null) {
    throw notFoundError('还没有打开过任何书。先用 reading_open({ path }) 导入一本。');
  }
  return requireBook(config, latest);
}

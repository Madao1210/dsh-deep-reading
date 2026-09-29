/**
 * 阅读档案 (the reading profile) — layer 2 of the blueprint, in its smallest
 * honest form. It stores exactly three things and nothing else:
 *
 *   1. 进度：正在读哪本书、哪一章     → `progress`
 *   2. 读者标记：已懂 / 困惑 / 兴趣点 / 待验证 → `marks`
 *   3. 档案索引：哪本书哪一章已建档     → derived from each book's manifest
 *
 * Single JSON file is the source of truth; the compact projection the
 * conversation sees each turn is *derived* from it deterministically and never
 * written back. That is the one structural idea worth taking from dsh-mnemon:
 * a projection that can be regenerated cannot drift, and a hand-maintained
 * "summary of the profile" eventually contradicts the profile.
 *
 * Per-book facts (chapters, chunks, archive state) deliberately live in the
 * book's own manifest instead of here, so this file stays small enough to read
 * and rewrite on every mark.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listBooks } from './book.js';

/** The reader's marks, exactly as the blueprint names them. */
export const MARK_KINDS = ['已懂', '困惑', '兴趣点', '待验证'];

export function profilePath(config) {
  return join(config.dataRoot, 'profile.json');
}

/** @returns {{ progress: object|null, marks: object[], crossBookNotes: object[], updatedAt: string|null }} */
export function readProfile(config) {
  const path = profilePath(config);
  if (!existsSync(path)) return emptyProfile();
  const mtimeMs = statSync(path).mtimeMs;
  const cached = profileCache.get(path);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cloneProfile(cached.profile);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const profile = {
      progress: parsed.progress ?? null,
      marks: Array.isArray(parsed.marks) ? parsed.marks : [],
      crossBookNotes: Array.isArray(parsed.crossBookNotes) ? parsed.crossBookNotes : [],
      updatedAt: parsed.updatedAt ?? null,
    };
    profileCache.set(path, { mtimeMs, profile });
    return cloneProfile(profile);
  } catch {
    // A corrupt profile must not take the reading session down; it is
    // reconstructible from the books on disk, so starting clean is safe here in
    // a way it would not be for an archive.
    return emptyProfile();
  }
}

/** Cache by mtime; writes are atomic renames, so the mtime is an exact revision. */
const profileCache = new Map();

/**
 * Callers mutate what they read (addMark pushes), so the cached object is never
 * handed out directly — otherwise the cache would quietly become the new
 * uncommitted state.
 */
function cloneProfile(profile) {
  return {
    progress: profile.progress === null ? null : { ...profile.progress },
    marks: profile.marks.map((mark) => ({ ...mark })),
    crossBookNotes: profile.crossBookNotes.map((note) => ({ ...note })),
    updatedAt: profile.updatedAt,
  };
}

export function writeProfile(config, profile) {
  mkdirSync(config.dataRoot, { recursive: true });
  profile.updatedAt = new Date().toISOString();
  const path = profilePath(config);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(profile, null, 2), 'utf8');
  renameSync(tmp, path);
  profileCache.delete(path);
  return profile;
}

function emptyProfile() {
  return { progress: null, marks: [], crossBookNotes: [], updatedAt: null };
}

/** Record where the reader has got to. Called by the tools, never by a model guess. */
export function setProgress(config, { bookId, chapterId, title }) {
  const profile = readProfile(config);
  profile.progress = {
    bookId,
    chapterId: chapterId ?? null,
    title: title ?? null,
    at: new Date().toISOString(),
  };
  return writeProfile(config, profile);
}

/**
 * Add a reader mark. `kind` must be one of {@link MARK_KINDS} — the vocabulary is
 * closed on purpose: a free-form tag cloud is not something a later turn can act
 * on, and the four words here are the four states the dialogue layer branches on.
 */
export function addMark(config, { bookId, chapterId, kind, text }) {
  const profile = readProfile(config);
  profile.marks.push({
    bookId,
    chapterId: chapterId ?? null,
    kind,
    text,
    at: new Date().toISOString(),
  });
  return writeProfile(config, profile);
}

export function removeMark(config, index) {
  const profile = readProfile(config);
  if (index < 0 || index >= profile.marks.length) return null;
  const [removed] = profile.marks.splice(index, 1);
  writeProfile(config, profile);
  return removed;
}

/**
 * The compact projection injected into the conversation each turn.
 *
 * Budgeted by construction: at most 6 marks, each truncated to 40 characters,
 * because this text is re-sent on every step of every turn and the one thing
 * measured about the previous attempt at this plugin is that resident context is
 * where the money goes. Returns '' when nothing has been read yet — an empty
 * context contributes nothing, so a fresh session pays nothing for having the
 * plugin installed.
 *
 * This runs inside prompt assembly, so it must never throw: a corrupt profile or
 * a deleted book directory degrades to no projection, not to a broken turn.
 * Cheapness comes from the mtime-keyed caches in `readProfile` and `listBooks`
 * rather than from a time-to-live memo — a TTL would hide a mark the reader just
 * added, and hiding the reader's own mark is the one thing this projection
 * exists not to do.
 *
 * @returns {string}
 */
export function renderProjection(config, { maxMarks = 6, maxMarkChars = 40 } = {}) {
  try {
    return computeProjection(config, maxMarks, maxMarkChars);
  } catch (error) {
    console.warn(`[dsh-deep-reading] 阅读档案投影生成失败，本轮不注入：${error.message}`);
    return '';
  }
}

function computeProjection(config, maxMarks, maxMarkChars) {
  const profile = readProfile(config);
  const books = listBooks(config);
  const lines = [];

  if (profile.progress !== null) {
    const book = books.find((entry) => entry.bookId === profile.progress.bookId);
    const total = book?.chapters?.length ?? 0;
    const done = book === undefined ? 0 : Object.keys(book.archives ?? {}).length;
    const title = profile.progress.title ?? book?.title ?? '（未命名）';
    const position = profile.progress.chapterId === null
      ? '未进入具体章节'
      : `${profile.progress.chapterId}/${total}`;
    lines.push(`阅读进度：《${title}》 ${position}（已建档 ${done} 章）`);
  }

  const recent = profile.marks.slice(-maxMarks);
  if (recent.length > 0) {
    const marks = recent.map((mark) => {
      const where = mark.chapterId === null ? '' : `${mark.chapterId} `;
      const text = mark.text.length <= maxMarkChars ? mark.text : `${mark.text.slice(0, maxMarkChars)}…`;
      return `${where}${mark.kind}：${text}`;
    });
    lines.push(`读者标记：${marks.join('；')}`);
  }

  if (lines.length === 0) return '';
  return ['【深度讲解】', ...lines].join('\n');
}

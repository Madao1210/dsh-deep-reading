/**
 * Assemble, verify and persist one section archive.
 *
 * The order is fixed and not configurable: verify first, write only if clean,
 * then append the plugin's own facts. A rejected archive is not written at all —
 * a partially-written archive on disk is a thing a later turn will read back and
 * believe.
 */
import { verifyArchive } from './verify.js';
import { renderMemorySection, withMemorySection, READER_PLACEHOLDER } from './template.js';
import { archivePath, writeArchive, writeBook } from '../store/book.js';

/**
 * @param {object} input
 * @param {object} input.config
 * @param {object} input.book        manifest
 * @param {object} input.chapter     chapter entry from the manifest
 * @param {string} input.markdown    archive body submitted by the model
 * @param {{ normalized: string, marks: {start:number,line:number}[] }} input.sourceIndex
 * @param {boolean} [input.readerInput]
 * @returns {{ ok: boolean, violations: object[], warnings: string[], quoteLocators: string[],
 *             markdown?: string, path?: string, state?: string }}
 */
export function persistArchive({ config, book, chapter, markdown, sourceIndex, readerInput = false }) {
  const verification = verifyArchive({ markdown, sourceIndex, config, readerInput });
  if (verification.violations.length > 0) {
    return {
      ok: false,
      violations: verification.violations,
      warnings: verification.warnings,
      quoteLocators: verification.quoteLocators,
    };
  }

  const previous = book.archives?.[chapter.id] ?? null;
  const revision = (previous?.revision ?? 0) + 1;
  const state = verification.warnings.length === 0 ? 'complete' : 'partial';
  const coveredChars = chapter.chars;
  const totalChars = book.stats?.chars ?? 0;

  const final = withMemorySection(markdown, renderMemorySection({
    chapterId: chapter.id,
    understanding: previous?.understanding ?? '待验证',
    memoryPath: relativeMemoryPath(book.bookId, chapter.id),
    state,
    coveredChars,
    totalChars,
    verification: verification.warnings.length === 0
      ? `引文 ${verification.quoteLocators.length} 条全部逐字命中原文`
      : `引文 ${verification.quoteLocators.length} 条逐字命中；另有 ${verification.warnings.length} 条提示`,
    revision,
    nextStep: nextStepFor(book, chapter),
  }));

  const path = writeArchive(config, book.bookId, chapter.id, final);

  book.archives = book.archives ?? {};
  book.archives[chapter.id] = {
    state,
    revision,
    chars: final.length,
    coveredChars,
    quoteCount: verification.quoteLocators.length,
    warnings: verification.warnings,
    readerInput,
    updatedAt: new Date().toISOString(),
  };
  writeBook(config, book);

  return {
    ok: true,
    violations: [],
    warnings: verification.warnings,
    quoteLocators: verification.quoteLocators,
    markdown: final,
    path,
    state,
  };
}

/**
 * Where the archive lives, written the way the blueprint names it, with the real
 * data root in front so the line is usable rather than decorative.
 */
export function relativeMemoryPath(bookId, chapterId) {
  return `books/${bookId}/archives/${chapterId}.md`;
}

export function archivePathOf(config, bookId, chapterId) {
  return archivePath(config, bookId, chapterId);
}

/** What the reader should do after this archive. Plugin state, not a model guess. */
function nextStepFor(book, chapter) {
  const done = Object.keys(book.archives ?? {}).length;
  const total = book.chapters.length;
  const next = book.chapters.find((entry) => entry.index > chapter.index && entry.source !== 'fallback');
  if (next !== undefined) {
    return `本章已建档（${done}/${total}）；下一章 ${next.id}（${next.title === '' ? '（无标题）' : next.title}）尚未建档。`;
  }
  return done >= total
    ? `全书 ${total} 章已建档。可以问全书层面的问题了（第 3 阶段的整书地图尚未实现，当前只能按章检索）。`
    : `本章已建档（${done}/${total}）；后面还有章节未建档。`;
}

export { READER_PLACEHOLDER };

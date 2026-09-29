/**
 * Chunk plan and Map-wave packing.
 *
 * Two rules carry the whole design:
 *
 *   1. A chapter is split into parts only when it is longer than
 *      `maxCharsPerChunk`, and the split happens at paragraph boundaries.
 *   2. A chapter is never split across waves. Each wave is one `workflow` call,
 *      and the Reduce step for a chapter must see all of that chapter's parts —
 *      so a chapter that does not fit in a wave takes a wave of its own and the
 *      overflow is reported instead of being silently interleaved.
 */
import { rangeChars } from '../util/text.js';

/**
 * @typedef {object} Chunk
 * @property {string} id          ch03#p1
 * @property {string} chapterId
 * @property {number} part        1-based
 * @property {number} startLine
 * @property {number} endLine
 * @property {number} chars
 */

/**
 * @typedef {object} Wave
 * @property {number} wave
 * @property {string[]} chunkIds
 * @property {string[]} chapterIds
 * @property {number} chars
 * @property {boolean} overCap
 */

/**
 * @param {import('./structure.js').Chapter[]} chapters
 * @param {string[]} lines
 * @param {{ maxCharsPerChunk: number, maxChunksPerWave: number }} config
 * @returns {{ chunks: Chunk[], waves: Wave[], warnings: string[] }}
 */
export function buildChunkPlan(chapters, lines, config) {
  const chunks = [];
  const warnings = [];

  for (const chapter of chapters) {
    const parts = splitChapter(chapter, lines, config.maxCharsPerChunk);
    parts.forEach((part, i) => {
      chunks.push({
        id: `${chapter.id}#p${i + 1}`,
        chapterId: chapter.id,
        part: i + 1,
        startLine: part.startLine,
        endLine: part.endLine,
        chars: rangeChars(lines, part.startLine, part.endLine),
      });
    });
    // Splitting is line-addressed, so a chapter that is one enormous line
    // cannot be cut at all: there is no line boundary to cut on, and cutting
    // mid-line would break every citation that points into that range. Report
    // it instead of pretending the chunk is within budget.
    const oversized = chunks.filter((chunk) => chunk.chapterId === chapter.id && chunk.chars > config.maxCharsPerChunk * 1.5);
    if (oversized.length > 0) {
      warnings.push(
        `${chapter.id} 有一块 ${oversized[0].chars} 字，明显超过 maxCharsPerChunk=${config.maxCharsPerChunk}，`
        + '但这一章没有可用的段落边界（可能是整章连成一行）。'
        + '本插件按行寻址，不在行内切分——否则所有指向这一段的引用都会失效。'
        + '要让它变小，请先用 textPath 传入分段过的文本。',
      );
    }
  }

  // Pack chapters — not chunks — into waves, in reading order.
  const waves = [];
  let current = null;
  for (const chapter of chapters) {
    const own = chunks.filter((chunk) => chunk.chapterId === chapter.id);
    if (current !== null && current.chunkIds.length + own.length <= config.maxChunksPerWave) {
      current.chunkIds.push(...own.map((chunk) => chunk.id));
      current.chapterIds.push(chapter.id);
      current.chars += own.reduce((sum, chunk) => sum + chunk.chars, 0);
      continue;
    }
    current = {
      wave: waves.length + 1,
      chunkIds: own.map((chunk) => chunk.id),
      chapterIds: [chapter.id],
      chars: own.reduce((sum, chunk) => sum + chunk.chars, 0),
      overCap: own.length > config.maxChunksPerWave,
    };
    waves.push(current);
    if (current.overCap) {
      warnings.push(
        `${chapter.id} 单独占一个波次：它被切成 ${own.length} 块，超过 maxChunksPerWave=${config.maxChunksPerWave}。`
        + '这一波会派生同样数量的子代理；如果超时，请调大 maxCharsPerChunk 或把这一章拆成多章。',
      );
    }
  }

  return { chunks, waves, warnings };
}

/**
 * Split one chapter at paragraph boundaries into parts of roughly equal size.
 * Returns the chapter itself when it already fits.
 */
function splitChapter(chapter, lines, maxCharsPerChunk) {
  if (chapter.chars <= maxCharsPerChunk) {
    return [{ startLine: chapter.startLine, endLine: chapter.endLine }];
  }
  const parts = Math.ceil(chapter.chars / maxCharsPerChunk);
  const target = Math.ceil(chapter.chars / parts);
  const out = [];
  let start = chapter.startLine;
  let chars = 0;

  for (let line = chapter.startLine; line <= chapter.endLine; line += 1) {
    chars += lines[line - 1].length;
    const atEnd = line === chapter.endLine;
    // Cut on a blank line (a paragraph boundary), or at the chapter end.
    const atBoundary = lines[line - 1].trim() === '' || line + 1 <= chapter.endLine && lines[line].trim() === '';
    if (atEnd || (chars >= target && atBoundary) || (atEnd === false && chars >= target * 2)) {
      const endLine = trimBlank(lines, start, line);
      if (endLine >= start) out.push({ startLine: start, endLine });
      start = Math.max(endLine + 1, line);
      chars = 0;
    }
  }
  if (start <= chapter.endLine) {
    const endLine = trimBlank(lines, start, chapter.endLine);
    if (endLine >= start) out.push({ startLine: start, endLine });
  }
  return out.length > 0 ? out : [{ startLine: chapter.startLine, endLine: chapter.endLine }];
}

function trimBlank(lines, startLine, endLine) {
  let end = endLine;
  while (end > startLine && lines[end - 1].trim() === '') end -= 1;
  return end;
}

/** The wave a chunk belongs to, or null. */
export function waveOf(waves, chunkId) {
  return waves.find((wave) => wave.chunkIds.includes(chunkId)) ?? null;
}

/**
 * Deterministic chapter detection.
 *
 * This runs in the plugin process, not in a subagent: splitting a text file
 * into chapters is a bookkeeping problem, and paying a model to solve a
 * bookkeeping problem produces a different answer every time for the same file.
 * Everything downstream (chunk ranges, archive ids, coverage) is addressed by
 * these line ranges, so they have to be reproducible.
 *
 * The detector is deliberately willing to say "I am not sure": a chapter found
 * by an explicit `第N章`/ATX-heading rule is high confidence, one found by the
 * short-standalone-line heuristic is low confidence and gets reported, and a
 * file with no structure at all falls back to fixed-size windows with a warning
 * rather than pretending it found chapters.
 */
import { rangeChars } from '../util/text.js';

/** A chapter marker that is almost certainly a chapter. */
const STRONG_PATTERNS = [
  /^第\s*[0-9零一二三四五六七八九十百千两]+\s*[章节回篇部卷]/,
  /^chapter\s+[0-9ivxl]+/i,
  /^part\s+[0-9ivxl]+/i,
  /^[0-9]{1,3}[.、]\s*\S/,
  /^[（(]\s*[0-9一二三四五六七八九十]{1,3}\s*[)）]\s*\S/,
];

/** Sentence-final or clause punctuation: a line carrying it is prose, not a title. */
const PROSE_PUNCTUATION = /[。！？；，,.;:!?]/;

const MAX_TITLE_CHARS = 40;
const MAX_HEURISTIC_TITLE_CHARS = 30;

/**
 * A preamble shorter than this is a title page, not a chapter.
 *
 * This threshold is the difference between a book whose first "chapter" is its
 * own title and a book whose preface is correctly addressable. A one-line title
 * becomes `frontMatter` (and usually becomes the book's title); anything longer
 * is content, and content that is not addressable is content that silently
 * drops out of coverage — which is the failure this whole layer exists to
 * prevent.
 */
const FRONT_MATTER_CHAPTER_CHARS = 200;

/**
 * @typedef {object} Chapter
 * @property {string} id            ch01, ch02, … — stable, used by every later stage
 * @property {number} index         1-based position in the book
 * @property {string} title         as written in the source ('' when none was found)
 * @property {number} startLine     1-based inclusive
 * @property {number} endLine       1-based inclusive
 * @property {number} chars         characters in the range, newlines excluded
 * @property {number} level         1 for chapter level
 * @property {'heading'|'bare_title'|'fallback'|'front_matter'} source
 * @property {'high'|'low'} confidence
 * @property {boolean} lowConfidence
 */

/**
 * @param {string[]} lines
 * @param {{ chapterHeadingLevel: number, minChapterChars: number, maxCharsPerChunk: number }} config
 * @returns {{ chapters: Chapter[], strategy: string, warnings: string[] }}
 */
export function detectChapters(lines, config) {
  const headingMarks = findHeadings(lines, config.chapterHeadingLevel);
  let marks;
  let strategy;
  /** @type {object[]} */
  let ignoredWeak = [];

  if (headingMarks.length >= 2) {
    marks = headingMarks;
    strategy = 'heading';
  } else {
    const { strong, weak } = findBareTitles(lines);
    const byLine = (a, b) => a.line - b.line;
    const all = [...strong, ...weak].sort(byLine);
    if (strong.length >= 2) {
      // Strong evidence wins outright. A bare `第一章` is a chapter marker; a
      // short standalone line is only a guess, and letting guesses compete with
      // markers is how a book's own title page becomes chapter one.
      marks = strong;
      ignoredWeak = weak;
      strategy = 'bare_title';
    } else if (all.length >= 2) {
      marks = all;
      strategy = 'bare_title';
    } else {
      return fallbackSplit(lines, config);
    }
  }

  const warnings = [];
  const chapters = [];

  /** @type {{ startLine: number, endLine: number, chars: number, text: string } | null} */
  let frontMatter = null;

  // Anything before the first marker is either the title page or a preface.
  // Dropping it would silently remove the preface from coverage; promoting a
  // title page to a chapter would make the chapter list start with a lie.
  const firstStart = marks[0].line;
  const preambleEnd = trimEnd(lines, 1, firstStart - 1);
  if (firstStart > 1 && lines.slice(0, firstStart - 1).join('').trim() !== '') {
    const preambleChars = rangeChars(lines, 1, preambleEnd);
    const text = lines.slice(0, preambleEnd).join('\n');
    if (preambleChars > FRONT_MATTER_CHAPTER_CHARS) {
      chapters.push(makeChapter(chapters.length + 1, {
        title: firstLineTitle(lines, 1, preambleEnd) || '（前置内容）',
        startLine: 1,
        endLine: preambleEnd,
        level: 1,
        source: 'front_matter',
        confidence: 'high',
      }, lines));
    } else {
      frontMatter = { startLine: 1, endLine: preambleEnd, chars: preambleChars, text };
    }
  }

  marks.forEach((mark, i) => {
    const next = marks[i + 1];
    const endLine = next === undefined ? lines.length : next.line - 1;
    chapters.push(makeChapter(chapters.length + 1, {
      title: mark.title,
      startLine: mark.line,
      endLine: trimEnd(lines, mark.line, endLine),
      level: mark.level,
      source: mark.source,
      confidence: mark.confidence,
    }, lines));
  });

  const kept = chapters.filter((chapter) => chapter.chars > 0);
  if (kept.length < 2) {
    const fallback = fallbackSplit(lines, config);
    fallback.warnings.unshift(
      `按${strategy === 'heading' ? '标题' : '裸标题'}只识别出 ${kept.length} 个章节，已退回等长切分。`,
    );
    return fallback;
  }

  const lows = kept.filter((chapter) => chapter.chars < config.minChapterChars);
  if (lows.length > 0) {
    warnings.push(
      `以下章节短于 ${config.minChapterChars} 字，已保留但标为低置信，请人工核对边界：`
      + lows.map((c) => `${c.id}(${c.chars}字)`).join('、'),
    );
  }
  if (strategy === 'bare_title') {
    warnings.push(
      '未发现 Markdown 标题，章节边界由（独立短行）启发式得到。'
      + '边界可疑时请用 reading_status 核对章节清单，必要时先用 textPath 传入手工整理过的文本。',
    );
  }
  if (ignoredWeak.length > 0) {
    warnings.push(
      `另有 ${ignoredWeak.length} 个弱标题候选未参与切分（已有足够的强章节标记）：`
      + ignoredWeak.slice(0, 8).map((mark) => `第 ${mark.line} 行（${mark.title}）`).join('、')
      + `${ignoredWeak.length > 8 ? ' 等' : ''}。如果其中某一行其实是章节，说明这本书的章节标记不统一。`,
    );
  }
  return { chapters: kept, strategy, warnings, frontMatter };
}

/**
 * Explicit ATX headings at or above the configured chapter level.
 * @param {string[]} lines
 * @param {number} chapterHeadingLevel
 */
function findHeadings(lines, chapterHeadingLevel) {
  const marks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (match === null) continue;
    const level = match[1].length;
    if (level > chapterHeadingLevel) continue;
    marks.push({ line: i + 1, title: match[2].trim(), level, source: 'heading', confidence: 'high' });
  }
  return marks;
}

/**
 * A line that stands alone between blank lines and does not read like prose.
 *
 * The blank-line requirement is what keeps this from matching every short
 * sentence in dialogue-heavy text; the punctuation veto is what keeps it from
 * matching the last line of a paragraph.
 *
 * Candidates come back split by confidence rather than merged, because the two
 * kinds are not interchangeable evidence: `strong` is a recognised chapter
 * marker, `weak` is a guess. Merging them makes a book's own title page
 * indistinguishable from its first chapter.
 *
 * @returns {{ strong: object[], weak: object[] }}
 */
function findBareTitles(lines) {
  const strong = [];
  const weak = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === '' || line.length > MAX_TITLE_CHARS) continue;
    if (isBlank(lines[i - 1] ?? '') === false && i !== 0) continue;
    if (isBlank(lines[i + 1] ?? '') === false) continue;
    if (isFence(line)) continue;

    if (STRONG_PATTERNS.some((pattern) => pattern.test(line))) {
      strong.push({ line: i + 1, title: line, level: 1, source: 'bare_title', confidence: 'high' });
      continue;
    }
    const looksLikeTitle = line.length <= MAX_HEURISTIC_TITLE_CHARS
      && PROSE_PUNCTUATION.test(line) === false
      && /[A-Za-z\u4e00-\u9fff]/.test(line);
    if (looksLikeTitle) {
      weak.push({ line: i + 1, title: line, level: 1, source: 'bare_title', confidence: 'low' });
    }
  }
  return { strong, weak };
}

/** No structure at all: fixed-size windows, loudly reported as such. */
function fallbackSplit(lines, config) {
  const target = config.maxCharsPerChunk;
  const chapters = [];
  let start = 1;
  while (start <= lines.length) {
    let end = start;
    let chars = 0;
    while (end <= lines.length && (chars < target || end === start)) {
      chars += lines[end - 1].length;
      end += 1;
    }
    end -= 1;
    chapters.push(makeChapter(chapters.length + 1, {
      title: `第 ${chapters.length + 1} 段（自动切分）`,
      startLine: start,
      endLine: end,
      level: 1,
      source: 'fallback',
      confidence: 'low',
    }, lines));
    start = end + 1;
  }
  return {
    chapters,
    strategy: 'fallback',
    frontMatter: null,
    warnings: [
      `未找到任何章节标记，已按每约 ${target} 字等长切分（${chapters.length} 段）。`
      + '这些（章节）不是作者的章节，档案里的"本节在全书中的位置"不可据此判断；'
      + '需要真正的章节边界时，请先整理源文本或用 textPath 传入带标题的版本。',
    ],
  };
}

/** @returns {Chapter} */
function makeChapter(index, spec, lines) {
  const width = index >= 100 ? 3 : 2;
  return {
    id: `ch${String(index).padStart(width, '0')}`,
    index,
    title: spec.title,
    startLine: spec.startLine,
    endLine: spec.endLine,
    chars: rangeChars(lines, spec.startLine, spec.endLine),
    level: spec.level,
    source: spec.source,
    confidence: spec.confidence,
    lowConfidence: spec.confidence === 'low',
  };
}

/** Pull back the end of a range past trailing blank lines. */
function trimEnd(lines, startLine, endLine) {
  let end = endLine;
  while (end > startLine && lines[end - 1].trim() === '') end -= 1;
  return end;
}

/** First non-blank line of a range, trimmed — a chapter's title when it has no marker. */
function firstLineTitle(lines, startLine, endLine) {
  for (let i = startLine - 1; i < endLine && i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line !== '') return line.length <= MAX_TITLE_CHARS ? line : '';
  }
  return '';
}

function isBlank(line) {
  return line.trim() === '';
}

function isFence(line) {
  return /^(```|~~~)/.test(line);
}

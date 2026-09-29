/**
 * Structure detection and chunk/wave planning.
 *
 * These are the deterministic half of the plugin, so the tests are about
 * reproducibility and about the specific ways a splitter lies: inventing a
 * chapter out of a title page, silently dropping a preface, or cutting a
 * chapter in half across two waves so that no single Reduce step can ever see
 * the whole of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectChapters } from '../../lib/pipeline/structure.js';
import { buildChunkPlan } from '../../lib/pipeline/chunker.js';
import { rangeChars } from '../../lib/util/text.js';

const CONFIG = { chapterHeadingLevel: 1, minChapterChars: 1, maxCharsPerChunk: 10000, maxChunksPerWave: 12 };
const lines = (text) => text.replace(/^\n+/, '').replace(/\n+$/, '').split('\n');

/** A chapter whose body is `paragraphs` separate lines, so boundaries exist. */
function chapterText(title, paragraphs, sentence = '这是一个用来把章节撑长的段落。') {
  return [title, '', ...Array.from({ length: paragraphs }, () => `${sentence.repeat(16)}\n`)].join('\n');
}

test('Markdown ATX 标题切章', () => {
  const text = lines(`
# 第一章 起点

正文一。

# 第二章 展开

正文二。

## 小节不该切章

正文三。
`);
  const result = detectChapters(text, CONFIG);
  assert.equal(result.strategy, 'heading');
  assert.equal(result.chapters.length, 2);
  assert.deepEqual(result.chapters.map((c) => c.title), ['第一章 起点', '第二章 展开']);
  assert.equal(result.chapters[1].startLine, 5);
});

test('强章节标记优先于弱标题候选（书名行不会被当成第一章）', () => {
  // Regression: a title page is a short standalone line, which is exactly what
  // the bare-title heuristic looks for. Before strong marks took precedence,
  // 《测试用书》 became ch01 and the real first chapter became ch02.
  const text = lines(`
《某本书》

第一章 甲

正文甲。

第二章 乙

正文乙。
`);
  const result = detectChapters(text, CONFIG);
  assert.equal(result.chapters.length, 2);
  assert.deepEqual(result.chapters.map((c) => c.title), ['第一章 甲', '第二章 乙']);
  assert.notEqual(result.frontMatter, null, '标题页应当作为 frontMatter 保留');
  assert.equal(result.frontMatter.chars, '《某本书》'.length);
  assert.match(result.warnings.join('\n'), /弱标题候选未参与切分/);
});

test('较长的前言是一章（不能被丢掉）', () => {
  const preface = '这是一段足够长的前言。'.repeat(20); // > 200 字
  const text = lines(`
前言

${preface}

第一章 甲

正文甲。

第二章 乙

正文乙。
`);
  const result = detectChapters(text, CONFIG);
  assert.equal(result.frontMatter, null);
  assert.equal(result.chapters.length, 3);
  assert.equal(result.chapters[0].source, 'front_matter');
});

test('没有任何章节标记时退回等长切分并给出警告', () => {
  const body = Array.from({ length: 40 }, (_, i) => `这是第 ${i} 行正文，没有任何标题结构。`).join('\n\n');
  const result = detectChapters(lines(body), { ...CONFIG, maxCharsPerChunk: 300 });
  assert.equal(result.strategy, 'fallback');
  assert.ok(result.chapters.length > 1);
  assert.match(result.warnings[0], /未找到任何章节标记/);
  assert.ok(result.chapters.every((c) => c.confidence === 'low'));
});

test('章节行范围互不重叠，空隙只允许是空行', () => {
  const text = lines(`
第一章 甲

甲正文。

第二章 乙

乙正文。

第三章 丙

丙正文。
`);
  const { chapters } = detectChapters(text, CONFIG);
  chapters.forEach((chapter, i) => {
    assert.ok(chapter.endLine >= chapter.startLine);
    if (i === 0) return;
    const previous = chapters[i - 1];
    assert.ok(chapter.startLine > previous.endLine, `${chapter.id} 与上一章重叠`);
    // Anything between two chapters is a blank separator, never content: a
    // non-blank line there would be text that belongs to no chapter and would
    // silently fall outside coverage.
    for (let line = previous.endLine + 1; line < chapter.startLine; line += 1) {
      assert.equal(text[line - 1].trim(), '', `第 ${line} 行夹在两章之间却不是空行`);
    }
  });
});

test('超长章节在段落边界切块', () => {
  const text = lines([
    chapterText('第一章 甲', 6),
    chapterText('第二章 乙', 1, '很短。'),
  ].join('\n\n'));
  const { chapters } = detectChapters(text, CONFIG);
  const long = chapters[0];
  assert.ok(long.chars > 1000, `第一章应当很长，实际 ${long.chars} 字`);
  const plan = buildChunkPlan(chapters, text, { maxCharsPerChunk: 500, maxChunksPerWave: 12 });
  const parts = plan.chunks.filter((chunk) => chunk.chapterId === long.id);
  assert.ok(parts.length > 1, `应当切成多块，实际 ${parts.length}`);
  assert.deepEqual(parts.map((p) => p.part), parts.map((_, i) => i + 1));
  assert.equal(parts[0].startLine, long.startLine);
  assert.equal(parts.at(-1).endLine, long.endLine);
  for (let i = 1; i < parts.length; i += 1) {
    assert.ok(parts[i].startLine > parts[i - 1].endLine, '块之间不得重叠');
  }
  // Blocks partition the chapter; only the blank separators between them are
  // attributed to neither side.
  const sum = parts.reduce((total, chunk) => total + chunk.chars, 0);
  assert.ok(sum <= long.chars && sum > long.chars * 0.85, `块字数 ${sum} 应接近章字数 ${long.chars}`);
  assert.equal(rangeChars(text, long.startLine, long.endLine), long.chars);
});

test('一章不会被拆到两个波次里', () => {
  const chapter = (n) => `第${n}章 标题${n}\n\n${'正文。'.repeat(300)}\n\n`;
  const text = lines(Array.from({ length: 6 }, (_, i) => chapter(i + 1)).join('\n'));
  const { chapters } = detectChapters(text, { ...CONFIG, minChapterChars: 1 });
  const plan = buildChunkPlan(chapters, text, { maxCharsPerChunk: 300, maxChunksPerWave: 3 });
  for (const wave of plan.waves) {
    for (const chapterId of wave.chapterIds) {
      const partsOfChapter = plan.chunks.filter((chunk) => chunk.chapterId === chapterId);
      for (const part of partsOfChapter) {
        assert.ok(wave.chunkIds.includes(part.id), `${chapterId} 的 ${part.id} 不在同一个波次里`);
      }
    }
  }
  assert.equal(plan.waves.map((w) => w.chapterIds.length).reduce((a, b) => a + b), chapters.length);
});

test('单章块数超过上限时独占一波并给出警告', () => {
  const text = lines([
    chapterText('第一章 甲', 8, '这一段很长，需要被切成很多块。'),
    chapterText('第二章 乙', 1, '很短。'),
  ].join('\n\n'));
  const { chapters } = detectChapters(text, { ...CONFIG, minChapterChars: 1 });
  const plan = buildChunkPlan(chapters, text, { maxCharsPerChunk: 120, maxChunksPerWave: 2 });
  assert.equal(plan.waves[0].overCap, true);
  assert.match(plan.warnings.join('\n'), /超过 maxChunksPerWave/);
});

test('整章连成一行时切不动，改成明确警告而不是假装合规', () => {
  // Line-addressed splitting cannot cut inside a line, and cutting anyway
  // would invalidate every citation pointing into that range.
  const text = lines(`第一章 甲\n\n${'正文。'.repeat(400)}\n\n第二章 乙\n\n短。`);
  const { chapters } = detectChapters(text, CONFIG);
  const plan = buildChunkPlan(chapters, text, { maxCharsPerChunk: 100, maxChunksPerWave: 12 });
  const parts = plan.chunks.filter((chunk) => chunk.chapterId === 'ch01');
  assert.equal(parts.length, 1);
  assert.match(plan.warnings.join('\n'), /没有可用的段落边界/);
});

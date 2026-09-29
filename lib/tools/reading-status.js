/**
 * `reading_status` — where the reading stands, and what to do next.
 *
 * This is the tool a fresh session should call first: it is the only place that
 * knows which chapters are archived, which Map chunks are cached, what the
 * reader last marked, and the literal `args` for the next `workflow` call. A
 * model that starts a session by re-reading a book instead of asking this
 * question is paying twice for work that is already on disk.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

import { cachedChapterModels, cachedChunkIds, buildWaveArgs, pendingChapterIds, pendingWaves } from '../pipeline/wave-args.js';
import { bookDir, listBooks, resolveBookId } from '../store/book.js';
import { readProfile, renderProjection } from '../store/profile.js';
import { chapterLine, guarded, refusalValue, textBlock } from './shared.js';

const OUTPUT_SCHEMA = {
  // Compiled by the value schema DSL: no `required`, explicit openness. See the
  // note in reading-open.js.
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    code: { type: 'string' },
    reason: { type: 'string' },
    nextStep: { type: 'string' },
    bookId: { type: 'string' },
    title: { type: 'string' },
    bookDir: { type: 'string' },
    dataRoot: { type: 'string' },
    statsLine: { type: 'string' },
    coverageLine: { type: 'string' },
    projectLine: { type: 'string' },
    chapters: { type: 'array', items: { type: 'string' } },
    pendingChapters: { type: 'array', items: { type: 'string' } },
    cachedChunks: { type: 'array', items: { type: 'string' } },
    cachedModels: { type: 'array', items: { type: 'string' } },
    projection: { type: 'string' },
    workflowArgsJson: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    books: { type: 'array', items: { type: 'string' } },
    lines: { type: 'array', items: { type: 'string' } },
  },
};

export function readingStatusTool({ config, promptRevision }) {
  return defineTool({
    name: 'reading_status',
    description:
      '看共读进度：已打开的书、当前读到哪、每章是否已建档、覆盖度、哪些块已有精读缓存、'
      + '读者留下了哪些标记，以及下一波要用的 workflow args。'
      + '新会话或续读时先调这个，不要重新读一遍书。',
    parameters: {
      bookId: { type: 'string', description: 'bookId；缺省时列出所有已打开的书，并详述最近一本。' },
      samples: { type: 'boolean', description: '为 true 时在章节清单里标注低置信边界，便于人工核对切分。' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(value.lines ?? [value.reason ?? '']),
    },
    async execute(args) {
      return guarded(async () => {
        const requested = typeof args.bookId === 'string' ? args.bookId.trim() : '';
        const books = listBooks(config);

        if (books.length === 0) {
          return {
            ok: true,
            action: 'reading_status',
            dataRoot: config.dataRoot,
            books: [],
            nextStep: '还没有打开过任何书。用 reading_open({ path }) 导入一本 txt/md。',
            lines: [
              '还没有打开过任何书。',
              `数据目录：${config.dataRoot}`,
              '用 reading_open({ path }) 导入一本 txt/md。',
            ],
          };
        }

        if (requested === '' && args.samples === true) {
          return {
            ok: true,
            action: 'reading_status',
            dataRoot: config.dataRoot,
            books: books.map((book) => describeBookLine(book)),
            nextStep: '要看书内详情，带上 bookId 再调一次。',
            lines: ['已打开的书：', ...books.map((book) => `  ${describeBookLine(book)}`)],
          };
        }

        const book = resolveBookId(config, requested === '' ? undefined : requested);
        const archived = book.archives ?? {};
        const archivedIds = Object.keys(archived);
        const coveredChars = book.chapters
          .filter((chapter) => archived[chapter.id] !== undefined)
          .reduce((sum, chapter) => sum + chapter.chars, 0);
        const profile = readProfile(config);
        const projection = renderProjection(config);
        const pending = pendingWaves(book);
        const wave = pending[0] ?? null;
        const cached = cachedChunkIds(config, book, promptRevision);
        const cachedModels = cachedChapterModels(config, book, promptRevision);
        const marksForBook = profile.marks.filter((mark) => mark.bookId === book.bookId);

        const lines = [
          `《${book.title}》  ${book.bookId}`,
          `结构：${book.stats.chapters} 章 / ${book.stats.chunks} 块 / ${book.stats.waves} 波  ${book.stats.chars} 字（切分策略 ${book.structure.strategy}）`,
          `建档：${archivedIds.length}/${book.stats.chapters} 章，覆盖 ${coveredChars}/${book.stats.chars} 字`
            + `（${Math.round((coveredChars / Math.max(book.stats.chars, 1)) * 100)}%）`,
          `正文：${book.sourcePath}`,
          '',
          '章节：',
          ...book.chapters.map((chapter) => {
            const entry = archived[chapter.id];
            const mapNote = cached.filter((chunkId) => chunkId.startsWith(`${chapter.id}#`)).length;
            const modelNote = cachedModels.includes(chapter.id) ? ' + mental model' : '';
            const extra = entry === undefined && mapNote > 0 ? `  [已精读 ${mapNote} 块${modelNote}，未合成]` : '';
            return `  ${chapterLine(chapter, entry?.state)}${extra}`;
          }),
        ];

        if (wave === null) {
          lines.push('', `全部 ${book.stats.chapters} 章都已建档。`);
        } else {
          const ids = pendingChapterIds(book, wave);
          const waveModels = ids.filter((id) => cachedModels.includes(id)).length;
          lines.push(
            '',
            `下一波（第 ${wave.wave} 波）：${ids.join('、')}，共 ${wave.chunkIds.length} 块`
              + `${cached.length > 0 ? `；其中 ${cached.length} 块命中精读缓存，不会重读` : ''}`
              + `${waveModels > 0 ? `；${waveModels} 章命中 mental model 缓存` : ''}`,
            'workflow args ——',
            JSON.stringify(buildWaveArgs({ config, book, wave, promptRevision }), null, 2),
          );
        }

        if (marksForBook.length > 0) {
          lines.push('', '读者标记：', ...marksForBook.map((mark) => `  ${mark.chapterId ?? ''} ${mark.kind}：${mark.text}`));
        }
        if (projection !== '') {
          lines.push('', '每轮会注入对话的紧凑投影 ——', projection);
        }
        if (book.structure.warnings.length > 0) {
          lines.push('', '导入时的提示：', ...book.structure.warnings.map((warning) => `  - ${warning}`));
        }

        return {
          ok: true,
          action: 'reading_status',
          bookId: book.bookId,
          title: book.title,
          bookDir: bookDir(config, book.bookId),
          dataRoot: config.dataRoot,
          statsLine: `${book.stats.chapters} 章 / ${book.stats.chunks} 块 / ${book.stats.waves} 波 / ${book.stats.chars} 字`,
          coverageLine: `${archivedIds.length}/${book.stats.chapters} 章，覆盖 ${coveredChars}/${book.stats.chars} 字`,
          projectLine: `${book.stats.waves} 波，已完成 ${book.stats.waves - pending.length}`,
          chapters: book.chapters.map((chapter) => chapterLine(chapter, archived[chapter.id]?.state)),
          pendingChapters: wave === null ? [] : pendingChapterIds(book, wave),
          cachedChunks: cached,
          cachedModels,
          projection,
          workflowArgsJson: wave === null ? '' : JSON.stringify(buildWaveArgs({ config, book, wave, promptRevision })),
          warnings: book.structure.warnings,
          books: books.map((entry) => describeBookLine(entry)),
          nextStep: wave === null
            ? '全书已建档：可以按章讲解与共读了，也可以问（这本书到目前为止讲了什么）（整书地图是第 3 阶段，尚未实现）。'
            : `调用 workflow 工具处理第 ${wave.wave} 波（args 见上）。`,
          lines,
        };
      }, (failure) => refusalValue(failure, 'reading_status'));
    },
  });
}

function describeBookLine(book) {
  const archived = Object.keys(book.archives ?? {}).length;
  const last = Object.keys(book.archives ?? {}).pop();
  return `${book.bookId}  《${book.title}》  ${archived}/${book.chapters.length} 章`
    + `${last === undefined ? '' : `（最近建档 ${last}）`}  ${book.stats.chars} 字`;
}

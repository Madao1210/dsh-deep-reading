/**
 * `reading_open` — turn a file into an addressable book.
 *
 * Deterministic end to end: this tool reads bytes, detects chapters, plans
 * chunks and waves, writes the source verbatim next to a manifest, and reports a
 * skeleton. No model is involved, so opening the same file twice gives the same
 * line ranges — which is the only reason a citation in an archive can still mean
 * something a week later.
 *
 * It returns the skeleton, never the text. A tool that dumped the book into the
 * conversation would make every later step pay for it again.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { SPLIT_RULE_VERSION } from '../config.js';
import { inputError, nextStepFor, sourceError } from '../util/errors.js';
import { fingerprintBook } from '../pipeline/cache.js';
import { buildChunkPlan } from '../pipeline/chunker.js';
import { detectChapters } from '../pipeline/structure.js';
import { buildWaveArgs, pendingChapterIds, pendingWaves } from '../pipeline/wave-args.js';
import { bookDir, readBook, writeBook, writeSource } from '../store/book.js';
import { setProgress } from '../store/profile.js';
import { normalizeSourceText, toLines } from '../util/text.js';
import { chapterLine, guarded, refusalValue, textBlock } from './shared.js';

const OUTPUT_SCHEMA = {
  // NOTE: `output.schema` is compiled by the *value schema DSL*, not the raw
  // JSON Schema subset used by workflow `agent()` schemas. That DSL rejects
  // `required` outright (a hard load-time failure, not a degraded parse) and
  // makes `additionalProperties` mandatory on every object node. Hence: no
  // `required` here, and every object names its openness explicitly.
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    code: { type: 'string' },
    reason: { type: 'string' },
    nextStep: { type: 'string' },
    returnedPrompt: { type: 'string' },
    textPath: { type: 'string' },
    bookId: { type: 'string' },
    bookDir: { type: 'string' },
    sourcePath: { type: 'string' },
    title: { type: 'string' },
    reopened: { type: 'boolean' },
    strategy: { type: 'string' },
    statsLine: { type: 'string' },
    chapters: { type: 'array', items: { type: 'string' } },
    waves: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    workflowArgsJson: { type: 'string' },
    pendingChapters: { type: 'array', items: { type: 'string' } },
    lines: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * @param {{ config: object, registryPromise: Promise<object>, buildArgs: Function }} input
 */
export function readingOpenTool({ config, registryPromise, promptRevision }) {
  return defineTool({
    name: 'reading_open',
    description:
      '把一份 txt/md 变成可寻址的书：确定性识别章节、切分块与波次，正文原样落盘，返回骨架（章节目录 + 波次 + 下一步的 workflow args）。'
      + '重复打开同一份文件是幂等的（bookId 由内容哈希与切分规则版本决定）。'
      + '只返回骨架，不返回正文。epub/pdf 不在这里解析：会返回 NEEDS_SUBAGENT_FETCH 与取文本提示词，'
      + '交给子代理取到纯文本后再用 textPath 导入。',
    parameters: {
      path: { type: 'string', description: '源文件路径（相对路径按当前工作目录解析）。txt/md 直接解析；epub/pdf 会返回取文本提示词。' },
      textPath: { type: 'string', description: '已提取好的纯文本路径。用于 epub/pdf 经子代理取文本后的第二次导入，或导入手工整理过的文本。' },
      title: { type: 'string', description: '书名；缺省时用文件名。' },
      format: { type: 'string', description: '强制解析器类型（txt/md/epub/pdf）；缺省按内容嗅探，不信任扩展名。' },
      bookId: { type: 'string', description: '只取某本已打开的书：给 bookId 时不重新读源文件，直接返回它的骨架。' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(value.lines ?? [value.reason ?? '']),
    },
    async execute(args) {
      return guarded(async () => {
        // ── reopen an already-known book ─────────────────────────────────────
        if (typeof args.bookId === 'string' && args.bookId.trim() !== '') {
          const book = readBook(config, args.bookId.trim());
          if (book === null) throw inputError(`没有这本书：${args.bookId}`, { bookId: args.bookId });
          return report(config, book, { reopened: true, warnings: [], promptRevision });
        }

        const registry = await registryPromise;
        const textPath = typeof args.textPath === 'string' ? args.textPath.trim() : '';
        const path = typeof args.path === 'string' ? args.path.trim() : '';
        if (textPath === '' && path === '') throw inputError('至少要给 path 或 textPath。');

        let text;
        let originPath;
        let parserName;

        if (textPath !== '') {
          const absolute = resolve(textPath);
          if (!existsSync(absolute)) throw sourceError(`textPath 指向的文件不存在：${absolute}`, { textPath: absolute });
          assertSize(absolute, config);
          text = normalizeSourceText(readFileSync(absolute, 'utf8'));
          originPath = path === '' ? absolute : resolve(path);
          parserName = 'text';
          if (text.trim() === '') {
            throw sourceError(`${absolute} 是空文件。取文本的子代理可能写失败了，请检查它是否真的写出了内容。`, { textPath: absolute });
          }
        } else {
          const absolute = resolve(path);
          if (!existsSync(absolute)) throw sourceError(`源文件不存在：${absolute}`, { path: absolute });
          if (statSync(absolute).isDirectory()) throw sourceError(`${absolute} 是目录，不是文件。`, { path: absolute });
          assertSize(absolute, config);
          const buffer = readFileSync(absolute);
          const parser = typeof args.format === 'string' && args.format.trim() !== ''
            ? registry.resolve(args.format.trim())
            : registry.detect(buffer, absolute);
          parserName = parser.name;

          if (parser.deterministic !== true) {
            // Hand the model a prompt instead of an algorithm it will get wrong:
            // see prompts and the parser's own comment for why this plugin does
            // not ship a second EPUB/PDF extractor.
            const incoming = join(config.dataRoot, 'incoming', `${slug(basename(absolute))}.txt`);
            mkdirSync(join(config.dataRoot, 'incoming'), { recursive: true });
            const returnedPrompt = parser.buildPrompt({ input: absolute, textPath: incoming });
            return {
              ok: false,
              action: 'reading_open',
              code: 'NEEDS_SUBAGENT_FETCH',
              reason: `${parser.name} 不由本插件解析（避免与已有的书本工具产生第二套章节边界）。`
                + '请把 returnedPrompt 交给一个子代理去取文本。',
              nextStep: nextStepFor('NEEDS_SUBAGENT_FETCH'),
              returnedPrompt,
              textPath: incoming,
              lines: [
                `${parser.name.toUpperCase()} 需要先取文本：本插件不自行解析该格式。`,
                `建议落点：${incoming}`,
                '',
                '把下面这段交给一个子代理，让它把全文原样写到该路径，然后调用：',
                `reading_open({ textPath: ${JSON.stringify(incoming)}, path: ${JSON.stringify(absolute)} })`,
                '',
                '—— 取文本提示词 ——',
                returnedPrompt,
              ],
            };
          }
          text = parser.extract({ buffer, path: absolute });
          originPath = absolute;
        }

        if (text.trim() === '') throw sourceError(`解析 ${originPath} 得到的正文是空的，无法建立章节结构。`, { path: originPath });

        const { bookId, sha } = fingerprintBook({ text, ruleVersion: SPLIT_RULE_VERSION });
        const existing = readBook(config, bookId);
        if (existing !== null) {
          // Same bytes, same split rules: the previous work is still valid.
          setProgress(config, { bookId, chapterId: existing.chapters[0]?.id ?? null, title: existing.title });
          return report(config, existing, { reopened: true, warnings: [], promptRevision });
        }

        const lines = toLines(text);
        const structure = detectChapters(lines, config);
        const explicitTitle = typeof args.title === 'string' ? args.title.trim() : '';
        const frontTitle = firstShortLine(structure.frontMatter?.text ?? '');
        const title = explicitTitle !== ''
          ? explicitTitle
          : (frontTitle !== '' ? frontTitle : basename(originPath).replace(/\.[^.]+$/, ''));
        const titleFrom = explicitTitle !== '' ? 'caller' : (frontTitle !== '' ? 'front_matter' : 'filename');
        const structureResult = detectChaptersReport(structure, titleFrom, title);
        const plan = buildChunkPlan(structure.chapters, lines, config);

        const book = {
          bookId,
          title,
          sourceSha: sha,
          ruleVersion: SPLIT_RULE_VERSION,
          originPath,
          parser: parserName,
          titleFrom,
          sourcePath: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          frontMatter: structure.frontMatter,
          stats: {
            lines: lines.length,
            chars: lines.reduce((sum, line) => sum + line.length, 0),
            chapters: structure.chapters.length,
            chunks: plan.chunks.length,
            waves: plan.waves.length,
          },
          structure: { strategy: structure.strategy, warnings: structureResult },
          chapters: structure.chapters,
          chunks: plan.chunks,
          waves: plan.waves,
          archives: {},
        };
        book.sourcePath = writeSource(config, bookId, text);
        writeBook(config, book);
        setProgress(config, { bookId, chapterId: structure.chapters[0]?.id ?? null, title });

        return report(config, book, {
          reopened: false,
          warnings: [...structureResult, ...plan.warnings],
          promptRevision,
        });
      }, (failure) => refusalValue(failure, 'reading_open'));
    },
  });
}

/** Everything the reader needs to know about a freshly opened (or known) book. */
function report(config, book, { reopened, warnings, promptRevision }) {
  const pending = pendingWaves(book);
  const wave = pending[0] ?? null;
  const archived = Object.keys(book.archives ?? {});
  const coveredChars = book.chapters
    .filter((chapter) => archived.includes(chapter.id))
    .reduce((sum, chapter) => sum + chapter.chars, 0);

  const lines = [
    `${reopened ? '已打开过的书' : '已导入'}：${book.bookId}  《${book.title}》`,
    `结构：${book.stats.chapters} 章 / ${book.stats.chunks} 块 / ${book.stats.waves} 波次  共 ${book.stats.chars} 字（${book.stats.lines} 行）`
      + `  切分策略 ${book.structure.strategy}${book.stats.waves > 1 ? `，本次先做第 1 波` : ''}`,
    `正文：${book.sourcePath}`,
    ...book.chapters.map((chapter) => `  ${chapterLine(chapter, book.archives?.[chapter.id]?.state)}`),
    ...(warnings.length > 0 ? ['', '注意：', ...warnings.map((warning) => `  - ${warning}`)] : []),
  ];

  if (wave === null) {
    lines.push('', `全部 ${book.stats.chapters} 章都已建档（覆盖 ${coveredChars}/${book.stats.chars} 字）。`);
  } else {
    const ids = pendingChapterIds(book, wave);
    lines.push(
      '',
      `下一步：调用 workflow 工具，用技能里给的 meta + script，args 用下面这份（第 ${wave.wave} 波，含 ${ids.length} 章 / ${wave.chunkIds.length} 块）——`,
      JSON.stringify(buildWaveArgs({ config, book, wave, promptRevision }), null, 2),
      '',
      `这一波覆盖：${ids.join('、')}${pending.length > 1 ? `；后面还有 ${pending.length - 1} 波，做完这一波后用 reading_status 拿下一波的 args。` : '。'}`,
    );
  }

  return {
    ok: true,
    action: 'reading_open',
    bookId: book.bookId,
    bookDir: bookDir(config, book.bookId),
    sourcePath: book.sourcePath,
    title: book.title,
    reopened,
    strategy: book.structure.strategy,
    statsLine: `${book.stats.chapters} 章 / ${book.stats.chunks} 块 / ${book.stats.waves} 波 / ${book.stats.chars} 字`,
    chapters: book.chapters.map((chapter) => chapterLine(chapter, book.archives?.[chapter.id]?.state)),
    waves: book.waves.map((entry) => `第 ${entry.wave} 波：${entry.chapterIds.join('、')}（${entry.chunkIds.length} 块，${entry.chars} 字）`),
    warnings,
    workflowArgsJson: wave === null ? '' : JSON.stringify(buildWaveArgs({ config, book, wave, promptRevision })),
    pendingChapters: wave === null ? [] : pendingChapterIds(book, wave),
    nextStep: wave === null ? '这本书已全部建档。' : `调用 workflow 工具处理第 ${wave.wave} 波。`,
    lines,
  };
}

function assertSize(path, config) {
  const size = statSync(path).size;
  if (size > config.maxSourceBytes) {
    throw sourceError(
      `文件 ${Math.round(size / 1024)} KB 超过 maxSourceBytes（${Math.round(config.maxSourceBytes / 1024)} KB）。`
      + '这本书不可能在一轮里读完；先切分成若干部分再导入，或调大配置。',
      { path, size },
    );
  }
}

function slug(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 60);
}

/**
 * The first line of a title page, if it plausibly is a title.
 *
 * A book's own first line being adopted as its title is only safe under two
 * conditions: it is short, and it is the whole of what stands before the first
 * chapter. Both are checked by the caller (`frontMatter` is only produced for a
 * preamble under the threshold), and the length check is repeated here.
 */
function firstShortLine(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim().replace(/^《|》$/g, '');
    if (trimmed === '') continue;
    return trimmed.length <= 60 ? trimmed : '';
  }
  return '';
}

/** Warnings, plus the one fact the caller needs to know about the title page. */
function detectChaptersReport(structure, titleFrom, title) {
  return [
    ...structure.warnings,
    ...(titleFrom === 'front_matter'
      ? [`书名取自正文前的标题行（${title}）。不对的话用 reading_open({ title }) 重开一次。`]
      : []),
    ...(structure.frontMatter !== null && titleFrom === 'caller'
      ? [`正文前有 ${structure.frontMatter.chars} 字的标题页（第 ${structure.frontMatter.startLine}–${structure.frontMatter.endLine} 行），未计入章节，也不参与覆盖度。`]
      : []),
  ];
}

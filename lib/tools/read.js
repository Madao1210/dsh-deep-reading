/**
 * dr_read — read-only windowed access to a book.
 * Modes: index | range (needs chapter) | locate (chapter + phrase) | find (keyword).
 * Never writes to disk.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { fail } from '../util.js';
import { chapterMeta, loadBook, readUnits, renderUnits } from '../bookstore.js';
import { COMMON, guarded, num, obj, str, strs, textBlock, bool } from './shared.js';

const DEFAULT_MAX_BYTES = 20000;
const DEFAULT_CONTEXT = 1;
const DEFAULT_LIMIT = 20;

const OUTPUT_SCHEMA = obj({
  ...COMMON,
  mode: str('本次模式：index / range / locate / find'),
  book: str('书籍 ID'),
  bookTitle: str('书名'),
  bookDir: str('书籍目录'),
  chapter: num('章节号（range / locate / find 指定章时）'),
  chapterTitle: str('章节标题'),
  totalParas: num('本章段落总数'),
  emittedFrom: num('实际起始段号'),
  emittedTo: num('实际结束段号'),
  nextFrom: num('下次续读的起始段号（hasMore 时）'),
  truncatedBy: str('截断原因：max-bytes'),
  text: str('原文（带 [n] 锚点）'),
  hasMore: bool('是否还有未读部分'),
  bytes: num('本次返回文本的字节数'),
  maxBytes: num('本次使用的字节上限'),
  matchCount: num('命中段落数'),
  scannedChapters: { type: 'array', items: { type: 'number' }, description: 'find 扫描的章节号' },
  matches: {
    type: 'array',
    description: 'find 命中：{chapter, para, snippet}',
    items: obj({ chapter: num('章'), para: num('段'), snippet: str('片段') }),
  },
  contextBlocks: strs('locate 命中的上下文窗口（含 [n] 锚点）'),
  chapters: {
    type: 'array',
    description: 'index 章节清单',
    items: obj({
      n: num('章号'),
      title: str('标题'),
      paras: num('段数'),
      chars: num('字符数'),
      state: str('analyzed / unanalyzed'),
      memoryState: str('记忆状态：complete / partial / 空'),
      covered: str('partial 的 covered'),
    }),
  },
});

export function drReadTool({ config }) {
  return defineTool({
    name: 'dr_read',
    description:
      '只读读取书籍：mode=index 列章节目录；mode=range 按 from/to 分段读取原文（带 [n] 锚点，超 maxBytes 截断并给 nextFrom）；'
      + 'mode=locate 按短语定位段落（附上下文）；mode=find 关键词检索全书或指定章。绝不写盘。',
    parameters: {
      book: { type: 'string', required: true, description: '书籍 ID' },
      mode: { type: 'string', required: true, description: 'index | range | locate | find' },
      chapter: { type: 'number', description: '章节号（range / locate 必需；find 可选，限定单章）' },
      from: { type: 'number', description: 'range 起始段号（默认 1）' },
      to: { type: 'number', description: 'range 结束段号（默认本章末段）' },
      maxBytes: { type: 'number', description: `range / locate 的字节上限（默认 ${DEFAULT_MAX_BYTES}）` },
      phrase: { type: 'string', description: 'locate 的定位短语（原样字符串）' },
      context: { type: 'number', description: `locate 的上下文段数（默认 ${DEFAULT_CONTEXT}）` },
      keyword: { type: 'string', description: 'find 的关键词' },
      limit: { type: 'number', description: `find 的命中上限（默认 ${DEFAULT_LIMIT}）` },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(value.lines ?? [value.error ?? '']),
    },
    async execute(args) {
      return guarded('dr_read', async () => {
        const { dir, book } = loadBook(config.booksRoot, args.book);
        const mode = String(args.mode ?? '').toLowerCase();
        const maxBytes = args.maxBytes === undefined ? DEFAULT_MAX_BYTES : Number(args.maxBytes);
        if (!Number.isFinite(maxBytes) || maxBytes <= 0) fail('maxBytes 必须是正整数');
        const needChapter = () => {
          if (args.chapter === undefined) fail(`mode=${mode} 需要 chapter`);
          const n = Number(args.chapter);
          if (!Number.isInteger(n) || n < 1) fail('chapter 必须是正整数');
          return n;
        };

        // ---- index ----
        if (mode === 'index') {
          const chapters = (book.chapters || []).map((c) => ({
            n: c.n,
            title: c.title,
            paras: c.paras,
            chars: c.chars,
            state: c.state,
            memoryState: c.memory ? c.memory.state : '',
            covered: c.memory && c.memory.covered ? c.memory.covered : '',
          }));
          return {
            ok: true, action: 'dr_read', mode, book: book.id, bookTitle: book.title, bookDir: dir,
            chapters,
            lines: [
              `《${book.title}》共 ${chapters.length} 章（来源 ${book.source ? book.source.type : ''}）`,
              ...chapters.map((c) =>
                ` ${String(c.n).padStart(3, '0')} ${c.title} — ${c.paras} 段 · ${c.chars} 字符`
                + ` · ${c.state === 'analyzed' ? '已分析' : '未分析'}`
                + (c.memoryState ? `（记忆 ${c.memoryState}${c.covered ? ` ${c.covered}` : ''}）` : '')),
            ],
          };
        }

        // ---- find ----
        if (mode === 'find') {
          const kw = String(args.keyword ?? '');
          if (kw === '') fail('mode=find 需要 keyword');
          const limit = args.limit === undefined ? DEFAULT_LIMIT : Number(args.limit);
          if (!Number.isFinite(limit) || limit <= 0) fail('limit 必须是正整数');
          const targets = args.chapter !== undefined
            ? [chapterMeta(book, needChapter())]
            : (book.chapters || []);
          const matches = [];
          let truncated = false;
          outer:
          for (const ch of targets) {
            const units = readUnits(dir, ch.n);
            for (const u of units) {
              const i = u.text.indexOf(kw);
              if (i === -1) continue;
              const before = u.text.slice(Math.max(0, i - 24), i);
              const after = u.text.slice(i + kw.length, i + kw.length + 24);
              matches.push({
                chapter: ch.n,
                para: u.n,
                snippet: `${i > 24 ? '…' : ''}${before}${kw}${after}${i + kw.length + 24 < u.text.length ? '…' : ''}`,
              });
              if (matches.length >= limit) { truncated = true; break outer; }
            }
          }
          return {
            ok: true, action: 'dr_read', mode, book: book.id,
            matchCount: matches.length,
            scannedChapters: targets.map((c) => c.n),
            hasMore: truncated,
            matches,
            lines: [
              `find「${kw}」：${matches.length} 处命中（扫描 ${targets.length} 章）${truncated ? '，已达上限' : ''}`,
              ...matches.map((m) => ` 第${m.chapter}章 [${m.para}] … ${m.snippet} …`),
              truncated ? '已达 limit 上限，可提高 limit 或限定 chapter 继续查' : '',
            ].filter(Boolean),
          };
        }

        // ---- range / locate ----
        const n = needChapter();
        const ch = chapterMeta(book, n);
        const units = readUnits(dir, n);
        const total = units.length;

        if (mode === 'locate') {
          const phrase = String(args.phrase ?? '');
          if (phrase === '') fail('mode=locate 需要 phrase');
          const k = args.context === undefined ? DEFAULT_CONTEXT : Number(args.context);
          if (!Number.isInteger(k) || k < 0) fail('context 必须是非负整数');
          const hitNs = units.filter((u) => u.text.includes(phrase)).map((u) => u.n);
          const contextBlocks = [];
          let bytesAcc = 0;
          let truncated = false;
          for (const hit of hitNs) {
            const fromU = Math.max(1, hit - k);
            const toU = Math.min(total, hit + k);
            const block = renderUnits(units.filter((u) => u.n >= fromU && u.n <= toU));
            const add = Buffer.byteLength(block, 'utf8');
            if (bytesAcc + add > maxBytes && contextBlocks.length > 0) { truncated = true; break; }
            bytesAcc += add;
            contextBlocks.push(block);
          }
          return {
            ok: true, action: 'dr_read', mode, book: book.id, chapter: n, chapterTitle: ch.title,
            totalParas: total, matchCount: hitNs.length, contextBlocks,
            hasMore: truncated, bytes: bytesAcc,
            lines: [
              `locate「${phrase}」：第 ${n} 章命中 ${hitNs.length} 段（共 ${total} 段）${truncated ? `，字节超 ${maxBytes} 已截断` : ''}`,
              ...contextBlocks.map((b, i) => `\n— 命中 ${i + 1} —\n${b}`),
            ],
          };
        }

        if (mode !== 'range') fail(`未知 mode：${mode}（index | range | locate | find）`);
        const from = args.from === undefined ? 1 : Number(args.from);
        const to = args.to === undefined ? total : Number(args.to);
        if (!Number.isInteger(from) || !Number.isInteger(to)) fail('from / to 必须是整数');
        if (from < 1 || to > total || from > to) {
          fail(`范围越界：from ${from} to ${to}，本章共 ${total} 段`);
        }
        const picked = [];
        let bytesAcc = 0;
        let truncatedBy = '';
        for (const u of units) {
          if (u.n < from || u.n > to) continue;
          const rendered = `[${u.n}] ${u.text}`;
          const add = Buffer.byteLength(rendered, 'utf8');
          if (bytesAcc + add > maxBytes && picked.length > 0) { truncatedBy = 'max-bytes'; break; }
          picked.push(u);
          bytesAcc += add + 2;
        }
        const emittedFrom = picked.length > 0 ? picked[0].n : null;
        const emittedTo = picked.length > 0 ? picked[picked.length - 1].n : null;
        const text = renderUnits(picked);
        const bytes = Buffer.byteLength(text, 'utf8');
        const hasMore = emittedTo !== null && emittedTo < to;
        const nextFrom = hasMore ? emittedTo + 1 : null;
        const out = {
          ok: true, action: 'dr_read', mode: 'range', book: book.id, chapter: n, chapterTitle: ch.title,
          totalParas: total, bytes, text,
          hasMore, truncatedBy, maxBytes,
          lines: [
            `[dr_read range] 第 ${n} 章 ${ch.title} · 段 ${emittedFrom ?? '-'}–${emittedTo ?? '-'} / 共 ${total} 段`
            + ` · ${bytes} 字节${truncatedBy ? `（已按 maxBytes=${maxBytes} 截断）` : ''}`
            + ` · hasMore=${hasMore}${nextFrom ? ` nextFrom=${nextFrom}` : ''}`,
            '',
            text,
          ],
        };
        // nextFrom / emitted* are declared as plain numbers in the output schema, so a
        // null would fail host validation ("value.nextFrom must be a number"). Omit the
        // key instead: the schema has no `required`, and a missing key means "no value".
        if (emittedFrom !== null) out.emittedFrom = emittedFrom;
        if (emittedTo !== null) out.emittedTo = emittedTo;
        if (nextFrom !== null) out.nextFrom = nextFrom;
        return out;
      });
    },
  });
}

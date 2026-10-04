/**
 * reading_chapter — the chapter subtask, run as a subagent.
 * The chapter text itself never enters the main session: a child agent
 * is spawned with the chapter skill as its persona, reads the chapter in
 * windows, writes memory + lecture, and returns only the explanation and a
 * status line. The child's token total is recorded for dr_usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { atomicWrite, fail, pad3 } from '../util.js';
import { bookDirOf, chapterMeta, loadBook } from '../bookstore.js';
import { judgeChapter } from './status.js';
import { COMMON, guarded, num, obj, str, textBlock, bool, usageTotals } from './shared.js';

const DEFAULT_SECTION_BYTES = 12000;

const OUTPUT_SCHEMA = obj({
  ...COMMON,
  book: str('书籍 ID'),
  chapter: num('章节号'),
  chapterTitle: str('章节标题'),
  stopReason: str('子任务结束原因：completed / aborted / error / max-tokens / refusal'),
  childTokens: num('子任务消耗的 tokens（记入 usage 账本的 subagentTokens）'),
  reusableBefore: bool('调用前该章记忆是否仍可复用（可复用时不应重读原文）'),
  memoryState: str('返回时 memory 的状态：complete / partial / 空'),
  covered: str('返回时 memory 的 covered'),
});

export function readingChapterTool({ ctx, config, chapterSkill }) {
  return defineTool({
    name: 'reading_chapter',
    description:
      '精读一本书的某一章：在隔离子任务里分节读取 chapters/NNN.md 原文，写出 memory/NNN.md（带 [n] 锚点）与 lecture/NNN.md，'
      + '返回讲解正文＋状态行。章节原文不会进入本会话。调用前先 dr_status；已 reusable 的章不要调本工具，直接基于记忆讲解。',
    parameters: {
      book: { type: 'string', required: true, description: '书籍 ID' },
      chapter: { type: 'number', required: true, description: '章节号' },
      purpose: { type: 'string', description: '本次阅读目的（一句话；缺省时子任务会先读 reader.md）' },
      sectionBytes: { type: 'number', description: `分节读取的字节上限（默认 ${DEFAULT_SECTION_BYTES}）` },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(value.lines ?? [value.error ?? '']),
    },
    async execute(args, exec) {
      return guarded('reading_chapter', async () => {
        const n = Number(args.chapter);
        if (!Number.isInteger(n) || n < 1) fail('chapter 必须是正整数');
        const sectionBytes = args.sectionBytes === undefined ? DEFAULT_SECTION_BYTES : Number(args.sectionBytes);
        if (!Number.isFinite(sectionBytes) || sectionBytes <= 0) fail('sectionBytes 必须是正整数');

        const booksRoot = config.booksRoot;
        const rawBook = String(args.book ?? '').trim();
        bookDirOf(booksRoot, rawBook);
        const { dir, book } = loadBook(booksRoot, rawBook);
        const ch = chapterMeta(book, n);

        const judged = judgeChapter(dir, ch);
        if (judged.reusable) {
          return {
            ok: false, action: 'reading_chapter',
            book: book.id, chapter: n, chapterTitle: ch.title, reusableBefore: true,
            memoryState: 'complete', covered: judged.covered,
            error: `第 ${n} 章记忆仍可复用（reusable）`,
            hint: '直接基于 memory/' + pad3(n) + '.md 讲解即可（注明“基于已有记忆，未重读原文”），不要重读原文',
            lines: [
              `第 ${pad3(n)} 章《${ch.title}》的记忆仍是 complete 且与原文一致（covered ${judged.covered}）——不需要重读。`,
              `请直接读 memory/${pad3(n)}.md 组织讲解，并注明“（基于已有记忆，未重读原文）”。`,
            ],
          };
        }

        // `ctx.subagents` throws in cordis 4 when the service is not reachable
        // ("cannot get property ... without inject"); `ctx.get('subagents')` is the
        // lookup DSH itself uses and returns undefined when the composition has no
        // subagent service. Fall back to the property form for plain-object contexts.
        const subagents = lookupSubagents(ctx);
        if (!subagents) {
          fail('当前组合没有 subagents 服务，无法启动章节子任务',
            'DSH 0.2.0-rc.2 的 base 组合默认带 dsh-subagent + spawn 后端；被禁用时请恢复');
        }
        const parent = exec && exec.agent ? exec.agent : undefined;
        if (!parent) fail('无法确定调用方会话（工具没有拿到 exec.agent）');

        const prompt = buildChildPrompt({
          book: book.id,
          title: book.title,
          n,
          chapterTitle: ch.title,
          paras: ch.paras,
          purpose: typeof args.purpose === 'string' ? args.purpose.trim() : '',
          sectionBytes,
        });

        const run = await subagents.start('spawn', {
          label: `deep-reading ${book.id} ch${pad3(n)}`,
          prompt: [{ type: 'text', text: prompt }],
          parent,
          persona: chapterSkill,
          maxDepth: 1,
          signal: exec.signal,
        });

        let res;
        let childTokens = 0;
        try {
          res = await run.result;
          childTokens = recordChildTokens(ctx, dir, run.localAgent, n);
        } finally {
          await run.dispose();
        }

        const text = (res.output || [])
          .filter((b) => b && b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        const after = judgeChapter(dir, (loadBook(booksRoot, book.id).book.chapters || []).find((c) => c.n === n) || ch);
        if (!text) {
          return {
            ok: false, action: 'reading_chapter',
            book: book.id, chapter: n, chapterTitle: ch.title,
            stopReason: res.stopReason, childTokens, reusableBefore: false,
            memoryState: after.state, covered: after.covered,
            error: `章节子任务没有产出讲解（stopReason=${res.stopReason}）`,
            hint: '检查 memory/ 与 lecture/ 是否已落盘；必要时重跑本章',
            lines: [
              `第 ${pad3(n)} 章《${ch.title}》子任务未返回讲解（stopReason=${res.stopReason}，子代理 ${childTokens} tokens）。`,
              `落盘情况：memory ${after.state || '无'}${after.covered ? ` (${after.covered})` : ''}`,
            ],
          };
        }
        const ok = res.stopReason === 'completed';
        return {
          ok, action: 'reading_chapter',
          book: book.id, chapter: n, chapterTitle: ch.title,
          stopReason: res.stopReason, childTokens, reusableBefore: false,
          memoryState: after.state, covered: after.covered,
          ...(ok ? {} : {
            error: `章节子任务未正常结束（stopReason=${res.stopReason}）`,
            hint: '讲解可能不完整；如需可重跑本章',
          }),
          lines: [
            `[reading_chapter] books/${book.id} 第 ${pad3(n)} 章《${ch.title}》`
            + ` · stopReason=${res.stopReason} · 子代理 ${childTokens} tokens`
            + ` · memory ${after.state || '无'}${after.covered ? ` (${after.covered})` : ''}`,
            ok ? '' : '（子任务未正常结束，下面的讲解可能不完整）',
            '',
            text,
          ].filter((l) => l !== undefined),
        };
      });
    },
  });
}

/** Resolve the subagent service through `ctx.get`, tolerating plain-object contexts. */
function lookupSubagents(ctx) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined;
    if (viaGet) return viaGet;
  } catch { /* fall through to the property form */ }
  try { return ctx.subagents; } catch { return undefined; }
}

/** Self-contained brief: the child sees none of the parent conversation. */
function buildChildPrompt({ book, title, n, chapterTitle, paras, purpose, sectionBytes }) {
  return [
    `精读任务：books/${book} 的第 ${n} 章。`,
    '',
    `书籍 ID：${book}（《${title}》）`,
    `章节：第 ${n} 章 ${chapterTitle}（共 ${paras} 段）`,
    `分节字节：${sectionBytes}`,
    `阅读目的：${purpose || '（未指定——请先读 reader.md 取阅读目的；不存在则在讲解开头注明“未提供阅读目的”）'}`,
    '',
    '按你的技能说明（persona 里的步骤）执行：先 dr_status 判定本章状态，再分节 dr_read 原文，逐节写 partial 检查点，'
    + '读完写 complete 记忆，最后把讲解 dr_write 落盘为 lecture 再输出。',
    '',
    '工具：dr_read / dr_write / dr_status（本插件自带）。不要调用 shell，也不要读 libros 以外的路径。',
    `注意：原文只能用 dr_read 读（mode=range / locate / find），不要用文件读取工具读 chapters/${String(n).padStart(3, '0')}.md，`
    + '也不要让原文整章进入你的上下文——按分节读。',
  ].join('\n');
}

/** Append the child's token total to the book's pending subagent ledger. */
function recordChildTokens(ctx, dir, childAgent, n) {
  try {
    const session = childAgent && childAgent.session;
    const projections = ctx.get('sessionProjections');
    if (!session || !projections) return 0;
    const usage = usageTotals(projections.stateOf(session, 'tokenUsage'));
    if (!usage) return 0;
    const input = Number(usage.uncachedInputTokens ?? 0);
    const output = Number(usage.outputTokens ?? 0);
    const cacheRead = Number(usage.cacheReadTokens ?? 0);
    const cacheWrite = Number(usage.cacheWriteTokens ?? 0);
    const totalTokens = input + output + cacheRead + cacheWrite;
    if (totalTokens <= 0) return 0;
    const p = path.join(dir, '.usage-agents.json');
    let reg = { pending: [] };
    if (fs.existsSync(p)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (parsed && Array.isArray(parsed.pending)) reg = parsed;
      } catch { /* rebuild the ledger */ }
    }
    reg.pending.push({
      sessionId: String(session.id ?? 'unknown'),
      chapter: n,
      input, output, cacheRead, cacheWrite, totalTokens,
      ts: new Date().toISOString(),
    });
    atomicWrite(p, JSON.stringify(reg, null, 2) + '\n');
    return totalTokens;
  } catch {
    // Accounting must never fail the reading itself.
    return 0;
  }
}

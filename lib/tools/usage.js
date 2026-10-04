/**
 * dr_usage — token accounting.
 *
 * The host already folds a running total per session, so a row is the delta of
 * `tokenUsage` since the
 * stored cursor. Child (subagent) tokens are recorded by the reading_chapter
 * tool into `<bookDir>/.usage-agents.json` and folded in when a row is written.
 *
 * Row shape stays stable (plain JSONL ledger):
 *   {ts, task, sessionId, models, input, output, cacheRead, cacheWrite5m,
 *    cacheWrite1h, thinking, subagentTokens, window:{from, to, resynced}}
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { atomicWrite, fail, pad3 } from '../util.js';
import { loadBook } from '../bookstore.js';
import { COMMON, guarded, bool, num, obj, str, strs, textBlock, usageTotals } from './shared.js';

const OUTPUT_SCHEMA = obj({
  ...COMMON,
  appended: bool('是否追加了一行用量'),
  reason: str('未追加的原因'),
  task: str('本次记账标签'),
  sessionId: str('会话 ID'),
  addedInput: num('本次新增未缓存输入 tokens'),
  addedOutput: num('本次新增输出 tokens'),
  addedCacheRead: num('本次新增缓存读 tokens'),
  addedCacheWrite: num('本次新增缓存写 tokens'),
  addedSubagentTokens: num('本次折入的子代理 tokens'),
  resynced: bool('累计值小于游标（会话被压缩/重建）时已重新同步'),
  book: str('书籍 ID'),
  chapterCount: num('章节数'),
  chapters: {
    type: 'array',
    description: 'report：逐章用量',
    items: obj({
      chapter: num('章号'),
      tasks: strs('计入该章的任务标签'),
      input: num('未缓存输入'),
      output: num('输出'),
      cacheRead: num('缓存读'),
      cacheWrite: num('缓存写'),
      subagentTokens: num('子代理 tokens'),
      baselineTokens: num('baseline 行 tokens'),
      total: num('该章合计'),
    }),
  },
  totalInput: num('report：全书未缓存输入合计'),
  totalOutput: num('report：全书输出合计'),
  totalCacheRead: num('report：全书缓存读合计'),
  totalCacheWrite: num('report：全书缓存写合计'),
  totalSubagentTokens: num('report：全书子代理 tokens 合计'),
  totalBaselineTokens: num('report：全书 baseline tokens 合计'),
  other: strs('report：未归入任何章的行（一行一条）'),
});

export function drUsageTool({ ctx, config }) {
  return defineTool({
    name: 'dr_usage',
    description:
      '用量记账。默认把当前会话自上次记账以来的 token 增量追加到 books/<ID>/usage.jsonl（同时折入子代理 tokens）；'
      + 'report=true 时按章汇总全书用量（task 里的 ch<N> 标签归章，baseline 单列）。',
    parameters: {
      book: { type: 'string', required: true, description: '书籍 ID' },
      task: { type: 'string', description: '本次记账标签，如 split / read-ch3 / read-ch3-resume / export' },
      report: { type: 'boolean', description: 'true 时只汇总已有账本，不追加新行' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(value.lines ?? [value.error ?? '']),
    },
    async execute(args, exec) {
      return guarded('dr_usage', async () => {
        const { dir, book } = loadBook(config.booksRoot, args.book);
        if (args.report === true) return doReport(dir, book);

        const task = String(args.task ?? '').trim();
        if (task === '') fail('缺少 task（本次记账标签，如 "read-ch3"）', 'report=true 时不需要 task');

        const session = exec && exec.agent ? exec.agent.session : undefined;
        if (!session) fail('无法确定当前会话（工具没有拿到 exec.agent）', '在 DSH 会话里调用 dr_usage；独立脚本请直接读 usage.jsonl');
        const projections = ctx.get('sessionProjections');
        if (!projections) {
          fail('当前组合没有 sessionProjections 服务，读不到 tokenUsage',
            'DSH 0.2.0-rc.2 的 base 组合默认带 dsh-session-projection + dsh-token-meter；被禁用时请恢复');
        }
        const cur = projections.stateOf(session, 'tokenUsage');
        if (!cur) fail('tokenUsage 投影不可用（会话里还没有任何调用记录？）');
        const totals = usageTotals(cur);
        if (!totals) {
          fail('tokenUsage 投影的结构不认识',
            'dsh-token-meter 的 state 里既没有 totals 也没有 uncachedInputTokens——记 0 会污染账本，故拒绝记账');
        }

        const sessionId = String(session.id ?? 'unknown');
        const cursorPath = path.join(dir, '.usage-cursor.json');
        const cursor = readJson(cursorPath, {});
        const prev = cursor[sessionId] && typeof cursor[sessionId] === 'object' ? cursor[sessionId] : null;
        const fields = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
        const now = {};
        for (const f of fields) now[f] = Number(totals[f] ?? 0);
        let resynced = false;
        const base = prev ? pick(prev, fields) : zeros(fields);
        for (const f of fields) if (now[f] < base[f]) resynced = true;
        const from = resynced ? zeros(fields) : base;
        const added = {
          input: Math.max(0, now.uncachedInputTokens - from.uncachedInputTokens),
          output: Math.max(0, now.outputTokens - from.outputTokens),
          cacheRead: Math.max(0, now.cacheReadTokens - from.cacheReadTokens),
          cacheWrite: Math.max(0, now.cacheWriteTokens - from.cacheWriteTokens),
        };

        // Subagent (chapter child) tokens: pending entries written by reading_chapter,
        // folded into this row and cleared.
        const agentsPath = path.join(dir, '.usage-agents.json');
        const agents = readJson(agentsPath, { pending: [] });
        const pending = Array.isArray(agents.pending) ? agents.pending : [];
        const subagentTokens = pending.reduce((s, e) => s + Number((e && e.totalTokens) || 0), 0);

        cursor[sessionId] = { ...now, updatedAt: new Date().toISOString() };
        atomicWrite(cursorPath, JSON.stringify(cursor, null, 2) + '\n');

        const hasMain = added.input + added.output + added.cacheRead + added.cacheWrite > 0;
        if (!hasMain && subagentTokens === 0) {
          return {
            ok: true, action: 'dr_usage', appended: false, reason: 'no-new-usage', task, sessionId,
            resynced, book: book.id,
            lines: [`未追加：自上次记账（${sessionId.slice(0, 8)}…）以来没有新的 token 用量`],
          };
        }

        const row = {
          ts: new Date().toISOString(),
          task,
          sessionId,
          models: '',
          input: added.input,
          output: added.output,
          cacheRead: added.cacheRead,
          cacheWrite5m: added.cacheWrite,
          cacheWrite1h: 0,
          thinking: 0,
          subagentTokens,
          ...(subagentTokens > 0 ? { subagentNote: '子代理 token 仅总数，无输入/输出拆分' } : {}),
          window: { resynced },
        };
        fs.appendFileSync(path.join(dir, 'usage.jsonl'), JSON.stringify(row) + '\n', 'utf8');
        if (pending.length > 0) {
          agents.pending = [];
          atomicWrite(agentsPath, JSON.stringify(agents, null, 2) + '\n');
        }

        return {
          ok: true, action: 'dr_usage', appended: true, task, sessionId, resynced, book: book.id,
          addedInput: added.input, addedOutput: added.output,
          addedCacheRead: added.cacheRead, addedCacheWrite: added.cacheWrite,
          addedSubagentTokens: subagentTokens,
          lines: [
            `记账 ${task}：输入 ${added.input} · 输出 ${added.output}`
            + ` · 缓存读 ${added.cacheRead} · 缓存写 ${added.cacheWrite}`
            + (subagentTokens > 0 ? ` · 子代理 ${subagentTokens}（折入 ${pending.length} 条待记）` : ''),
            `会话 ${sessionId}${resynced ? '（累计值回落，已重新同步）' : ''} → books/${book.id}/usage.jsonl`,
          ],
        };
      });
    },
  });
}

const pick = (o, fields) => Object.fromEntries(fields.map((f) => [f, Number(o[f] ?? 0)]));
const zeros = (fields) => Object.fromEntries(fields.map((f) => [f, 0]));

function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/** Per-chapter aggregation over usage.jsonl. */
function doReport(dir, book) {
  const total = (book.chapters || []).length;
  const rows = [];
  const usagePath = path.join(dir, 'usage.jsonl');
  if (fs.existsSync(usagePath)) {
    for (const line of fs.readFileSync(usagePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip torn line */ }
    }
  }
  const chapters = Array.from({ length: total }, (_, i) => ({
    chapter: i + 1, tasks: [], input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    subagentTokens: 0, baselineTokens: 0, total: 0,
  }));
  const other = [];
  for (const r of rows) {
    const task = String(r.task || '');
    const m = task.match(/ch(?:apter)?[\s-]*0*(\d+)/i);
    const idx = m ? Number(m[1]) - 1 : -1;
    const cw = (r.cacheWrite5m || 0) + (r.cacheWrite1h || 0);
    const input = r.input || 0;
    const output = r.output || 0;
    const cacheRead = r.cacheRead || 0;
    const subagent = r.subagentTokens || 0;
    if (idx >= 0 && idx < total) {
      const row = chapters[idx];
      row.tasks.push(task);
      if (/baseline/i.test(task)) {
        row.baselineTokens += subagent;
      } else {
        row.input += input;
        row.output += output;
        row.cacheRead += cacheRead;
        row.cacheWrite += cw;
        row.subagentTokens += subagent;
      }
    } else {
      other.push(
        `${r.ts || ''} ${task} — 输入 ${input} · 输出 ${output} · 缓存读 ${cacheRead} · 缓存写 ${cw} · 子代理 ${subagent}`,
      );
    }
  }
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, subagentTokens: 0, baselineTokens: 0 };
  for (const row of chapters) {
    row.total = row.input + row.output + row.cacheRead + row.cacheWrite;
    totals.input += row.input;
    totals.output += row.output;
    totals.cacheRead += row.cacheRead;
    totals.cacheWrite += row.cacheWrite;
    totals.subagentTokens += row.subagentTokens;
    totals.baselineTokens += row.baselineTokens;
  }
  const fmt = (n) => String(n).padStart(8);
  return {
    ok: true, action: 'dr_usage', appended: false, reason: 'report', book: book.id,
    chapterCount: total, chapters, other,
    totalInput: totals.input, totalOutput: totals.output, totalCacheRead: totals.cacheRead,
    totalCacheWrite: totals.cacheWrite, totalSubagentTokens: totals.subagentTokens,
    totalBaselineTokens: totals.baselineTokens,
    lines: [
      `《${book.title}》用量汇总（不含 baseline 列）`,
      ' 章     输入     输出   缓存读   缓存写    小计   子代理  baseline  标签',
      ...chapters.map((c) =>
        ` ${pad3(c.chapter)} ${fmt(c.input)} ${fmt(c.output)} ${fmt(c.cacheRead)} ${fmt(c.cacheWrite)}`
        + ` ${fmt(c.total)} ${fmt(c.subagentTokens)} ${fmt(c.baselineTokens)}  ${c.tasks.join(',')}`),
      ` 合计 ${fmt(totals.input)} ${fmt(totals.output)} ${fmt(totals.cacheRead)} ${fmt(totals.cacheWrite)}`
      + ` ${fmt(totals.input + totals.output + totals.cacheRead + totals.cacheWrite)}`
      + ` ${fmt(totals.subagentTokens)} ${fmt(totals.baselineTokens)}`,
      other.length > 0 ? `未归章的行 ${other.length} 条：` : '所有行都归到了章',
      ...other.map((o) => ` ${o}`),
    ],
  };
}

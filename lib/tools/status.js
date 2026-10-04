/**
 * dr_status — chapter state and `reusable` judgement.
 * Per chapter: reusable only when the memory is `complete`, its source hash still
 * matches the chapter file, and its method version is current.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { fail, pad3, sha256File } from '../util.js';
import { loadBook } from '../bookstore.js';
import { COMMON, guarded, bool, num, obj, str, textBlock } from './shared.js';

const METHOD_VERSION = '1.0';

const OUTPUT_SCHEMA = obj({
  ...COMMON,
  book: str('书籍 ID'),
  bookTitle: str('书名'),
  methodVersion: str('当前记忆协议版本'),
  total: num('章节总数'),
  reusableCount: num('可复用章节数'),
  partialCount: num('partial 章节数'),
  staleCount: num('过期章节数'),
  unreadCount: num('未读章节数'),
  chapters: {
    type: 'array',
    description: '逐章判定',
    items: obj({
      n: num('章号'),
      title: str('标题'),
      hasMemory: bool('记忆文件是否存在'),
      state: str('complete / partial'),
      covered: str('覆盖范围'),
      sourceSha256Match: bool('记忆记录的源哈希与当前章节文件一致'),
      methodVersionMatch: bool('记忆协议版本一致'),
      reusable: bool('可复用（complete + 哈希一致 + 版本一致）'),
      reason: str('ok / state-partial / hash-mismatch / method-mismatch / no-memory / no-frontmatter'),
      writtenAt: str('记忆写入时间'),
    }),
  },
});

export function drStatusTool({ config }) {
  return defineTool({
    name: 'dr_status',
    description:
      '逐章输出记忆可用性：reusable=true 表示可直接基于既有记忆讲解（不必重读原文）；'
      + 'reason 说明原因（no-memory 未读 / state-partial 读到一半 / hash-mismatch 章节文件已变 / method-mismatch 协议升级）。',
    parameters: {
      book: { type: 'string', required: true, description: '书籍 ID' },
      chapter: { type: 'number', description: '只看某一章（缺省看全书）' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(value.lines ?? [value.error ?? '']),
    },
    async execute(args) {
      return guarded('dr_status', async () => {
        const { dir, book } = loadBook(config.booksRoot, args.book);
        let targets = book.chapters || [];
        if (args.chapter !== undefined) {
          const n = Number(args.chapter);
          targets = targets.filter((c) => c.n === n);
          if (targets.length === 0) fail(`章节不存在：第 ${n} 章`);
        }
        const chapters = targets.map((ch) => judgeChapter(dir, ch));
        const summary = {
          total: chapters.length,
          reusable: chapters.filter((c) => c.reusable).length,
          partial: chapters.filter((c) => c.reason === 'state-partial').length,
          stale: chapters.filter((c) => c.reason === 'hash-mismatch' || c.reason === 'method-mismatch').length,
          unread: chapters.filter((c) => c.reason === 'no-memory').length,
        };
        const label = {
          ok: '可复用', 'state-partial': '读到一半', 'hash-mismatch': '原文已变',
          'method-mismatch': '协议已升级', 'no-memory': '未读', 'no-frontmatter': '记忆无头部',
        };
        return {
          ok: true, action: 'dr_status', book: book.id, bookTitle: book.title,
          methodVersion: METHOD_VERSION,
          chapters,
          total: summary.total, reusableCount: summary.reusable,
          partialCount: summary.partial, staleCount: summary.stale, unreadCount: summary.unread,
          lines: [
            `《${book.title}》记忆状态（协议 ${METHOD_VERSION}）：`
            + `共 ${summary.total} 章 · 可复用 ${summary.reusable} · 读到一半 ${summary.partial}`
            + ` · 过期 ${summary.stale} · 未读 ${summary.unread}`,
            ...chapters.map((c) =>
              ` ${pad3(c.n)} ${c.title} — ${label[c.reason] ?? c.reason}`
              + `${c.covered ? `（covered ${c.covered}）` : ''}${c.reusable ? ' · reusable' : ''}`),
          ],
        };
      });
    },
  });
}

/**
 * Judge one chapter's stored memory: `reusable` only when it is complete, its
 * recorded source hash still matches the chapter file, and its method version
 * is the current one.
 */
export function judgeChapter(dir, ch) {
  const memRel = `memory/${pad3(ch.n)}.md`;
  const memAbs = path.join(dir, memRel);
  const sourceAbs = path.join(dir, ch.file);
  const sourceSha = fs.existsSync(sourceAbs) ? sha256File(sourceAbs) : null;
  if (!fs.existsSync(memAbs)) {
    return {
      n: ch.n, title: ch.title, hasMemory: false, state: '', covered: '',
      sourceSha256Match: false, methodVersionMatch: false,
      reusable: false, reason: 'no-memory', writtenAt: '',
    };
  }
  const fm = parseFm(fs.readFileSync(memAbs, 'utf8'));
  if (!fm) {
    return {
      n: ch.n, title: ch.title, hasMemory: true, state: '', covered: '',
      sourceSha256Match: false, methodVersionMatch: false,
      reusable: false, reason: 'no-frontmatter', writtenAt: '',
    };
  }
  const sourceSha256Match = sourceSha !== null && fm.source_sha256 === sourceSha;
  const methodVersionMatch = fm.method_version === METHOD_VERSION;
  let reason = 'ok';
  if (fm.state !== 'complete') reason = `state-${fm.state}`;
  else if (!sourceSha256Match) reason = 'hash-mismatch';
  else if (!methodVersionMatch) reason = 'method-mismatch';
  return {
    n: ch.n, title: ch.title, hasMemory: true, state: fm.state ?? '',
    covered: fm.covered ?? '', sourceSha256Match, methodVersionMatch,
    reusable: reason === 'ok', reason, writtenAt: fm.written_at ?? '',
  };
}

function parseFm(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return null;
  const fm = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const raw = m[2].trim();
    if (raw === '') { fm[m[1]] = ''; continue; }
    try { fm[m[1]] = JSON.parse(raw); } catch { fm[m[1]] = raw; }
  }
  return fm;
}

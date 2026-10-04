/**
 * dr_write — write to the book's data directory.
 * Kinds: memory | lecture | user-note | user-state | reader | export.
 *
 * The gates are the point of this tool:
 *   - memory payload must carry a [n] anchor; a still-valid `complete` memory is
 *     immutable; partial coverage starts at 1 and may only advance.
 *   - export only splices `@include` lines into the output, never rewrites text.
 * Every write goes through temp-file + fsync + rename.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { atomicWrite, fail, pad3, sha256, sha256File, serializeFrontmatter } from '../util.js';
import { bookDirOf, loadBook } from '../bookstore.js';
import { COMMON, guarded, num, obj, str, strs, textBlock, bool } from './shared.js';

const TOOL_NAME = 'deep-reading-checkpoint';
const TOOL_VERSION = '0.1.1';
const METHOD_VERSION = '1.0';

const OUTPUT_SCHEMA = obj({
  ...COMMON,
  kind: str('写入类别'),
  path: str('相对书籍目录的路径'),
  absPath: str('绝对路径'),
  bytes: num('写入字节数'),
  sha256: str('写入内容哈希'),
  state: str('memory 状态：complete / partial'),
  covered: str('memory 覆盖范围，如 1-3/7'),
  replaced: bool('是否覆盖了已有文件'),
  included: strs('export 拼接进去的相对路径'),
  chapter: num('章节号'),
  book: str('书籍 ID'),
  sourceSha256: str('记忆对应的章节文件哈希'),
  methodVersion: str('记忆协议版本'),
  writtenAt: str('写入时间（ISO）'),
  note: str('备注'),
});

export function drWriteTool({ config }) {
  return defineTool({
    name: 'dr_write',
    description:
      '写入检查点。kind=memory（需 chapter + state，正文必须带 [n] 段落定位；complete 记忆一经写入不可回改）；'
      + 'kind=lecture（本章讲解落盘）；kind=user-note（用户原话）；kind=user-state（用户理解状态）；kind=reader（阅读目的／偏好）；'
      + 'kind=export（name + content=manifest 文本，@include 行按原文逐字拼接）。'
      + 'payload 一律放 content，不要自带 frontmatter（--- 开头）。',
    parameters: {
      book: { type: 'string', required: true, description: '书籍 ID' },
      kind: { type: 'string', required: true, description: 'memory | lecture | user-note | user-state | reader | export' },
      content: { type: 'string', required: true, description: '要写入的正文（不带 frontmatter）；export 时是 manifest 文本' },
      chapter: { type: 'number', description: '章节号（memory / lecture / user-note 必需）' },
      state: { type: 'string', description: 'memory 状态：complete（默认）或 partial' },
      covered: { type: 'string', description: 'state=partial 时的覆盖范围 "a-b/total"' },
      note: { type: 'string', description: '备注（写进 frontmatter 的 note）' },
      name: { type: 'string', description: 'export 的文件名，如 reading.md' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(value.lines ?? [value.error ?? '']),
    },
    async execute(args) {
      return guarded('dr_write', async () => {
        const booksRoot = config.booksRoot;
        const rawBook = String(args.book ?? '').trim();
        bookDirOf(booksRoot, rawBook);
        const { dir, book } = loadBook(booksRoot, rawBook);
        const kind = String(args.kind ?? '').trim();
        if (kind === '') fail('缺少 kind（memory|lecture|user-note|user-state|reader|export）');

        const payload = String(args.content ?? '');
        if (kind !== 'export') checkPayload(payload);

        // ---- export: manifest splice, verbatim ----
        if (kind === 'export') {
          if (args.chapter !== undefined) fail('export 不支持 chapter（导出是 manifest 拼接）');
          const name = String(args.name ?? '');
          if (name === '') fail('export 需要 name（如 reading.md）');
          if (!/^[A-Za-z0-9._-]{1,80}\.md$/.test(name)) fail(`name 不合法：${name}（只允许字母数字._-，以 .md 结尾）`);
          checkPayload(payload);
          const included = [];
          const parts = [];
          for (const line of payload.replace(/\r\n/g, '\n').split('\n')) {
            const m = line.match(/^@include\s+(.+?)\s*$/);
            if (!m) { parts.push(line); continue; }
            const rel = m[1].replace(/\\/g, '/');
            const abs = path.resolve(dir, rel);
            if (!abs.startsWith(dir + path.sep)) fail(`@include 越出书籍目录：${rel}`);
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail(`@include 的文件不存在：${rel}`);
            let content = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
            if (!content.endsWith('\n')) content += '\n';
            parts.push(content);
            included.push(rel);
          }
          const text = parts.join('\n');
          const target = path.join(dir, 'exports', name);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const replaced = fs.existsSync(target);
          atomicWrite(target, text);
          return {
            ok: true, action: 'dr_write', kind: 'export', path: `exports/${name}`, absPath: target,
            bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(Buffer.from(text, 'utf8')),
            replaced, included, book: book.id,
            lines: [
              `export 完成：exports/${name}（${Buffer.byteLength(text, 'utf8')} 字节，拼接 ${included.length} 个文件）`,
              ...included.map((r) => ` @include ${r}`),
              replaced ? '已覆盖同名导出文件' : '',
            ].filter(Boolean),
          };
        }

        const now = new Date().toISOString();
        const metaOf = (n) => {
          const ch = (book.chapters || []).find((c) => c.n === n);
          if (!ch) fail(`章节不存在：第 ${n} 章（本书共 ${(book.chapters || []).length} 章）`);
          const abs = path.join(dir, ch.file);
          if (!fs.existsSync(abs)) fail(`章节文件缺失：${ch.file}`);
          return { ch, abs };
        };
        let target;
        let fm;
        let chapterNo = null;

        if (kind === 'memory') {
          if (args.chapter === undefined) fail('memory 需要 chapter');
          const n = Number(args.chapter);
          const { ch, abs } = metaOf(n);
          chapterNo = n;
          const sourceSha = sha256File(abs);

          // A still-valid `complete` memory is immutable; later understanding goes
          // into a later chapter's memory as a correction, never by rewriting this one.
          const existPath = path.join(dir, 'memory', `${pad3(n)}.md`);
          if (fs.existsSync(existPath)) {
            const existFm = parseFm(fs.readFileSync(existPath, 'utf8'));
            if (existFm && existFm.state === 'complete' && existFm.source_sha256 === sourceSha && existFm.method_version === METHOD_VERSION) {
              fail(`第 ${n} 章记忆已是 complete 且仍然有效，不允许改写`,
                '跨章理解变化时：在后续章节的记忆中写“修正了第 N 章的 X 结论”并引用定位，不要回改旧文件');
            }
          }

          const state = args.state === undefined ? 'complete' : String(args.state);
          if (state !== 'complete' && state !== 'partial') fail('state 只能是 complete 或 partial');
          if (!/\[\d+[-\d]*\]/.test(payload)) {
            fail('记忆必须包含段落定位（如 [12]）；缺定位时先补定位，不要压缩内容',
              '规则：每条主张都要能指回原文段落编号');
          }
          let covered;
          if (state === 'partial') {
            if (args.covered === undefined) fail('state=partial 时必须给 covered "a-b/total"');
            const c = parseCovered(args.covered, ch.paras);
            if (c.b >= ch.paras) fail(`covered=${c.b}/${ch.paras} 已覆盖全部段落，请改用 state=complete`);
            if (fs.existsSync(existPath)) {
              const oldFm = parseFm(fs.readFileSync(existPath, 'utf8'));
              if (oldFm && oldFm.state === 'partial' && oldFm.covered) {
                const oc = String(oldFm.covered).match(/^(\d+)-(\d+)\/(\d+)$/);
                if (oc && Number(oc[2]) >= c.b) fail(`covered 未推进：已有 ${oldFm.covered}，新值 ${args.covered}`);
              }
            }
            covered = `${c.a}-${c.b}/${c.total}`;
          } else {
            covered = `1-${ch.paras}/${ch.paras}`;
          }
          target = path.join(dir, 'memory', `${pad3(n)}.md`);
          fm = {
            book: book.id, kind, chapter: n, state, covered,
            source_sha256: sourceSha,
            method_version: METHOD_VERSION, tool_version: TOOL_VERSION,
            written_at: now, note: args.note,
          };
        } else if (kind === 'lecture' || kind === 'user-note') {
          if (args.chapter === undefined) fail(`${kind} 需要 chapter`);
          const n = Number(args.chapter);
          const { abs } = metaOf(n);
          chapterNo = n;
          target = kind === 'lecture'
            ? path.join(dir, 'lecture', `${pad3(n)}.md`)
            : path.join(dir, 'user', `${pad3(n)}.md`);
          fm = {
            book: book.id, kind, chapter: n, state: 'complete',
            source_sha256: sha256File(abs),
            method_version: METHOD_VERSION, tool_version: TOOL_VERSION,
            written_at: now, note: args.note,
          };
        } else if (kind === 'user-state' || kind === 'reader') {
          target = kind === 'user-state' ? path.join(dir, 'user', 'state.md') : path.join(dir, 'reader.md');
          fm = {
            book: book.id, kind, state: 'complete', written_at: now,
            method_version: METHOD_VERSION, tool_version: TOOL_VERSION, note: args.note,
          };
        } else {
          fail(`未知 kind：${kind}（memory|lecture|user-note|user-state|reader|export）`);
        }

        fs.mkdirSync(path.dirname(target), { recursive: true });
        const replaced = fs.existsSync(target);
        const text = `${serializeFrontmatter(fm)}\n\n${payload.replace(/\r\n/g, '\n').trimEnd()}\n`;
        atomicWrite(target, text);

        // Mirror a memory write into book.json (the file itself stays authoritative).
        if (kind === 'memory') {
          const ch = (book.chapters || []).find((c) => c.n === chapterNo);
          ch.state = fm.state === 'complete' ? 'analyzed' : 'unanalyzed';
          ch.memory = {
            file: `memory/${pad3(chapterNo)}.md`, state: fm.state, covered: fm.covered,
            sourceSha256: fm.source_sha256, methodVersion: fm.method_version,
            toolVersion: fm.tool_version, writtenAt: fm.written_at,
          };
          atomicWrite(path.join(dir, 'book.json'), JSON.stringify(book, null, 2) + '\n');
        }

        const rel = path.relative(dir, target).replace(/\\/g, '/');
        const bytes = Buffer.byteLength(text, 'utf8');
        return {
          ok: true, action: 'dr_write', kind, path: rel, absPath: target, bytes,
          sha256: sha256(Buffer.from(text, 'utf8')),
          state: fm.state, covered: fm.covered ?? '', replaced,
          ...(chapterNo === null ? {} : { chapter: chapterNo }),
          book: book.id, sourceSha256: fm.source_sha256 ?? '', methodVersion: fm.method_version,
          writtenAt: fm.written_at, note: fm.note ?? '',
          lines: [
            `写入完成：${rel}（${kind}${fm.state ? `，state=${fm.state}` : ''}${fm.covered ? `，covered=${fm.covered}` : ''}，${bytes} 字节）`,
            replaced ? '（覆盖了同名旧文件）' : '',
          ].filter(Boolean),
        };
      });
    },
  });
}

function checkPayload(content) {
  const c = String(content ?? '').replace(/\r\n/g, '\n');
  if (!c.trim()) fail('content 为空');
  if (c.startsWith('---\n') || c.trim() === '---') {
    fail('content 不应自带 frontmatter（--- 开头），frontmatter 由本工具注入');
  }
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

function parseCovered(s, paras) {
  const m = String(s).match(/^(\d+)-(\d+)\/(\d+)$/);
  if (!m) fail(`covered 格式应为 "a-b/total"（如 1-3/7），收到：${s}`);
  const a = Number(m[1]);
  const b = Number(m[2]);
  const total = Number(m[3]);
  if (total !== paras) fail(`covered 的总数与章节段数不符：covered=${total}，本章共 ${paras} 段`);
  if (a !== 1) fail('分节覆盖应从第 1 段开始：covered 应以 "1-" 开头');
  if (a > b || b > total) fail(`covered 区间不合法：${s}`);
  return { a, b, total };
}

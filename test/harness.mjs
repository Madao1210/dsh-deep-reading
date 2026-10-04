/**
 * harness — behavioral gates, without the host.
 *
 * Every rule here must hold: idempotent import, windowed reads that never skip a
 * paragraph, memory that refuses to exist without an anchor, immutable complete
 * memories, monotonic partial coverage, verbatim export splicing, escape
 * guards, reusable short-circuiting, and the child-token ledger.
 *
 * Run: npm test
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';
import { validateValue } from './vschema.mjs';
import { makePdfBytes } from './fixtures/minipdf.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-harness-'));
let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return false;
};
const eq = (name, actual, expected) => ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，得到 ${JSON.stringify(actual)}`);

// ---------------------------------------------------------------- fixtures
const bookDir = path.join(TMP, 'gate');
fs.mkdirSync(bookDir, { recursive: true });
const src = path.join(TMP, 'gate.md');
const LONG = Array.from({ length: 40 }, (_, i) => `第${i + 1}节内容：这是一段用来撑开字节数的测试正文，编号 ${i + 1}。`).join('\n\n');
fs.writeFileSync(src, `# 第一章 起点\n\n短章第一段。\n\n短章第二段。\n\n# 第二章 长章\n\n${LONG}\n`, 'utf8');

const spawns = [];
const PARENT_USAGE = { uncachedInputTokens: 1200, outputTokens: 340, cacheReadTokens: 8000, cacheWriteTokens: 500 };
const CHILD_USAGE = { uncachedInputTokens: 500, outputTokens: 120, cacheReadTokens: 3000, cacheWriteTokens: 200 };
let childUsage = CHILD_USAGE;

const { ctx, tools } = makeContext();
apply(ctx, { booksRoot: TMP });
const T = Object.fromEntries(tools.map((t) => [t.name, t]));
for (const t of tools) {
  const original = t.execute;
  t.execute = async (args, exec) => {
    const value = await original(args, exec);
    const errs = validateValue(t.output.schema, value, t.name);
    if (errs.length > 0) failures.push(`${t.name} 返回值不合 schema：${errs.join('; ')}`);
    return value;
  };
}

const exec = { agent: { session: { id: 'parent-sess' } }, signal: new AbortController().signal };
const call = (name, args) => T[name].execute(args, exec);

// ---------------------------------------------------------------- 1. import
const imported = await call('dr_import', { src, book: 'gate', title: '门禁测试书' });
eq('导入成功', imported.ok, true);
eq('导入章数', imported.chapterCount, 2);

const again = await call('dr_import', { src, book: 'gate', title: '门禁测试书' });
eq('源未变 → skipped', again.skipped, true);

const ch1 = fs.readFileSync(path.join(bookDir, 'chapters', '001.md'), 'utf8');
ok('章节文件带 [n] 锚点', /\[1\] 短章第一段。/.test(ch1), ch1.slice(0, 80));

// ---------------------------------------------------------------- 2. reads
const ranged = await call('dr_read', { book: 'gate', mode: 'range', chapter: 2, from: 1, maxBytes: 60 });
eq('range 命中 maxBytes 截断', ranged.truncatedBy, 'max-bytes');
eq('range hasMore', ranged.hasMore, true);
eq('range nextFrom 衔接', ranged.nextFrom, ranged.emittedTo + 1);

const next = await call('dr_read', { book: 'gate', mode: 'range', chapter: 2, from: ranged.nextFrom, maxBytes: 600 });
eq('续读 from 衔接', next.emittedFrom, ranged.nextFrom, `emittedFrom=${next.emittedFrom} nextFrom=${ranged.nextFrom}`);
ok('续读正文带锚点', /^\[/m.test(next.text));

// the window that reaches the end of the chapter: must not claim hasMore and
// must not answer with nextFrom — the output schema declares it a number, so a
// null here is rejected by the host (ToolOutputError INVALID_TOOL_OUTPUT).
const whole = await call('dr_read', { book: 'gate', mode: 'range', chapter: 2, from: 1 });
eq('读到章末 hasMore=false', whole.hasMore, false);
eq('读到章末 emittedTo=末段', whole.emittedTo, whole.totalParas);
ok('读完不给 nextFrom', !('nextFrom' in whole), JSON.stringify(whole.nextFrom));

const found = await call('dr_read', { book: 'gate', mode: 'find', keyword: '编号 7。' });
ok('find 命中且带片段', found.matchCount >= 1 && found.matches[0].snippet.includes('编号 7。'), JSON.stringify(found.matches[0] ?? null));

const located = await call('dr_read', { book: 'gate', mode: 'locate', chapter: 1, phrase: '短章第二段' });
eq('locate 命中 1 段', located.matchCount, 1);
ok('locate 上下文含锚点', located.contextBlocks[0].includes('[2]'));

// ---------------------------------------------------------------- 3. memory gates
const noAnchor = await call('dr_write', { book: 'gate', kind: 'memory', chapter: 1, state: 'complete', content: '## 核心主张\n- 没有定位的主张' });
eq('无定位的记忆被拒', noAnchor.ok, false);
ok('拒绝理由提到定位', /定位/.test(noAnchor.error), noAnchor.error);
ok('拒绝带纠正提示', typeof noAnchor.hint === 'string' && noAnchor.hint.length > 0);

const partialSkip = await call('dr_write', { book: 'gate', kind: 'memory', chapter: 2, state: 'partial', covered: '3-9/40', content: '## 核心主张\n- 从中段开始（依据 [3]）' });
eq('covered 未从第 1 段开始 → 拒', partialSkip.ok, false);
ok('理由提到 covered', /covered/.test(partialSkip.error), partialSkip.error);

const partialOk = await call('dr_write', { book: 'gate', kind: 'memory', chapter: 2, state: 'partial', covered: '1-9/40', content: '## 核心主张\n- 读到第九段（依据 [3][9]）' });
eq('合法 partial 写入', partialOk.ok, true);
eq('partial 记录 covered', partialOk.covered, '1-9/40');
eq('partial 状态', partialOk.state, 'partial');

const noAdvance = await call('dr_write', { book: 'gate', kind: 'memory', chapter: 2, state: 'partial', covered: '1-8/40', content: '## 核心主张\n- 回退（依据 [3]）' });
eq('covered 未推进 → 拒', noAdvance.ok, false);

const fullViaPartial = await call('dr_write', { book: 'gate', kind: 'memory', chapter: 2, state: 'partial', covered: '1-40/40', content: '## 核心主张\n- 读完（依据 [40]）' });
eq('covered 覆盖全部 → 提示改 complete', fullViaPartial.ok, false);
ok('提示 state=complete', /state=complete/.test(fullViaPartial.error + (fullViaPartial.hint ?? '')), fullViaPartial.error);

const complete = await call('dr_write', { book: 'gate', kind: 'memory', chapter: 1, state: 'complete', content: '## 核心主张\n- 起点是短章（依据 [1][2]）' });
eq('complete 记忆写入', complete.ok, true);
eq('complete covered 全覆盖', complete.covered, '1-2/2');
ok('写盘带 frontmatter', fs.readFileSync(path.join(bookDir, 'memory', '001.md'), 'utf8').startsWith('---\n'));

const rewritten = await call('dr_write', { book: 'gate', kind: 'memory', chapter: 1, state: 'complete', content: '## 核心主张\n- 改口（依据 [1]）' });
eq('仍有效的 complete 记忆不可回改', rewritten.ok, false);
ok('提示跨章修正', /修正/.test(rewritten.hint ?? ''), rewritten.hint);

const noFrontmatter = await call('dr_write', { book: 'gate', kind: 'memory', chapter: 1, content: '---\nfoo: 1\n---\n\n正文 [1]' });
eq('payload 自带 frontmatter → 拒', noFrontmatter.ok, false);

const lecture = await call('dr_write', { book: 'gate', kind: 'lecture', chapter: 1, content: '# 第一章讲解\n\n逐字落盘的讲解正文（依据 [1]）。' });
eq('讲解落盘', lecture.ok, true);

// ---------------------------------------------------------------- 4. status
const status = await call('dr_status', { book: 'gate' });
eq('可复用章数', status.reusableCount, 1);
const ch1Row = status.chapters.find((c) => c.n === 1);
eq('第 1 章 reusable', ch1Row.reusable, true);
eq('第 1 章 reason', ch1Row.reason, 'ok');
const ch2Row = status.chapters.find((c) => c.n === 2);
eq('第 2 章 reason=state-partial', ch2Row.reason, 'state-partial');

// touching the source invalidates reuse
const chFile = path.join(bookDir, 'chapters', '001.md');
fs.writeFileSync(chFile, fs.readFileSync(chFile, 'utf8') + '\n[3] 追加段。\n', 'utf8');
const stale = await call('dr_status', { book: 'gate', chapter: 1 });
eq('源变 → hash-mismatch', stale.chapters[0].reason, 'hash-mismatch');
eq('源变 → 不再复用', stale.chapters[0].reusable, false);

// ---------------------------------------------------------------- 5. reading_chapter
spawns.length = 0;
const reuseShort = await call('reading_chapter', { book: 'gate', chapter: 2 });
ok('partial 章不短路', spawns.length === 1, `spawn 次数 ${spawns.length}`);
eq('子任务 provider=spawn', spawns[0]?.provider, 'spawn');
ok('子任务带 persona（章节技能正文）', typeof spawns[0]?.request.persona === 'string' && spawns[0].request.persona.includes('单章精读'));
eq('子任务 maxDepth', spawns[0]?.request.maxDepth, 1);
eq('子任务 label', spawns[0]?.request.label, 'deep-reading gate ch002');
ok('子任务用父会话', spawns[0]?.request.parent === exec.agent);
ok('简报自包含', spawns[0]?.request.prompt[0].text.includes('books/gate 的第 2 章'), spawns[0]?.request.prompt[0].text?.slice(0, 60));
ok('简报禁止用文件工具读原文', /不要用文件读取工具读 chapters\/002\.md/.test(spawns[0].request.prompt[0].text));
eq('子任务文本逐字返回', reuseShort.ok, true);
ok('返回正文含子任务产出', reuseShort.lines.join('\n').includes('子任务产出，逐字返回'), reuseShort.lines.slice(-2).join('|'));
eq('子任务 tokens 入账', reuseShort.childTokens, 3820);
eq('memory 状态回报', reuseShort.memoryState, 'partial');

spawns.length = 0;
const reuseHit = await call('reading_chapter', { book: 'gate', chapter: 1 });
eq('过期章不短路（源已变）', spawns.length, 1);
ok('源已变时报 reusableBefore=false', reuseHit.reusableBefore === false);

// a genuinely reusable chapter short-circuits
const fresh = await call('dr_write', { book: 'gate', kind: 'memory', chapter: 1, state: 'complete', content: '## 核心主张\n- 含追加段（依据 [1][3]）' });
eq('源变后可重写 complete', fresh.ok, true);
spawns.length = 0;
const shorted = await call('reading_chapter', { book: 'gate', chapter: 1 });
eq('reusable 章短路（不 spawn）', spawns.length, 0);
eq('短路返回 ok=false', shorted.ok, false);
eq('短路标记 reusableBefore', shorted.reusableBefore, true);
ok('短路提示基于记忆讲解', /基于已有记忆/.test(shorted.hint ?? ''), shorted.hint);

// ---------------------------------------------------------------- 6. export verbatim
const manifest = [
  '# 《门禁测试书》阅读导出', '',
  '## 第 1 章', '',
  '@include chapters/001.md',
  '@include memory/001.md',
].join('\n');
const exported = await call('dr_write', { book: 'gate', kind: 'export', name: 'reading.md', content: manifest });
eq('导出成功', exported.ok, true);
eq('拼接两个文件', exported.included.length, 2);
const exportedText = fs.readFileSync(path.join(bookDir, 'exports', 'reading.md'), 'utf8');
const rawCh1 = fs.readFileSync(chFile, 'utf8');
ok('导出逐字收录章节原文', exportedText.includes(rawCh1.replace(/\r\n/g, '\n').trimEnd() + '\n'), '未找到逐字章节内容');
ok('manifest 其余行保留', exportedText.startsWith('# 《门禁测试书》阅读导出\n\n## 第 1 章\n'));

const escape = await call('dr_write', { book: 'gate', kind: 'export', name: 'bad.md', content: '@include ../../../etc/hosts' });
eq('@include 越界 → 拒', escape.ok, false);
const badName = await call('dr_write', { book: 'gate', kind: 'export', name: '../evil.md', content: '正文' });
eq('导出文件名不合法 → 拒', badName.ok, false);

// ---------------------------------------------------------------- 7. usage
const { usageTotals } = await import('../lib/tools/shared.js');
eq('投影 host state 取 totals 层', usageTotals({ totals: { uncachedInputTokens: 7 }, last: null })?.uncachedInputTokens, 7);
eq('扁平 wire 形状也认', usageTotals({ uncachedInputTokens: 8 })?.uncachedInputTokens, 8);
eq('陌生结构 → null（不记账）', usageTotals({ foo: 1 }), null);

const usage1 = await call('dr_usage', { book: 'gate', task: 'read-ch1' });
eq('首次记账追加', usage1.appended, true);
eq('折入子代理 tokens', usage1.addedSubagentTokens, 3820 * 2);
const usage2 = await call('dr_usage', { book: 'gate', task: 'read-ch1' });
eq('无新增 → 不追加', usage2.appended, false);
eq('无新增理由', usage2.reason, 'no-new-usage');
const report = await call('dr_usage', { book: 'gate', report: true });
eq('report 章数', report.chapterCount, 2);
const r1 = report.chapters.find((c) => c.chapter === 1);
eq('第 1 章标签归纳', r1.tasks.join(','), 'read-ch1');
eq('第 1 章输入', r1.input, PARENT_USAGE.uncachedInputTokens);
ok('第 1 章小计>0', r1.total > 0);

// ---------------------------------------------------------------- 8. epub
const epub = await call('dr_export_epub', { book: 'gate' });
eq('EPUB 导出成功', epub.ok, true);
eq('EPUB 收录 1 章', epub.chapterCount, 1);
ok('EPUB 列出未讲解章', epub.missingChapters.join(',') === '2', epub.missingChapters.join(','));
const epubBuf = fs.readFileSync(path.join(bookDir, 'exports', 'gate-讲解.epub'));
const entries = readZipEntries(epubBuf);
eq('EPUB 首条目是 mimetype', entries[0]?.name, 'mimetype');
eq('mimetype 不压缩', entries[0]?.method, 0);
ok('EPUB 含容器描述', entries.some((e) => e.name === 'META-INF/container.xml'));
ok('EPUB 含讲解正文', entries.some((e) => e.name.startsWith('OEBPS/ch') && e.text().includes('逐字落盘的讲解正文')),
  entries.map((e) => e.name).join(','));
ok('EPUB 不含 frontmatter', !entries.some((e) => e.text().includes('source_sha256')));

// ---------------------------------------------------------------- 9. txt / pdf 转换
const txtPath = path.join(TMP, 'chaoxi.txt');
fs.writeFileSync(txtPath, '《测试小书》\n\n第一章 起点\n\n第一段正文，用来看转换。\n\n第二段正文，同上一段。\n\n第二章 转折\n\n第二章的正文内容。\n', 'utf8');
const txtImport = await call('dr_import', { src: txtPath, book: 'txtbook' });
eq('txt 导入 ok', txtImport.ok, true);
eq('txt 章数（前言 + 2 章）', txtImport.chapterCount, 3);
eq('txt 书名取首行', txtImport.title, '测试小书');
ok('txt 转换行含编码', (txtImport.conversion || []).some((l) => l.includes('编码 utf-8')), JSON.stringify(txtImport.conversion));
ok('txt 提示留了 source.md', (txtImport.conversion || []).some((l) => l.includes('source.md')), JSON.stringify(txtImport.conversion));
const txtSource = fs.readFileSync(path.join(TMP, 'txtbook', 'source.md'), 'utf8');
ok('txt source.md 是转换全文', txtSource.includes('# 第一章 起点') && txtSource.includes('# 第二章 转折'), txtSource.slice(0, 80));
const txtBook = JSON.parse(fs.readFileSync(path.join(TMP, 'txtbook', 'book.json'), 'utf8'));
eq('book.json 源类型 txt', txtBook.source?.type, 'txt');
eq('book.json 记 conversion.kind', txtBook.source?.conversion?.kind, 'txt');
eq('book.json 记编码', txtBook.source?.conversion?.encoding, 'utf-8');

const txtSkip = await call('dr_import', { src: txtPath, book: 'txtbook' });
eq('txt 同源 → skipped', txtSkip.skipped, true);
ok('skipped 仍报转换说明', (txtSkip.conversion || []).some((l) => l.includes('编码')), JSON.stringify(txtSkip.conversion));

// GBK 编码样本（test/fixtures/gbk-sample.txt，无 BOM 的 GB18030 字节）
const gbkImport = await call('dr_import', { src: path.join(FIXTURES, 'gbk-sample.txt'), book: 'gbkbook' });
eq('GBK txt 导入 ok', gbkImport.ok, true);
ok('GBK 识别为 gb18030', (gbkImport.conversion || []).some((l) => l.includes('gb18030')), JSON.stringify(gbkImport.conversion));
ok('GBK 不标"不确定"', !(gbkImport.conversion || []).some((l) => l.includes('不确定')), JSON.stringify(gbkImport.conversion));
eq('GBK 章数', gbkImport.chapterCount, 2);
const gbkSource = fs.readFileSync(path.join(TMP, 'gbkbook', 'source.md'), 'utf8');
ok('GBK 解码无乱码', gbkSource.includes('# 第一章 起点') && !gbkSource.includes('�'), gbkSource.slice(0, 60));

// 目录导入：source.md 不参与切章
const dirSrc = path.join(TMP, 'dirsrc');
fs.mkdirSync(dirSrc);
fs.writeFileSync(path.join(dirSrc, 'a.md'), '# 第一章 甲\n\n甲的正文。\n', 'utf8');
fs.writeFileSync(path.join(dirSrc, 'source.md'), '# 不该被切章\n\n这行不该出现在任何章节里。\n', 'utf8');
const dirImport = await call('dr_import', { src: dirSrc, book: 'dirbook' });
eq('目录导入 ok', dirImport.ok, true);
eq('目录导入只切 1 章', dirImport.chapterCount, 1);
ok('source.md 被排除', !JSON.stringify(dirImport.chapters).includes('不该被切章'), JSON.stringify(dirImport.chapters));

// 文字层 PDF（手搓两页）与扫描件样子（两页纯图形，零文字）
const pdfGood = path.join(TMP, 'tiny.pdf');
fs.writeFileSync(pdfGood, makePdfBytes([
  { lines: ['1', 'Chapter 1', 'First paragraph of the tiny book.', 'Second paragraph of the tiny book.'] },
  { lines: ['2', 'Chapter 2', 'Third paragraph of the tiny book.'] },
]));
const pdfImport = await call('dr_import', { src: pdfGood, book: 'pdfbook', title: '小书' });
eq('pdf 导入 ok', pdfImport.ok, true);
eq('pdf 章数', pdfImport.chapterCount, 2);
eq('pdf 书名', pdfImport.title, '小书');
ok('pdf 转换行含页数/标题数/去页码',
  (pdfImport.conversion || []).some((l) => l.includes('2 页') && l.includes('标题 2 个') && l.includes('去页码 2 条')),
  JSON.stringify(pdfImport.conversion));
const pdfSource = fs.readFileSync(path.join(TMP, 'pdfbook', 'source.md'), 'utf8');
ok('pdf source.md 是转换全文', pdfSource.includes('# Chapter 1') && pdfSource.includes('# Chapter 2'), pdfSource.slice(0, 80));
const pdfCh1 = fs.readFileSync(path.join(TMP, 'pdfbook', 'chapters', '001.md'), 'utf8');
ok('pdf 章节带 [n] 锚点', /\[1\]/.test(pdfCh1), pdfCh1.slice(0, 100));
const pdfBook = JSON.parse(fs.readFileSync(path.join(TMP, 'pdfbook', 'book.json'), 'utf8'));
eq('book.json 源类型 pdf', pdfBook.source?.type, 'pdf');
eq('book.json 记 conversion.pages', pdfBook.source?.conversion?.pages, 2);

const pdfScan = path.join(TMP, 'scan.pdf');
fs.writeFileSync(pdfScan, makePdfBytes([{ rectOnly: true }, { rectOnly: true }]));
const scanImport = await call('dr_import', { src: pdfScan, book: 'scanbook' });
eq('扫描件被拒', scanImport.ok, false);
ok('拒绝理由提扫描件', /扫描件/.test(scanImport.error ?? ''), scanImport.error);
ok('提示先 OCR', /OCR/.test(scanImport.hint ?? ''), scanImport.hint);
ok('拒绝时不建目录', !fs.existsSync(path.join(TMP, 'scanbook')), 'scanbook 竟然建出来了');

// ---------------------------------------------------------------- report
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`harness: ${pass} 通过，${failures.length} 失败`);
for (const f of failures) console.log(` ✗ ${f}`);
process.exit(failures.length === 0 ? 0 : 1);

/** Stub context: collects tools, queues child behaviour for reading_chapter. */
function makeContext() {
  const tools = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register: (t) => tools.push(t) },
    skills: { register() {} },
    get: (key) => (key === 'sessionProjections'
      ? {
        // The real host state is `{totals, last}` (dsh-token-meter,
        // lib/types/usage-projection.js). Serving a flat object here would let
        // a wrong-level read through as silent zeros.
        stateOf: (session) => ({ totals: session.id === 'child-sess' ? childUsage : PARENT_USAGE, last: null }),
      }
      : undefined),
    subagents: {
      start: (provider, request) => {
        spawns.push({ provider, request });
        const run = {
          id: `child-${spawns.length}`,
          localAgent: { session: { id: 'child-sess' } },
          result: Promise.resolve({ output: makeChildOutput(), stopReason: 'completed' }),
          dispose: async () => {},
        };
        return run;
      },
    },
  };
  return { ctx, tools };
}

function makeChildOutput() {
  return [{ type: 'text', text: '第二章讲解正文（子任务产出，逐字返回）。\n\n— 记忆：memory/002.md（state: complete，covered 1-40/40）' }];
}

/** Central-directory zip reader: enough to assert entry order, method, and text. */
function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('不是有效的 zip：找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.slice(dataStart, dataStart + compSize);
    entries.push({
      name,
      method,
      text: () => (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8'),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

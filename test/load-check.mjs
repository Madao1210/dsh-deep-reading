/**
 * load-check — the plugin contract, without the host.
 *
 * Builds a stub cordis context, applies the plugin, and asserts:
 *   - apply() is callable and registers 2 skills + 7 tools
 *   - every tool returns a value the host's strict validator would accept
 *     (declared keys only, matching types) — see test/vschema.mjs
 *   - every output.schema object node declares additionalProperties
 *   - a representative call of each tool passes that validator end to end
 *   - the txt/pdf converter's dependencies resolve and its entry points load
 *
 * Run: npm run load-check
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { apply, Config } from '../lib/index.js';
import { auditSchemaNode, validateValue } from './vschema.mjs';
import { makePdfBytes } from './fixtures/minipdf.mjs';

const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-loadcheck-'));

let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const { ctx, tools, skills } = makeContext();

// ---- contract ----
ok('Config 是 schemastery schema', typeof Config === 'function' || typeof Config === 'object');
ok('apply 不抛异常', (() => { try { apply(ctx, { booksRoot: TMP }); return true; } catch (e) {
  failures.push(`apply 抛错：${e.message}`);
  return false;
} })());
ok('注册了 2 个技能', skills.length === 2, `实际 ${skills.length}`);
ok('注册了 7 个工具', tools.length === 7, `实际 ${tools.length}`);

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
for (const n of ['dr_import', 'dr_read', 'dr_write', 'dr_status', 'dr_usage', 'dr_export_epub', 'reading_chapter']) {
  ok(`工具存在：${n}`, Boolean(byName[n]));
}
for (const s of skills) {
  ok(`技能名合法：${s.name}`, /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.name), s.name);
  ok(`技能有 description：${s.name}`, typeof s.description === 'string' && s.description.length > 0);
  ok(`技能有 content：${s.name}`, typeof s.content === 'string' && s.content.length > 200);
  ok(`技能 source 是字符串：${s.name}`, typeof s.source === 'string');
}
const chapterSkill = skills.find((s) => s.name === 'deep-reading-chapter');
ok('章节技能不对模型/用户暴露', chapterSkill
  && chapterSkill.invocation.modelInvocable === false && chapterSkill.invocation.userInvocable === false);

// ---- txt/pdf 转换的依赖与入口 ----
try {
  const unpdf = await import('unpdf');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  ok('unpdf 可加载', typeof unpdf.getDocumentProxy === 'function');
  ok('pdfjs-dist Node 构建可加载', typeof pdfjs.getDocument === 'function');
} catch (e) {
  ok('unpdf / pdfjs-dist 可加载', false, e.message);
}
const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
ok('pdfjs cmaps 目录在（中文 PDF 字符表）', fs.existsSync(path.join(pdfjsDir, 'cmaps')));
ok('pdfjs standard_fonts 目录在', fs.existsSync(path.join(pdfjsDir, 'standard_fonts')));
const conv = await import('../lib/convert.js');
for (const fn of ['decodeText', 'textToMarkdown', 'joinWrappedLines', 'markHeadings', 'convertTxt', 'convertPdf']) {
  ok(`convert.js 导出 ${fn}`, typeof conv[fn] === 'function');
}

// ---- schema shape + a live call of every tool ----
const src = path.join(TMP, 'src.md');
fs.writeFileSync(src, [
  '# 第一章 起点', '', '第一段。', '', '第二段。', '', '第三段。', '',
  '# 第二章 转折', '', '第二章第一段。', '', '第二章第二段。', '',
].join('\n'), 'utf8');

const txtSrc = path.join(TMP, 'load-txt.txt');
fs.writeFileSync(txtSrc, '第一章 开始\n\n这是第一段。\n\n这是第二段。\n\n第二章 结束\n\n这是第二章的正文。\n', 'utf8');
const pdfSrc = path.join(TMP, 'load-tiny.pdf');
fs.writeFileSync(pdfSrc, makePdfBytes([{ lines: ['Chapter 1', 'First paragraph of the tiny book.', 'Second paragraph of the tiny book.'] }]));
const scanSrc = path.join(TMP, 'load-scan.pdf');
fs.writeFileSync(scanSrc, makePdfBytes([{ rectOnly: true }]));

const exec = {
  agent: { session: { id: 'sess-load-check' } },
  signal: new AbortController().signal,
};
const calls = [
  ['dr_import', { src, book: 'load-check', title: '测试书' }],
  ['dr_import', { src: txtSrc, book: 'load-txt' }],
  ['dr_import', { src: pdfSrc, book: 'load-pdf', title: '小 PDF' }],
  ['dr_import', { src: scanSrc, book: 'load-scan' }],
  ['dr_status', { book: 'load-check' }],
  ['dr_read', { book: 'load-check', mode: 'index' }],
  ['dr_read', { book: 'load-check', mode: 'range', chapter: 1, from: 1, to: 3, maxBytes: 40 }],
  ['dr_read', { book: 'load-check', mode: 'locate', chapter: 1, phrase: '第二段' }],
  ['dr_read', { book: 'load-check', mode: 'find', keyword: '第一段' }],
  ['dr_write', { book: 'load-check', kind: 'memory', chapter: 1, state: 'complete', content: '## 核心主张\n- 起点的意思（依据 [1]）' }],
  ['dr_write', { book: 'load-check', kind: 'lecture', chapter: 1, content: '# 第一章讲解\n\n内容。' }],
  ['dr_write', { book: 'load-check', kind: 'reader', content: '目的：理解机制' }],
  // refusal path: no anchor
  ['dr_write', { book: 'load-check', kind: 'memory', chapter: 2, content: '## 核心主张\n- 没有定位' }],
  ['dr_usage', { book: 'load-check', task: 'split' }],
  ['dr_usage', { book: 'load-check', report: true }],
  ['dr_export_epub', { book: 'load-check' }],
  ['reading_chapter', { book: 'load-check', chapter: 2 }],
];

for (const [toolName, args] of calls) {
  const tool = byName[toolName];
  if (!tool) continue;
  const schemaErrs = auditSchemaNode(tool.output.schema, toolName);
  ok(`schema 结构：${toolName}`, schemaErrs.length === 0, schemaErrs.join('; '));
  let value;
  try {
    value = await tool.execute(args, exec);
  } catch (e) {
    failures.push(`${toolName} 抛错（应当返回结构化结果）：${e.message}`);
    continue;
  }
  const errs = validateValue(tool.output.schema, value, toolName);
  ok(`返回值合 schema：${toolName} ${JSON.stringify(args).slice(0, 40)}`, errs.length === 0, errs.join('; '));
  ok(`返回值可渲染：${toolName}`, value && typeof value.ok === 'boolean');
}

// ---- report ----
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`load-check: ${pass} 通过，${failures.length} 失败`);
for (const f of failures) console.log(` ✗ ${f}`);
process.exit(failures.length === 0 ? 0 : 1);

/**
 * A stub cordis context: tools/skills collectors, a no-op logger, and a
 * sessionProjections stand-in so dr_usage can fold a token delta.
 */
function makeContext() {
  const tools = [];
  const skills = [];
  const usage = {
    uncachedInputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: 8000,
    cacheWriteTokens: 500,
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register: (t) => tools.push(t) },
    skills: { register: (s) => skills.push(s) },
    get: (key) => (key === 'sessionProjections'
      ? { stateOf: () => usage }
      : undefined),
    subagents: {
      start: () => ({
        id: 'child-1',
        localAgent: { session: { id: 'child-sess-1' } },
        result: Promise.resolve({
          output: [{ type: 'text', text: '第二章讲解正文（子任务产出，逐字返回）。' }],
          stopReason: 'completed',
        }),
        dispose: async () => {},
      }),
    },
    logger2: undefined,
    _dir: HERE,
  };
  return { ctx, tools, skills };
}

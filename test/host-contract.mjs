/**
 * host-contract — run the plugin inside the REAL host libraries.
 *
 * The other two suites use stubs; this one mounts the app's own cordis,
 * ToolRuntime and SkillRegistry (read straight out of app.asar) and applies the
 * plugin into that live context. It answers the questions a stub cannot:
 *   - does the host's service surface really look like ctx.tools / ctx.skills?
 *   - do our output schemas survive the host's own validators?
 *   - does the host's SkillRegistry accept and expose both skills, and does its
 *     own predicate hide the chapter skill from the model?
 *
 * Needs the DSH desktop app installed (it only reads from it). Run under the
 * app's Electron-as-Node; the script re-execs itself for that.
 *
 * Run: npm run host-check
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makePdfBytes } from './fixtures/minipdf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');

const APP_DIR = process.env.DSH_APP_DIR
  ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness');
const EXE = path.join(APP_DIR, 'DeepSeek Harness.exe');
const HOST_NM = path.join(APP_DIR, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');

if (!process.versions.electron) {
  if (!fs.existsSync(EXE)) {
    console.error(`找不到 DeepSeek Harness：${EXE}\n用 DSH_APP_DIR 指定安装目录。`);
    process.exit(2);
  }
  const r = spawnSync(EXE, ['--expose-internals', fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  process.exit(r.status ?? 1);
}

// ------------------------------------------------------------ real host libs
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
function entryOf(pkg) {
  const j = readJson(path.join(HOST_NM, pkg, 'package.json'));
  let e = j.exports?.['.'] ?? j.module ?? j.main;
  if (typeof e === 'object') e = e.import ?? e.default ?? e.require;
  if (typeof e !== 'string') throw new Error(`${pkg}: 无法解析入口`);
  return path.join(HOST_NM, pkg, e.replace(/^\.\//, ''));
}
const load = async (pkg) => import(pathToFileURL(entryOf(pkg)).href);

const cordis = await load('cordis');
const promptMod = await load('dsh-system-prompt');
const toolsMod = await load('dsh-tools');
const skillMod = await load('dsh-skill');
const projMod = await load('dsh-session-projection');
const meterMod = await load('dsh-token-meter');

let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, actual, expected) => ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，得到 ${JSON.stringify(actual)}`);

const ctx = new cordis.Context();
ctx.logger = { info() {}, warn() {}, error() {}, debug() {} };
ctx.plugin(promptMod.default ?? promptMod.SystemPrompt);
ctx.plugin(toolsMod.default ?? toolsMod.ToolRuntime);
ctx.plugin(skillMod.default ?? skillMod.SkillRegistry);
ctx.plugin(projMod.default ?? projMod.SessionProjectionRegistry);
ctx.plugin(meterMod.default ?? meterMod.TokenMeter);
await new Promise((r) => setTimeout(r, 300));

ok('宿主 tools 服务已挂载', Boolean(ctx.tools));
ok('宿主 skills 服务已挂载', Boolean(ctx.skills));
ok('宿主 sessionProjections 服务已挂载', Boolean(ctx.sessionProjections));

const tools = [];
const skills = [];
const regTool = ctx.tools.register.bind(ctx.tools);
ctx.tools.register = (...a) => { tools.push(a[0]); return regTool(...a); };
const regSkill = ctx.skills.register.bind(ctx.skills);
ctx.skills.register = (...a) => { skills.push(a[0]); return regSkill(...a); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-host-'));
const plugin = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'index.js')).href);
try {
  plugin.apply(ctx, { booksRoot: TMP });
  ok('apply() 在真实宿主上下文里不抛异常', true);
} catch (e) {
  ok('apply() 在真实宿主上下文里不抛异常', false, e.message);
}

const NAMES = ['dr_import', 'dr_read', 'dr_write', 'dr_status', 'dr_usage', 'dr_export_epub', 'reading_chapter'];
ok('宿主 ToolRuntime 收下 7 个工具', tools.length === 7, `实际 ${tools.length}`);
ok('宿主 SkillRegistry 收下 2 个技能', skills.length === 2, `实际 ${skills.length}`);

// ------------------------------------------------- schema shape, host-validated
for (const t of tools) {
  try {
    toolsMod.assertObjectJsonSchema(t.output.schema);
    toolsMod.assertSupportedJsonSchema(t.output.schema);
    ok(`${t.name} output.schema 合宿主子集`, true);
  } catch (e) {
    ok(`${t.name} output.schema 合宿主子集`, false, e.message.split('\n')[0]);
  }
  const req = t.parameters?.required;
  ok(`${t.name} 编译出必填参数`, Array.isArray(req) && req.length > 0, JSON.stringify(req));
  ok(`${t.name} 缺必填参数被拒`, toolsMod.validateJsonSchemaValue(t.parameters, {}, '').length > 0);
}

// ------------------------------------------------- live calls, host-validated
const src = path.join(TMP, 'host.md');
fs.writeFileSync(src, '# 第一章 起点\n\n第一段。\n\n第二段。\n\n# 第二章 转折\n\n第三段。\n', 'utf8');

// txt / pdf fixtures: the converter must also work inside the app's own
// Electron-as-Node runtime (dynamic import + pdfjs Node build + CMaps).
const srcTxt = path.join(TMP, 'host.txt');
fs.writeFileSync(srcTxt, '第一章 开始\n\n这是第一段。\n\n这是第二段。\n\n第二章 结束\n\n这是第二章的正文。\n', 'utf8');
const srcPdf = path.join(TMP, 'host-tiny.pdf');
fs.writeFileSync(srcPdf, makePdfBytes([
  { lines: ['1', 'Chapter 1', 'First paragraph of the tiny book.', 'Second paragraph of the tiny book.'] },
  { lines: ['2', 'Chapter 2', 'Third paragraph of the tiny book.'] },
]));
const srcScan = path.join(TMP, 'host-scan.pdf');
fs.writeFileSync(srcScan, makePdfBytes([{ rectOnly: true }, { rectOnly: true }]));

// A session only needs `header` / `inheritedEventCount` / `snapshotEvents()` /
// `seq` for dsh-session-projection to fold it; an empty log is a valid start.
const parentSession = {
  id: 'host-contract-parent', header: {}, inheritedEventCount: 0, seq: 0, snapshotEvents: () => [],
};
const childSession = {
  id: 'host-contract-child', header: {}, inheritedEventCount: 0, seq: 0, snapshotEvents: () => [],
};
const exec = { agent: { session: parentSession }, signal: new AbortController().signal };

/** Drive one real usage settlement through the host's own projection service. */
function settle(session, usage) {
  ctx.sessionProjections.stateOf(session, 'tokenUsage');
  ctx.sessionProjections.drive(session, {
    type: 'assistant/message', seq: 0, data: { turn: 0, step: 0, usage },
  });
  return ctx.sessionProjections.stateOf(session, 'tokenUsage');
}

const PARENT_USAGE = { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 8000, cacheWriteTokens: 500 };
const CHILD_USAGE = { inputTokens: 500, outputTokens: 120, cacheReadTokens: 3000, cacheWriteTokens: 200 };
const projected = settle(parentSession, PARENT_USAGE);
ok('tokenUsage 状态带 totals 层', Boolean(projected?.totals), JSON.stringify(projected)?.slice(0, 120));
eq('totals 折入宿主用量', projected?.totals?.uncachedInputTokens, PARENT_USAGE.inputTokens);

const CALLS = [
  ['dr_import', { src, book: 'host', title: '宿主校验书' }, 'ok'],
  ['dr_import', { src: srcTxt, book: 'host-txt' }, 'ok', 'importTxt'],
  ['dr_import', { src: srcPdf, book: 'host-pdf', title: '宿主小 PDF' }, 'ok', 'importPdf'],
  ['dr_import', { src: srcScan, book: 'host-scan' }, { error: /扫描件/ }, 'importScan'],
  ['dr_read', { book: 'host', mode: 'index' }, 'ok'],
  ['dr_read', { book: 'host', mode: 'range', chapter: 1, from: 1, maxBytes: 20 }, 'ok'],
  ['dr_read', { book: 'host', mode: 'range', chapter: 1, from: 1 }, 'ok', 'rangeToEnd'],
  ['dr_read', { book: 'host', mode: 'locate', chapter: 1, phrase: '第二段' }, 'ok'],
  ['dr_read', { book: 'host', mode: 'find', keyword: '第一段' }, 'ok'],
  ['dr_status', { book: 'host' }, 'ok'],
  ['dr_write', { book: 'host', kind: 'memory', chapter: 1, state: 'complete', content: '## 核心主张\n- 有定位（依据 [1]）' }, 'ok'],
  ['dr_write', { book: 'host', kind: 'lecture', chapter: 1, content: '# 第一章讲解\n\n讲解正文。' }, 'ok'],
  ['dr_write', { book: 'host', kind: 'memory', chapter: 2, content: '## 核心主张\n- 无定位' }, { error: /定位/ }],
  ['dr_export_epub', { book: 'host' }, 'ok'],
  ['reading_chapter', { book: 'host', chapter: 2 }, { error: /没有 subagents 服务/ }],
];
const values = {};
for (const [name, args, expect, label] of CALLS) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) { ok(`${name} 存在`, false); continue; }
  try {
    const value = await tool.execute(args, exec);
    toolsMod.validateJsonSchemaValue(tool.output.schema, value);
    await tool.output.render(args, value);
    values[label ?? name] = value;
    // A guarded() refusal is a perfectly valid *value*, so "did not throw" is
    // not a pass — each call states which outcome it must produce.
    if (expect === 'ok') ok(`${name} 实跑且 ok`, value.ok === true, `ok=${value.ok} ${value.error ?? ''}`);
    else ok(`${name} 按预期拒绝`, value.ok === false && expect.error.test(String(value.error)), `ok=${value.ok} error=${value.error ?? ''}`);
  } catch (e) {
    ok(`${name} 实跑 + 宿主校验 + 渲染`, false, e.message.split('\n')[0]);
  }
}
ok('读到章末 hasMore=false', values.rangeToEnd?.hasMore === false, JSON.stringify(values.rangeToEnd?.hasMore));
ok('读完不给 nextFrom', !('nextFrom' in (values.rangeToEnd ?? {})), JSON.stringify(values.rangeToEnd?.nextFrom));
ok('txt 转换经宿主导入', values.importTxt?.chapterCount === 2 && values.importTxt?.sourceType === 'txt',
  JSON.stringify({ c: values.importTxt?.chapterCount, t: values.importTxt?.sourceType, e: values.importTxt?.error }));
ok('txt source.md 在宿主流程里落盘', fs.existsSync(path.join(TMP, 'host-txt', 'source.md')));
ok('pdf 在 Electron 运行时里抽出文字', values.importPdf?.chapterCount === 2 && values.importPdf?.sourceType === 'pdf',
  JSON.stringify({ c: values.importPdf?.chapterCount, e: values.importPdf?.error }));
ok('扫描 PDF 被拒且提示 OCR', values.importScan?.ok === false && /OCR/.test(String(values.importScan?.hint ?? '')),
  `${values.importScan?.error} | ${values.importScan?.hint}`);

// ------------------------------------------------- chapter child, token ledger
const childStub = {
  start: (provider, request) => ({
    id: 'child-1',
    provider,
    request,
    localAgent: { session: childSession },
    result: Promise.resolve({
      output: [{ type: 'text', text: '第二章讲解正文（子代理产出）。' }],
      stopReason: 'completed',
    }),
    dispose: async () => {},
  }),
};
const disposeSubagents = ctx.provide('subagents', childStub);
settle(childSession, CHILD_USAGE);

const chapterTool = tools.find((t) => t.name === 'reading_chapter');
let chapterValue;
try {
  chapterValue = await chapterTool.execute({ book: 'host', chapter: 2 }, exec);
  toolsMod.validateJsonSchemaValue(chapterTool.output.schema, chapterValue);
  await chapterTool.output.render({ book: 'host', chapter: 2 }, chapterValue);
  ok('子代理链路实跑且 ok', chapterValue.ok === true, `ok=${chapterValue.ok} ${chapterValue.error ?? ''}`);
  ok('子任务文本逐字返回', chapterValue.lines.join('\n').includes('子代理产出'));
} catch (e) {
  ok('子代理链路实跑且 ok', false, e.message.split('\n')[0]);
}
eq('子代理 tokens 从真投影读出', chapterValue?.childTokens, 500 + 120 + 3000 + 200);
const pendingFile = path.join(TMP, 'host', '.usage-agents.json');
const pendingBefore = JSON.parse(fs.readFileSync(pendingFile, 'utf8')).pending;
eq('待记子代理条目落盘', pendingBefore.length, 1);

// dr_usage folds the parent delta and the pending child total into one row.
const usageTool = tools.find((t) => t.name === 'dr_usage');
let usage1;
try {
  usage1 = await usageTool.execute({ book: 'host', task: 'read-ch2' }, exec);
  toolsMod.validateJsonSchemaValue(usageTool.output.schema, usage1);
  await usageTool.output.render({ book: 'host', task: 'read-ch2' }, usage1);
  ok('记账实跑且 ok', usage1.ok === true, `ok=${usage1.ok} ${usage1.error ?? ''}`);
} catch (e) {
  ok('记账实跑且 ok', false, e.message.split('\n')[0]);
}
eq('记账追加', usage1?.appended, true);
eq('记账输入取真投影', usage1?.addedInput, PARENT_USAGE.inputTokens);
eq('记账输出取真投影', usage1?.addedOutput, PARENT_USAGE.outputTokens);
eq('记账折入子代理', usage1?.addedSubagentTokens, 3820);
const ledger = fs.readFileSync(path.join(TMP, 'host', 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
eq('账本一行', ledger.length, 1);
eq('账本行含子代理 tokens', ledger[0].subagentTokens, 3820);
eq('折入后待记清空', JSON.parse(fs.readFileSync(pendingFile, 'utf8')).pending.length, 0);

const usage2 = await usageTool.execute({ book: 'host', task: 'read-ch2' }, exec);
eq('无新增不追加', usage2.appended, false);
eq('无新增理由', usage2.reason, 'no-new-usage');

const report = await usageTool.execute({ book: 'host', report: true }, exec);
eq('report 章数', report.chapterCount, 2);
eq('report 归章输入', report.chapters[1]?.input, PARENT_USAGE.inputTokens);
disposeSubagents();

// ------------------------------------------------- skills, read back from the registry
for (const n of ['deep-reading', 'deep-reading-chapter']) {
  try {
    const def = await ctx.skills.get(n);
    ok(`注册表可读回 ${n}`, Boolean(def));
    const text = JSON.stringify(def);
    ok(`${n} 内容完整`, text.includes('Books') || text.length > 400, `长度 ${text.length}`);
  } catch (e) {
    ok(`注册表可读回 ${n}`, false, e.message.split('\n')[0]);
  }
}
const chapterDef = await ctx.skills.get('deep-reading-chapter');
const entryDef = await ctx.skills.get('deep-reading');
ok('入口技能可被模型调用', skillMod.isModelInvocable(entryDef) === true);
ok('章节技能对模型隐藏', skillMod.isModelInvocable(chapterDef) === false);
ok('章节技能对用户隐藏', skillMod.isUserInvocable(chapterDef) === false);
ok('工具名与预期一致', tools.map((t) => t.name).join(',') === NAMES.join(','), tools.map((t) => t.name).join(','));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`host-contract: ${pass} 通过，${failures.length} 失败`);
for (const f of failures) console.log(` ✗ ${f}`);
process.exit(failures.length === 0 ? 0 : 1);

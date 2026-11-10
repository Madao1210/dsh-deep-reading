/**
 * host-contract-linux — host-contract.mjs 的 Linux 版。
 * 直接加载 npm 安装的 DSH 0.2.2-rc.1 CLI 自带真实宿主库（cordis / dsh-tools /
 * dsh-session-projection / dsh-token-meter），在真 cordis 上下文里 apply 插件，
 * 按 0.2.2-rc.1 的 startActivation 契约 stub subagents，实跑 reading_chapter。
 * Run: node test/host-contract-linux.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const HOST_NM = '/home/lyx/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
function entryOf(pkg) {
  const j = readJson(path.join(HOST_NM, pkg, 'package.json'));
  let e = j.exports?.['.'] ?? j.module ?? j.main;
  if (typeof e === 'object') e = e.import ?? e.default ?? e.require;
  if (typeof e !== 'string') throw new Error(`${pkg}: 无法解析入口`);
  return path.join(HOST_NM, pkg, e.replace(/^\.\//, ''));
}
const load = async (pkg) => import(pathToFileURL(entryOf(pkg)).href);

// ------------------------------------------------------------ real host libs
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
const eq = (name, a, b) => ok(name, a === b, `期望 ${JSON.stringify(b)}，得到 ${JSON.stringify(a)}`);

const ctx = new cordis.Context();
ctx.logger = { info() {}, warn() {}, error() {}, debug() {} };
ctx.plugin(promptMod.default ?? promptMod.SystemPrompt);
ctx.plugin(toolsMod.default ?? toolsMod.ToolRuntime);
ctx.plugin(skillMod.default ?? skillMod.SkillRegistry);
ctx.plugin(projMod.default ?? projMod.SessionProjectionRegistry);
ctx.plugin(meterMod.default ?? meterMod.TokenMeter);
await new Promise((r) => setTimeout(r, 300));
ok('宿主 tools 服务已挂载', Boolean(ctx.tools));
ok('宿主 sessionProjections 服务已挂载', Boolean(ctx.sessionProjections));

// --------------------------------------------------- apply plugin, collect tools
const tools = [];
const regTool = ctx.tools.register.bind(ctx.tools);
ctx.tools.register = (...a) => { tools.push(a[0]); return regTool(...a); };
const plugin = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'index.js')).href);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-host-linux-'));
try {
  plugin.apply(ctx, { booksRoot: TMP });
  ok('apply() 在真宿主上下文里不抛异常', true);
} catch (e) {
  ok('apply() 在真宿主上下文里不抛异常', false, e.message);
}
ok('真宿主 ToolRuntime 收下 7 个工具', tools.length === 7, `实际 ${tools.length}`);

// ------------------------------------------------------- stubs (0.2.2-rc.1 契约)
const parentSession = { id: 'linux-parent', header: {}, inheritedEventCount: 0, seq: 0, snapshotEvents: () => [] };
const childSession = { id: 'linux-child', header: {}, inheritedEventCount: 0, seq: 0, real: true, snapshotEvents: () => [] };

const CHILD_USAGE = { inputTokens: 500, outputTokens: 120, cacheReadTokens: 3000, cacheWriteTokens: 200 };
const exec = { agent: { session: parentSession }, signal: new AbortController().signal };
const activationSpecs = [];
const childStub = {
  getProvider: (name) => (name === 'spawn' ? { name: 'spawn' } : undefined),
  startActivation: (spec) => {
    activationSpecs.push(spec);
    return {
      childId: 'linux-child',
      result: Promise.resolve({
        output: [{ type: 'text', text: '第二章讲解正文（子代理产出）。' }],
        stopReason: 'completed',
      }),
      dispose: async () => {},
    };
  },
};
ctx.provide('subagents', childStub);
ctx.provide('sessions', { get: (id) => (id === 'linux-child' ? childSession : undefined) });

/** Fold one usage event through the real projection service. */
function settle(session, usage) {
  ctx.sessionProjections.drive(session, {
    type: 'assistant/message', seq: 0, data: { turn: 0, step: 0, usage },
  });
  return ctx.sessionProjections.stateOf(session, 'tokenUsage');
}

// ------------------------------------------------------------------ drive tools
settle(parentSession, { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 8000, cacheWriteTokens: 500 });
const src = path.join(TMP, 'linux.md');
fs.writeFileSync(src, '# 第一章 起点\n\n第一段。\n\n第二段。\n\n# 第二章 转折\n\n第三段。\n', 'utf8');
const imported = await tools.find((t) => t.name === 'dr_import').execute({ src, book: 'linux', title: 'Linux 宿主校验书' }, exec);
ok('dr_import 实跑且 ok', imported.ok === true, imported.error ?? '');
eq('导入章数', imported.chapterCount, 2);

const chapterTool = tools.find((t) => t.name === 'reading_chapter');
settle(childSession, { inputTokens: 500, outputTokens: 120, cacheReadTokens: 3000, cacheWriteTokens: 200 });
let chapterValue;
try {
  chapterValue = await chapterTool.execute({ book: 'linux', chapter: 2 }, exec);
  toolsMod.validateJsonSchemaValue(chapterTool.output.schema, chapterValue);
  ok('真宿主输出校验通过', true);
} catch (e) {
  ok('reading_chapter 实跑 + 真宿主校验', false, e.message.split('\n')[0]);
}
eq('startActivation 收到 provider=spawn', activationSpecs[0]?.provider, 'spawn');
eq('spec.delivery=caller', activationSpecs[0]?.delivery, 'caller');
eq('spec.label', activationSpecs[0]?.label, 'deep-reading linux ch002');
eq('request.maxDepth', activationSpecs[0]?.request.maxDepth, 1);
eq('request.parent=exec.agent', activationSpecs[0]?.request.parent, exec.agent);
ok('prompt 内联章节规程', activationSpecs[0]?.request.prompt[0].text.includes('单章精读'), '');
ok('简报含书与章', activationSpecs[0]?.request.prompt[0].text.includes('books/linux 的第 2 章'));
eq('子代理 tokens 从真投影读出', chapterValue?.childTokens, 500 + 120 + 3000 + 200);
ok('子任务文本逐字返回', chapterValue?.lines?.join('\n').includes('子代理产出'));

// --------------------------------------------------- dr_usage folds child tokens
const usageTool = tools.find((t) => t.name === 'dr_usage');
const usage1 = await usageTool.execute({ book: 'linux', task: 'read-ch2' }, exec);
ok('记账实跑且 ok', usage1.ok === true, usage1.error ?? '');
eq('记账折入子代理', usage1.addedSubagentTokens, 3820);
const pendingFile = path.join(TMP, 'linux', '.usage-agents.json');
eq('折入后待记清空', JSON.parse(fs.readFileSync(pendingFile, 'utf8')).pending.length, 0);
eq('账本行含子代理 tokens', fs.readFileSync(path.join(TMP, 'linux', 'usage.jsonl'), 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l))[0].subagentTokens, 3820);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`host-contract-linux: ${pass} 通过，${failures.length} 失败`);
for (const f of failures) console.log(` ✗ ${f}`);
process.exit(failures.length === 0 ? 0 : 1);

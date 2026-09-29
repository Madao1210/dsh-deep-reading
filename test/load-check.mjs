/**
 * Load check — walk the installed path the way DSH does, without starting dsh.
 *
 * Order matters here, because each step can only catch what the previous one
 * could not: the patch file names the plugin, the Config schema has to accept
 * that file's own config block, `apply()` has to survive a real context, the
 * tools have to register with valid schemas, and then the deterministic half has
 * to actually run against a real file.
 *
 * Run: node test/load-check.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, name as pluginName, inject, Config } from '../lib/index.js';
import { createFakeContext, patchConfig, PLUGIN_ROOT } from './harness.mjs';

const checks = [];
function check(label, ok, detail = '') {
  checks.push({ label, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

const { row, config: rawConfig } = patchConfig();

// ── 1. the patch row is the plugin ───────────────────────────────────────────
check('cordis.patch.yml 的行 id 等于插件 name', row.id === pluginName, `${row.id} / ${pluginName}`);
check('插件声明了 tools / skills / systemPrompt', ['tools', 'skills', 'systemPrompt'].every((s) => inject.includes(s)), inject.join(', '));

// ── 2. the Config schema accepts the patch file's own config ─────────────────
const dataRoot = mkdtempSync(join(tmpdir(), 'dr-loadcheck-'));
let resolved;
try {
  resolved = Config({ ...rawConfig, dataRoot });
  check('Config schema 接受 patch 里的配置', true);
} catch (error) {
  check('Config schema 接受 patch 里的配置', false, error.message);
  process.exit(1);
}

// ── 3. apply() against a fake context ────────────────────────────────────────
const { ctx, record } = createFakeContext();
try {
  apply(ctx, { ...rawConfig, dataRoot });
  check('apply() 在假 cordis 上下文上跑通', true);
} catch (error) {
  check('apply() 在假 cordis 上下文上跑通', false, `${error.message}\n${error.stack}`);
  process.exit(1);
}

const toolNames = record.tools.map((tool) => tool.name);
check('注册了三个工具', toolNames.length === 3, toolNames.join(', '));
check('工具名刻意不占 book_*（那是别的书本工具的地盘）', toolNames.every((n) => n.startsWith('book_') === false), toolNames.join(', '));
check('每个工具都有 description / parameters / output.render', record.tools.every(
  (tool) => typeof tool.description === 'string' && tool.description.length > 40
    && tool.parameters !== undefined && typeof tool.output?.render === 'function',
));
check('注册了技能', record.skills.length === 1 && record.skills[0].name === 'dsh-deep-reading');
check('技能正文里带着 workflow 的 meta + script', record.skills[0]?.content.includes('runDeepReading') === true
  && record.skills[0]?.content.includes('"name": "dsh-deep-reading"') === true,
  `content ${record.skills[0]?.content.length ?? 0} 字符`);
check('技能 source 标为 bundled', record.skills[0]?.source === 'bundled');
check('注册了系统提示段', record.sections.length === 1 && record.sections[0].name === 'tool:dsh-deep-reading');
check('注册了动态投影 context', record.contexts.length === 1 && typeof record.contexts[0].text === 'function');
check('投影为空时不注入任何东西（新会话零成本）', record.contexts[0]?.text() === '');

// ── 4. actually call the tools ───────────────────────────────────────────────
const byName = Object.fromEntries(record.tools.map((tool) => [tool.name, tool]));

const open = await byName.reading_open.execute({ path: join(PLUGIN_ROOT, 'test', 'fixtures', 'sample-book.txt') });
check('reading_open 跑通并识别出章节', open.ok === true && open.chapters?.length === 3, `bookId=${open.bookId} 章节=${open.chapters?.length}`);
check('reading_open 返回可直接使用的 workflow args', typeof open.workflowArgsJson === 'string' && open.workflowArgsJson.includes('"cachedChunkIds"'));

const status = await byName.reading_status.execute({ bookId: open.bookId });
check('reading_status 跑通', status.ok === true && status.coverageLine?.startsWith('0/3'), status.coverageLine);

// A deliberately broken archive: every violation class fires, and nothing is written.
const broken = await byName.reading_archive.execute({
  bookId: open.bookId,
  chapterId: 'ch01',
  markdown: [
    '# ch01 第一章',
    '',
    '## 一、原文线索',
    '### 小节',
    '- 作者主张：作者认为重复读是主要成本 **这是一句原文里根本没有的话**',
    '',
    '## 二、共读推演',
    '### 推演 1：x',
    '- 依据：一',
    '',
    '## 三、我的看法（读者）',
    '我觉得这一章说得很好。',
  ].join('\n'),
});
check('reading_archive 拒收坏档案', broken.ok === false && broken.code === 'VERIFY');
const codes = (broken.violations ?? []).map((line) => /\[(\w+)\]/.exec(line)?.[1]);
check(
  '坏档案命中引文/推断标注/读者代笔/缺节/AI 视角/章末定位等违规',
  [
    'V_QUOTE_NOT_FOUND', 'V_INFERENCE_UNMARKED', 'V_READER_FABRICATED', 'V_SECTION_MISSING',
    'V_AI_VIEW_MISSING', 'V_BOOK_POSITION_MISSING',
  ].every((code) => codes.includes(code)),
  codes.join(', '),
);

// projection now has something to say
const projection = record.contexts[0].text();
check('开户后投影非空（续读时插件知道读到哪）', projection.includes('阅读进度'), projection.split('\n')[1] ?? '');

rmSync(dataRoot, { recursive: true, force: true });

const failed = checks.filter((entry) => entry.ok === false);
console.log('');
console.log(failed.length === 0
  ? `装载自检通过：${checks.length} 项。`
  : `装载自检失败：${failed.length}/${checks.length} 项。`);
process.exit(failed.length === 0 ? 0 : 1);

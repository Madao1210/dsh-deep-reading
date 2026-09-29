/**
 * dsh-deep-reading — 共读理解伙伴 (co-reading comprehension partner).
 *
 * What this plugin is NOT: a summarizer, a Q&A bot, or an agent that reads the
 * book for you. It supplies the deterministic half of reading a book — parse,
 * address, verify, persist — and leaves every judgement to the conversation's
 * own model. It calls no model itself. That line is what keeps the reader's
 * money and the plugin's opinion separable, and it is the same line the other
 * plugins in this environment drew.
 *
 * What it registers:
 *
 *   - one system-prompt section   the co-reading protocol + its vocabularies
 *   - one dynamic context          the compact reading-profile projection
 *   - one skill                    how to run the pipeline (meta + script + args)
 *   - three model tools            reading_open / reading_archive / reading_status
 *
 * `apply()` starts nothing by itself: no book is opened, no subagent is spawned,
 * no file is written until the model calls a tool.
 */
import Schema from '@deepseek-ai/schemastery';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfig } from './config.js';
import { buildProtocolText } from './orchestrator/protocol.js';
import { createParserRegistry } from './pipeline/parsers/index.js';
import { buildWorkflow } from './pipeline/workflow.js';
import { renderProjection } from './store/profile.js';
import { buildTools } from './tools/index.js';

/** Cordis plugin name; MUST equal the row id in cordis.patch.yml. */
export const name = 'dsh-deep-reading';

/** `tools` is what it registers into; `skills` publishes the workflow; `systemPrompt` carries the protocol. */
export const inject = ['skills', 'systemPrompt', 'tools'];

export const Config = Schema.object({
  dataRoot: Schema.string().default(''),
  maxSourceBytes: Schema.number().default(67108864),
  chapterHeadingLevel: Schema.number().default(1),
  minChapterChars: Schema.number().default(400),
  maxCharsPerChunk: Schema.number().default(12000),
  maxChunksPerWave: Schema.number().default(12),
  verifyQuotes: Schema.boolean().default(true),
  minQuoteChars: Schema.number().default(4),
});

/** lib/index.js → the package root. */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig ?? {});

  // Built once, at load. Custom parsers are ESM, so the registry is a promise
  // the tools await; the workflow is generated here so a broken prompt file or
  // an unparsable script fails at load rather than after the reader has waited.
  const registryPromise = createParserRegistry(PLUGIN_ROOT);
  const workflow = buildWorkflow({ pluginRoot: PLUGIN_ROOT });

  ctx.systemPrompt.section({
    name: 'tool:dsh-deep-reading',
    order: 130,
    text: buildProtocolText({ pluginRoot: PLUGIN_ROOT }),
  });

  // The projection is a *provider*: it is evaluated at each assembly, so a mark
  // the reader adds in one turn shows up in the next without a restart. It
  // returns '' when nothing has been opened, and an empty context contributes
  // nothing — installing this plugin costs a fresh session nothing.
  ctx.systemPrompt.context({
    name: 'dsh-deep-reading:reading-profile',
    order: 50,
    text: () => renderProjection(config),
  });

  ctx.skills.register({
    name: 'dsh-deep-reading',
    description: '深度讲解：把书变成可寻址文本，逐章精读（Map）→ 读完整章形成 mental model（Model）→ 按模型组织成含四步与 AI 视角的档案（Reduce），引文逐字可回源',
    whenToUse: workflow.meta.whenToUse,
    content: buildSkillContent(config, workflow),
    resourceBase: { kind: 'directory', path: join(PLUGIN_ROOT, 'skills', 'dsh-deep-reading') },
    // `source` is the skill's provenance bucket, not a description: this skill
    // ships inside the plugin package, so it is `bundled`.
    source: 'bundled',
  });

  buildTools({
    config,
    registryPromise,
    promptRevision: workflow.promptRevision,
    register: (toolName, definition) => ctx.tools.register(definition),
  });
}

/**
 * The skill body: the prose instructions plus the *literal* meta, script and
 * args the model must hand to the `workflow` tool.
 *
 * The script is embedded rather than referenced because the workflow tool takes
 * the script as an argument — there is no registry to load it from. It is
 * generated from `prompts/*.md` at load time, so editing a prompt changes the
 * script and the Map cache revision together.
 */
export function buildSkillContent(config, workflow) {
  const body = readFileSync(join(PLUGIN_ROOT, 'skills', 'dsh-deep-reading', 'SKILL.md'), 'utf8').trim();
  const argsExample = {
    bookId: '<reading_open 返回的 bookId>',
    bookDir: '<reading_open 返回的 bookDir>',
    sourcePath: '<reading_open 返回的 sourcePath>',
    title: '<书名>',
    chapters: '<reading_open / reading_status 返回的 chapters，原样复制>',
    cachedChunkIds: '<同上，原样复制；没有就给空数组>',
  };
  return [
    body,
    '',
    '## 用 workflow 工具执行',
    '',
    '`args` 不要自己拼：`reading_open` 与 `reading_status` 的返回里带 `workflowArgsJson`，**原样复制**它。',
    '下面是形状示例（真实值以工具返回为准）：',
    '',
    '```json',
    JSON.stringify(argsExample, null, 2),
    '```',
    '',
    '`meta`：',
    '',
    '```json',
    JSON.stringify(workflow.meta, null, 2),
    '```',
    '',
    '`script`（完整脚本，原样填入 `script` 参数；已自包含提示词与 schema，宿主无需额外注入）：',
    '',
    '```javascript',
    workflow.script,
    '```',
    '',
    `（脚本 revision：${workflow.promptRevision}。改了 prompts/ 下的任何一份，revision 会变，精读缓存随之失效。）`,
  ].join('\n');
}

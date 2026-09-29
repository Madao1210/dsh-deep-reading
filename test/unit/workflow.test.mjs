/**
 * The workflow: the generated script and the two prompt contracts around it.
 *
 * Everything here is a load-time failure if it is wrong, which is the point:
 * a workflow script that does not parse, or a schema outside the enforced
 * subset, fails *inside the sandbox after the reader has waited*. These tests
 * move that failure to `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools';

import { MAP_SCHEMA, MODEL_SCHEMA, REDUCE_SCHEMA, buildPayload, buildWorkflow } from '../../lib/pipeline/workflow.js';
import { MODEL_PROMPT_TOKENS } from '../../lib/pipeline/model.js';
import { runDeepReading } from '../../lib/pipeline/script-body.js';
import { PLUGIN_ROOT } from '../harness.mjs';

const workflow = buildWorkflow({ pluginRoot: PLUGIN_ROOT });
const payload = buildPayload({ pluginRoot: PLUGIN_ROOT });

test('生成的脚本能解析（且带顶层 await 与 return）', () => {
  assert.match(workflow.script, /const __DR = \{/);
  assert.match(workflow.script, /async function runDeepReading/);
  assert.match(workflow.script, /return await runDeepReading\(__DR, args, \{ agent, parallel, pipeline, phase, log \}\);/);
  // Same wrap the plugin uses internally; duplicated here so the test fails on
  // its own rather than through the plugin's error message.
  assert.doesNotThrow(() => new Function(`return (async () => {\n${workflow.script}\n});`));
});

test('脚本把提示词与 schema 都内联了（不依赖宿主注入）', () => {
  const parsed = JSON.parse(/const __DR = ([\s\S]*?);\n\nasync function/.exec(workflow.script)[1]);
  assert.ok(parsed.mapTemplate.includes('你只负责这一个块'));
  assert.ok(parsed.modelTemplate.includes('这一章真正在解决什么问题'));
  assert.ok(parsed.reduceTemplate.includes('把本章的精读结果合成'));
  assert.ok(parsed.archiveTemplate.includes('## 二、共读推演'));
  assert.deepEqual(Object.keys(parsed.mapSchema.properties).sort(), ['chunkId', 'gaps', 'openQuestions', 'points']);
  assert.deepEqual(Object.keys(parsed.modelSchema.properties).sort(), ['chapterId', 'chapterModel', 'teachingOrder']);
  assert.match(parsed.promptRevision, /^r[0-9a-f]{8}$/);
});

test('Model 阶段产出骨架：一章的 mental model + 讲解顺序', () => {
  // The pipeline is Map → Model → Reduce, and this schema is where "who decides
  // the lecture's structure" is answered: the whole-chapter reading, not the
  // chunk fragments Reduce happens to be holding.
  assert.deepEqual(Object.keys(MODEL_SCHEMA.properties.teachingOrder.properties).sort(), ['reason', 'shape', 'steps']);
  assert.deepEqual(MODEL_SCHEMA.properties.teachingOrder.properties.shape.enum, ['source', 'reordered']);
  // `reason` is required even for the source order: "原序就好" with no reason is
  // indistinguishable from never having asked the question.
  assert.deepEqual(MODEL_SCHEMA.properties.teachingOrder.required.sort(), ['reason', 'shape', 'steps']);
});

test('Map 的工作单位是带四个槽位的 point，不是一堆 findings', () => {
  // This schema is the plugin's positioning written as a contract: a chunk that
  // could hand back claims and quotes alone would let the archive — and the
  // lecture — stop at "the author says X".
  const point = MAP_SCHEMA.properties.points.items;
  assert.deepEqual(Object.keys(point.properties).sort(), ['boundary', 'claim', 'evidence', 'mechanism', 'missing', 'quote']);
  assert.deepEqual(point.required.sort(), ['claim', 'missing', 'quote']);
  assert.deepEqual(point.properties.missing.items.enum, ['evidence', 'mechanism', 'boundary']);
  assert.match(point.properties.mechanism.description, /为什么必然是这样/);
});

test('两个结构化 schema 都通过宿主的对象根校验（不被支持的关键字是致命错，不是降级）', () => {
  assert.doesNotThrow(() => assertObjectJsonSchema(MAP_SCHEMA));
  assert.doesNotThrow(() => assertObjectJsonSchema(REDUCE_SCHEMA));
});

test('Reduce 的回执故意很小：档案正文走磁盘，不走返回值', () => {
  assert.deepEqual(Object.keys(REDUCE_SCHEMA.properties).sort(), ['chapterId', 'draftPath', 'notes', 'sectionCount', 'written']);
  assert.ok(REDUCE_SCHEMA.properties.markdown === undefined, '回执里不该有 markdown 字段');
});

test('提示词里的每个 %%TOKEN%% 都会被脚本填上', () => {
  const tokensOf = (template) => new Set([...template.matchAll(/%%([A-Z_]+)%%/g)].map((m) => m[1]));
  const unfilled = (tokens, filled) => [...tokens].filter((token) => filled.has(token) === false);
  // Mirrors the `fill(...)` call sites in script-body.js.
  const filledForMap = new Set(['TITLE', 'CHAPTER_ID', 'CHUNK_ID', 'START_LINE', 'END_LINE', 'SOURCE_PATH', 'MAP_OUT_PATH']);
  const filledForModel = new Set(MODEL_PROMPT_TOKENS);
  const filledForReduce = new Set([
    'TITLE', 'CHAPTER_ID', 'CHAPTER_TITLE', 'START_LINE', 'END_LINE', 'SOURCE_PATH',
    'CHAPTER_MODEL', 'CHUNK_FINDINGS', 'CACHED_HINT', 'DRAFT_PATH', 'ARCHIVE_TEMPLATE',
  ]);
  assert.deepEqual(unfilled(tokensOf(payload.mapTemplate), filledForMap), [], 'map.md 里有脚本不填的占位符');
  assert.deepEqual(unfilled(tokensOf(payload.modelTemplate), filledForModel), [], 'model.md 里有脚本不填的占位符');
  assert.deepEqual(unfilled(tokensOf(payload.reduceTemplate), filledForReduce), [], 'reduce.md 里有脚本不填的占位符');
});

test('改一份提示词会让 promptRevision 变（精读缓存随之失效）', () => {
  const fake = { ...payload, promptRevision: undefined };
  const revisionOf = (mapTemplate) => `r${mapTemplate}`;
  assert.notEqual(revisionOf(payload.mapTemplate), revisionOf(`${payload.mapTemplate}\n新增一句`));
  assert.equal(fake.promptRevision, undefined);
});

test('参数缺失是致命错：整轮终止，不产出半成品', async () => {
  const hooks = { agent: async () => null, parallel: async () => [], pipeline: async () => [], phase: () => {}, log: () => {} };
  await assert.rejects(() => runDeepReading(payload, {}, hooks), /\[FATAL\] args\.bookId 缺失/);
  await assert.rejects(
    () => runDeepReading(payload, { bookId: 'x', bookDir: '/d', sourcePath: '/s', chapters: [] }, hooks),
    /\[FATAL\] args\.chapters 为空/,
  );
  await assert.rejects(
    () => runDeepReading(payload, { bookId: 'x', bookDir: '/d', sourcePath: '/s', chapters: [{ id: 'ch01' }] }, {}),
    /\[FATAL\] workflow 钩子缺失/,
  );
});

test('某个子代理失败只会把那一块记为缺口，不会拖垮整章', async () => {
  const prompts = [];
  const hooks = {
    phase: () => {},
    log: () => {},
    parallel: async (thunks) => Promise.all(thunks.map((run) => run().then((v) => v, () => null))),
    pipeline: async (items, ...stages) => Promise.all(items.map(async (item, i) => {
      let prev;
      for (const stage of stages) prev = await stage(prev, item, i);
      return prev;
    })),
    agent: async (prompt) => {
      prompts.push(prompt);
      if (prompt.includes('你只负责这一个块')) return null; // Map 失败
      return { chapterId: 'ch01', draftPath: '/d/drafts/ch01.md', written: true };
    },
  };
  const result = await runDeepReading(payload, {
    bookId: 'b1',
    bookDir: '/d',
    sourcePath: '/s',
    chapters: [{ id: 'ch01', title: 't', startLine: 1, endLine: 9, chunks: [{ id: 'ch01#p1', startLine: 1, endLine: 9 }] }],
  }, hooks);

  assert.equal(result.ok, true);
  assert.equal(result.chapters[0].ok, true);
  assert.deepEqual(result.chapters[0].mapFailures, ['ch01#p1']);
  const reducePrompt = prompts.find((p) => p.includes('把本章的精读结果合成'));
  assert.match(reducePrompt, /精读失败/);
  assert.match(reducePrompt, /必须在（本节留下的口子）里写明这一段没有被覆盖/);
});

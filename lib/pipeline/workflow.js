/**
 * The workflow this plugin hands to the model: meta + a self-contained script.
 *
 * There is no workflow *registry* to register into — the plugin only publishes
 * (a) this object, embedded in the skill content, and (b) the fact that the
 * script must be run as the `workflow` tool's `script` argument. That is what
 * the reference plugin does, and it is the only way to get parallel Map without
 * the plugin calling a model itself: `agent()` spawns the subagents.
 *
 * The script is generated, not written out longhand: the prompt templates and
 * schemas are injected as a `const __DR = {…}` prelude, and the body comes from
 * `runDeepReading.toString()`. Writing prompts twice — once as a file the reader
 * can edit, once as a string literal inside a script — is how a plugin ends up
 * with a prompt it cannot actually change.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDeepReading } from './script-body.js';
import { MODEL_SCHEMA } from './model.js';
import { sha256Hex } from '../util/text.js';

/** Re-exported so callers (and tests) can reach every structured output from one place. */
export { MODEL_SCHEMA };

export const META = {
  name: 'dsh-deep-reading',
  description: '深度讲解底稿：逐章并行精读（Map）→ 读完整章形成 mental model（Model）→ 按 model 组织成含四步与 AI 视角的章节档案（Reduce），逐字校验引文',
  whenToUse:
    '读者给了一本书（txt/md）并要求把它讲透、建立章节理解档案，或要求继续为尚未建档的章节生成档案时',
  phases: [
    {
      title: '逐章精读与合成',
      detail: '每章三步：并行精读各块（Map）→ 读完整章形成 mental model 与讲解顺序（Model）→ 把 point 挂到 model 上合成档案草稿（Reduce）',
    },
  ],
};

/**
 * The Map agent's structured result. Object-rooted and limited to the enforced
 * subset (type / properties / required / additionalProperties / items / enum /
 * const + annotations): an unsupported keyword is not a degraded parse, it
 * throws and kills the whole workflow run.
 *
 * The unit of work is a **point with four slots**, not a bag of findings. That
 * shape is the whole positioning of this plugin in one schema: an explanation
 * is only as deep as its `mechanism` and `boundary`, and a schema that lets a
 * chunk hand back claims and quotes alone would let the archive — and therefore
 * the lecture — stop at "the author says X".
 *
 * `missing` is load-bearing rather than decorative: it is how a Map agent says
 * "I could not derive a mechanism here" without inventing one. The Reduce step
 * turns a missing boundary into the literal text 「原文未给边界」.
 */
export const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chunkId: { type: 'string', description: '你负责的块号，原样回填' },
    points: {
      type: 'array',
      description: '这一段里讲得透的 point，每个 point 一件事，四个槽位都要填',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim: { type: 'string', description: '主张：作者说了什么，用你自己的话转述' },
          evidence: { type: 'string', description: '证据：原文里支撑它的例子／数字／案例；没有就留空并在 missing 里标出' },
          quote: { type: 'string', description: '从原文逐字复制的连续文本，10–200 字，支撑主张或证据；合成环节会拿它和原文逐字比对' },
          mechanism: { type: 'string', description: '机制：为什么必然是这样（作者没明说但逻辑上成立的推导）；推不出就留空并在 missing 里标出' },
          boundary: { type: 'string', description: '边界：什么情况下不成立、作者的限定词在哪；看不出就留空并在 missing 里标出' },
          missing: {
            type: 'array',
            description: '哪个槽位没填出来。空数组表示四个槽位都齐',
            items: { type: 'string', enum: ['evidence', 'mechanism', 'boundary'] },
          },
        },
        required: ['claim', 'quote', 'missing'],
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' }, description: '作者提出但没回答的问题、论证停住的地方' },
    gaps: { type: 'array', items: { type: 'string' }, description: '这一段没有覆盖、但你预期会出现的内容' },
  },
  required: ['chunkId', 'points', 'openQuestions', 'gaps'],
};

/**
 * The Reduce agent's receipt. Deliberately tiny: the archive itself goes to disk,
 * not through this return value.
 */
export const REDUCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chapterId: { type: 'string' },
    draftPath: { type: 'string', description: '你实际写入的草稿文件路径' },
    written: { type: 'boolean', description: '草稿是否确实写成了' },
    sectionCount: { type: 'integer', description: '你写了几个小节' },
    notes: { type: 'string', description: '没把握的地方；没有就留空' },
  },
  required: ['chapterId', 'draftPath', 'written'],
};

function readPrompt(pluginRoot, name) {
  return readFileSync(join(pluginRoot, 'prompts', name), 'utf8');
}

/**
 * The payload injected as `const __DR = {…}`.
 *
 * Exported so tests can drive the real script body against the real prompts and
 * schemas instead of a hand-made copy of them — the copy is what drifts.
 * @param {{ pluginRoot: string }} input
 */
export function buildPayload({ pluginRoot }) {
  const mapTemplate = readPrompt(pluginRoot, 'map.md');
  const modelTemplate = readPrompt(pluginRoot, 'model.md');
  const reduceTemplate = readPrompt(pluginRoot, 'reduce.md');
  // The whole archive guide goes to the Reduce agent, not just the template
  // block: it needs the hard rules to write something that will pass them.
  const archiveTemplate = readPrompt(pluginRoot, 'archive.md');

  // The revision is part of every Map and Model cache filename, so editing a
  // prompt invalidates the cached readings instead of silently reusing results
  // that were produced under different instructions.
  const promptRevision = `r${sha256Hex(mapTemplate + modelTemplate + reduceTemplate + archiveTemplate).slice(0, 8)}`;

  return {
    mapTemplate,
    modelTemplate,
    reduceTemplate,
    archiveTemplate,
    mapSchema: MAP_SCHEMA,
    modelSchema: MODEL_SCHEMA,
    reduceSchema: REDUCE_SCHEMA,
    promptRevision,
  };
}

/**
 * Build the workflow once, at plugin load.
 * @param {{ pluginRoot: string }} input
 * @returns {{ meta: object, script: string, promptRevision: string, payload: object }}
 */
export function buildWorkflow({ pluginRoot }) {
  const payload = buildPayload({ pluginRoot });
  const { promptRevision } = payload;

  const script = [
    '// dsh-deep-reading — generated workflow script. Do not edit by hand.',
    `// promptRevision: ${promptRevision}`,
    `const __DR = ${JSON.stringify(payload, null, 2)};`,
    '',
    runDeepReading.toString(),
    '',
    'return await runDeepReading(__DR, args, { agent, parallel, pipeline, phase, log });',
    '',
  ].join('\n');

  assertParses(script);
  return { meta: META, script, promptRevision, payload };
}

/**
 * A script that fails to parse only fails inside the workflow sandbox, at run
 * time, after the reader has already waited — so it is checked here instead.
 * Top-level `await`/`return` are only legal inside a function, hence the async
 * wrapper: this asserts the *syntax*, nothing more.
 */
function assertParses(script) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (async () => {\n${script}\n});`);
  } catch (error) {
    throw new Error(`workflow 脚本语法错误（这是插件自身的缺陷，不是调用错误）：${error.message}`);
  }
}

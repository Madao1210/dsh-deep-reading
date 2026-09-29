/**
 * MODEL 阶段：读完整章之后，形成这一章的 mental model。
 *
 * 这是 MAP 与 REDUCE 之间新增的一步，也是这个插件从 source-shaped 转向
 * model-shaped 的落点。
 *
 * 为什么它必须是一个**独立步骤**、而不是 Reduce 顺手做掉的事：
 *
 *   1. Reduce 手上只有分块的碎片（Map 的产出）。用碎片拼出来的「整章在讲什么」
 *      必然是碎片形状的——那正是要修掉的东西。
 *   2. 只有这一步真正把整章读一遍。它读原文，不读 Map 的结论，所以它不会被
 *      分块边界锚住。
 *   3. 它的产出是 Reduce 的**组织依据**：Reduce 不再是「把 point 聚合起来」，
 *      而是「把 point 挂到一个骨架上」。骨架先于挂载物存在。
 *
 * 它回答两个问题（都不许写成章节摘要）：
 *
 *   FORM MODEL   这一章真正在解决什么问题？一段话，短到能当三句话读。
 *   RECONSTRUCT  如果不能按原文顺序讲，我会怎么让一个没读过的人最快懂？
 *
 * 第二个问题**不是**要求重排。原书顺序在说明文里常常是论证的一部分，重排会
 * 破坏论证链。它要求的是：讲者必须知道自己为什么用这个顺序。
 *
 * 缓存：一次 MODEL 调用要读整章，是这一轮里最贵的一步，所以它的结果也落盘
 * （`<bookDir>/models/<章节>.<rev>.json`），重跑一波时不会重付。
 */

/**
 * The MODEL agent's structured result.
 *
 * `teachingOrder.reason` is required even when `shape === 'source'`: "原序就好"
 * with no reason is indistinguishable from never having asked the question.
 */
export const MODEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chapterId: { type: 'string', description: '你负责的章号，原样回填' },
    chapterModel: {
      type: 'string',
      description: '一段话：这一章真正在解决什么问题。不是章节摘要——摘要回答（讲了什么），这里要回答（在解决什么）',
    },
    teachingOrder: {
      type: 'object',
      additionalProperties: false,
      description: '如果要重讲这一章，讲解顺序是什么，为什么这个顺序最快让人懂',
      properties: {
        shape: { type: 'string', enum: ['source', 'reordered'], description: 'source=按原文顺序就最优（要说明为什么）；reordered=需要重排' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: '讲解顺序的步骤标题，按你实际要讲的先后排列',
        },
        reason: {
          type: 'string',
          description: '为什么这个顺序最快让人懂。shape=source 时说明为什么原序本身就在搭这个模型；shape=reordered 时说明原序哪里挡路',
        },
      },
      required: ['shape', 'steps', 'reason'],
    },
  },
  required: ['chapterId', 'chapterModel', 'teachingOrder'],
};

/** The `%%TOKEN%%`s `prompts/model.md` needs filled. Mirrored by the workflow coverage test. */
export const MODEL_PROMPT_TOKENS = [
  'TITLE',
  'CHAPTER_ID',
  'CHAPTER_TITLE',
  'START_LINE',
  'END_LINE',
  'SOURCE_PATH',
  'MODEL_OUT_PATH',
];

/**
 * Where a chapter's model is cached.
 *
 * The workflow script cannot import this (it runs as generated text with no
 * module system), so it repeats the rule inline. `test/drive-txt.mjs` reads the
 * path the script actually hands the subagent and requires the plugin to find
 * that same file, which is what keeps the two copies from drifting apart.
 */
export function modelOutPath(bookDir, chapterId, promptRevision) {
  const sep = bookDir.includes('\\') ? '\\' : '/';
  return `${bookDir}${sep}models${sep}${chapterId}.${promptRevision}.json`;
}

export function modelsDir(bookDir) {
  const sep = bookDir.includes('\\') ? '\\' : '/';
  return `${bookDir}${sep}models`;
}

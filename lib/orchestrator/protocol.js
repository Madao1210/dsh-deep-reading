/**
 * Assemble the system-prompt section from `prompts/system.md` plus the three
 * vocabularies.
 *
 * The vocabularies live in code because the rest of the plugin branches on them
 * (a mark's `kind`, a state's name), and a list written out twice — once as prose
 * the model reads, once as the values the plugin accepts — eventually diverges.
 * Rendering them into the prompt from the same table keeps the model's
 * vocabulary and the plugin's vocabulary the same thing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { UNDERSTANDING_STATES, MARK_VOCABULARY } from './state.js';
import { EXPLANATION_MOVES } from './action.js';
import { PERSPECTIVES } from './perspectives.js';

/**
 * @param {{ pluginRoot: string }} input
 * @returns {string}
 */
export function buildProtocolText({ pluginRoot }) {
  const body = readFileSync(join(pluginRoot, 'prompts', 'system.md'), 'utf8').trim();
  return [
    body,
    '',
    '## 词表（这些词是插件与对话共用的，不要另造同义词）',
    '',
    '理解状态（只决定讲多深、从哪讲；**不决定问什么——不要用提问去确认状态**）：',
    ...UNDERSTANDING_STATES.map(
      (state) => `- ${state.name} —— ${state.looksLike} 讲法：${state.explain} 忌：${state.avoid}`,
    ),
    '',
    '讲解手法（不是互动动作，都只靠讲者自己完成）：',
    ...EXPLANATION_MOVES.map(
      (move) => `- ${move.name} —— ${move.does} 用于：${move.when} 代价：${move.costs}`,
    ),
    '',
    '内心视角（想，不要写出来；用来让讲解更立体，不用来生成问题）：',
    ...PERSPECTIVES.map((perspective) => `- ${perspective.name}：${perspective.asks}`),
    '',
    `读者标记用词表：${MARK_VOCABULARY.join(' / ')}。`,
    '',
    '档案里 `（）` 内的文字只能是原文的逐字复制。插件会拿去和原文比对，对不上就拒收——'
      + '这不是风格建议，是一条会被执行的检查。',
    '',
    '你的输出里不出现问句（读者主动提问时除外）。这一条由插件在校验档案时执行：'
      + '正文里出现（你怎么看）（你觉得）（你能……吗）这类句式会被拒收。',
  ].join('\n');
}

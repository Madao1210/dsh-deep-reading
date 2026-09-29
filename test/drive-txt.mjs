/**
 * Closed-loop drive: 导入一份 txt → 生成合格的章节理解档案。
 *
 * The Map and Reduce "subagents" here are test doubles, and it is worth being
 * precise about what that does and does not prove.
 *
 * It DOES prove the whole contract holds: that the workflow script's path rules
 * and the tools' path rules agree, that the args a tool hands out are the args
 * the script needs, that the draft a Reduce step writes is the draft
 * `reading_archive` reads, that verification accepts a well-formed archive, and
 * that the reading profile ends up knowing where the reader is. Those are the
 * joints where a plugin like this actually breaks, and none of them need a model
 * to test.
 *
 * It does NOT prove that a model writes a good archive. Nothing cheap proves
 * that, and a test that claimed to would be lying.
 *
 * Run: node test/drive-txt.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { apply } from '../lib/index.js';
import { runDeepReading } from '../lib/pipeline/script-body.js';
import { buildPayload } from '../lib/pipeline/workflow.js';
import { toLines } from '../lib/util/text.js';
import { createFakeContext, patchConfig, PLUGIN_ROOT } from './harness.mjs';

const log = (line) => console.log(line);
const checks = [];
function check(label, ok, detail = '') {
  checks.push({ label, ok });
  log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

const dataRoot = mkdtempSync(join(tmpdir(), 'dr-drive-'));
const { ctx, record } = createFakeContext();
apply(ctx, { ...patchConfig().config, dataRoot });
const tools = Object.fromEntries(record.tools.map((tool) => [tool.name, tool]));

// ── 1. 导入 ──────────────────────────────────────────────────────────────────
const sourceFile = join(PLUGIN_ROOT, 'test', 'fixtures', 'sample-book.txt');
const open = await tools.reading_open.execute({ path: sourceFile });
log(`导入：${open.bookId}   ${open.statsLine}`);
log(open.chapters.map((line) => `  ${line}`).join('\n'));
check('导入成功且切出 3 章', open.ok === true && open.chapters.length === 3);

const args = JSON.parse(open.workflowArgsJson);
check('workflow args 带着 sourcePath / bookDir / chapters / cachedChunkIds',
  Boolean(args.sourcePath) && Boolean(args.bookDir) && args.chapters.length === 3 && Array.isArray(args.cachedChunkIds));

// ── 2. 跑 workflow（Map 并行 + Reduce 合成），用测试替身当子代理 ────────────
const payload = buildPayload({ pluginRoot: PLUGIN_ROOT });
let mapCalls = 0;
let modelCalls = 0;
let reduceCalls = 0;
let reduceWantsCache = false;
let reduceWantsCachedModel = false;

const hooks = {
  phase: (title) => log(`\n[phase] ${title}`),
  log: (message) => log(`        ${message}`),
  parallel: async (thunks) => Promise.all(thunks.map((run) => run().then((value) => value, () => null))),
  pipeline: async (items, ...stages) => Promise.all(items.map(async (item, index) => {
    let previous;
    try {
      for (const stage of stages) previous = await stage(previous, item, index);
    } catch {
      return null;
    }
    return previous;
  })),
  agent: fakeAgent,
};

async function fakeAgent(prompt) {
  if (prompt.includes('你只负责这一个块')) return mapAgent(prompt);
  if (prompt.includes('在讲之前，先把这一章想明白')) return modelAgent(prompt);
  if (prompt.includes('把本章的精读结果合成')) return reduceAgent(prompt);
  throw new Error('测试替身收到无法识别的提示词');
}

/**
 * The Model double. It reads the whole chapter — that is the one thing that
 * distinguishes this stage from Map, and a double that skipped the read would
 * hide a wiring bug where the stage is handed the wrong range.
 */
async function modelAgent(prompt) {
  modelCalls += 1;
  const chapterId = /章节：(\S+) /.exec(prompt)[1];
  const [, startLine, endLine] = /整章范围：原文第 (\d+) – (\d+) 行/.exec(prompt);
  const sourcePath = /原文文件：`([^`]+)`/.exec(prompt)[1];
  const outPath = /```\s*\n([^\n]*\.json)\s*\n```/.exec(prompt)[1];

  const lines = toLines(readFileSync(sourcePath, 'utf8'));
  const readChars = lines.slice(Number(startLine) - 1, Number(endLine)).join('').length;
  if (readChars < 100) throw new Error(`Model 替身读到的整章只有 ${readChars} 字，行范围可能传错了`);

  const receipt = {
    chapterId,
    chapterModel: `${chapterId} 在解决一个问题：重复读取的代价能不能不靠少读来降。它的两个环节是稳定寻址与逐字可核，前者让引用有坐标，后者让坐标可检验。（测试替身）`,
    teachingOrder: {
      shape: 'source',
      steps: ['成本的来源', '可寻址是前提', '逐字校验是收口'],
      reason: '原序先摆成本再给对策，本身就沿着上面这个模型一步步搭，重排没有收益。（测试替身）',
    },
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(receipt, null, 2), 'utf8');
  return receipt;
}

async function mapAgent(prompt) {
  mapCalls += 1;
  const chunkId = /你这一块：\*\*([^*]+)\*\*/.exec(prompt)[1];
  const sourcePath = /原文文件：`([^`]+)`/.exec(prompt)[1];
  const [, startLine, endLine] = /原文第 (\d+) – (\d+) 行/.exec(prompt);
  const outPath = /```\s*\n([^\n]*\.json)\s*\n```/.exec(prompt)[1];

  const lines = toLines(readFileSync(sourcePath, 'utf8'));
  const quotes = [];
  for (let line = Number(startLine); line <= Number(endLine) && quotes.length < 3; line += 1) {
    // A whole source line is verbatim by construction — which is exactly the
    // property the archive verifier checks, so the double cannot cheat past it.
    if (lines[line - 1] !== undefined && lines[line - 1].trim().length >= 12) quotes.push(lines[line - 1].trim());
  }
  // One fully-filled point, then ones that honestly report what could not be
  // derived — the shape the schema requires, including the `missing` channel.
  const points = quotes.map((quote, index) => ({
    claim: `${chunkId} 的第 ${index + 1} 条主张（测试替身）`,
    evidence: `${chunkId} 的证据 ${index + 1}（测试替身）`,
    quote,
    mechanism: index === 0 ? '机制：结论依赖每一步都重发完整历史，所以命中缓存时结论要重算。（测试替身）' : '',
    boundary: index === 0 ? '边界：只在读者真的去核对引用时成立。（测试替身）' : '',
    missing: index === 0 ? [] : ['mechanism', 'boundary'],
  }));
  const receipt = {
    chunkId,
    points,
    openQuestions: [`${chunkId}：作者提出但没回答的问题（测试替身）`],
    gaps: [],
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(receipt, null, 2), 'utf8');
  return receipt;
}

async function reduceAgent(prompt) {
  reduceCalls += 1;
  const chapterId = /章节：(\S+) /.exec(prompt)[1];
  const chapterTitle = /章节：\S+ (.+)/.exec(prompt)[1].trim();
  const draftPath = /```\s*\n([^\n]*\.md)\s*\n```/.exec(prompt)[1];

  const quotes = [];
  for (const match of prompt.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
    const parsed = JSON.parse(match[1]);
    for (const point of parsed.points ?? []) quotes.push(point.quote);
  }
  if (quotes.length < 2) {
    // Cached-run path: the points are on disk, and a real Reduce agent would
    // read them. The double reads them too rather than inventing quotes.
    for (const match of prompt.matchAll(/`([^`]*\.json)`/g)) {
      if (existsSync(match[1]) === false) continue;
      reduceWantsCache = true;
      const parsed = JSON.parse(readFileSync(match[1], 'utf8'));
      for (const point of parsed.points ?? []) quotes.push(point.quote);
    }
  }
  if (quotes.length < 2) throw new Error(`Reduce 替身没拿到足够引文（${quotes.length}）`);

  // The mental model arrives either inline or — on a cached run — as a path the
  // Reduce agent is told to read. A real agent reads the file; so does the double.
  let chapterModel = '';
  let orderReason = '';
  const cachedModelPath = /命中缓存：用 read 读 `([^`]+)`/.exec(prompt);
  if (cachedModelPath !== null && existsSync(cachedModelPath[1])) {
    reduceWantsCachedModel = true;
    const cached = JSON.parse(readFileSync(cachedModelPath[1], 'utf8'));
    chapterModel = cached.chapterModel;
    orderReason = cached.teachingOrder.reason;
  } else {
    for (const match of prompt.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
      let parsed;
      try {
        parsed = JSON.parse(match[1]);
      } catch {
        continue; // A point block that is not the model block.
      }
      if (typeof parsed.chapterModel === 'string') {
        chapterModel = parsed.chapterModel;
        orderReason = parsed.teachingOrder?.reason ?? '';
      }
    }
  }
  if (chapterModel === '') throw new Error('Reduce 替身没拿到 mental model：说明管线里 Model 那一步没有接上');

  // Note the discipline in this markdown: bold appears ONLY around verbatim
  // source text, while names of sections and concepts use parentheses. A double
  // that bolded a concept would be rejected — bold must be verbatim in the
  // source — which is the correct behaviour and was in fact how this template
  // was written the first time.
  const markdown = [
    `# ${chapterId} ${chapterTitle}`,
    '',
    '> 本节在全书中的位置：',
    '> 承接前面一节对成本的观察，开启对（引用是否可核对）的讨论。（测试替身生成）',
    '',
    '## 这一章真正在解决什么',
    '',
    chapterModel,
    '',
    '### 讲解顺序',
    '',
    `按原文顺序讲。${orderReason}`,
    '',
    '## 一、原文线索',
    '',
    '### 成本与可寻址',
    `- 作者主张：把重复读取的代价当成设计起点 ${wrap(quotes[0])}`,
    `- 关键证据／例子：前缀缓存会改变这笔算术 ${wrap(quotes[1] ?? quotes[0])}`,
    `- 作者洞见：引用漂移比没有引用更糟 ${wrap(quotes[2] ?? quotes[0])}`,
    '',
    '### AI 视角',
    '机制本身依赖每一步都重发完整历史，所以缓存一旦命中，这一节的成本结论要重算。（测试替身生成）',
    '',
    '## 二、共读推演（AI 推断，非作者原意）',
    '',
    '### 推演 1：可寻址是省钱之外更根本的收益',
    '- 依据：第一节（成本与可寻址）的三条线索',
    '- 理由：稳定的名字让引用可回源，而回源是判断可信度的前提。',
    '- 限制：只在引用被真正核对时成立；如果没人核对，名字稳定与否无关紧要。',
    '- 状态：可接受',
    '',
    '## 三、我的看法（读者）',
    '',
    '### 我觉得最自洽的地方',
    '（待读者填写）',
    '',
    '### 我觉得滑太快／存疑的地方',
    '（待读者填写）',
    '',
    '### 我想继续追问的问题',
    '（待读者填写）',
    '',
    '## 四、本节留下的口子',
    '',
    // A fragment rather than a whole line: quoting part of a sentence is what a
    // real Reduce step does, and it is a strictly harder case for the verifier.
    `- 前缀缓存可以改变结论的样子：${wrap('算术会完全变样')}`,
    '- 可寻址的粒度（段？节？章？）作者没有定义。',
    '',
    '### 在全书中的位置',
    '本章把成本问题转成一个寻址问题，为后面的逐字引用校验铺路。（测试替身生成）',
    '',
  ].join('\n');

  mkdirSync(dirname(draftPath), { recursive: true });
  writeFileSync(draftPath, markdown, 'utf8');
  return { chapterId, draftPath, written: true, sectionCount: 4, notes: '' };
}

function wrap(quote) {
  return `**${quote}**`;
}

const result = await runDeepReading(payload, args, hooks);
log('');
check('workflow 返回 ok', result.ok === true);
check('每章都产出了草稿', result.chapters.length === 3 && result.chapters.every((entry) => entry.ok === true),
  result.chapters.map((entry) => `${entry.chapterId}:${entry.ok}`).join(' '));
check('Map 次数 = 块数', mapCalls === args.chapters.reduce((sum, chapter) => sum + chapter.chunks.length, 0), `${mapCalls} 次`);
check('Model 次数 = 章数（每章读一次整章）', modelCalls === 3, `${modelCalls} 次`);
check('Reduce 次数 = 章数', reduceCalls === 3, `${reduceCalls} 次`);
check('草稿落在 bookDir/drafts 下（脚本与工具的路径规则一致）',
  result.chapters.every((entry) => entry.draftPath.includes(join(args.bookDir, 'drafts'))));
check('没有章节因为 model 失败而被标记', result.chapters.every((entry) => entry.modelFailed === false));

// ── 3. 缓存：存档之前，插件应当已经能报告两类缓存 ────────────────────────────
//
// The args come from the plugin (`reading_status`), NOT assembled here. An
// earlier version of this test built `cachedChunkIds` by hand from the files the
// double had written, so when the Map schema moved from `findings` to `points`
// and the plugin's scanner kept checking the old field, the cache silently
// stopped hitting and this test still passed. Asking the plugin is the only way
// the assertion can measure the plugin.
const afterRun = await tools.reading_status.execute({ bookId: open.bookId });
check('reading_status 报告了精读缓存', (afterRun.cachedChunks ?? []).length === 3, (afterRun.cachedChunks ?? []).join(' '));
check('reading_status 报告了 mental model 缓存', (afterRun.cachedModels ?? []).length === 3, (afterRun.cachedModels ?? []).join(' '));

const rerunArgs = JSON.parse(afterRun.workflowArgsJson || '{}');
check('存档前 reading_status 给出可用的 workflow args', rerunArgs.bookId === open.bookId && rerunArgs.chapters.length === 3);

const beforeMap = mapCalls;
const beforeModel = modelCalls;
reduceWantsCache = false;
reduceWantsCachedModel = false;
const rerun = await runDeepReading(payload, rerunArgs, hooks);
check('重跑时 Map 不再被调用（结果来自缓存）', mapCalls === beforeMap, `map 调用 ${mapCalls - beforeMap} 次`);
check('重跑时 Model 不再被调用（整章不再重读）', modelCalls === beforeModel, `model 调用 ${modelCalls - beforeModel} 次`);
check('重跑时 Reduce 从磁盘读取缓存结果', reduceWantsCache === true);
check('重跑时 Reduce 从磁盘读取缓存的 mental model', reduceWantsCachedModel === true);
check('重跑同样产出 3 章草稿', rerun.chapters.length === 3 && rerun.chapters.every((entry) => entry.ok === true));

// ── 4. 逐章校验并落盘 ────────────────────────────────────────────────────────
for (const chapter of result.chapters) {
  const archived = await tools.reading_archive.execute({ bookId: open.bookId, chapterId: chapter.chapterId });
  if (archived.ok !== true) {
    log(`  归档 ${chapter.chapterId} 被拒：`);
    log((archived.violations ?? []).map((line) => `    ${line}`).join('\n'));
    log(`  提示：${(archived.warnings ?? []).join(' / ')}`);
  }
  check(`${chapter.chapterId} 落盘通过`, archived.ok === true, archived.state ?? archived.code);
}

// ── 5. 落盘的结果确实在磁盘上、且是校验过的样子 ──────────────────────────────
const status = await tools.reading_status.execute({ bookId: open.bookId });
check('覆盖度 3/3 章', status.coverageLine?.startsWith('3/3'), status.coverageLine);
check('每章档案都带骨架、第五节与 AI 视角', status.chapters.length === 3
  && ['ch01', 'ch02', 'ch03'].every((id) => {
    const text = readFileSync(join(args.bookDir, 'archives', `${id}.md`), 'utf8');
    return text.includes('## 这一章真正在解决什么')
      && text.includes('### 讲解顺序')
      && text.includes('### AI 视角')
      && text.includes('### 在全书中的位置')
      && text.includes('## 五、理解状态与记忆')
      && text.includes('revision：1');
  }));
check('投影知道读到哪一章', record.contexts[0].text().includes('已建档 3 章'), record.contexts[0].text().split('\n')[1]);

// ── 6. 幂等：再开一次同一份文件，不产生第二本书 ──────────────────────────────
const reopened = await tools.reading_open.execute({ path: sourceFile });
check('重复导入是幂等的（同一 bookId，标记为已打开过）', reopened.bookId === open.bookId && reopened.reopened === true);
check('已全部建档时不再给出 workflow args', reopened.workflowArgsJson === '');

rmSync(dataRoot, { recursive: true, force: true });

const failed = checks.filter((entry) => entry.ok === false);
log('');
log(failed.length === 0
  ? `最小闭环跑通：${checks.length} 项全过。`
  : `最小闭环失败：${failed.length}/${checks.length} 项。`);
process.exit(failed.length === 0 ? 0 : 1);

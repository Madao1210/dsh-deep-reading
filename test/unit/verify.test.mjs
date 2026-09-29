/**
 * Archive verification.
 *
 * The verifier is the plugin's only claim to authority, so these tests are
 * written as pairs: for every rule, one archive that passes and one that is
 * caught. A rule with no failing case is a rule nobody has ever seen work.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSourceIndex, extractQuotes, locateQuote, splitSections, unescapeBold, verifyArchive } from '../../lib/archive/verify.js';

const SOURCE = [
  '读一本书最贵的不是读，是重复地读。',
  '',
  '限制条件要说清楚：如果前缀缓存能命中，这笔算术会变样。',
  '',
  '引用必须是原文里真实存在的一段连续文字。',
];

const INDEX = buildSourceIndex(SOURCE);
const CONFIG = { verifyQuotes: true, minQuoteChars: 4 };

/** A well-formed archive; individual tests break exactly one thing in it. */
function archive(overrides = {}) {
  const parts = {
    title: '# ch01 第一章',
    position: '> 本节在全书中的位置：\n> 起点。',
    model: [
      '## 这一章真正在解决什么',
      '',
      '这一章在解决一个问题：重复读取的代价能不能不靠少读来降。它的两个环节是稳定寻址与逐字可核，',
      '前者让引用有坐标，后者让坐标可以被检验。',
    ].join('\n'),
    order: [
      '### 讲解顺序',
      '',
      '按原文顺序讲。原序本身就先把成本摆出来、再给对策，正好是搭出上面这个模型的顺序，不需要重排。',
    ].join('\n'),
    one: [
      '## 一、原文线索',
      '### 成本',
      '- 作者主张：重复读才是主要成本 **读一本书最贵的不是读，是重复地读。**',
      '',
      '### AI 视角',
      '这条成本论证依赖于每一步都重发完整历史。前缀缓存一旦命中，结论就要重算。',
    ].join('\n'),
    two: [
      '## 二、共读推演（AI 推断，非作者原意）',
      '### 推演 1：可寻址比省钱更根本',
      '- 依据：第一节的成本条目',
      '- 理由：稳定的名字让引用可回源。',
      '- 限制：没人核对时不成立。',
      '- 状态：可接受',
    ].join('\n'),
    three: [
      '## 三、我的看法（读者）',
      '### 我觉得最自洽的地方',
      '（待读者填写）',
    ].join('\n'),
    four: [
      '## 四、本节留下的口子',
      '- 作者没定义可寻址的粒度。',
      '',
      '### 在全书中的位置',
      '本章把成本问题转成寻址问题，为后面的引用校验铺路。',
    ].join('\n'),
  };
  return [
    overrides.title ?? parts.title, '',
    overrides.position ?? parts.position, '',
    overrides.model ?? parts.model, '',
    overrides.order ?? parts.order, '',
    overrides.one ?? parts.one, '',
    overrides.two ?? parts.two, '',
    overrides.three ?? parts.three, '',
    overrides.four ?? parts.four, '',
  ].join('\n');
}

const verify = (markdown, extra = {}) => verifyArchive({
  markdown,
  sourceIndex: INDEX,
  config: CONFIG,
  readerInput: false,
  ...extra,
});

const codes = (result) => result.violations.map((violation) => violation.code);

test('合格的档案零违规', () => {
  const result = verify(archive());
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
  assert.equal(result.quoteLocators.length, 1);
});

test('引文在原文里找不到 → V_QUOTE_NOT_FOUND', () => {
  const result = verify(archive({
    one: '## 一、原文线索\n### 成本\n- 作者主张：成本很高 **这句话原文里根本没有出现过**',
  }));
  assert.ok(codes(result).includes('V_QUOTE_NOT_FOUND'));
  // The fix text must not suggest editing the quote to fit the claim.
  const violation = result.violations.find((v) => v.code === 'V_QUOTE_NOT_FOUND');
  assert.match(violation.fix, /不要改写引文/);
});

test('引文去掉空白与标点差异后仍算命中', () => {
  const result = verify(archive({
    one: [
      '## 一、原文线索',
      '### 成本',
      '- 作者主张：成本很高 **读一本书最贵的不是读， 是重复地读**',
      '',
      '### AI 视角',
      '这一节我没有额外的补充。',
    ].join('\n'),
  }));
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
});

test('第一节有判断却没有引文 → V_SECTION_ONE_NO_QUOTE', () => {
  const result = verify(archive({
    one: '## 一、原文线索\n### 成本\n- 作者主张：重复读是主要成本',
  }));
  assert.ok(codes(result).includes('V_SECTION_ONE_NO_QUOTE'));
});

test('第二节没标「推断」 → V_INFERENCE_UNMARKED', () => {
  const result = verify(archive({
    two: [
      '## 二、共读推演',
      '### 推演 1：x',
      '- 依据：a', '- 理由：b', '- 限制：c', '- 状态：可接受',
    ].join('\n'),
  }));
  assert.ok(codes(result).includes('V_INFERENCE_UNMARKED'));
});

test('推演缺 依据/理由/限制/状态 → V_INFERENCE_FIELD', () => {
  const result = verify(archive({
    two: [
      '## 二、共读推演（AI 推断，非作者原意）',
      '### 推演 1：x',
      '- 依据：a',
    ].join('\n'),
  }));
  assert.equal(codes(result).filter((code) => code === 'V_INFERENCE_FIELD').length, 3);
});

test('推演状态不在词表内 → V_INFERENCE_STATE', () => {
  const result = verify(archive({
    two: [
      '## 二、共读推演（AI 推断，非作者原意）',
      '### 推演 1：x',
      '- 依据：a', '- 理由：b', '- 限制：c', '- 状态：大概是吧',
    ].join('\n'),
  }));
  assert.ok(codes(result).includes('V_INFERENCE_STATE'));
});

test('替读者写了话 → V_READER_FABRICATED；声明 readerInput 后放行', () => {
  const filled = [
    '## 三、我的看法（读者）',
    '### 我觉得最自洽的地方',
    '我觉得限定条件那一段最站得住。',
  ].join('\n');
  assert.ok(codes(verify(archive({ three: filled }))).includes('V_READER_FABRICATED'));
  const allowed = verify(archive({ three: filled }), { readerInput: true });
  assert.deepEqual(allowed.violations, []);
});

test('缺节与节序错误都会被指出', () => {
  const result = verify(archive({ four: '' }));
  assert.ok(codes(result).includes('V_SECTION_MISSING'));

  const reordered = [
    '# ch01 第一章', '',
    '> 位置', '',
    '## 二、共读推演（AI 推断，非作者原意）',
    '### 推演 1：x', '- 依据：a', '- 理由：b', '- 限制：c', '- 状态：可接受', '',
    '## 一、原文线索', '### 成本', '- 作者主张：x **读一本书最贵的不是读，是重复地读。**', '',
    '## 三、我的看法（读者）', '（待读者填写）', '',
    '## 四、本节留下的口子', '- x', '',
  ].join('\n');
  assert.ok(codes(verify(reordered)).includes('V_SECTION_ORDER'));
});

test('奇数个 **（未闭合）→ V_QUOTE_UNCLOSED', () => {
  const result = verify(archive({
    one: '## 一、原文线索\n### 成本\n- 作者主张：成本很高 **读一本书最贵的不是读，是重复地读。',
  }));
  assert.ok(codes(result).includes('V_QUOTE_UNCLOSED'));
});

test('粗体跨行 → V_QUOTE_CROSSLINE', () => {
  // Two lines each carrying one `**`: the document total is even, so the only
  // reading is that they close each other — and no single-line check could
  // verify a quotation that spans a line break.
  const result = verify(archive({
    one: [
      '## 一、原文线索',
      '### 成本',
      '- 作者主张：成本很高 **读一本书最贵的不是读，',
      '是重复地读。**',
      '',
      '### AI 视角',
      '这一节我没有额外的补充。',
    ].join('\n'),
  }));
  const found = codes(result);
  assert.ok(found.includes('V_QUOTE_CROSSLINE'), found.join(', '));
  assert.ok(found.includes('V_QUOTE_UNCLOSED') === false, '总数是偶数，不该同时报未闭合');
});

test('小标题里出现粗体 → V_QUOTE_IN_HEADING', () => {
  const result = verify(archive({
    one: [
      '## 一、原文线索',
      '### 成本 **这是标题里的粗体**',
      '- 作者主张：重复读才是主要成本 **读一本书最贵的不是读，是重复地读。**',
      '',
      '### AI 视角',
      '这一节我没有额外的补充。',
    ].join('\n'),
  }));
  assert.ok(codes(result).includes('V_QUOTE_IN_HEADING'));
});

test('三类粗体错误同现：奇数 **、小标题内粗体、跨行粗体 → 三类都被拒', () => {
  const result = verify(archive({
    one: [
      '## 一、原文线索',
      '### 成本 **这个标题里不该有粗体**',            // 本行偶数，但是小标题 → V_QUOTE_IN_HEADING
      '- 作者主张：重复读才是主要成本 **读一本书最贵的不是读，', // 跨行开
      '是重复地读。**',                                // 跨行闭 → V_QUOTE_CROSSLINE
      '- 另一条：**这段引文没有闭合',                    // 全文因此变成奇数 → V_QUOTE_UNCLOSED
      '',
      '### AI 视角',
      '这一节我没有额外的补充。',
    ].join('\n'),
  }));
  const found = codes(result);
  assert.ok(found.includes('V_QUOTE_IN_HEADING'), found.join(', '));
  assert.ok(found.includes('V_QUOTE_CROSSLINE'), found.join(', '));
  assert.ok(found.includes('V_QUOTE_UNCLOSED'), found.join(', '));
});

test('残留的旧引号标记 → V_QUOTE_GLYPH_RESIDUE', () => {
  // The words inside the old marker are never verified, so leaving it in lets an
  // unverifiable sentence masquerade as a quotation — which is the one failure
  // this plugin exists to prevent. Hence a violation, not a warning.
  const legacy = '\u300c这句话原文里根本没有出现过\u300d';
  const result = verify(archive({
    one: `## 一、原文线索\n### 成本\n- 作者主张：成本很高 ${legacy}`,
  }));
  assert.ok(codes(result).includes('V_QUOTE_GLYPH_RESIDUE'), codes(result).join(', '));
});

test('引文内部本身含旧引号（嵌套对话）不算残留', () => {
  // A novel's dialogue may quote the old glyphs; stripping bold first means the
  // quotation is not punished for what it quotes. Normalization drops the glyphs
  // from both sides, so the comparison still lands.
  const result = verify(archive({
    one: [
      '## 一、原文线索',
      '### 成本',
      '- 作者主张：重复读才是主要成本 **读一本书最贵的不是读，是重复地读。\u300c\u300d**',
      '',
      '### AI 视角',
      '这一节我没有额外的补充。',
    ].join('\n'),
  }));
  assert.ok(codes(result).includes('V_QUOTE_GLYPH_RESIDUE') === false, JSON.stringify(result.violations, null, 2));
  assert.ok(codes(result).includes('V_QUOTE_NOT_FOUND') === false, JSON.stringify(result.violations, null, 2));
});

test('过短的粗体按术语给提示而不是违规（术语不该用粗体）', () => {
  const result = verify(archive({
    four: [
      '## 四、本节留下的口子',
      '- **可寻址** 的粒度没定义。',
      '',
      '### 在全书中的位置',
      '本章把成本问题转成寻址问题。',
    ].join('\n'),
  }));
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
  assert.match(result.warnings.join('\n'), /按术语处理/);
});

test('粗体逐字命中但太短 → 提示更像强调', () => {
  const result = verify(archive({
    four: [
      '## 四、本节留下的口子',
      '- 作者用的是 **重复** 这个词。',
      '',
      '### 在全书中的位置',
      '本章把成本问题转成寻址问题。',
    ].join('\n'),
  }));
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
  assert.match(result.warnings.join('\n'), /更像是强调/);
});

test('引文里的 `*` 转义后仍能抽取并还原', () => {
  const quotes = extractQuotes('x **a\\*b** y');
  assert.deepEqual(quotes.map((q) => q.span), ['a*b']);
  assert.equal(unescapeBold('a\\*b'), 'a*b');
  assert.equal(unescapeBold('a\\nb'), 'a\\nb', '只还原 \\*，别的转义不动');
});

test('找到的引文会给出原文行号，找不到的返回 null', () => {
  assert.equal(locateQuote(INDEX, '读一本书最贵的不是读,是重复地读。'), 1);
  assert.equal(locateQuote(INDEX, '引用必须是原文里真实存在的一段连续文字'), 5);
  // Fragments are located too — a real Reduce step quotes part of a sentence.
  assert.equal(locateQuote(INDEX, '这笔算术会变样'), 3);
  assert.equal(locateQuote(INDEX, '这句话不存在'), null);
});

test('extractQuotes 逐行抽取并认出未闭合的行', () => {
  const quotes = extractQuotes('a **一** b **二**\nc **三\n');
  assert.deepEqual(quotes.filter((q) => q.span !== null).map((q) => q.span), ['一', '二']);
  assert.equal(quotes.filter((q) => q.oddLine === true).length, 1);
});

test('splitSections 认得出被改写的节标题仍按序号归类', () => {
  const { sections } = splitSections('# t\n\n## 一、随便什么标签\n\n## 三、我的看法（读者）\n');
  assert.ok(sections.has('一'));
  assert.ok(sections.has('三'));
  assert.equal(sections.has('二'), false);
});

// ── 深度讲解这条定位在档案里的三个落点 ───────────────────────────────────────

test('第一节没有 AI 视角 → V_AI_VIEW_MISSING', () => {
  const result = verify(archive({
    one: '## 一、原文线索\n### 成本\n- 作者主张：重复读才是主要成本 **读一本书最贵的不是读，是重复地读。**',
  }));
  assert.ok(codes(result).includes('V_AI_VIEW_MISSING'));
});

test('小标题多于 AI 视角 → V_AI_VIEW_INCOMPLETE', () => {
  const result = verify(archive({
    one: [
      '## 一、原文线索',
      '### 成本',
      '- 作者主张：重复读才是主要成本 **读一本书最贵的不是读，是重复地读。**',
      '',
      '### AI 视角',
      '结论依赖前缀未命中。',
      '',
      '### 可寻址',
      '- 作者主张：文本要有稳定的名字 **引用必须是原文里真实存在的一段连续文字。**',
    ].join('\n'),
  }));
  assert.ok(codes(result).includes('V_AI_VIEW_INCOMPLETE'));
  assert.ok(codes(result).includes('V_AI_VIEW_MISSING') === false, '已经有一段 AI 视角，不该同时报缺失');
});

test('推不出增量时写「这一节我没有额外的补充」是被允许的', () => {
  const result = verify(archive({
    one: [
      '## 一、原文线索',
      '### 成本',
      '- 作者主张：重复读才是主要成本 **读一本书最贵的不是读，是重复地读。**',
      '',
      '### AI 视角',
      '这一节我没有额外的补充。',
    ].join('\n'),
  }));
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
});

test('章末缺「在全书中的位置」 → V_BOOK_POSITION_MISSING', () => {
  const result = verify(archive({ four: '## 四、本节留下的口子\n- 作者没定义可寻址的粒度。' }));
  assert.ok(codes(result).includes('V_BOOK_POSITION_MISSING'));
});

test('正文残留提问句式 → V_QUESTION_RESIDUE（引文里的问句不算）', () => {
  const asked = verify(archive({
    four: [
      '## 四、本节留下的口子',
      '- 成本为什么这样算，你可以自己想想？',
      '',
      '### 在全书中的位置',
      '本章把成本问题转成寻址问题。',
    ].join('\n'),
  }));
  assert.ok(codes(asked).includes('V_QUESTION_RESIDUE'));

  // A rhetorical question inside a quotation is the author's voice and content,
  // not the plugin asking the reader anything.
  const quoted = verify(archive({
    one: [
      '## 一、原文线索',
      '### 成本',
      '- 作者主张：他先反问读者为什么重复读 **读一本书最贵的不是读，是重复地读？**',
      '',
      '### AI 视角',
      '这一节我没有额外的补充。',
    ].join('\n'),
  }));
  assert.ok(codes(quoted).includes('V_QUESTION_RESIDUE') === false);
});

test('段落超过 4 句只给提示，不拒收', () => {
  const result = verify(archive({
    four: [
      '## 四、本节留下的口子',
      '- 一。二。三。四。五。',
      '',
      '### 在全书中的位置',
      '本章把成本问题转成寻址问题。',
    ].join('\n'),
  }));
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
  assert.match(result.warnings.join('\n'), /超过 4 句/);
});

// ── 骨架：这一组规则是 source-shaped → model-shaped 的执行点 ─────────────────

test('缺「这一章真正在解决什么」 → V_CHAPTER_MODEL_MISSING', () => {
  const result = verify(archive({ model: '' }));
  assert.ok(codes(result).includes('V_CHAPTER_MODEL_MISSING'));
});

test('mental model 只有几个字 → V_CHAPTER_MODEL_THIN', () => {
  const result = verify(archive({ model: '## 这一章真正在解决什么\n\n成本问题。' }));
  assert.ok(codes(result).includes('V_CHAPTER_MODEL_THIN'));
});

test('缺「讲解顺序」 → V_TEACHING_ORDER_MISSING', () => {
  const result = verify(archive({ order: '' }));
  assert.ok(codes(result).includes('V_TEACHING_ORDER_MISSING'));
});

test('讲解顺序没说原序还是重排 → V_TEACHING_ORDER_UNCLEAR', () => {
  const result = verify(archive({
    order: '### 讲解顺序\n\n先讲成本，再讲寻址，最后讲引用校验，这样最顺。',
  }));
  assert.ok(codes(result).includes('V_TEACHING_ORDER_UNCLEAR'));
});

test('讲解顺序只有表态没有理由 → V_TEACHING_ORDER_THIN', () => {
  const result = verify(archive({ order: '### 讲解顺序\n\n重排。' }));
  assert.ok(codes(result).includes('V_TEACHING_ORDER_THIN'));
});

test('重排并说明理由是被接受的', () => {
  const result = verify(archive({
    order: [
      '### 讲解顺序',
      '',
      '这一章要重排。原序先讲前缀缓存的技术细节，而没读过的人还没有（为什么要在意成本）这个前提，',
      '所以先讲成本来源，再回头讲缓存，最后讲它如何改变结论。',
    ].join('\n'),
  }));
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
});

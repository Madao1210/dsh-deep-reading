/**
 * Archive verification — the plugin's one non-negotiable job.
 *
 * The model may write anything it likes as long as it can be checked. What can
 * be checked deterministically is exactly the ways this kind of plugin lies to a
 * reader, plus the ways it fails to be a deep explainer at all:
 *
 *   1. It puts words in the author's mouth.       → every **…** must be verbatim
 *   2. It presents its own inference as the text. → 二 must be labelled 推断
 *   3. It speaks for the reader.                  → 三 must be a placeholder
 *   4. It stops at "the author says X".           → every 小标题 needs an AI 视角
 *   5. It forgets the chapter has a job to do.    → 章末 needs 在全书中的位置
 *   6. It asks the reader instead of telling.     → no question residue
 *
 * Nothing here judges whether an interpretation is *good*. That is the reader's
 * call, and a plugin that scored interpretations would be the summary machine
 * this plugin exists not to be. Rules 4–6 are structural for the same reason:
 * they check that the four-step explanation and the closing position note are
 * present at all, not that they are insightful. Whether a 「机制」 is real is
 * exactly the judgement that stays with the reader.
 *
 * The quotation marker is `**…**`, not 「」: bold reads as "look at this", which
 * is what a quotation is for, and it does not tire the eye the way nested corner
 * brackets do. The cost — Markdown also uses bold for emphasis — is paid by
 * prohibition: bold is for quotations only, enforced by rule 1 itself.
 */
import {
  READER_PLACEHOLDER,
  REQUIRED_SECTIONS,
  INFERENCE_STATES,
  INFERENCE_MARKER,
  AI_VIEW_HEADING,
  BOOK_POSITION_HEADING,
  CHAPTER_MODEL_HEADING,
  TEACHING_ORDER_HEADING,
  ORDER_SHAPE_WORDS,
  NO_EXTRA_NOTE,
} from './template.js';
import { normalizeForCompare } from '../util/text.js';

/**
 * A verbatim quotation is wrapped in `**…**`.
 *
 * Bold rather than 「」 for two reasons: 「」 is visually heavy when it recurs, and
 * bold reads as "look at this" — which is what a quotation is for. The price is
 * that Markdown also uses bold for emphasis, and that ambiguity is resolved by
 * prohibition rather than by syntax: **bold is for quotations only.** The
 * verifier enforces it indirectly and completely — every bold span must be
 * verbatim in the source, so bold used for emphasis fails the same check a
 * fabricated quotation fails.
 *
 * The content pattern permits `\*`, so a quotation that itself contains an
 * asterisk survives the round trip; `unescapeBold` turns it back before
 * comparison, because what must match the book is what the book actually says.
 */
const BOLD_RE = /\*\*((?:[^*\\]|\\.)+?)\*\*/g;

/** The marker, spelled once so no message can drift from the regex. */
const BOLD = '**';

/** `\*` → `*`. Only that escape: unescaping everything would rewrite content. */
export function unescapeBold(text) {
  return text.replace(/\\\*/g, '*');
}

const MAX_BULLET_QUOTE_CHARS = 400;
const MAX_SENTENCES_PER_PARAGRAPH = 4;

/**
 * Second-person question forms.
 *
 * Deliberately narrow in one direction and broad in another. Narrow: any `？`
 * inside a quotation is the author's voice, so quoted spans are stripped before
 * this runs. Broad: the second-person check does not require a question mark,
 * because "你可以自己想想？" and "你觉得呢。" both hand the turn back to the
 * reader, and the first version of this rule only caught the second one.
 */
const QUESTION_RESIDUE = /(你|您)[^。！\n]{0,24}[？?]|(你|您)\s*(怎么看|觉得|认为|想不想|要不要|是不是|能不能)|(吗|呢)\s*[？?]/;

/**
 * A line that *ends* in a question mark.
 *
 * Narrower than "contains one" on purpose. Prose legitimately contains question
 * marks that are not addressed to anyone — `（段？节？章？）` enumerates
 * uncertainty — and a verifier that flags those turns a real signal into noise
 * the model learns to ignore. A line that ends in `？` is the shape a question
 * actually takes.
 */
function endsWithQuestion(line) {
  return /[？?]\s*$/.test(line.trim());
}

/**
 * @typedef {object} Violation
 * @property {string} code
 * @property {string} where   line number or section label, for the model to jump to
 * @property {string} detail
 * @property {string} fix
 */

/**
 * Normalized source plus a line index, so a found quote can be reported with the
 * line it actually lives on. Built once per book and reused.
 *
 * @param {string[]} lines
 * @returns {{ normalized: string, marks: { start: number, line: number }[] }}
 */
export function buildSourceIndex(lines) {
  const marks = [];
  let normalized = '';
  for (let i = 0; i < lines.length; i += 1) {
    const piece = normalizeForCompare(lines[i]);
    if (piece === '') continue;
    marks.push({ start: normalized.length, line: i + 1 });
    normalized += piece;
  }
  return { normalized, marks };
}

/**
 * The line a found quote starts on, or null.
 * @param {{ normalized: string, marks: { start: number, line: number }[] }} index
 * @param {string} needle already normalized
 */
export function locateQuote(index, needle) {
  const at = index.normalized.indexOf(needle);
  if (at === -1) return null;
  let low = 0;
  let high = index.marks.length - 1;
  let answer = index.marks[0]?.line ?? null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (index.marks[mid].start <= at) {
      answer = index.marks[mid].line;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}

/**
 * Every `**…**` span in the document, with the line it sits on.
 *
 * A line whose `**` count is odd gets a `{ span: null, oddLine: true }` entry
 * instead of a guess: that line's bold did not close where it opened, and a
 * quotation spanning two lines cannot be checked against one source line anyway.
 */
export function extractQuotes(markdown) {
  const out = [];
  const lines = markdown.split('\n');
  lines.forEach((line, i) => {
    BOLD_RE.lastIndex = 0;
    let match = BOLD_RE.exec(line);
    while (match !== null) {
      out.push({ span: unescapeBold(match[1]), line: i + 1 });
      match = BOLD_RE.exec(line);
    }
    if ((line.match(/\*\*/g) ?? []).length % 2 === 1) out.push({ span: null, line: i + 1, oddLine: true });
  });
  return out;
}

/**
 * Split the archive into its numbered sections plus the preamble (title + the
 * `>` position note).
 * @param {string} markdown
 */
export function splitSections(markdown) {
  const lines = markdown.split('\n');
  const headings = [];
  lines.forEach((line, i) => {
    const match = /^##\s*([一二三四五六七八九十]+)\s*、\s*(.*)$/.exec(line.trim());
    if (match !== null) headings.push({ numeral: match[1], label: match[2], line: i + 1 });
  });
  /** @type {Map<string, { label: string, line: number, body: string[] }>} */
  const sections = new Map();
  headings.forEach((heading, i) => {
    const end = headings[i + 1]?.line ?? lines.length + 1;
    sections.set(heading.numeral, {
      label: heading.label,
      line: heading.line,
      body: lines.slice(heading.line, end - 1),
    });
  });
  const firstHeading = headings[0]?.line ?? lines.length + 1;
  return { lines, headings, sections, preamble: lines.slice(0, firstHeading - 1) };
}

/**
 * @param {object} input
 * @param {string} input.markdown
 * @param {{ normalized: string, marks: { start: number, line: number }[] }} input.sourceIndex
 * @param {{ verifyQuotes: boolean, minQuoteChars: number }} input.config
 * @param {boolean} input.readerInput whether the caller asserts section 三 came from the reader
 * @returns {{ violations: Violation[], warnings: string[], quoteLocators: string[] }}
 */
export function verifyArchive({ markdown, sourceIndex, config, readerInput }) {
  /** @type {Violation[]} */
  const violations = [];
  const warnings = [];
  const quoteLocators = [];
  const { lines, sections, preamble } = splitSections(markdown);

  const h1 = lines.find((line) => /^#\s+\S/.test(line.trim()));
  if (h1 === undefined) {
    violations.push({
      code: 'V_NO_TITLE',
      where: '第 1 行',
      detail: '档案缺少一级标题。',
      fix: '首行写成 `# {chapterId} {章节标题}`。',
    });
  }
  if (!preamble.some((line) => line.trim().startsWith('>'))) {
    violations.push({
      code: 'V_NO_POSITION',
      where: '标题之后',
      detail: '缺少（本节在全书中的位置）的引用块（以 > 开头）。',
      fix: '在标题下方补一个 `> 本节在全书中的位置：…` 引用块。',
    });
  }

  for (const section of REQUIRED_SECTIONS) {
    if (sections.has(section.numeral)) continue;
    violations.push({
      code: 'V_SECTION_MISSING',
      where: '章节结构',
      detail: `缺少（${section.heading}）。`,
      fix: `补上 ${section.heading}。${section.rule}`,
    });
  }
  // Order is read off the document, not off the canonical list: iterating
  // REQUIRED_SECTIONS would hand back 一二三四 for a document written 二一三四,
  // and the check would pass on exactly the case it exists to catch.
  const presentOrder = [...sections.keys()]
    .map((numeral) => REQUIRED_SECTIONS.findIndex((section) => section.numeral === numeral))
    .filter((index) => index >= 0);
  if (presentOrder.some((value, i) => i > 0 && value < presentOrder[i - 1])) {
    violations.push({
      code: 'V_SECTION_ORDER',
      where: '章节结构',
      detail: '小节顺序与模版不一致：读者会先读到你的推断，再读到作者的原文。',
      fix: `按 ${REQUIRED_SECTIONS.map((s) => s.numeral).join(' → ')} 的顺序排列。`,
    });
  }

  // ── 二 must say it is inference ────────────────────────────────────────────
  const inference = sections.get('二');
  if (inference !== undefined) {
    if (!inference.label.includes(INFERENCE_MARKER)) {
      violations.push({
        code: 'V_INFERENCE_UNMARKED',
        where: `第 ${inference.line} 行`,
        detail: `第二节标题里没有（${INFERENCE_MARKER}）二字，读者无法区分这是你的推断还是作者原意。`,
        fix: `标题写成 ${REQUIRED_SECTIONS[1].heading}。`,
      });
    }
    const blocks = splitInferenceBlocks(inference.body);
    if (blocks.length === 0) {
      violations.push({
        code: 'V_INFERENCE_EMPTY',
        where: `第 ${inference.line} 行`,
        detail: '第二节没有任何推演块。',
        fix: '每条推演写成 `### 推演 N：{一句话结论}` 加 依据 / 理由 / 限制 / 状态 四行。',
      });
    }
    blocks.forEach((block) => {
      for (const field of ['依据', '理由', '限制', '状态']) {
        if (!block.fields.has(field)) {
          violations.push({
            code: 'V_INFERENCE_FIELD',
            where: `第 ${block.line} 行`,
            detail: `推演（${block.title}）缺（${field}）。`,
            fix: `补上 \`- ${field}：…\`。没有边界就写（原文未给边界），不要省略这一项——省略限制正是过度自信的来源。`,
          });
        }
      }
      const state = block.fields.get('状态');
      if (state !== undefined && !INFERENCE_STATES.some((word) => state.includes(word))) {
        violations.push({
          code: 'V_INFERENCE_STATE',
          where: `第 ${block.line} 行`,
          detail: `推演（${block.title}）的状态（${state.trim()}）不在词表内。`,
          fix: `状态取 ${INFERENCE_STATES.join(' / ')} 之一。`,
        });
      }
    });
  }

  // ── 三 belongs to the reader ───────────────────────────────────────────────
  const reader = sections.get('三');
  if (reader !== undefined) {
    const body = reader.body.join('\n');
    const stripped = body.replace(/^#{1,6}.*$/gm, '').replace(new RegExp(escapeRegExp(READER_PLACEHOLDER), 'g'), '').trim();
    if (stripped !== '' && readerInput !== true) {
      violations.push({
        code: 'V_READER_FABRICATED',
        where: `第 ${reader.line} 行`,
        detail: '第三节（读者自己的看法）被写上了内容，但这次调用没有声明 readerInput —— 等于替读者说话。',
        fix: `把第三节恢复成 ${READER_PLACEHOLDER}；若这些内容确实来自读者，请带 readerInput: true 重新提交。`,
      });
    }
    if (!body.includes(READER_PLACEHOLDER) && readerInput !== true) {
      violations.push({
        code: 'V_READER_MARKER_MISSING',
        where: `第 ${reader.line} 行`,
        detail: `第三节没有 ${READER_PLACEHOLDER} 占位。`,
        fix: `三个小标题下各写一行 ${READER_PLACEHOLDER}。`,
      });
    }
  }

  // ── 一 must quote, and every quote must exist ──────────────────────────────
  const evidence = sections.get('一');
  if (evidence !== undefined && evidence.body.join('').includes('- ') && (evidence.body.join('').match(/\*\*/g) ?? []).length === 0) {
    violations.push({
      code: 'V_SECTION_ONE_NO_QUOTE',
      where: `第 ${evidence.line} 行`,
      detail: '第一节列了主张／证据／洞见，却没有一条引文——读者无法核对你是不是在替作者说话。',
      fix: `每条判断后面补一条 ${BOLD}逐字引文${BOLD}。`,
    });
  }

  // ── 粗体的结构：成对、同行、不进小标题 ────────────────────────────────────
  //
  // Bold has no closing-glyph asymmetry to exploit the way 「」 does, so the
  // structure has to be counted. These three checks are what makes "bold is only
  // for quotations" enforceable rather than aspirational.
  const boldMarks = (markdown.match(/\*\*/g) ?? []).length;
  /** @type {number[]} */
  const oddLines = [];
  lines.forEach((line, index) => {
    if ((line.match(/\*\*/g) ?? []).length % 2 === 1) oddLines.push(index + 1);

    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed) === false || trimmed.includes(BOLD) === false) return;
    violations.push({
      code: 'V_QUOTE_IN_HEADING',
      where: `第 ${index + 1} 行`,
      detail: `小标题里出现了粗体：（${truncateForMessage(trimmed)}）。粗体只用于正文里的逐字引文。`,
      fix: '把小标题里的粗体去掉。小标题是结构，不是引文；要强调就改标题的措辞。',
    });
  });

  if (boldMarks % 2 === 1) {
    violations.push({
      code: 'V_QUOTE_UNCLOSED',
      where: '全文',
      detail: `全文的 ${BOLD} 是奇数（${boldMarks} 个），有一条粗体没有闭合。`,
      fix: `补上闭合的 ${BOLD}。粗体必须成对。`,
    });
  }
  // Two or more lines with an odd count means they are closing each other's
  // bold — that is cross-line bold, which no single-line check can verify.
  if (oddLines.length >= 2) {
    for (const line of oddLines) {
      violations.push({
        code: 'V_QUOTE_CROSSLINE',
        where: `第 ${line} 行`,
        detail: `这一行的 ${BOLD} 是奇数：粗体没有在本行内闭合。`,
        fix: '引文必须成对出现在同一行内。跨行的引文先把原文合并成一行再包裹；合并之后仍要逐字，不能加字改字。',
      });
    }
  }

  // Residual 「」 from the old convention. Worse than a syntax problem: the words
  // inside it are never checked, so a 「…」 can pass off an unverifiable sentence
  // as a quotation. Stripping bold first means a quotation that legitimately
  // contains 「」 (nested dialogue in a novel) is not punished for it.
  lines.forEach((line, index) => {
    if (/[「」]/.test(stripBold(line)) === false) return;
    violations.push({
      code: 'V_QUOTE_GLYPH_RESIDUE',
      where: `第 ${index + 1} 行`,
      detail: '「」 已经不是这个插件的引文标记，而且它里面的字不会被逐字校验——留着它，等于让一段无法回源的文字冒充引文。',
      fix: `换成粗体：${BOLD}逐字引文${BOLD}。术语、节名、需要强调的地方改用（ ）或句式，不要用标点包起来。`,
    });
  });

  const quotes = extractQuotes(markdown);
  for (const quote of quotes) {
    // Structural problems were already reported above; re-reporting them here
    // would bury the actual quotation check under duplicate noise.
    if (quote.oddLine === true) continue;
    if (config.verifyQuotes !== true) continue;
    const needle = normalizeForCompare(quote.span);
    if (needle === '') continue;
    const line = locateQuote(sourceIndex, needle);
    if (line !== null) {
      quoteLocators.push(`L${quote.line} → 原文 L${line}`);
      if (quote.span.length < config.minQuoteChars) {
        warnings.push(
          `第 ${quote.line} 行的粗体只有 ${quote.span.length} 字（不足 ${config.minQuoteChars}），虽然逐字命中了，`
          + '但更像是强调而不是引文。粗体只用于引文；强调请改用句式。',
        );
      } else if (quote.span.length > MAX_BULLET_QUOTE_CHARS) {
        warnings.push(`第 ${quote.line} 行的引文长 ${quote.span.length} 字，超过 ${MAX_BULLET_QUOTE_CHARS} 字，建议截取关键句。`);
      }
      continue;
    }
    if (quote.span.length < config.minQuoteChars) {
      warnings.push(`第 ${quote.line} 行的 ${BOLD}${quote.span}${BOLD} 在原文里找不到，但只有 ${quote.span.length} 字（不足 ${config.minQuoteChars}），按术语处理，未计为违规。术语请改用（ ）或不用标点。`);
      continue;
    }
    violations.push({
      code: 'V_QUOTE_NOT_FOUND',
      where: `第 ${quote.line} 行`,
      detail: `引文 ${BOLD}${truncateForMessage(quote.span)}${BOLD} 在原文里逐字找不到。`,
      fix: '不要改写引文去迁就判断：要么回到原文复制准确的句子，要么去掉粗体、把它改标为你的推断（放到第二节并说明依据）。'
        + '如果这句话本来是在强调而不是引用，也去掉粗体，改用句式。',
    });
  }

  // ── 骨架：整章的 mental model 与讲解顺序 ────────────────────────────────────
  //
  // These two are the difference between a model-shaped lecture and a
  // source-shaped one, which is why they are structural rules rather than style
  // advice. What cannot be checked here is whether the model is any *good* —
  // deciding that is exactly what the reader is there for.
  const modelIndex = lines.findIndex((line) => line.trim().startsWith(CHAPTER_MODEL_HEADING));
  const orderIndex = lines.findIndex((line) => line.trim().startsWith(TEACHING_ORDER_HEADING));

  if (modelIndex === -1) {
    violations.push({
      code: 'V_CHAPTER_MODEL_MISSING',
      where: '正文开头',
      detail: '缺少（这一章真正在解决什么）。没有它，后面的讲解只能按原书顺序走。',
      fix: `在位置引用块之后、第一节之前补一段：\n${CHAPTER_MODEL_HEADING}\n`
        + '一段话，回答这一章真正在解决什么问题（不是（讲了什么）），长度以能当三句话读为限。',
    });
  } else if (sectionBodyAfter(lines, modelIndex).length < 40) {
    violations.push({
      code: 'V_CHAPTER_MODEL_THIN',
      where: `第 ${modelIndex + 1} 行`,
      detail: '（这一章真正在解决什么）太短，不足四十字，当不了骨架。',
      fix: '写成一段完整的话：这一章在解决什么问题、它的几个环节是什么。',
    });
  }

  if (orderIndex === -1) {
    violations.push({
      code: 'V_TEACHING_ORDER_MISSING',
      where: '正文开头',
      detail: '缺少（讲解顺序）。读者有权知道听到的顺序是不是原书的顺序，以及为什么。',
      fix: `在 mental model 之后补一段：\n${TEACHING_ORDER_HEADING}\n`
        + `写出选定的顺序与理由，并出现（${ORDER_SHAPE_WORDS.join('）或（')}）字样之一。`,
    });
  } else {
    const body = sectionBodyAfter(lines, orderIndex);
    if (ORDER_SHAPE_WORDS.some((word) => body.includes(word)) === false) {
      violations.push({
        code: 'V_TEACHING_ORDER_UNCLEAR',
        where: `第 ${orderIndex + 1} 行`,
        detail: `（讲解顺序）没有说明这是原序还是重排（${ORDER_SHAPE_WORDS.join(' / ')} 一个都没出现）。`,
        fix: '明确写出是原序还是重排。原序也要给理由——（原序就好）而不给理由，等于没问过这个问题。',
      });
    } else if (body.length < 30) {
      violations.push({
        code: 'V_TEACHING_ORDER_THIN',
        where: `第 ${orderIndex + 1} 行`,
        detail: '（讲解顺序）只有一句表态，没有理由。',
        fix: '补上理由：原序要说明为什么原序本身就在搭出这个模型；重排要说明原序哪里挡路。',
      });
    }
  }

  // ── 4/5. 深度讲解：每节要有 AI 视角，章末要有在全书中的位置 ─────────────────
  const aiViewCount = lines.filter((line) => line.trim().startsWith(AI_VIEW_HEADING)).length;
  if (evidence !== undefined) {
    const subHeadings = evidence.body.filter((line) => {
      const trimmed = line.trim();
      if (/^###\s+/.test(trimmed) === false) return false;
      return trimmed.startsWith(AI_VIEW_HEADING) === false;
    });
    if (aiViewCount === 0) {
      violations.push({
        code: 'V_AI_VIEW_MISSING',
        where: `第 ${evidence.line} 行`,
        detail: '第一节没有任何（AI 视角）。深度讲解要求每一节讲完后给一段增量视角。',
        fix: `每个（### 小标题）后面补一段：\n${AI_VIEW_HEADING}\n`
          + `一段话、不超过 4 句，写作者没明说但可以从原文推出来的机制／与全书的连接／一个反例；`
          + `推不出新东西就写（${NO_EXTRA_NOTE}），不要硬编。`,
      });
    } else if (aiViewCount < subHeadings.length) {
      violations.push({
        code: 'V_AI_VIEW_INCOMPLETE',
        where: `第 ${evidence.line} 行`,
        detail: `第一节有 ${subHeadings.length} 个小标题，却只有 ${aiViewCount} 段 AI 视角。`,
        fix: '每个小标题后面都要跟一段 AI 视角，一段都不要省。',
      });
    }
  }
  if (lines.some((line) => line.trim().startsWith(BOOK_POSITION_HEADING)) === false) {
    violations.push({
      code: 'V_BOOK_POSITION_MISSING',
      where: '章末',
      detail: '缺少（在全书中的位置）。这是本章在全书论证链里承担什么功能的唯一落点。',
      fix: `在（${REQUIRED_SECTIONS[3].heading}）的内容之后补一段：\n${BOOK_POSITION_HEADING}\n`
        + '一段话，讲这一章和前后章的关系、它在论证链里解决掉什么、为哪一章铺路。',
    });
  }

  // ── 6. 不提问：正文里不许残留把球踢回给读者的句式 ───────────────────────────
  lines.forEach((line, index) => {
    // Quoted text is the author's voice, not the plugin's: a rhetorical question
    // inside a quotation is content, and flagging it would make the rule fight
    // the thing the plugin cares most about.
    const bare = stripBold(line);
    if (QUESTION_RESIDUE.test(bare) === false) {
      if (endsWithQuestion(bare)) {
        warnings.push(
          `第 ${index + 1} 行以问号结尾：（${truncateForMessage(bare.trim())}）。`
          + '如果这句话是在问读者，改成陈述句；如果只是引用或列举，可以忽略这条提示。',
        );
      }
      return;
    }
    violations.push({
      code: 'V_QUESTION_RESIDUE',
      where: `第 ${index + 1} 行`,
      detail: `正文里出现提问句式：（${truncateForMessage(bare.trim())}）。这个插件的定位是深度讲解，不主动提问。`,
      fix: '改成陈述句，把答案直接讲出来。引文里的问句保留——那是作者在问。',
    });
  });

  // ── 短句：一段不超过 4 句。风格度量，给提示但不算违规 ────────────────────────
  for (const paragraph of splitParagraphs(lines)) {
    const sentences = countSentences(paragraph.text);
    if (sentences > MAX_SENTENCES_PER_PARAGRAPH) {
      warnings.push(
        `第 ${paragraph.line} 行的段落有 ${sentences} 句，超过 ${MAX_SENTENCES_PER_PARAGRAPH} 句。`
        + '拆成几段，一个 point 一段。',
      );
    }
  }

  return { violations, warnings, quoteLocators };
}

/** Remove `**…**` spans, so no rule ever fires on the author's own words. */
function stripBold(line) {
  return line.replace(BOLD_RE, '');
}

/**
 * Paragraph = a run of consecutive body lines. Headings and blockquotes are not
 * paragraphs (the blockquote at the top is the fixed position note), and a
 * bullet list is one paragraph per bullet — which is what makes the 4-sentence
 * rule meaningful for the one-point-per-line style this archive uses.
 */
function splitParagraphs(lines) {
  const out = [];
  let current = null;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const isBody = trimmed !== '' && /^#{1,6}\s/.test(trimmed) === false && trimmed.startsWith('>') === false;
    if (isBody === false) {
      current = null;
      return;
    }
    if (current === null) {
      current = { line: index + 1, text: line };
      out.push(current);
      return;
    }
    current.text += `\n${line}`;
  });
  return out;
}

function countSentences(text) {
  const matches = stripBold(text).match(/[。！？!?]/g);
  return matches === null ? 0 : matches.length;
}

/** One `### 推演 N：…` block and its `- 字段：值` lines. */
function splitInferenceBlocks(body) {
  const blocks = [];
  let current = null;
  body.forEach((line, i) => {
    const heading = /^###\s+(.*)$/.exec(line.trim());
    if (heading !== null) {
      current = { title: heading[1].trim(), line: i + 1, fields: new Map() };
      blocks.push(current);
      return;
    }
    const field = /^[-*]\s*([^：:]{1,10})[：:]\s*(.*)$/.exec(line.trim());
    if (field !== null && current !== null) current.fields.set(field[1].trim(), field[2].trim());
  });
  return blocks;
}

/**
 * The text under one heading, up to the next heading of any level.
 *
 * Used for the two blocks that live above the numbered sections (the chapter
 * model and the teaching order), where there is no section map to lean on.
 */
function sectionBodyAfter(lines, startIndex) {
  const out = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (/^#{1,6}\s/.test(trimmed)) break;
    if (trimmed === '') continue;
    out.push(trimmed);
  }
  return out.join('\n');
}

function truncateForMessage(text) {
  return text.length <= 60 ? text : `${text.slice(0, 60)}…`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

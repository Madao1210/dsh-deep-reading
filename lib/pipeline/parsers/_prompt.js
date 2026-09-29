/**
 * Shared "get the full text, then hand it back" prompt template.
 *
 * Borrowed from the reference plugin's `parsers/_prompt.js`, with one
 * deliberate difference: where that version told the subagent how to extract
 * text by hand (pdftotext, unpack the EPUB), this one first points at whatever
 * book tools the session already has. Re-implementing EPUB/ZIP extraction
 * inside a second plugin is how you end up with two parsers that disagree about
 * the same book.
 */

/**
 * @param {object} cfg
 * @param {string} cfg.input          path or URL the reader gave
 * @param {string} cfg.textPath       where the subagent must write the full text
 * @param {string} cfg.kindLabel      human label for the content type
 * @param {string[]} cfg.steps        extraction steps, numbered by the template
 * @param {string} cfg.chunkRule      how to split (advisory only: the plugin splits)
 * @returns {string}
 */
export function buildFetchPrompt(cfg) {
  const steps = (cfg.steps ?? []).map((step, i) => `${i + 1}. ${step}`);
  return [
    `你的任务：把${cfg.kindLabel}的全文取出来，原样写到 ${cfg.textPath}，然后只回报结果。`,
    `输入来源：${cfg.input}`,
    '',
    '步骤：',
    ...steps,
    `${steps.length + 1}. 校验：用 read 打开 ${cfg.textPath}，确认总行数与你写入的一致；不要截断、不要加任何评注、不要重排段落。`,
    '',
    '取文本的优先顺序（不要跳级，也不要为了取文本去装重依赖）：',
    '  a) 本会话里已有的书本工具优先——例如 book_open / book_toc / book_segment，或者 read_document。',
    '     它们已经把书变成了可寻址文本，重复自己解析只会得到第二套边界。',
    '  b) 上面都没有时，再用通用手段：read 直接读；PDF 读不出正文才考虑 pdftotext；扫描版才考虑 OCR。',
    '  c) 都失败时不要硬撑：回报 { "ok": false, "reason": "具体原因" }，让主代理决定下一步。',
    '',
    '输出 JSON（只输出 JSON，不要有别的文字）：',
    '{ "ok": true, "textPath": "' + cfg.textPath + '", "totalLines": N, "notes": "取文本过程中实际用了什么手段 / 有什么损坏" }',
  ].join('\n');
}

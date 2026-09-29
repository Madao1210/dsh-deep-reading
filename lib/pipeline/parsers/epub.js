/**
 * Parser: EPUB — prompt-level only.
 *
 * This parser deliberately does NOT parse EPUB. The session usually already has
 * book tools that turn an EPUB into addressable text with stable ids (and, when
 * it does not, a generic document reader will do it). Adding another ZIP/OCF
 * implementation here would create a second set of chapter boundaries for the
 * same file, and the reader would have no way to tell which one a citation
 * refers to.
 *
 * So this parser ships a prompt, not an algorithm: a subagent is told to fetch
 * the text with whatever the session has, write it verbatim to `textPath`, and
 * come back. `reading_open({ textPath })` then ingests it.
 */
import { buildFetchPrompt } from './_prompt.js';

export default {
  name: 'epub',
  types: ['epub'],
  description: 'EPUB：不自行解析，出提示词交子代理用会话已有的书本工具取文本后再导入',
  deterministic: false,

  sniff(buffer) {
    // EPUB is a ZIP: local file header magic, with "mimetype" stored first.
    const head = buffer.subarray(0, 4);
    if (head[0] !== 0x50 || head[1] !== 0x4b) return false;
    return buffer.subarray(0, 200).toString('latin1').includes('mimetype');
  },

  buildPrompt({ input, textPath }) {
    return buildFetchPrompt({
      input,
      textPath,
      kindLabel: 'EPUB 全书文本',
      steps: [
        '先看本会话有没有书本工具：有 book_open / book_toc / book_segment 就用它们把全书按阅读顺序（spine，不是文件名顺序）取出来；'
        + '有 read_document 就用它直接读 EPUB。',
        '没有上述工具时，再退回解包 EPUB（ZIP → OCF/OPF → spine）自己拼文本；拼的时候按 spine 顺序，不要按文件名排序。',
        '把结果按 章标题行 + 空行 + 正文 的形式写入目标文件，保留标题行——章节边界依赖它们。',
      ],
      chunkRule: '原书章节（保留章节标题行）',
    });
  },
};

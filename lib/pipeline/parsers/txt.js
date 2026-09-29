/**
 * Parser: plain text.
 *
 * Deterministic: the plugin reads the bytes and hands back the string. There is
 * nothing to ask a model about, and a model asked to "extract the text from this
 * .txt" is a model that will occasionally helpfully reformat it — which would
 * move every line number and quietly invalidate every citation downstream.
 */
import { buildFetchPrompt } from './_prompt.js';
import { normalizeSourceText } from '../../util/text.js';

export default {
  name: 'txt',
  types: ['txt', 'text'],
  description: '纯文本（.txt / .text）：插件内确定性读取，零模型参与',
  deterministic: true,

  /** @param {{ buffer: Buffer }} input */
  extract(input) {
    return normalizeSourceText(input.buffer.toString('utf8'));
  },

  /** Content sniffing: no NUL bytes, mostly printable. */
  sniff(buffer) {
    const head = buffer.subarray(0, 4096);
    if (head.includes(0)) return false;
    return true;
  },

  buildPrompt({ input, textPath }) {
    return buildFetchPrompt({
      input,
      textPath,
      kindLabel: '纯文本全文',
      steps: ['用 read 读取源文件全文（若超过单次读取上限，分段读完再拼接，不要只取前面一段）。'],
      chunkRule: '章节（或章节内小节）',
    });
  },
};

/**
 * Parser: Markdown.
 *
 * Deterministic for the same reason as `txt`. The only difference that matters
 * downstream is that chapters come from ATX headings, which `structure.js` reads
 * off the text itself — so this parser does not need to pre-split anything.
 */
import { buildFetchPrompt } from './_prompt.js';
import { normalizeSourceText } from '../../util/text.js';

export default {
  name: 'md',
  types: ['md', 'markdown'],
  description: 'Markdown（.md / .markdown）：插件内确定性读取，章节边界取 ATX 标题',
  deterministic: true,

  extract(input) {
    return normalizeSourceText(input.buffer.toString('utf8'));
  },

  sniff(buffer) {
    const head = buffer.subarray(0, 4096).toString('utf8');
    if (head.includes('\u0000')) return false;
    return /^#{1,6}\s+\S/m.test(head);
  },

  buildPrompt({ input, textPath }) {
    return buildFetchPrompt({
      input,
      textPath,
      kindLabel: 'Markdown 全文',
      steps: [
        '用 read 读取源文件全文（保留 # 标题行原样，不要转成纯文本标题：章节边界依赖它们）。',
      ],
      chunkRule: 'ATX 标题（# …）',
    });
  },
};

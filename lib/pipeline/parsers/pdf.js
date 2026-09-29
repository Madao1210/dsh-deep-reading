/**
 * Parser: PDF — prompt-level only, and honest about it.
 *
 * A PDF is a layout format, not a text format: whether the extraction is any
 * good depends on the tool and on whether the file is a scan. The plugin has no
 * business guessing, so it asks a subagent that can actually look at the file.
 */
import { buildFetchPrompt } from './_prompt.js';

export default {
  name: 'pdf',
  types: ['pdf'],
  description: 'PDF：不自行解析，出提示词交子代理取文本（扫描版需 OCR）后再导入',
  deterministic: false,

  sniff(buffer) {
    return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  },

  buildPrompt({ input, textPath }) {
    return buildFetchPrompt({
      input,
      textPath,
      kindLabel: 'PDF 全书文本',
      steps: [
        '先试 read_document：它直接读 PDF，是首选。',
        '读不出正文（返回空或乱码）时，才考虑 pdftotext 之类的命令行工具；扫描版才考虑 OCR。',
        '分清两种情况并如实回报：正文提出来了但排版乱（可继续）／根本没提出正文（应回报 ok:false，不要拿乱码冒充全文）。',
        '写入目标文件时保留章节标题行，章节边界依赖它们。',
      ],
      chunkRule: '原书章节（保留章节标题行）',
    });
  },
};

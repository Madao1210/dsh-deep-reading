/**
 * dr_import — source import: EPUB / Markdown file / plain text / PDF /
 * directory of Markdown → books/<ID>/{book.json,index.md,chapters/NNN.md,
 * chapters/NNN.map.json}. txt and pdf sources are converted to Markdown first
 * (convert.js); the converted full text is kept as books/<ID>/source.md.
 *
 * Idempotency is source-sha256 + tool version + every chapter file hash; the
 * rebuild happens in a temp directory swapped in atomically, carrying the
 * existing memory/user/lecture/exports/usage state across.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { collectFromDir, collectFromEpub, collectFromMdFile, collectFromPdf, collectFromTxt } from '../collect.js';
import { displayTitle, fail, pad3, rand6, renderChapter, sha256, sha256File, splitBlocks } from '../util.js';
import { bookDirOf } from '../bookstore.js';
import { COMMON, guarded, obj, str, bool, num, strs, textBlock } from './shared.js';

const TOOL_NAME = 'deep-reading-split';
const TOOL_VERSION = '0.1.2';
const SCHEMA_VERSION = 1;

const OUTPUT_SCHEMA = obj({
  ...COMMON,
  skipped: bool('源与工具版本未变，重建被跳过'),
  id: str('书籍 ID'),
  title: str('书名'),
  bookDir: str('书籍目录绝对路径'),
  sourceType: str('源类型：epub / md / txt / pdf / dir'),
  sourceSha256: str('源哈希'),
  chapterCount: num('章节数'),
  chapters: strs('每章一行：编号、标题、段数、字符数、状态'),
  conversion: strs('txt/pdf 源的转换说明，每行一条'),
});

/** txt/pdf 转换结果 → 报告行。 */
function conversionLines(id, conv) {
  if (!conv) return [];
  const out = [];
  if (conv.kind === 'txt') {
    out.push(`转换：txt → md（编码 ${conv.encoding}${conv.uncertain ? '，不确定' : ''} · ${conv.mode || ''} · 标题 ${conv.headings} 个）`);
  } else if (conv.kind === 'pdf') {
    out.push(`转换：pdf → md（${conv.pages} 页 · ${conv.chars} 字 · 标题 ${conv.headings} 个 · 去页码 ${conv.droppedPageNumbers} 条）`);
  } else {
    out.push('转换：已转换为 Markdown');
  }
  out.push(`已留原文：books/${id}/source.md（切章时排除）`);
  for (const w of conv.warnings || []) out.push(`注意：${w}`);
  return out;
}

export function drImportTool({ config }) {
  return defineTool({
    name: 'dr_import',
    description:
      '把 EPUB / Markdown / txt / pdf 文件 / 含 .md 的目录导入为 books/<ID>/ 结构（章节文件带 [n] 段落锚点）。'
      + 'txt / pdf 先自动转成 Markdown（转换全文留在 books/<ID>/source.md，切章时排除）；'
      + '中文 PDF 需要文字层，扫描件（图片版）会被拒绝并提示先 OCR。'
      + '源未变时幂等：返回 skipped:true，不重做。重建时保留既有 memory/user/lecture/exports/usage 状态。',
    parameters: {
      src: { type: 'string', required: true, description: '源路径：EPUB / .md / .txt / .pdf 文件 / 含 .md 的目录（绝对路径）' },
      book: { type: 'string', required: true, description: '书籍 ID：简短英文/拼音（字母数字 . _ -），如 du-kou-de-deng' },
      title: { type: 'string', description: '书名；缺省时取 EPUB 元数据 / 首个标题 / 目录名' },
      force: { type: 'boolean', description: '源未变也强制重建（默认 false 时返回 skipped:true）' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(value.lines ?? [value.error ?? '']),
    },
    async execute(args) {
      return guarded('dr_import', async () => {
        const id = String(args.book ?? '').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
          fail('书籍 ID 不合法：只允许字母/数字/._-，且以字母或数字开头（不要用中文或路径分隔符）');
        }
        const srcArg = String(args.src ?? '').trim();
        if (srcArg === '') fail('缺少 src（EPUB / .md / .txt / .pdf 文件 / 含 .md 的目录）');
        const src = path.resolve(srcArg);
        if (!fs.existsSync(src)) fail(`源不存在：${src}`);

        const stat = fs.statSync(src);
        let collected;
        let sourceSha;
        if (stat.isDirectory()) {
          collected = collectFromDir(src, args.title);
          sourceSha = collected.sourceHashOverride;
        } else if (src.toLowerCase().endsWith('.epub')) {
          collected = await collectFromEpub(src);
          sourceSha = sha256File(src);
        } else if (src.toLowerCase().endsWith('.md')) {
          collected = collectFromMdFile(src, args.title);
          sourceSha = sha256File(src);
        } else if (src.toLowerCase().endsWith('.txt')) {
          collected = collectFromTxt(src, args.title);
          sourceSha = sha256File(src);
        } else if (src.toLowerCase().endsWith('.pdf')) {
          collected = await collectFromPdf(src, args.title);
          sourceSha = sha256File(src);
        } else {
          fail(`不支持的源类型：${src}（只支持 .epub / .md / .txt / .pdf / 目录）`);
        }

        if (collected.chapters.length === 0) fail('源里没有可用章节（EPUB 正文为空，或转换后没有内容）');

        const booksRoot = config.booksRoot;
        const bookDir = bookDirOf(booksRoot, id);
        const sourceInfo = { type: collected.sourceType, path: src, sha256: sourceSha };
        if (collected.conversion) sourceInfo.conversion = collected.conversion;

        let oldBook = null;
        const oldBookPath = path.join(bookDir, 'book.json');
        if (fs.existsSync(oldBookPath)) {
          try { oldBook = JSON.parse(fs.readFileSync(oldBookPath, 'utf8')); } catch { oldBook = null; }
        }

        // Idempotent: same source hash, same tool version, every chapter file intact → skip.
        if (oldBook && !args.force) {
          const sameSource = oldBook.source && oldBook.source.sha256 === sourceSha;
          const sameTool = oldBook.tool && oldBook.tool.version === TOOL_VERSION;
          let filesOk = Array.isArray(oldBook.chapters) && oldBook.chapters.length === collected.chapters.length;
          if (filesOk) {
            for (const ch of oldBook.chapters) {
              const p = path.join(bookDir, ch.file);
              if (!fs.existsSync(p) || sha256File(p) !== ch.sha256) { filesOk = false; break; }
            }
          }
          if (sameSource && sameTool && filesOk) {
            return {
              ok: true,
              action: 'dr_import',
              skipped: true,
              id,
              title: oldBook.title,
              bookDir,
              sourceType: collected.sourceType,
              sourceSha256: sourceSha,
              chapterCount: oldBook.chapters.length,
              chapters: oldBook.chapters.map((c) => chapterLine(c)),
              conversion: conversionLines(id, oldBook.source && oldBook.source.conversion),
              lines: [
                `已导入过且源未变（skipped:true，未重做）：${id}《${oldBook.title}》`,
                `来源：${sourceInfo.type}（${src}） · sha256 ${sourceSha.slice(0, 16)}…`,
                ...conversionLines(id, oldBook.source && oldBook.source.conversion),
                `目录：${bookDir}`,
                ...oldBook.chapters.map((c) => ` ${chapterLine(c)}`),
              ],
            };
          }
        }

        // Build in a temp directory.
        fs.mkdirSync(booksRoot, { recursive: true });
        const tmpDir = path.join(booksRoot, `.import-${id}-${rand6()}`);
        fs.mkdirSync(path.join(tmpDir, 'chapters'), { recursive: true });

        const chaptersMeta = [];
        for (let i = 0; i < collected.chapters.length; i++) {
          const n = i + 1;
          const ch = collected.chapters[i];
          const blocks = splitBlocks(ch.body);
          const { text } = renderChapter(n, ch.title, blocks);
          const file = `chapters/${pad3(n)}.md`;
          fs.writeFileSync(path.join(tmpDir, file), text, 'utf8');

          const map = {
            schemaVersion: SCHEMA_VERSION,
            book: id,
            chapter: n,
            source: ch.sourceDescriptor,
            paras: blocks.map((b, bi) => ({
              n: bi + 1,
              blockIndex: bi,
              chars: b.length,
              head: b.slice(0, 30),
            })),
          };
          fs.writeFileSync(path.join(tmpDir, `chapters/${pad3(n)}.map.json`), JSON.stringify(map, null, 2) + '\n', 'utf8');

          chaptersMeta.push({
            n,
            title: ch.title,
            file,
            sha256: sha256(Buffer.from(text, 'utf8')),
            paras: blocks.length,
            chars: text.length,
            state: 'unanalyzed',
            memory: null,
          });
        }

        // Carry old chapter state when the chapter file hash still matches its memory record.
        if (oldBook) {
          for (const ch of chaptersMeta) {
            const old = (oldBook.chapters || []).find((c) => c.n === ch.n);
            if (old && old.memory && old.memory.sourceSha256 === ch.sha256) {
              ch.state = old.state;
              ch.memory = old.memory;
            }
          }
        }

        // 转换源（txt/pdf）的全文 Markdown 留在书根目录，默认可见；切章不读它。
        if (typeof collected.convertedMarkdown === 'string') {
          fs.writeFileSync(path.join(tmpDir, 'source.md'), collected.convertedMarkdown + '\n', 'utf8');
        }

        const importedAt = new Date().toISOString();
        const indexLines = [
          `# 《${collected.bookTitle}》目录`,
          '',
          `- 来源：${sourceInfo.type}（${sourceInfo.path}）`,
          `- 导入：${importedAt}`,
          `- 章节数：${chaptersMeta.length}`,
          '',
          '## 章节',
          '',
          ...chaptersMeta.map((c) =>
            `- ${pad3(c.n)} ${displayTitle(c.n, c.title)} — ${c.paras} 段 · ${c.chars} 字符 · ${c.state === 'analyzed' ? '已分析' : '未分析'}`),
          '',
        ];
        fs.writeFileSync(path.join(tmpDir, 'index.md'), indexLines.join('\n'), 'utf8');

        // Carry user data across the rebuild (memories, lecture text, user area,
        // exports, usage ledger). `lecture` is the reader-facing text that the
        // epub export reads from.
        if (fs.existsSync(bookDir)) {
          for (const rel of ['memory', 'user', 'exports', 'lecture']) {
            const old = path.join(bookDir, rel);
            if (fs.existsSync(old)) fs.cpSync(old, path.join(tmpDir, rel), { recursive: true });
          }
          const oldUsage = path.join(bookDir, 'usage.jsonl');
          if (fs.existsSync(oldUsage)) fs.copyFileSync(oldUsage, path.join(tmpDir, 'usage.jsonl'));
          const oldCursor = path.join(bookDir, '.usage-cursor.json');
          if (fs.existsSync(oldCursor)) fs.copyFileSync(oldCursor, path.join(tmpDir, '.usage-cursor.json'));
          const oldAgents = path.join(bookDir, '.usage-agents.json');
          if (fs.existsSync(oldAgents)) fs.copyFileSync(oldAgents, path.join(tmpDir, '.usage-agents.json'));
          const oldReader = path.join(bookDir, 'reader.md');
          if (fs.existsSync(oldReader)) fs.copyFileSync(oldReader, path.join(tmpDir, 'reader.md'));
        }

        // book.json is written last: its presence marks a finished build.
        const bookJson = {
          schemaVersion: SCHEMA_VERSION,
          id,
          title: collected.bookTitle,
          source: sourceInfo,
          tool: { name: TOOL_NAME, version: TOOL_VERSION },
          importedAt,
          chapters: chaptersMeta,
        };
        fs.writeFileSync(path.join(tmpDir, 'book.json'), JSON.stringify(bookJson, null, 2) + '\n', 'utf8');

        // Atomic swap.
        if (fs.existsSync(bookDir)) {
          const oldDir = path.join(booksRoot, `.old-${id}-${rand6()}`);
          fs.renameSync(bookDir, oldDir);
          try {
            fs.renameSync(tmpDir, bookDir);
          } catch (e) {
            fs.renameSync(oldDir, bookDir);
            fs.rmSync(tmpDir, { recursive: true, force: true });
            throw e;
          }
          fs.rmSync(oldDir, { recursive: true, force: true });
        } else {
          fs.renameSync(tmpDir, bookDir);
        }

        return {
          ok: true,
          action: 'dr_import',
          skipped: false,
          id,
          title: collected.bookTitle,
          bookDir,
          sourceType: collected.sourceType,
          sourceSha256: sourceSha,
          chapterCount: chaptersMeta.length,
          chapters: chaptersMeta.map((c) => chapterLine(c)),
          conversion: conversionLines(id, collected.conversion),
          lines: [
            `导入完成：${id}《${collected.bookTitle}》`,
            `来源：${sourceInfo.type}（${src}） · ${chaptersMeta.length} 章 · sha256 ${sourceSha.slice(0, 16)}…`,
            ...conversionLines(id, collected.conversion),
            `目录：${bookDir}`,
            ...chaptersMeta.map((c) => ` ${chapterLine(c)}`),
          ],
        };
      });
    },
  });
}

function chapterLine(c) {
  return `${pad3(c.n)} ${displayTitle(c.n, c.title)} — ${c.paras} 段 · ${c.chars} 字符 · ${c.state === 'analyzed' ? '已分析' : '未分析'}`;
}

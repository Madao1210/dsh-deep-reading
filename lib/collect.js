/**
 * Source collection: EPUB (via @storyteller-platform/epub), one Markdown file,
 * a directory of Markdown files, or a plain-text / PDF source converted to
 * Markdown by convert.js first. Every collector returns
 *   { bookTitle, sourceType, chapters: [{title, body, sourceDescriptor}],
 *     sourceHashOverride?, convertedMarkdown?, conversion? }
 */
import fs from 'node:fs';
import path from 'node:path';
import { Epub } from '@storyteller-platform/epub';
import TurndownService from 'turndown';
import { convertPdf, convertTxt } from './convert.js';
import { extractHeading, fail, sha256, sha256File } from './util.js';

const turndown = new TurndownService({ headingStyle: 'atx' });

function toMarkdown(xhtml) {
  const cleaned = xhtml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  return turndown.turndown(cleaned).trim();
}

export async function collectFromEpub(src) {
  // The library reads EPUB 3 only; an EPUB 2 source is upgraded to a temp copy first.
  let epub;
  try {
    epub = await Epub.from(src);
  } catch (e) {
    if (!/EPUB 2/.test(e && e.message ? e.message : '')) throw e;
    epub = await Epub.upgrade(src);
  }
  try {
    const epubTitle = (await epub.getTitle())?.trim() || path.basename(src, path.extname(src));
    const spineItems = await epub.getSpineItems();
    const chapters = [];
    for (let i = 0; i < spineItems.length; i++) {
      const item = spineItems[i];
      if (!item.mediaType || !item.mediaType.includes('xhtml')) continue;
      const xhtml = await epub.readItemContents(item.id, 'utf-8');
      const markdown = toMarkdown(xhtml);
      if (!markdown) continue;
      const { title, body } = extractHeading(markdown, /^#{1,6}[ \t]+(.+)$/m);
      chapters.push({
        title: title || `第${chapters.length + 1}节`,
        body,
        sourceDescriptor: { type: 'epub', path: src, spineIndex: i, href: item.href || '' },
      });
    }
    return { bookTitle: epubTitle, sourceType: 'epub', chapters };
  } finally {
    epub.discardAndClose();
  }
}

/** Markdown → chapters：按 `# ` 一级标题切分；标题前的内容算"前言"。 */
export function chaptersFromMarkdown(raw, fallbackTitle, descriptor) {
  const headings = [...raw.matchAll(/^#[ \t]+.+$/gm)];
  const chapters = [];
  if (headings.length === 0) {
    chapters.push({ title: fallbackTitle, body: raw, sourceDescriptor: descriptor });
  } else {
    const pre = raw.slice(0, headings[0].index).trim();
    if (pre) {
      chapters.push({ title: '前言', body: pre, sourceDescriptor: descriptor });
    }
    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].index + headings[i][0].length;
      const end = i + 1 < headings.length ? headings[i + 1].index : raw.length;
      chapters.push({
        title: headings[i][0].replace(/^#[ \t]+/, '').trim(),
        body: raw.slice(start, end),
        sourceDescriptor: descriptor,
      });
    }
  }
  return chapters;
}

/** 没有 titleOpt 时猜一个书名：转换文本的第一行（多半是书名页）。 */
function guessTitle(markdown) {
  const first = (markdown.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  if (first === '' || first.startsWith('#') || first.length > 40) return '';
  const t = first.replace(/^[《【([("']+/, '').replace(/[》】)\]）)"']+$/, '').trim();
  return /[\p{Script=Han}A-Za-z]/u.test(t) ? t : '';
}

export function collectFromMdFile(src, titleOpt) {
  const raw = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
  const chapters = chaptersFromMarkdown(raw, titleOpt || path.basename(src, path.extname(src)), { type: 'md', path: src });
  return {
    bookTitle: titleOpt || (chapters[0] && chapters[0].title) || path.basename(src, path.extname(src)),
    sourceType: 'md',
    chapters,
  };
}

export function collectFromTxt(src, titleOpt) {
  const { markdown, conversion } = convertTxt(src);
  const chapters = chaptersFromMarkdown(markdown, titleOpt || path.basename(src, path.extname(src)), { type: 'txt', path: src });
  return {
    bookTitle: titleOpt || guessTitle(markdown) || path.basename(src, path.extname(src)),
    sourceType: 'txt',
    chapters,
    convertedMarkdown: markdown,
    conversion,
  };
}

export async function collectFromPdf(src, titleOpt) {
  const r = await convertPdf(src);
  const chapters = chaptersFromMarkdown(r.markdown, titleOpt || path.basename(src, path.extname(src)), { type: 'pdf', path: src });
  const { markdown, ...conversion } = r;
  conversion.kind = 'pdf';
  return {
    bookTitle: titleOpt || guessTitle(markdown) || path.basename(src, path.extname(src)),
    sourceType: 'pdf',
    chapters,
    convertedMarkdown: markdown,
    conversion,
  };
}

export function collectFromDir(src, titleOpt) {
  // source.md 是 txt/pdf 导入时留下的转换全文，切章时排除。
  const files = fs.readdirSync(src)
    .filter((f) => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'source.md')
    .sort();
  if (files.length === 0) fail(`目录里没有 .md 文件：${src}`);
  const hashOfSet = sha256(files.map((f) => f + '\0' + sha256File(path.join(src, f))).join('\n'));
  const chapters = files.map((f) => {
    const raw = fs.readFileSync(path.join(src, f), 'utf8').replace(/\r\n/g, '\n');
    const { title, body } = extractHeading(raw, /^#[ \t]+.+$/m);
    return {
      title: title || path.basename(f, '.md'),
      body,
      sourceDescriptor: { type: 'dir', path: src, file: f },
    };
  });
  return {
    bookTitle: titleOpt || path.basename(src),
    sourceType: 'dir',
    chapters,
    sourceHashOverride: hashOfSet,
  };
}

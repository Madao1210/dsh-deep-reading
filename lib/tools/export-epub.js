/**
 * dr_export_epub — splice chapters into an EPUB3.
 * Splices books/<ID>/lecture/NNN.md into an EPUB3. The lecture text is carried
 * over byte-for-byte; only the wrapper (XHTML/CSS/OPF) is generated.
 * Chapter order follows the numeric file prefix, so unread chapters simply lack.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import yazl from 'yazl';
import { fail } from '../util.js';
import { loadBook } from '../bookstore.js';
import { COMMON, guarded, num, obj, str, strs, textBlock, bool } from './shared.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return t;
}

/** Minimal Markdown → XHTML: headings, paragraphs, lists, quotes, rules, inline emphasis. */
function mdToXhtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const outLines = [];
  let list = null;
  const closeList = () => { if (list) { outLines.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { closeList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const lvl = Math.min(m[1].length + 1, 6);
      outLines.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      continue;
    }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); outLines.push('<ul>'); list = 'ul'; }
      outLines.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); outLines.push('<ol>'); list = 'ol'; }
      outLines.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      closeList();
      outLines.push(`<blockquote><p>${inline(m[1])}</p></blockquote>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { closeList(); outLines.push('<hr/>'); continue; }
    closeList();
    outLines.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return outLines.join('\n');
}

function stripFrontmatter(text) {
  const t = text.replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return t;
  const end = t.indexOf('\n---\n', 3);
  return end === -1 ? t : t.slice(end + 5);
}

/** The lecture file's leading "# title" repeats the book's chapter title; drop it. */
function stripLeadingTitle(body) {
  const lines = body.replace(/^\n+/, '').split('\n');
  if (lines[0] && /^#\s+/.test(lines[0])) lines.shift();
  return lines.join('\n').replace(/^\n+/, '');
}

const XHTML = (title, bodyHtml) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
<section epub:type="chapter" xmlns:epub="http://www.idpf.org/2007/ops">
<h1>${esc(title)}</h1>
${bodyHtml}
</section>
</body>
</html>
`;

const CSS = `body{font-family:serif;line-height:1.75;margin:0 5%;}
h1{font-size:1.5em;line-height:1.35;margin:1.4em 0 .8em;}
h2{font-size:1.2em;margin:1.4em 0 .6em;}
h3{font-size:1.05em;margin:1.2em 0 .5em;}
p{margin:0 0 .85em;text-indent:0;}
blockquote{margin:.9em 1.2em;padding-left:.9em;border-left:3px solid #ccc;color:#444;}
code{font-family:monospace;font-size:.92em;}
hr{border:0;border-top:1px solid #ddd;margin:1.4em 0;}
`;

function zipToFile(outPath, entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const e of entries) zip.addBuffer(Buffer.from(e.data), e.name, { compress: e.compress !== false });
    const ws = fs.createWriteStream(outPath);
    ws.on('close', () => resolve());
    ws.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(ws);
    zip.end();
  });
}

const OUTPUT_SCHEMA = obj({
  ...COMMON,
  book: str('书籍 ID'),
  kind: str('导出类别'),
  title: str('书名'),
  author: str('作者'),
  path: str('相对书籍目录的路径'),
  absPath: str('绝对路径'),
  bytes: num('文件字节数'),
  sha256: str('文件哈希'),
  replaced: bool('是否覆盖了同名文件'),
  chapterCount: num('收录的讲解章数'),
  chapters: strs('收录的章节标题（按顺序）'),
  missingChapters: { type: 'array', items: { type: 'number' }, description: '本书中尚无讲解的章号' },
});

export function drExportEpubTool({ config }) {
  return defineTool({
    name: 'dr_export_epub',
    description:
      '把 books/<ID>/lecture/*.md 讲解拼成 EPUB3（逐字收录讲解，不重写一个字；未读章节自然缺席）。'
      + '输出到 books/<ID>/exports/，out 缺省为 <ID>-讲解.epub。',
    parameters: {
      book: { type: 'string', required: true, description: '书籍 ID' },
      out: { type: 'string', description: '输出文件名（缺省 <ID>-讲解.epub）' },
      title: { type: 'string', description: '书名（缺省用 book.json 的 title）' },
      author: { type: 'string', description: '作者（缺省用 book.json 的 author）' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(value.lines ?? [value.error ?? '']),
    },
    async execute(args) {
      return guarded('dr_export_epub', async () => {
        const { dir, book } = loadBook(config.booksRoot, args.book);
        const lectureDir = path.join(dir, 'lecture');
        if (!fs.existsSync(lectureDir)) {
          fail('还没有任何讲解落盘（books/<ID>/lecture/ 不存在）', '先精读至少一章');
        }
        const files = fs.readdirSync(lectureDir).filter((f) => /^\d{3}\.md$/.test(f)).sort();
        if (files.length === 0) fail('lecture/ 目录里没有讲解文件', '先精读至少一章');

        const chapters = files.map((f) => {
          const n = Number(f.slice(0, 3));
          const meta = (book.chapters || []).find((c) => c.n === n);
          const body = stripLeadingTitle(stripFrontmatter(fs.readFileSync(path.join(lectureDir, f), 'utf8')));
          if (!body.trim()) fail(`讲解为空：lecture/${f}`);
          return { n, title: meta ? meta.title : `第 ${n} 节`, body };
        });

        const title = String(args.title || book.title || book.id);
        const author = String(args.author || book.author || '');
        const outName = String(args.out || `${book.id}-讲解.epub`);
        if (!/^[A-Za-z0-9._一-龥-]{1,80}\.epub$/.test(outName)) fail(`out 不合法：${outName}`);

        const docs = chapters.map((c, i) => ({
          id: `ch${String(i + 1).padStart(3, '0')}`,
          href: `ch${String(i + 1).padStart(3, '0')}.xhtml`,
          title: c.title,
          html: XHTML(c.title, mdToXhtml(c.body)),
        }));

        const uid = `urn:uuid:${crypto.randomUUID()}`;
        const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

        const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head><meta charset="utf-8"/><title>目录</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<nav epub:type="toc" id="toc"><h1>目录</h1>
<ol>
${docs.map((d) => `<li><a href="${d.href}">${esc(d.title)}</a></li>`).join('\n')}
</ol>
</nav>
</body>
</html>
`;

        const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="zh-CN">
<head><meta name="dtb:uid" content="${escAttr(uid)}"/><meta name="dtb:depth" content="1"/></head>
<docTitle><text>${esc(title)}</text></docTitle>
<navMap>
${docs.map((d, i) => `<navPoint id="nav${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(d.title)}</text></navLabel><content src="${d.href}"/></navPoint>`).join('\n')}
</navMap>
</ncx>
`;

        const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${esc(uid)}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
<dc:language>zh-CN</dc:language>
${author ? `<dc:creator>${esc(author)}</dc:creator>` : ''}
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
${docs.map((d) => `<item id="${d.id}" href="${d.href}" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine toc="ncx">
${docs.map((d) => `<itemref idref="${d.id}"/>`).join('\n')}
</spine>
</package>
`;

        const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`;

        const entries = [
          { name: 'mimetype', data: 'application/epub+zip', compress: false },
          { name: 'META-INF/container.xml', data: container },
          { name: 'OEBPS/content.opf', data: opf },
          { name: 'OEBPS/nav.xhtml', data: nav },
          { name: 'OEBPS/toc.ncx', data: ncx },
          { name: 'OEBPS/style.css', data: CSS },
          ...docs.map((d) => ({ name: `OEBPS/${d.href}`, data: d.html })),
        ];

        const exportsDir = path.join(dir, 'exports');
        fs.mkdirSync(exportsDir, { recursive: true });
        const target = path.join(exportsDir, outName);
        const replaced = fs.existsSync(target);
        await zipToFile(target, entries);
        const bytes = fs.statSync(target).size;
        const sha = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
        const written = new Set(chapters.map((c) => c.n));
        const missingChapters = (book.chapters || [])
          .filter((c) => !written.has(c.n))
          .map((c) => c.n);

        return {
          ok: true, action: 'dr_export_epub', kind: 'export-epub', book: book.id,
          title, author, path: `exports/${outName}`, absPath: target,
          bytes, sha256: sha, replaced,
          chapterCount: docs.length, chapters: docs.map((d) => d.title), missingChapters,
          lines: [
            `EPUB 导出完成：exports/${outName}（${bytes} 字节，${docs.length} 章）`,
            ...docs.map((d, i) => ` ${String(i + 1).padStart(3, '0')} ${d.title}`),
            missingChapters.length > 0 ? `尚未讲解的章：${missingChapters.join(', ')}` : '全书章节均已收录',
            replaced ? '（覆盖了同名旧文件）' : '',
          ].filter(Boolean),
        };
      });
    },
  });
}

/**
 * Book store: path resolution, book.json loading, and chapter file access.
 *
 * Layout per book is the shared one — identical across installs:
 *   books/<ID>/{book.json,index.md,chapters/NNN.md,chapters/NNN.map.json,
 *               memory/NNN.md,lecture/NNN.md,user/NNN.md,user/state.md,
 *               reader.md,exports/,usage.jsonl}
 */
import fs from 'node:fs';
import path from 'node:path';
import { fail, pad3 } from './util.js';

/** Resolve <booksRoot>/<id>, refusing anything that escapes the library root. */
export function bookDirOf(booksRoot, id) {
  const root = path.resolve(booksRoot);
  const dir = path.resolve(root, String(id ?? ''));
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    fail(`书籍 ID 越出书库目录：${id}`);
  }
  return dir;
}

export function loadBook(booksRoot, id) {
  if (id === undefined || id === null || String(id).trim() === '') fail('缺少 --book（书籍 ID）');
  const dir = bookDirOf(booksRoot, id);
  const bookJsonPath = path.join(dir, 'book.json');
  if (!fs.existsSync(bookJsonPath)) {
    fail(`书籍不存在：books/${id}（先用 dr_import 导入）`);
  }
  return { dir, book: JSON.parse(fs.readFileSync(bookJsonPath, 'utf8')) };
}

export function chapterMeta(book, n) {
  const ch = (book.chapters || []).find((c) => c.n === n);
  if (!ch) fail(`章节不存在：第 ${n} 章（本书共 ${(book.chapters || []).length} 章）`);
  return ch;
}

/** Parse chapters/NNN.md into [{n, text}]; numbering must be continuous from 1. */
export function parseChapterUnits(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const units = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^\[(\d+)\]\s?(.*)$/);
    if (m) {
      if (cur) units.push(cur);
      cur = { n: Number(m[1]), lines: [m[2]] };
    } else if (cur && line.trim() !== '') {
      cur.lines.push(line);
    }
  }
  if (cur) units.push(cur);
  const parsed = units.map((u) => ({ n: u.n, text: u.lines.join('\n').trim() }));
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].n !== i + 1) {
      fail(`章节文件损坏：段落编号不连续（第 ${i + 1} 个块是 [${parsed[i].n}]）`);
    }
  }
  return parsed;
}

export function readUnits(dir, n) {
  const file = path.join(dir, `chapters/${pad3(n)}.md`);
  if (!fs.existsSync(file)) fail(`章节文件缺失：${file}`);
  return parseChapterUnits(fs.readFileSync(file, 'utf8'));
}

export const renderUnits = (units) => units.map((u) => `[${u.n}] ${u.text}`).join('\n\n');

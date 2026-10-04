/**
 * Shared primitives used across the tools:
 * hashing, atomic writes, frontmatter, and chapter block rendering.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** A tool failure that carries an optional corrective hint for the model. */
export class DrError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'DrError';
    this.hint = hint;
  }
}

export const fail = (message, hint) => {
  throw new DrError(message, hint);
};

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const sha256File = (p) => sha256(fs.readFileSync(p));
export const rand6 = () => crypto.randomBytes(3).toString('hex');
export const pad3 = (n) => String(n).padStart(3, '0');
export const byteLen = (s) => Buffer.byteLength(s, 'utf8');

/** Write via temp file + fsync + rename, so a crash never leaves a half file. */
export function atomicWrite(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${rand6()}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

export function serializeFrontmatter(obj) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    lines.push(`${k}: ${typeof v === 'number' ? v : JSON.stringify(String(v))}`);
  }
  lines.push('---');
  return lines.join('\n');
}

export function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return null;
  const fm = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const raw = m[2].trim();
    if (raw === '') { fm[m[1]] = ''; continue; }
    try { fm[m[1]] = JSON.parse(raw); } catch { fm[m[1]] = raw; }
  }
  return fm;
}

/** Markdown → block list (split on blank lines; trailing whitespace trimmed; no rewriting). */
export function splitBlocks(markdown) {
  return markdown
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((b) => b.replace(/[ \t]+$/gm, '').trim())
    .filter(Boolean);
}

/** First heading of a given level: {title, body}; title=null and body unchanged when absent. */
export function extractHeading(text, re) {
  const m = text.match(re);
  if (!m) return { title: null, body: text };
  const title = m[0].replace(/^#{1,6}[ \t]+/, '').trim();
  return { title, body: text.slice(0, m.index) + text.slice(m.index + m[0].length) };
}

/** Do not repeat the 第X章 prefix when the title already carries a chapter marker. */
export function displayTitle(n, title) {
  return /^第\s*[0-9一二三四五六七八九十百零两]+\s*[章回节话]|^chapter\b/i.test(title)
    ? title
    : `第${n}章 ${title}`;
}

export function renderChapter(chapterNo, title, blocks) {
  const header = `# ${displayTitle(chapterNo, title)}`;
  const body = blocks.map((b, i) => `[${i + 1}] ${b}`).join('\n\n');
  return { text: `${header}\n\n${body}\n`, paras: blocks.length };
}

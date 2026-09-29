/**
 * Parser registry.
 *
 * The plugin's extension point, and deliberately the same shape as the reference
 * workflow's: a parser is `{ name, types, description, deterministic, sniff,
 * extract?, buildPrompt }`, one file per format, discovered by type. Dropping a
 * same-named file in `<pluginRoot>/custom-parsers/` overrides the built-in; a new
 * type name adds one.
 *
 * `deterministic` is the field that matters at runtime: a deterministic parser
 * is executed in this process (no model, no cost, reproducible line numbers), a
 * non-deterministic one only contributes a prompt for a subagent to follow.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import txt from './txt.js';
import md from './md.js';
import epub from './epub.js';
import pdf from './pdf.js';

const BUILTINS = [txt, md, epub, pdf];

export class ParserRegistry {
  /**
   * @param {Record<string, object>} parsers
   */
  constructor(parsers) {
    /** @type {Record<string, object>} */
    this.parsers = parsers;
  }

  /** @returns {object[]} */
  list() {
    const seen = new Set();
    const out = [];
    for (const parser of Object.values(this.parsers)) {
      if (seen.has(parser.name)) continue;
      seen.add(parser.name);
      out.push({
        name: parser.name,
        types: parser.types,
        description: parser.description,
        deterministic: parser.deterministic === true,
      });
    }
    return out;
  }

  /** By type name; unknown types fall back to plain text rather than failing. */
  resolve(type) {
    return this.parsers[String(type).toLowerCase()] ?? this.parsers.txt;
  }

  /**
   * Pick a parser by content first, then by extension. Content wins: this user
   * has a directory full of files whose extension disagrees with their bytes.
   * @param {Buffer} buffer
   * @param {string} pathHint
   */
  detect(buffer, pathHint = '') {
    for (const parser of Object.values(this.parsers)) {
      if (typeof parser.sniff === 'function' && parser.sniff(buffer) === true) return parser;
    }
    const ext = /\.([a-z0-9]+)$/i.exec(pathHint)?.[1]?.toLowerCase();
    if (ext !== undefined && this.parsers[ext] !== undefined) return this.parsers[ext];
    return this.parsers.txt;
  }
}

/**
 * Build the registry, loading `<pluginRoot>/custom-parsers/` overrides.
 * Async because custom parsers are ESM modules and `import()` is the only way
 * to load one; tools await the promise once.
 * @param {string} pluginRoot
 * @returns {Promise<ParserRegistry>}
 */
export async function createParserRegistry(pluginRoot) {
  /** @type {Record<string, object>} */
  const parsers = {};
  for (const parser of BUILTINS) {
    for (const type of parser.types) parsers[type] = parser;
  }

  const customDir = join(pluginRoot, 'custom-parsers');
  if (existsSync(customDir)) {
    for (const file of readdirSync(customDir)) {
      if (!file.endsWith('.js')) continue;
      try {
        const mod = await import(pathToFileURL(join(customDir, file)).href);
        const parser = mod.default ?? mod;
        if (typeof parser?.name !== 'string' || typeof parser?.buildPrompt !== 'function') {
          console.warn(`[dsh-deep-reading] 跳过自定义解析器 ${file}：缺少 name 或 buildPrompt`);
          continue;
        }
        for (const type of parser.types ?? [parser.name]) parsers[type] = parser;
        console.log(`[dsh-deep-reading] 已加载自定义解析器：${parser.name}（${file}）`);
      } catch (error) {
        console.warn(`[dsh-deep-reading] 自定义解析器 ${file} 加载失败：${error.message}`);
      }
    }
  }

  return new ParserRegistry(parsers);
}

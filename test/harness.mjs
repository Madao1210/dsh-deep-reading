/**
 * A fake Cordis context, so the plugin can be loaded and its tools called
 * without starting dsh.
 *
 * This is deliberately thin: it records what `apply()` registers and nothing
 * else. The point of load-check is to catch the failures that only appear at
 * load time — a prompt file that moved, a generated script that does not parse,
 * a schema outside the enforced subset, a tool whose parameter spec is invalid —
 * and every one of those fails here rather than in front of the reader.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Read the config block out of this plugin's own `cordis.patch.yml`.
 *
 * The real loader parses this file before calling `apply()`, so a test that
 * hard-coded its own config would not be testing the file the user actually
 * edits — and a mistyped key in that file is exactly the mistake this catches.
 */
export function patchConfig() {
  const raw = readFileSync(join(PLUGIN_ROOT, 'cordis.patch.yml'), 'utf8');
  const parsed = yaml.load(raw);
  const row = Array.isArray(parsed) ? parsed[0]?.insert?.[0] : undefined;
  if (row === undefined) throw new Error('cordis.patch.yml 里没有找到 insert 行');
  if (row.id !== row.name) throw new Error(`patch 行 id(${row.id}) 必须等于 name(${row.name})`);
  return { row, config: row.config ?? {} };
}

/**
 * @param {Record<string, unknown>} [config]
 */
export function createFakeContext(config = {}) {
  const record = { tools: [], skills: [], sections: [], contexts: [] };
  const ctx = {
    tools: { register: (definition) => record.tools.push(definition) },
    skills: { register: (definition) => record.skills.push(definition) },
    systemPrompt: {
      section: (section) => record.sections.push(section),
      context: (context) => record.contexts.push(context),
    },
  };
  return { ctx, record, config };
}

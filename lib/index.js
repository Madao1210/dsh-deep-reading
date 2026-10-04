/**
 * dsh-deep-reading — a token-efficient deep-reading workflow for DSH.
 *
 * One entry skill (`deep-reading`) plus seven tools; the chapter work runs in a
 * `spawn` subagent driven by `reading_chapter`, so chapter text never enters the
 * main session. The skill texts live next to this package and are read at
 * apply() time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Schema from '@deepseek-ai/schemastery';
import { resolveConfig } from './config.js';
import { buildTools } from './tools/index.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = path.join(PKG_ROOT, 'skills');

export const name = 'dsh-deep-reading';
export const inject = ['tools', 'skills'];

export const Config = Schema.object({
  booksRoot: Schema.string()
    .default('')
    .description('书库根目录（默认 $DSH_HOME/deep-reading/books）；可指向其他安装的 books 目录共用书库'),
});

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const entrySkill = readSkill('deep-reading');
  const chapterSkill = readSkill('deep-reading-chapter');

  ctx.skills.register({
    name: 'deep-reading',
    description: entrySkill.description,
    whenToUse: '用户说“读这本书 / 继续读书 / 精读第N章 / 导出阅读笔记”时',
    content: entrySkill.content,
    resourceBase: { kind: 'directory', path: SKILLS_DIR },
    source: `plugin:${name}`,
  });

  // Internal: reading_chapter hands this body to the child as its persona. It is
  // hidden from both catalogs — the entry skill is the only way in.
  ctx.skills.register({
    name: 'deep-reading-chapter',
    description: chapterSkill.description,
    content: chapterSkill.content,
    invocation: { modelInvocable: false, userInvocable: false },
    resourceBase: { kind: 'directory', path: SKILLS_DIR },
    source: `plugin:${name}`,
  });

  for (const tool of buildTools({ ctx, config, chapterSkill: chapterSkill.content })) {
    ctx.tools.register(tool);
  }

  ctx.logger?.info?.(`deep-reading: 书库 ${config.booksRoot}`);
}

/** Read one SKILL.md and split its frontmatter off: the registry wants the body alone. */
function readSkill(dirName) {
  const file = path.join(SKILLS_DIR, dirName, 'SKILL.md');
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  let description = '';
  let content = raw;
  if (raw.startsWith('---\n')) {
    const end = raw.indexOf('\n---\n', 3);
    if (end !== -1) {
      const fm = raw.slice(4, end);
      content = raw.slice(end + 5).replace(/^\n+/, '');
      const line = fm.split('\n').find((l) => l.startsWith('description:'));
      if (line) description = line.slice('description:'.length).trim().replace(/^["']|["']$/g, '');
    }
  }
  if (description === '') description = `deep-reading skill: ${dirName}`;
  return { description, content };
}

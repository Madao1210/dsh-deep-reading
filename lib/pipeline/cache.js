/**
 * Identity and idempotency.
 *
 * `bookId` is derived from the source content and the split-rule version, so:
 *   - re-opening the same file is a no-op that returns the same book,
 *   - a hand-edited source produces a NEW book instead of corrupting the old
 *     one's citations,
 *   - changing how chapters are detected (a new rule version) also produces a
 *     new book, because the old line ranges no longer mean what they said.
 *
 * The Map cache is keyed by chunk id + prompt revision. Without it, re-running a
 * wave after a Reduce failure would pay for the same reading twice — and the
 * one measured fact that is not in dispute about this class of plugin is that
 * re-reading is where the money goes.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256Hex } from '../util/text.js';

/**
 * @param {{ text: string, ruleVersion: string }} input
 * @returns {{ bookId: string, sha: string }}
 */
export function fingerprintBook({ text, ruleVersion }) {
  const sha = sha256Hex(text);
  const bookId = sha256Hex(`${ruleVersion}\u0000${sha}`).slice(0, 12);
  return { bookId, sha };
}

/** Key for one Map result: the chunk and the prompt revision that produced it. */
export function mapCacheKey(chunkId, promptRevision) {
  return `${chunkId}.${promptRevision}`;
}

/**
 * A tiny file-per-key JSON cache. Writes are atomic (temp + rename) because a
 * half-written Map record that parses as JSON would be worse than no record.
 */
export class JsonCache {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir;
  }

  /** @param {string} key */
  read(key) {
    try {
      return JSON.parse(readFileSync(this.pathFor(key), 'utf8'));
    } catch {
      return null;
    }
  }

  /** @param {string} key */
  has(key) {
    return this.read(key) !== null;
  }

  /** @param {string} key @param {unknown} value */
  write(key, value) {
    const path = this.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmp, path);
    return path;
  }

  /** @param {string} key */
  pathFor(key) {
    // Keys are plugin-generated ids (ch03#p1.rev3), so they are already safe as
    // filenames; '#' is kept out of the way of shells by mapping it to '_'.
    return join(this.dir, `${key.replace('#', '_')}.json`);
  }
}

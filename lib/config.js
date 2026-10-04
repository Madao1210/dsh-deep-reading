/**
 * Config resolution. `booksRoot` is the only knob: the shared library root.
 * Empty string means the portable default under the DSH home.
 */
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BOOKS_ROOT = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'deep-reading', 'books');

export function resolveConfig(raw) {
  const configured = typeof raw.booksRoot === 'string' ? raw.booksRoot.trim() : '';
  return {
    booksRoot: configured === '' ? DEFAULT_BOOKS_ROOT : path.resolve(configured),
  };
}

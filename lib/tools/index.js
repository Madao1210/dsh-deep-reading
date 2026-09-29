/**
 * Tool registry for the plugin.
 *
 * Three tools, and the split between them is deliberate:
 *
 *   reading_open      deterministic: file → addressable book (no model)
 *   reading_archive   deterministic: verify + persist one chapter's archive (no model)
 *   reading_status    deterministic: where things stand + the next workflow args (no model)
 *
 * Everything that needs judgement goes through the `workflow` tool the model
 * already has, so this plugin never calls a model itself. That is the same line
 * the previous plugins in this environment drew, and it is the line that keeps
 * the reader's money and the plugin's opinion separable.
 */
import { readingOpenTool } from './reading-open.js';
import { readingArchiveTool } from './reading-archive.js';
import { readingStatusTool } from './reading-status.js';

/**
 * @param {{ config: object, registryPromise: Promise<object>, promptRevision: string,
 *           register: (name: string, definition: unknown) => void }} input
 */
export function buildTools({ config, registryPromise, promptRevision, register }) {
  const tools = [
    ['reading_open', readingOpenTool({ config, registryPromise, promptRevision })],
    ['reading_archive', readingArchiveTool({ config })],
    ['reading_status', readingStatusTool({ config, promptRevision })],
  ];
  for (const [name, definition] of tools) register(name, definition);
  return tools.map(([name]) => name);
}

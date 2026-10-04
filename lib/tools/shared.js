/**
 * Shared tool helpers. Every tool answers with a structured value and renders
 * it to a text block; a failure keeps `ok:false` and carries `error` + `hint`
 * so the model reads the reason and corrects course instead of crashing.
 */
import { DrError } from '../util.js';

/** Render lines as one text block. */
export function textBlock(lines) {
  return [{ type: 'text', text: lines.join('\n') }];
}

/** Output-schema object node: the value DSL requires `additionalProperties:false` on every object. */
export const obj = (properties) => ({ type: 'object', additionalProperties: false, properties });
export const str = (description) => ({ type: 'string', description });
export const num = (description) => ({ type: 'number', description });
export const bool = (description) => ({ type: 'boolean', description });
export const strs = (description) => ({ type: 'array', items: { type: 'string' }, description });

/** Fields every dr_* output carries (refusals included). */
export const COMMON = {
  ok: { type: 'boolean' },
  action: { type: 'string' },
  error: { type: 'string' },
  hint: { type: 'string' },
  lines: { type: 'array', items: { type: 'string' } },
};

/**
 * Unwrap a `tokenUsage` projection state into its four counters.
 *
 * `sessionProjections.stateOf()` returns the unit's *host state*, and
 * dsh-token-meter keeps the counters one level down (`{totals, last}` —
 * lib/types/usage-projection.js). Reading the host state as if it were flat
 * silently yields all-zero deltas, so a shape that is neither is reported as
 * null and the caller refuses loudly instead of accounting zeros.
 */
export function usageTotals(state) {
  if (state && typeof state === 'object') {
    if (state.totals && typeof state.totals === 'object') return state.totals;
    if ('uncachedInputTokens' in state) return state;
  }
  return null;
}

export function refusal(action, error, hint) {
  const lines = [`${action} 失败：${error}`];
  if (hint) lines.push(`提示：${hint}`);
  return { ok: false, action, error, hint: hint ?? '', lines };
}

/**
 * Run a tool body; a typed failure becomes a structured refusal value.
 * @param {string} action tool name
 * @param {() => Promise<Record<string, unknown>>|Record<string, unknown>} body
 */
export async function guarded(action, body) {
  try {
    return await body();
  } catch (e) {
    if (e instanceof DrError) return refusal(action, e.message, e.hint);
    return refusal(action, `内部错误：${e instanceof Error ? e.message : String(e)}`);
  }
}

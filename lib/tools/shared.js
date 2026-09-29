/**
 * Shared tool helpers.
 *
 * Every tool answers with a structured value and renders it to a text block. A
 * refusal keeps `isError` false and carries `code` / `reason` / `nextStep`: the
 * call succeeded in answering, and the model needs to read the reason and act on
 * it rather than treat it as a crash.
 */
import { DeepReadingError, nextStepFor } from '../util/errors.js';

/** Render lines as one text block. */
export function textBlock(lines) {
  return [{ type: 'text', text: lines.join('\n') }];
}

/** @param {unknown} error */
export function toFailure(error) {
  if (error instanceof DeepReadingError) {
    return { code: error.code, reason: error.reason, details: error.details ?? {} };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'INTERNAL', reason: `内部错误：${message}`, details: {} };
}

/** The value shape every refusal uses. */
export function refusalValue(failure, action) {
  const nextStep = nextStepFor(failure.code);
  return {
    ok: false,
    action,
    code: failure.code,
    reason: failure.reason,
    nextStep,
    lines: [],
    returnedPrompt: typeof failure.details?.returnedPrompt === 'string' ? failure.details.returnedPrompt : '',
  };
}

/**
 * Wrap a tool body so a typed failure becomes a structured refusal.
 * @template T
 * @param {() => Promise<T>} body
 * @param {(error: ReturnType<typeof toFailure>) => Record<string, unknown>} onFailure
 */
export async function guarded(body, onFailure) {
  try {
    return await body();
  } catch (error) {
    return onFailure(toFailure(error));
  }
}

/** A compact one-line chapter description. */
export function chapterLine(chapter, archiveState) {
  const title = chapter.title === '' ? '（无标题）' : chapter.title;
  const flags = [];
  if (chapter.lowConfidence === true) flags.push('低置信');
  if (chapter.source === 'fallback') flags.push('自动切分');
  if (archiveState !== undefined && archiveState !== null) flags.push(`已建档/${archiveState}`);
  const notes = flags.length > 0 ? `  [${flags.join(' ')}]` : '';
  return `${chapter.id}  ${title}  第 ${chapter.startLine}–${chapter.endLine} 行  ${chapter.chars} 字${notes}`;
}

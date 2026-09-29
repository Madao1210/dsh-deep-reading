/**
 * `reading_archive` — verify and persist one chapter's understanding archive.
 *
 * Two things this tool deliberately does NOT do:
 *
 *  - It does not rewrite a rejected archive. It reports violations and stops.
 *    The one failure this plugin exists to prevent is a confident paraphrase
 *    presented as the author's words, and "helpfully" fixing a quote would be
 *    exactly that failure, automated.
 *  - It does not ask the model to resend the archive body. By default it adopts
 *    the draft the Reduce subagent already wrote to disk, so a long archive is
 *    never carried through the conversation twice — once as a tool result and
 *    again as a tool argument.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { persistArchive, relativeMemoryPath } from '../archive/section.js';
import { READER_PLACEHOLDER } from '../archive/template.js';
import { inputError, nextStepFor } from '../util/errors.js';
import { archivePath, bookDir, readArchive, readSourceIndex, resolveBookId } from '../store/book.js';
import { setProgress, readProfile } from '../store/profile.js';
import { guarded, refusalValue, textBlock } from './shared.js';

const OUTPUT_SCHEMA = {
  // Compiled by the value schema DSL: no `required`, explicit openness. See the
  // note in reading-open.js.
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    code: { type: 'string' },
    reason: { type: 'string' },
    nextStep: { type: 'string' },
    bookId: { type: 'string' },
    chapterId: { type: 'string' },
    state: { type: 'string' },
    path: { type: 'string' },
    draftPath: { type: 'string' },
    quoteCount: { type: 'number' },
    coverageLine: { type: 'string' },
    violations: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    markdown: { type: 'string' },
    lines: { type: 'array', items: { type: 'string' } },
  },
};

export function readingArchiveTool({ config }) {
  return defineTool({
    name: 'reading_archive',
    description:
      '校验并落盘一章的理解档案。默认采用本章草稿（books/<bookId>/drafts/<章节>.md），不需要把正文再传一遍；也可用 markdown 直接提交正文。'
      + '校验会逐字核对每一条（）引文是否存在于原文，检查第二节是否标注为（推断）、每条推演是否有 依据/理由/限制/状态，'
      + '并检查第三节是否替读者写了话。不通过时会返回 violations 与修法，档案不会落盘——请用 edit 修草稿后重新提交，不要重跑 workflow。',
    parameters: {
      bookId: { type: 'string', description: 'reading_open 返回的 bookId；缺省时用最近打开的书。' },
      chapterId: { type: 'string', description: '章节 id，如 ch03。' },
      markdown: { type: 'string', description: '档案正文（可选）。不给时读取本章草稿文件。' },
      mode: { type: 'string', description: 'auto（默认，校验并落盘）| check（只校验不落盘）| read（读回已落盘的档案）。' },
      readerInput: { type: 'boolean', description: `声明第三节的内容来自读者本人。为 true 时才允许第三节不是 ${READER_PLACEHOLDER}。` },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(value.lines ?? [value.reason ?? '']),
    },
    async execute(args) {
      return guarded(async () => {
        const book = resolveBookId(config, args.bookId);
        const chapterId = typeof args.chapterId === 'string' ? args.chapterId.trim() : '';
        if (chapterId === '') throw inputError('缺少 chapterId。');
        const chapter = book.chapters.find((entry) => entry.id === chapterId);
        if (chapter === undefined) {
          throw inputError(
            `这本书没有章节 ${chapterId}。可选：${book.chapters.map((entry) => entry.id).join('、')}`,
            { chapterId },
          );
        }

        const mode = typeof args.mode === 'string' && args.mode.trim() !== '' ? args.mode.trim() : 'auto';

        // ── read back ────────────────────────────────────────────────────────
        if (mode === 'read') {
          const stored = readArchive(config, book.bookId, chapterId);
          if (stored === null) {
            return {
              ok: false,
              action: 'reading_archive',
              code: 'NOT_FOUND',
              reason: `${chapterId} 还没有建档。`,
              nextStep: '先跑 workflow 生成草稿，再调用本工具落盘。',
              bookId: book.bookId,
              chapterId,
              lines: [`${chapterId} 还没有建档。`, '先跑 workflow 生成草稿，再调用 reading_archive 落盘。'],
            };
          }
          const entry = book.archives?.[chapterId] ?? {};
          return {
            ok: true,
            action: 'reading_archive',
            bookId: book.bookId,
            chapterId,
            state: entry.state ?? '',
            path: archivePath(config, book.bookId, chapterId),
            quoteCount: entry.quoteCount ?? 0,
            markdown: stored,
            lines: [
              `${chapterId} 的档案（state=${entry.state ?? '?'}，revision=${entry.revision ?? '?'}，引文 ${entry.quoteCount ?? 0} 条）：`,
              '',
              stored,
            ],
          };
        }

        // ── body: inline or the draft on disk ────────────────────────────────
        const inline = typeof args.markdown === 'string' ? args.markdown : '';
        let body = inline;
        let usedDraft = false;
        if (body.trim() === '') {
          const guess = draftGuess(config, book, chapterId);
          if (existsSync(guess)) {
            body = readFileSync(guess, 'utf8');
            usedDraft = true;
          }
        }
        if (body.trim() === '') {
          throw inputError(
            `${chapterId} 既没有传 markdown，磁盘上也没有草稿。先跑 workflow 生成草稿（drafts/${chapterId}.md），或用 markdown 直接提交。`,
            { chapterId },
          );
        }

        const sourceIndex = readSourceIndex(config, book.bookId);
        const result = persistArchive({
          config,
          book,
          chapter,
          markdown: body,
          sourceIndex,
          readerInput: args.readerInput === true,
        });

        if (result.ok === false) {
          const lines = [
            `${chapterId} 的档案被拒收：${result.violations.length} 处违规，未落盘。`,
            '',
            ...result.violations.map(formatViolation),
            ...(result.warnings.length > 0
              ? ['', '另有提示（不阻塞落盘）：', ...result.warnings.map((warning) => `  - ${warning}`)]
              : []),
            '',
            `修法：用 edit 直接改 ${draftGuess(config, book, chapterId)}（不要重跑 workflow——那会重新付一遍精读的钱），改完再调用一次 reading_archive。`,
          ];
          return {
            ok: false,
            action: 'reading_archive',
            code: 'VERIFY',
            reason: `${chapterId} 的档案未通过校验：${result.violations.map((violation) => violation.code).join('、')}`,
            nextStep: nextStepFor('VERIFY'),
            bookId: book.bookId,
            chapterId,
            quoteCount: result.quoteLocators.length,
            violations: result.violations.map(formatViolation),
            warnings: result.warnings,
            lines,
          };
        }

        if (mode === 'check') {
          return {
            ok: true,
            action: 'reading_archive',
            bookId: book.bookId,
            chapterId,
            state: 'checked',
            quoteCount: result.quoteLocators.length,
            warnings: result.warnings,
            lines: [
              `${chapterId} 可以落盘：引文 ${result.quoteLocators.length} 条全部逐字命中，结构齐全。（mode=check，未写盘）`,
              ...result.quoteLocators.map((locator) => `  引文 ${locator}`),
            ],
          };
        }

        // The archive is on disk and registered; the reader's position moves with it.
        setProgress(config, {
          bookId: book.bookId,
          chapterId,
          title: book.title,
        });
        const profile = readProfile(config);
        const archivedCount = Object.keys(book.archives ?? {}).length;
        const coveredChars = book.chapters
          .filter((entry) => book.archives?.[entry.id] !== undefined)
          .reduce((sum, entry) => sum + entry.chars, 0);

        return {
          ok: true,
          action: 'reading_archive',
          bookId: book.bookId,
          chapterId,
          state: result.state,
          path: result.path,
          draftPath: usedDraft ? draftGuess(config, book, chapterId) : '',
          quoteCount: result.quoteLocators.length,
          warnings: result.warnings,
          coverageLine: `${archivedCount}/${book.chapters.length} 章，覆盖 ${coveredChars}/${book.stats.chars} 字`,
          nextStep: nextArchiveStep(book, chapterId),
          lines: [
            `${chapterId} 已落盘：state=${result.state}，引文 ${result.quoteLocators.length} 条全部逐字命中原文。`,
            `记忆：${relativeMemoryPath(book.bookId, chapterId)}`,
            `进度：${archivedCount}/${book.chapters.length} 章，覆盖 ${coveredChars}/${book.stats.chars} 字。`,
            ...(result.warnings.length > 0 ? ['提示：', ...result.warnings.map((warning) => `  - ${warning}`)] : []),
            `读者标记：${profile.marks.length} 条。`,
            nextArchiveStep(book, chapterId),
          ],
        };
      }, (failure) => refusalValue(failure, 'reading_archive'));
    },
  });
}

/** Where the draft for a chapter lives. Mirrors the workflow script's rule. */
function draftGuess(config, book, chapterId) {
  return join(bookDir(config, book.bookId), 'drafts', `${chapterId}.md`);
}

function formatViolation(violation) {
  return `  [${violation.code}] ${violation.where}：${violation.detail}\n      修法：${violation.fix}`;
}

function nextArchiveStep(book, chapterId) {
  const archived = book.archives ?? {};
  const chapter = book.chapters.find((entry) => entry.id === chapterId);
  const next = book.chapters.find((entry) => entry.index > chapter.index && archived[entry.id] === undefined);
  if (next !== undefined) {
    return `下一章 ${next.id}（${next.title === '' ? '（无标题）' : next.title}）还没有建档；用 reading_status 拿下一波的 workflow args。`;
  }
  const missing = book.chapters.filter((entry) => archived[entry.id] === undefined);
  if (missing.length > 0) {
    return `还有 ${missing.length} 章未建档（${missing.map((entry) => entry.id).join('、')}）；用 reading_status 拿下一波的 workflow args。`;
  }
  return `全书 ${book.chapters.length} 章已建档。可以开始按章讲解与共读了。`;
}

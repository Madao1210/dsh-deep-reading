/**
 * The workflow script body — Map → Model → Reduce over one wave of chapters.
 *
 * Written as a real function so the JS parser checks it and so tests can drive
 * it in-process with fake hooks; `workflow.js` turns it into the script text with
 * `toString()` and prepends `const __DR = {…}` carrying the prompt templates and
 * schemas. `__DR` and the hooks are injected by the workflow sandbox.
 *
 * Three decisions carry this file:
 *
 *   1. **The archive body never travels through the main agent's context.**
 *      The Reduce subagent writes the draft to `drafts/<chapter>.md` and returns a
 *      three-line receipt; the plugin later verifies that file from disk. The
 *      alternative — the markdown coming back in the workflow's return value and
 *      then going out again in a tool argument — is the single largest resident
 *      cost in this kind of run (measured on the previous attempt at this plugin:
 *      11.7M tokens for a 105k-character book, 62k of it the assistant's own
 *      resident text).
 *   2. **Map and Model results are validated *and* cached.** Each subagent
 *      returns its result under a schema (so the structure is guaranteed) and
 *      also writes the same JSON to disk. The plugin only reports an entry as
 *      cached when that file actually parses, so a half-written cache entry can
 *      never be mistaken for a real reading.
 *   3. **Model sits between Map and Reduce, and it reads the whole chapter.**
 *      Reduce only ever holds fragments, and a chapter model assembled from
 *      fragments comes out fragment-shaped — which is exactly the source-shaped
 *      lecture this stage exists to prevent. Reduce hangs the points on the
 *      model; it does not have to invent the model.
 *
 * Failure discipline: a missing/invalid arg throws and kills the run (a
 * half-produced wave is worse than no wave); a failed subagent becomes a
 * reported gap, and the chapter's archive must say so in 「本节留下的口子」.
 * A failed Model step is deliberately NOT papered over by synthesising a model
 * from the points — Reduce is told to say so instead.
 */

/**
 * @param {object} __DR  injected: { mapTemplate, modelTemplate, reduceTemplate, archiveTemplate,
 *                       mapSchema, modelSchema, reduceSchema, promptRevision }
 * @param {object} args  the workflow tool's `args`
 * @param {{ agent: Function, parallel: Function, pipeline: Function, phase: Function, log: Function }} hooks
 */
async function runDeepReading(__DR, args, hooks) {
  const { agent, parallel, pipeline, phase, log } = hooks;

  // ── args ────────────────────────────────────────────────────────────────────
  const a = args ?? {};
  const str = (value) => (typeof value === 'string' ? value.trim() : '');
  const bookId = str(a.bookId);
  const bookDir = str(a.bookDir);
  const sourcePath = str(a.sourcePath);
  const title = str(a.title) === '' ? '（未命名）' : str(a.title);
  const chapters = Array.isArray(a.chapters) ? a.chapters : [];
  const cachedChunkIds = new Set(Array.isArray(a.cachedChunkIds) ? a.cachedChunkIds.map(str) : []);
  const cachedChapterModels = new Set(Array.isArray(a.cachedChapterModels) ? a.cachedChapterModels.map(str) : []);

  if (bookId === '') throw new Error('[FATAL] args.bookId 缺失：先调用 reading_open');
  if (bookDir === '') throw new Error('[FATAL] args.bookDir 缺失：先调用 reading_open');
  if (sourcePath === '') throw new Error('[FATAL] args.sourcePath 缺失：先调用 reading_open');
  if (chapters.length === 0) {
    throw new Error('[FATAL] args.chapters 为空：这一波没有需要处理的章节。先调用 reading_status 确认还剩哪些章没建档。');
  }
  if (typeof agent !== 'function' || typeof pipeline !== 'function') {
    throw new Error('[FATAL] workflow 钩子缺失：本脚本只能在 workflow 工具里运行。');
  }

  // ── path helpers live inside the body so `toString()` carries them ──────────
  const sep = bookDir.includes('\\') ? '\\' : '/';
  const mapOutPath = (chunkId) => `${bookDir}${sep}map${sep}${chunkId.replace('#', '_')}.${__DR.promptRevision}.json`;
  // Mirrors modelOutPath() in lib/pipeline/model.js — the drive test requires the
  // plugin to find the file the script actually wrote, which keeps them in sync.
  const modelOutPath = (chapterId) => `${bookDir}${sep}models${sep}${chapterId}.${__DR.promptRevision}.json`;
  const draftPath = (chapterId) => `${bookDir}${sep}drafts${sep}${chapterId}.md`;
  const fill = (template, vars) => {
    let out = template;
    for (const key of Object.keys(vars)) out = out.split(`%%${key}%%`).join(String(vars[key]));
    return out;
  };

  phase('逐章精读与合成');

  const results = await pipeline(
    chapters,

    // ── Map: one subagent per uncached chunk, all in parallel ────────────────
    async (_previous, chapter) => {
      const chunks = Array.isArray(chapter.chunks) ? chapter.chunks : [];
      const pending = chunks.filter((chunk) => cachedChunkIds.has(chunk.id) === false);
      const reused = chunks.filter((chunk) => cachedChunkIds.has(chunk.id));

      const mapped = pending.length === 0 ? [] : await parallel(pending.map((chunk) => async () => {
        const outPath = mapOutPath(chunk.id);
        const prompt = fill(__DR.mapTemplate, {
          TITLE: title,
          CHAPTER_ID: chapter.id,
          CHUNK_ID: chunk.id,
          START_LINE: chunk.startLine,
          END_LINE: chunk.endLine,
          SOURCE_PATH: sourcePath,
          MAP_OUT_PATH: outPath,
        });
        const receipt = await agent(prompt, {
          label: `${chapter.id} ${chunk.id}`,
          phase: '逐章精读与合成',
          schema: __DR.mapSchema,
        });
        return { chunkId: chunk.id, path: outPath, ok: receipt !== null, findings: receipt };
      }));

      const ok = mapped.filter((entry) => entry.ok).length;
      log(`${chapter.id}：精读 ${ok}/${pending.length} 块完成${reused.length > 0 ? `，${reused.length} 块命中缓存` : ''}`);
      return {
        chapterId: chapter.id,
        chunks: chunks.map((chunk) => ({ id: chunk.id, startLine: chunk.startLine, endLine: chunk.endLine })),
        mapped,
        reusedIds: reused.map((chunk) => chunk.id),
      };
    },

    // ── Model: one subagent per chapter, reading the whole chapter ────────────
    //
    // This is the step that decides whether the lecture comes out model-shaped
    // or source-shaped. It is deliberately given the source only — not the
    // points — so that it forms a first-hand judgement instead of summarising
    // fragments, and it is the only step that reads the chapter end to end.
    async (previous, chapter) => {
      if (previous === null || previous === undefined) return null;
      const outPath = modelOutPath(chapter.id);

      if (cachedChapterModels.has(chapter.id)) {
        log(`${chapter.id}：mental model 命中缓存`);
        return { ...previous, model: null, modelPath: outPath, modelCached: true, modelFailed: false };
      }

      const prompt = fill(__DR.modelTemplate, {
        TITLE: title,
        CHAPTER_ID: chapter.id,
        CHAPTER_TITLE: chapter.title === '' ? '（无标题）' : chapter.title,
        START_LINE: chapter.startLine,
        END_LINE: chapter.endLine,
        SOURCE_PATH: sourcePath,
        MODEL_OUT_PATH: outPath,
      });
      const receipt = await agent(prompt, {
        label: `${chapter.id} mental model`,
        phase: '逐章精读与合成',
        schema: __DR.modelSchema,
      });
      const ok = receipt !== null && str(receipt.chapterModel) !== '';
      log(`${chapter.id}：${ok ? 'mental model 已形成' : 'mental model 失败'}`);
      return { ...previous, model: ok ? receipt : null, modelPath: outPath, modelCached: false, modelFailed: ok === false };
    },

    // ── Reduce: one subagent per chapter, writing the draft to disk ───────────
    async (previous, chapter) => {
      if (previous === null || previous === undefined) return null;
      const rangeOf = (chunkId) => {
        const found = previous.chunks.find((chunk) => chunk.id === chunkId);
        return found === undefined ? '' : `（第 ${found.startLine}–${found.endLine} 行）`;
      };

      const findings = [
        ...previous.mapped.map((entry) => (entry.ok
          ? `- 块 ${entry.chunkId}${rangeOf(entry.chunkId)}：精读完成，结果如下；同一份 JSON 也缓存在 \`${entry.path}\`。\n\n\`\`\`json\n${JSON.stringify(entry.findings, null, 2)}\n\`\`\``
          : `- 块 ${entry.chunkId}${rangeOf(entry.chunkId)}：**精读失败**，这一块没有证据。`
            + '必须在（本节留下的口子）里写明这一段没有被覆盖，不要凭印象补上它的内容。')),
        ...previous.reusedIds.map((chunkId) => `- 块 ${chunkId}${rangeOf(chunkId)}：命中上次的精读缓存，用 read 读 \`${mapOutPath(chunkId)}\` 取回。`
          + '读不出合法 JSON 时不要猜内容，把这一块记进（本节留下的口子）。'),
      ].join('\n');

      // What Reduce hangs the points on. A cached or failed model is not
      // silently replaced by a model synthesised from the points: that would
      // produce exactly the fragment-shaped skeleton this stage exists to
      // prevent, and it would look indistinguishable from a real one.
      const modelBlock = previous.modelCached === true
        ? `（本章的 mental model 命中缓存：用 read 读 \`${previous.modelPath}\` 取回。）`
        : (previous.modelFailed === true
          ? '（**本章的 mental model 没有形成**：Model 步骤失败。不要用下面的 point 拼一个出来——'
            + '那正是这一步要避免的。（这一章真正在解决什么）一节按原文如实写，'
            + '并在（本节留下的口子）里写明本章缺少一次整体阅读。）'
          : `\`\`\`json\n${JSON.stringify(previous.model, null, 2)}\n\`\`\``);

      const draft = draftPath(chapter.id);
      const prompt = fill(__DR.reduceTemplate, {
        TITLE: title,
        CHAPTER_ID: chapter.id,
        CHAPTER_TITLE: chapter.title === '' ? '（无标题）' : chapter.title,
        START_LINE: chapter.startLine,
        END_LINE: chapter.endLine,
        SOURCE_PATH: sourcePath,
        CHAPTER_MODEL: modelBlock,
        CHUNK_FINDINGS: findings,
        CACHED_HINT: '',
        DRAFT_PATH: draft,
        ARCHIVE_TEMPLATE: __DR.archiveTemplate,
      });

      const receipt = await agent(prompt, {
        label: `${chapter.id} 合成档案`,
        phase: '逐章精读与合成',
        schema: __DR.reduceSchema,
      });
      const ok = receipt !== null && receipt.written === true;
      log(`${chapter.id}：${ok ? '档案草稿已落盘' : '合成失败或未落盘'}`);
      return {
        chapterId: chapter.id,
        ok,
        draftPath: receipt !== null && str(receipt.draftPath) !== '' ? str(receipt.draftPath) : draft,
        mapFailures: previous.mapped.filter((entry) => entry.ok === false).map((entry) => entry.chunkId),
        modelFailed: previous.modelFailed === true,
      };
    },
  );

  const done = results.filter((entry) => entry !== null && entry !== undefined);
  return {
    ok: true,
    bookId,
    chapters: done.map((entry) => ({
      chapterId: entry.chapterId,
      ok: entry.ok === true,
      draftPath: entry.draftPath,
      mapFailures: entry.mapFailures,
      modelFailed: entry.modelFailed === true,
    })),
    failedChapters: chapters
      .filter((_chapter, index) => results[index] === null || results[index] === undefined)
      .map((chapter) => chapter.id),
    nextStep: '对每个 ok=true 的章节调用 reading_archive({ bookId, chapterId })，由插件校验草稿并落盘。'
      + '被拒收时按 violations 用 edit 修 drafts/<章节>.md，再重新提交；不要重跑 workflow（那会重新付一遍精读与 model 的钱）。'
      + 'modelFailed=true 的章节表示（整体阅读）这一步失败了：草稿里会写明，讲解时要如实交代。',
  };
}

export { runDeepReading };

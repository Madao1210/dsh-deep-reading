/**
 * Typed plugin errors.
 *
 * Tools turn these into a structured refusal (`ok: false` + `code` + `reason`
 * + `nextStep`) rather than throwing a bare string: a failure the model cannot
 * act on is worse than no result at all.
 */

export class DeepReadingError extends Error {
  /**
   * @param {string} code
   * @param {string} reason human-readable, actionable, in the user's language
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, reason, details = {}) {
    super(reason);
    this.name = 'DeepReadingError';
    this.code = code;
    this.reason = reason;
    this.details = details;
  }
}

export const inputError = (reason, details) => new DeepReadingError('INPUT', reason, details);
export const notFoundError = (reason, details) => new DeepReadingError('NOT_FOUND', reason, details);
export const configError = (reason, details) => new DeepReadingError('CONFIG', reason, details);
export const sourceError = (reason, details) => new DeepReadingError('SOURCE', reason, details);
export const verifyError = (reason, details) => new DeepReadingError('VERIFY', reason, details);

/** Next action per refusal code, so every refusal tells the model what to do. */
export function nextStepFor(code) {
  switch (code) {
    case 'INPUT':
      return '修正参数后重试。';
    case 'NOT_FOUND':
      return '先用 reading_open 打开这本书，或调用 reading_status 查看已打开的书。';
    case 'CONFIG':
      return '修正 cordis.patch.yml 里的配置后重启 dsh（配置错误不会靠重试自愈）。';
    case 'SOURCE':
      return '检查源文件路径与大小上限；源文件读不动时，改用 textPath 传入已提取好的纯文本。';
    case 'NEEDS_SUBAGENT_FETCH':
      return '本格式无法确定性解析：把 returnedPrompt 交给一个子代理，让它把全文写到 textPath 指向的文件，再用 reading_open({ textPath }) 重新导入。';
    case 'VERIFY':
      return '阅读 violations 逐条修正档案正文后重新提交（插件不会替你改引文；引文对不上就删掉它或改标为推断）。';
    default:
      return '阅读 reason 后修正调用。';
  }
}

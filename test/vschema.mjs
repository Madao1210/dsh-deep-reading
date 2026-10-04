/**
 * Minimal stand-in for the host's output validator (dsh-tools runs
 * `validateJsonSchemaValue(tool.output.schema, value)` and throws ToolOutputError
 * on mismatch). We cannot import the host's copy, so this checks the two rules
 * that actually bite: every returned key must be declared, and its type must match.
 */
export function validateValue(schema, value, at = '$', errs = []) {
  const t = schema.type;
  if (t === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errs.push(`${at}: 期望 object，收到 ${describe(value)}`);
      return errs;
    }
    for (const k of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties ?? {}, k)) errs.push(`${at}.${k}: 未在 output.schema 里声明`);
    }
    for (const [k, s] of Object.entries(schema.properties ?? {})) {
      if (value[k] === undefined) continue;
      validateValue(s, value[k], `${at}.${k}`, errs);
    }
    return errs;
  }
  if (t === 'array') {
    if (!Array.isArray(value)) { errs.push(`${at}: 期望 array，收到 ${describe(value)}`); return errs; }
    value.forEach((v, i) => validateValue(schema.items, v, `${at}[${i}]`, errs));
    return errs;
  }
  if (t === 'string') {
    if (typeof value !== 'string') errs.push(`${at}: 期望 string，收到 ${describe(value)}`);
    return errs;
  }
  if (t === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) errs.push(`${at}: 期望 number，收到 ${describe(value)}`);
    return errs;
  }
  if (t === 'boolean') {
    if (typeof value !== 'boolean') errs.push(`${at}: 期望 boolean，收到 ${describe(value)}`);
    return errs;
  }
  errs.push(`${at}: 未知 schema 类型 ${String(t)}`);
  return errs;
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** The value DSL forbids `required` and demands an explicit boolean on every object node. */
export function auditSchemaNode(schema, at = '$', errs = []) {
  for (const key of ['required', 'allOf', 'anyOf', 'oneOf', 'not']) {
    if (Object.hasOwn(schema, key)) errs.push(`${at}: output.schema 不允许出现 ${key}`);
  }
  if (schema.type === 'object') {
    if (typeof schema.additionalProperties !== 'boolean') {
      errs.push(`${at}: object 节点必须显式写 additionalProperties`);
    }
    for (const [k, s] of Object.entries(schema.properties ?? {})) auditSchemaNode(s, `${at}.${k}`, errs);
  } else if (schema.type === 'array') {
    auditSchemaNode(schema.items, `${at}[]`, errs);
  }
  return errs;
}

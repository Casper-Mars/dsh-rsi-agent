/**
 * 字段级脱敏（技术方案 §13.3，风险项「日志脱敏不完整」的落地）。
 *
 * 出口只有一个：日志**写盘前**（exporter 的 `write`）统一过 {@link redactRecord}，
 * 保证 JSONL 中不出现明文凭证、金额与超长正文。
 *
 * 口径（fail-closed，宁可多遮）：
 *   1. **敏感键**（大小写不敏感、归一化后**子串**命中）：
 *      `token / secret / password / passwd / authorization / cookie /
 *       api[-_]?key / access[-_]?key / private[-_]?key / credential /
 *       session[-_]?key / bearer`，外加领域扩展 `secretKeys`；
 *      命中 → 值替换 {@link REDACTED}，**保留键名**（结构仍可排障）。
 *   2. **金额 / 成本键**：`cost / amount / price / pnl / profit / balance /
 *      position / equity / …`，外加领域扩展 `amountKeys`；同样替换为
 *      {@link REDACTED}。领域扩展让「本领域特有口径」不必改核心代码。
 *   3. **文本级**：`key=value` / `key: value`（一行多键、空格 / 逗号分隔）、
 *      `Bearer <x>`、前缀型裸令牌（`sk-` / `ghp_` / `xoxb-` / `AKIA`）。
 *      分隔符兼容全角 `：` / `＝`，键名兼容中文（如 `密码：abc`）。
 *   4. **长文本**：任意字符串超过 {@link DEFAULT_MAX_TEXT_LENGTH}（2000 **码点**，
 *      见 {@link truncate}）→ 截断 + {@link TRUNCATED_SUFFIX}。不再区分键名，
 *      避免「换个键名就绕过预算」。
 *   5. **Error** → `{ name, message, stack: 前 10 行 }`（message / stack 同样走文本级）。
 *   6. **护栏**：深度上限 6、数组上限 100、循环引用 → {@link CIRCULAR_MARKER}。
 *   7. **fail-closed（关键）**：脱敏函数自身抛错时，该字段值替换为
 *      {@link REDACTED} —— 绝不允许「脱敏失败 → 明文放行」。
 *
 * 纯函数、零第三方依赖、无 IO。
 */

/** 敏感值替换字面量。 */
export const REDACTED = '[REDACTED]'

/** 长文本截断后缀。 */
export const TRUNCATED_SUFFIX = '…[truncated]'

/** 循环引用替换字面量。 */
export const CIRCULAR_MARKER = '[Circular]'

/** 超过深度上限的替换字面量。 */
export const MAX_DEPTH_MARKER = '[MaxDepth]'

/** 默认长文本阈值（字符数）。 */
export const DEFAULT_MAX_TEXT_LENGTH = 2000

/** 默认深度上限。 */
export const DEFAULT_MAX_DEPTH = 6

/** 默认数组元素上限。 */
export const DEFAULT_MAX_ARRAY_LENGTH = 100

/** 默认 Error stack 保留行数。 */
export const DEFAULT_MAX_STACK_LINES = 10

/**
 * 基础敏感键（支持 `[-_]?` 形态写法；匹配前会归一化为纯小写字母数字）。
 *
 * 注意 `bearer` 作为**键名**几乎不会出现，但它以 `Bearer` 形式出现在文本里，
 * 故文本级另有专门扫描（见 {@link redactText}），此处保留以自证口径。
 */
export const BASE_SECRET_KEY_PATTERNS: readonly string[] = Object.freeze([
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'api[-_]?key',
  'access[-_]?key',
  'private[-_]?key',
  'credential',
  'session[-_]?key',
  'bearer',
  // 中文键（fail-closed 方向，基础表可适度扩充）。归一化会丢掉非 ASCII 字符，
  // 故这类词由 {@link buildCjkTokens} 单独抽取并按原样做子串匹配。
  '密码',
  '口令',
  '密钥',
  '秘钥',
  '私钥',
  '凭证',
  '令牌',
])

/** 默认金额 / 成本键（子串匹配，覆盖 `costPrice` / `positionValue` 等组合形态）。 */
export const DEFAULT_AMOUNT_KEY_PATTERNS: readonly string[] = Object.freeze([
  'cost',
  'amount',
  'price',
  'pnl',
  'profit',
  'balance',
  'position',
  'equity',
  'value',
  'fee',
  'commission',
  'turnover',
  'principal',
  'capital',
  'drawdown',
])

/** {@link redactRecord} / {@link redactText} 选项。 */
export interface RedactOptions {
  /** 追加的敏感键（与 {@link BASE_SECRET_KEY_PATTERNS} 并集）。 */
  readonly secretKeys?: readonly string[]
  /** 追加的金额 / 成本键（与 {@link DEFAULT_AMOUNT_KEY_PATTERNS} 并集）。 */
  readonly amountKeys?: readonly string[]
  /** 长文本阈值（字符数，`<= 0` 表示不截断）。默认 2000。 */
  readonly maxTextLength?: number
  /** 深度上限（> 0）。默认 6。 */
  readonly maxDepth?: number
  /** 数组元素上限（> 0）。默认 100。 */
  readonly maxArrayLength?: number
  /** Error stack 保留行数（> 0）。默认 10。 */
  readonly maxStackLines?: number
  /** 替换字面量。默认 {@link REDACTED}。 */
  readonly replacement?: string
}

/** 解析后的选项（各字段均已就绪，避免深遍历中反复判空）。 */
interface ResolvedOptions {
  readonly secretTokens: readonly string[]
  readonly secretCjkTokens: readonly string[]
  readonly amountTokens: readonly string[]
  readonly maxTextLength: number
  readonly maxDepth: number
  readonly maxArrayLength: number
  readonly maxStackLines: number
  readonly replacement: string
}

/** 键名 / 模式归一化：小写 + 仅保留字母数字。 */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 把 `api[-_]?key` 这类模式归一化为可做子串匹配的纯文本（`apikey`）。 */
function normalizePattern(pattern: string): string {
  return normalize(pattern.replace(/\[-_\]\?/g, ''))
}

/** 正整数归位。 */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

/** 合并「基础词表 + 领域扩展」并归一化去重。 */
function buildTokens(base: readonly string[], extra: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const pattern of base) {
    const token = normalizePattern(pattern)
    if (token !== '') out.push(token)
  }
  if (Array.isArray(extra)) {
    for (const pattern of extra) {
      if (typeof pattern !== 'string') continue
      const token = normalizePattern(pattern)
      if (token !== '') out.push(token)
    }
  }
  return [...new Set(out)]
}

/** 中文（CJK）片段抽取：用于按键原文做子串匹配。 */
function buildCjkTokens(
  base: readonly string[],
  extra: readonly string[] | undefined,
): string[] {
  const seen = new Set<string>()
  for (const pattern of [...base, ...(Array.isArray(extra) ? extra : [])]) {
    if (typeof pattern !== 'string') continue
    for (const run of pattern.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g) ?? []) {
      seen.add(run)
    }
  }
  return [...seen]
}

/** 判据：键名是否命中敏感词（ASCII 走归一化子串，中文走原文子串）。 */
function hitsSecretKey(key: string, opts: ResolvedOptions): boolean {
  const normalized = normalize(key)
  if (opts.secretTokens.some((token) => normalized.includes(token))) return true
  return opts.secretCjkTokens.some((token) => key.includes(token))
}

function resolveOptions(options: RedactOptions | undefined): ResolvedOptions {
  const replacement =
    typeof options?.replacement === 'string' && options.replacement !== ''
      ? options.replacement
      : REDACTED
  const maxTextLength =
    typeof options?.maxTextLength === 'number' && Number.isFinite(options.maxTextLength)
      ? Math.floor(options.maxTextLength)
      : DEFAULT_MAX_TEXT_LENGTH
  return {
    secretTokens: buildTokens(BASE_SECRET_KEY_PATTERNS, options?.secretKeys),
    secretCjkTokens: buildCjkTokens(BASE_SECRET_KEY_PATTERNS, options?.secretKeys),
    amountTokens: buildTokens(DEFAULT_AMOUNT_KEY_PATTERNS, options?.amountKeys),
    maxTextLength,
    maxDepth: positiveInt(options?.maxDepth, DEFAULT_MAX_DEPTH),
    maxArrayLength: positiveInt(options?.maxArrayLength, DEFAULT_MAX_ARRAY_LENGTH),
    maxStackLines: positiveInt(options?.maxStackLines, DEFAULT_MAX_STACK_LINES),
    replacement,
  }
}

/** 判据：键名是否命中敏感词（归一化子串）。 */
export function isSensitiveKey(
  key: string,
  options?: Pick<RedactOptions, 'secretKeys'>,
): boolean {
  if (typeof key !== 'string') return false
  const normalized = normalize(key)
  const tokens = buildTokens(BASE_SECRET_KEY_PATTERNS, options?.secretKeys)
  if (tokens.some((token) => normalized.includes(token))) return true
  return buildCjkTokens(BASE_SECRET_KEY_PATTERNS, options?.secretKeys).some((token) =>
    key.includes(token),
  )
}

/** 判据：键名是否命中金额 / 成本词（归一化子串）。 */
export function isAmountKey(key: string, options?: Pick<RedactOptions, 'amountKeys'>): boolean {
  if (typeof key !== 'string') return false
  const normalized = normalize(key)
  const tokens = buildTokens(DEFAULT_AMOUNT_KEY_PATTERNS, options?.amountKeys)
  return tokens.some((token) => normalized.includes(token))
}

/**
 * 截断长文本（`max <= 0` 不截断）。
 *
 * 边界口径按 **Unicode 码点**计数（`Array.from`），而非 UTF-16 码元：
 * 按码元 `slice` 会把 emoji 的代理对切成孤立代理，`JSON.stringify` 后落盘成
 * `\ud83d` 这类非法转义。快速路径用 `text.length <= max` 提前返回（码点数必然
 * ≤ 码元数），仅在真正超限时才做码点切分，避免热路径上的额外分配。
 */
function truncate(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text
  const points = Array.from(text)
  if (points.length <= max) return text
  return `${points.slice(0, max).join('')}${TRUNCATED_SUFFIX}`
}

/** 取前 n 行（`\r\n` 归一为 `\n`）。 */
function firstLines(text: string, n: number): string {
  return text.split(/\r?\n/).slice(0, Math.max(1, n)).join('\n')
}

/**
 * 赋值形态：`key=value` / `key: value`（键可选引号，值可为引号串）。
 *
 * 兼容全角分隔符 `：` / `＝` 与中文键名（`密码：abc`）。
 */
function assignmentRx(): RegExp {
  return /(["']?)([A-Za-z\u3400-\u4DBF\u4E00-\u9FFF][A-Za-z0-9_.\-\u3400-\u4DBF\u4E00-\u9FFF]{0,63})(["']?)(\s*[:：=＝]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|Bearer\s+[^\s,;)\]}"'&]+|[^\s,;)\]}"'&]+)/g
}

/** 文本级「裸 Bearer 令牌」：按形态判定（≥ 8 位令牌字符），不做高熵猜测。 */
function bearerRx(): RegExp {
  return /\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi
}

/** 文本级「已知前缀令牌」（`sk-` / `ghp_` / `xoxb-` / `AKIA`）。 */
function prefixTokenRx(): RegExp {
  return /\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bxox[bpoas]-[A-Za-z0-9-]{8,}|\bAKIA[0-9A-Z]{8,}/g
}

/** 保持引号形态地包裹替换值。 */
function wrapReplacement(value: string, replacement: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return `"${replacement}"`
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return `'${replacement}'`
  return replacement
}

/** 赋值替换：命中敏感 / 金额键 → 遮蔽值；未命中则对值再递归一次（处理 `Error: token=abc`）。 */
function redactAssignments(
  text: string,
  opts: ResolvedOptions,
  depth: number,
): string {
  return text.replace(
    assignmentRx(),
    (match: string, q1: string, key: string, q3: string, sep: string, value: string) => {
      const normalized = normalize(key)
      const hit =
        hitsSecretKey(key, opts) || opts.amountTokens.some((token) => normalized.includes(token))
      if (hit) return `${q1}${key}${q3}${sep}${wrapReplacement(value, opts.replacement)}`
      // 未命中：键可能只是句子前缀（`Error: token=abc`），对值再做一层（限深度防递归）。
      if (depth <= 0) return match
      return `${q1}${key}${q3}${sep}${redactAssignments(value, opts, depth - 1)}`
    },
  )
}

/** 文本级脱敏核心（不含截断）。 */
function redactTextCore(text: string, opts: ResolvedOptions): string {
  const assigned = redactAssignments(text, opts, 2)
  return assigned
    .replace(bearerRx(), () => opts.replacement)
    .replace(prefixTokenRx(), () => opts.replacement)
}

/**
 * 文本级脱敏（纯函数）：赋值遮蔽 → 裸令牌遮蔽 → 长文本截断。
 *
 * @param text    待处理文本。
 * @param options 见 {@link RedactOptions}。
 */
export function redactText(text: string, options?: RedactOptions): string {
  const opts = resolveOptions(options)
  if (typeof text !== 'string') return opts.replacement
  try {
    return truncate(redactTextCore(text, opts), opts.maxTextLength)
  } catch {
    // fail-closed：自身出错时宁可整段丢弃，也不放行可能含明文的原文。
    return opts.replacement
  }
}

/** 单字段安全脱敏：任何异常 → 替换值（fail-closed）。 */
function safely<T>(fn: () => T, replacement: string): T | string {
  try {
    return fn()
  } catch {
    return replacement
  }
}

/** `Error` → `{ name, message, stack: 前 N 行 }`。 */
function redactError(
  error: Error,
  opts: ResolvedOptions,
  depth: number,
  seen: Set<object>,
): Record<string, unknown> {
  const name = typeof error.name === 'string' && error.name !== '' ? error.name : 'Error'
  const message = typeof error.message === 'string' ? error.message : String(error)
  const out: Record<string, unknown> = {
    name: truncate(name, opts.maxTextLength),
    message: truncate(redactTextCore(message, opts), opts.maxTextLength),
  }
  if (typeof error.stack === 'string' && error.stack !== '') {
    const redactedStack = truncate(redactTextCore(error.stack, opts), opts.maxTextLength)
    out.stack = firstLines(redactedStack, opts.maxStackLines)
  }
  // 自定义错误常带附加字段（如 `err.code`），按普通对象口径继续脱敏，且同样受
  // 深度 / 循环护栏约束（seen 已包含 error 自身，故自引用会落为 CIRCULAR_MARKER）。
  const extra: Record<string, unknown> = {}
  for (const key of Object.keys(error)) {
    if (key === 'name' || key === 'message' || key === 'stack') continue
    extra[key] = safely(
      () => redactEntry(key, (error as unknown as Record<string, unknown>)[key], depth + 1, opts, seen),
      opts.replacement,
    )
  }
  if (Object.keys(extra).length > 0) out.details = extra
  return out
}

/** 数组遍历（元素上限护栏）。 */
function walkArray(
  values: readonly unknown[],
  depth: number,
  opts: ResolvedOptions,
  seen: Set<object>,
): unknown[] {
  const out: unknown[] = []
  const limit = Math.min(values.length, opts.maxArrayLength)
  for (let index = 0; index < limit; index += 1) {
    out.push(walk(values[index], depth, opts, seen))
  }
  if (values.length > limit) out.push(`[+${values.length - limit} more]`)
  return out
}

/** 单个键值对的脱敏口径（对象 / Map 共用，避免两处判定漂移）。 */
function redactEntry(
  key: string,
  value: unknown,
  depth: number,
  opts: ResolvedOptions,
  seen: Set<object>,
): unknown {
  return safely(() => {
    const normalized = normalize(key)
    if (hitsSecretKey(key, opts)) return opts.replacement
    if (opts.amountTokens.some((token) => normalized.includes(token))) return opts.replacement
    if (typeof value === 'string') {
      return truncate(redactTextCore(value, opts), opts.maxTextLength)
    }
    return walk(value, depth, opts, seen)
  }, opts.replacement)
}

/** 普通对象遍历。 */
function walkObject(
  object: Record<string, unknown>,
  depth: number,
  opts: ResolvedOptions,
  seen: Set<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(object)) {
    let value: unknown
    try {
      value = object[key]
    } catch {
      // fail-closed：getter 抛错时该字段直接丢弃内容，绝不放行明文。
      out[key] = opts.replacement
      continue
    }
    out[key] = redactEntry(key, value, depth, opts, seen)
  }
  return out
}

/** 深遍历入口。 */
function walk(value: unknown, depth: number, opts: ResolvedOptions, seen: Set<object>): unknown {
  if (value === null) return null
  const type = typeof value
  if (type === 'string') {
    return truncate(redactTextCore(value as string, opts), opts.maxTextLength)
  }
  if (type === 'number' || type === 'boolean') return value
  if (type === 'bigint') return (value as bigint).toString()
  if (type === 'undefined') return undefined
  if (type === 'function') return '[Function]'
  if (type === 'symbol') return truncate(redactTextCore(String(value), opts), opts.maxTextLength)

  const object = value as object
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? String(object) : object.toISOString()
  }
  if (object instanceof Error) return redactError(object, opts, depth, seen)
  if (depth >= opts.maxDepth) return MAX_DEPTH_MARKER
  if (seen.has(object)) return CIRCULAR_MARKER

  seen.add(object)
  try {
    if (Array.isArray(object)) return walkArray(object, depth + 1, opts, seen)
    if (object instanceof Map) {
      const mapped: Record<string, unknown> = {}
      let count = 0
      for (const [key, entry] of object) {
        if (count >= opts.maxArrayLength) break
        mapped[String(key)] = redactEntry(String(key), entry, depth + 1, opts, seen)
        count += 1
      }
      return mapped
    }
    if (object instanceof Set) return walkArray([...object], depth + 1, opts, seen)
    return walkObject(object as Record<string, unknown>, depth + 1, opts, seen)
  } finally {
    seen.delete(object)
  }
}

/**
 * 记录级脱敏（纯函数）：对整条日志记录逐字段脱敏。
 *
 * `msg` 走文本级口径；其余字段（含 `meta` 嵌套结构）走深遍历口径。
 *
 * @param record  日志记录（任意键）。
 * @param options 见 {@link RedactOptions}。
 * @returns 脱敏后的**新**记录（键名保留）。
 */
export function redactRecord(
  record: Record<string, unknown>,
  options?: RedactOptions,
): Record<string, unknown> {
  const opts = resolveOptions(options)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    let value: unknown
    try {
      value = record[key]
    } catch {
      // fail-closed：取值抛错 → 该字段替换为 [REDACTED]。
      out[key] = opts.replacement
      continue
    }
    out[key] = redactEntry(key, value, 0, opts, new Set<object>())
  }
  return out
}

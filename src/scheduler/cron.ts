/**
 * 5 段 cron 解析与「下一触发时刻」计算（零第三方依赖）。
 *
 * 硬约束（技术方案 §12.4）：
 *   1. **只支持 5 段**（分 时 日 月 周），最小粒度分钟，不接受秒字段；
 *   2. **时区由调用方注入**（`next(schedule, from, timezone)`），不做全局锁；
 *   3. 纯函数：`from` 即时钟注入点，不读全局 `now()`。
 *
 * 实现思路（为什么不是「逐分钟 UTC 扫描」）：
 *   - 先把 `from` 的下一个整分钟换算成**目标时区的墙钟时间**，在「naive 本地时间」
 *     （用 UTC 时间戳表示的墙钟）上做日历推进，最后再把墙钟映射回真实 UTC。
 *   - 这样跨夏令时也成立：映射后校验一次墙钟是否真的等于目标，必要时按差值迭代
 *     修正；落进 DST 空洞（不存在的墙钟时刻）则跳过该候选。
 *   - 日历推进按「月 → 日 → 时 → 分」跳级，而不是逐分钟暴力扫描，年级表达式
 *     （如 `0 0 29 2 *`）也不会退化成数百万次循环。
 *
 * 语法（Vixie/Linux 标准子集）：
 *   `*`、`?`（仅日/周）、`5`、`1,2,3`、`9-17`、`*\/15`、`9-17/2`；
 *   月份与星期支持英文缩写（`JAN` / `MON`），星期 `0` 与 `7` 都表示周日。
 *
 * DOM/DOW 语义：两者**都被限制**时取「或」（任一命中即触发，Vixie 标准）。
 */

/** 单个 cron 字段的解析结果。 */
export interface CronField {
  /** 命中值集合（升序去重）。 */
  readonly values: readonly number[]
  /** 是否被限制（`*` / `?` 以外的写法为 true）。 */
  readonly restricted: boolean
}

/** cron 表达式的解析结果。 */
export interface CronSchedule {
  /** 归一化后的表达式（用于诊断）。 */
  readonly expr: string
  readonly minute: CronField
  readonly hour: CronField
  readonly dayOfMonth: CronField
  readonly month: CronField
  readonly dayOfWeek: CronField
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const

/** 单个候选最大循环次数（5 年按「跳级」推进，远小于分钟数上限）。 */
const MAX_CANDIDATES = 500_000

function fieldError(expr: string, field: string, detail: string): Error {
  return new Error(`[cron] ${JSON.stringify(expr)} 非法：${field} ${detail}`)
}

function parseValue(
  expr: string,
  field: string,
  raw: string,
  min: number,
  max: number,
  names?: readonly string[],
): number {
  const upper = raw.toUpperCase()
  if (names !== undefined) {
    const index = names.indexOf(upper)
    if (index >= 0) return field === '月' ? index + 1 : index
  }
  if (!/^\d+$/.test(raw)) throw fieldError(expr, field, `取值 ${JSON.stringify(raw)} 不是整数`)
  const value = Number(raw)
  if (value < min || value > max) {
    throw fieldError(expr, field, `取值 ${value} 超出范围 ${min}-${max}`)
  }
  return value
}

interface FieldOptions {
  readonly allowQuestion?: boolean
  readonly names?: readonly string[]
  /** 星期 7 归一化为 0。 */
  readonly sundaySeven?: boolean
}

function parseField(
  expr: string,
  field: string,
  raw: string,
  min: number,
  max: number,
  options: FieldOptions = {},
): CronField {
  if (raw === '' ) throw fieldError(expr, field, '不能为空')
  if (raw === '*' || (options.allowQuestion === true && raw === '?')) {
    const values: number[] = []
    for (let value = min; value <= max; value += 1) values.push(value)
    return { values, restricted: false }
  }

  const values = new Set<number>()
  for (const part of raw.split(',')) {
    if (part === '') throw fieldError(expr, field, '含空枚举项')
    const [rangePart, stepPart, extra] = part.split('/')
    if (extra !== undefined) throw fieldError(expr, field, `步进写法非法：${JSON.stringify(part)}`)
    let step = 1
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) {
        throw fieldError(expr, field, `步长必须是正整数：${JSON.stringify(part)}`)
      }
      step = Number(stepPart)
    }

    let start: number
    let end: number
    if (rangePart === '*') {
      start = min
      end = max
    } else if (rangePart !== undefined && rangePart.includes('-')) {
      const [left, right, rest] = rangePart.split('-')
      if (rest !== undefined || left === '' || right === '') {
        throw fieldError(expr, field, `区间写法非法：${JSON.stringify(part)}`)
      }
      start = parseValue(expr, field, left, min, max, options.names)
      end = parseValue(expr, field, right, min, max, options.names)
      if (start > end) throw fieldError(expr, field, `区间起点大于终点：${JSON.stringify(part)}`)
    } else {
      const value = parseValue(expr, field, rangePart as string, min, max, options.names)
      if (stepPart === undefined) {
        values.add(options.sundaySeven === true && value === 7 ? 0 : value)
        continue
      }
      // `a/n` 语义：从 a 到字段上界，每 n 个取一个（与 Vixie 一致）。
      start = value
      end = max
    }

    for (let value = start; value <= end; value += step) {
      values.add(options.sundaySeven === true && value === 7 ? 0 : value)
    }
  }

  if (values.size === 0) throw fieldError(expr, field, '未命中任何取值')
  return { values: [...values].sort((a, b) => a - b), restricted: true }
}

/**
 * 解析 5 段 cron。
 *
 * @throws 段数不对 / 字段非法 / 取值越界时抛 `[cron] ...` 错误。
 */
export function parseCron(expr: string): CronSchedule {
  if (typeof expr !== 'string' || expr.trim() === '') {
    throw new Error('[cron] <空表达式> 非法：表达式必须为非空字符串')
  }
  const trimmed = expr.trim()
  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(
      `[cron] ${JSON.stringify(trimmed)} 非法：应含 5 段（分 时 日 月 周），实际 ${fields.length} 段`,
    )
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields as [string, string, string, string, string]

  return {
    expr: trimmed,
    minute: parseField(trimmed, '分', minuteRaw, 0, 59),
    hour: parseField(trimmed, '时', hourRaw, 0, 23),
    dayOfMonth: parseField(trimmed, '日', domRaw, 1, 31, { allowQuestion: true }),
    month: parseField(trimmed, '月', monthRaw, 1, 12, { names: MONTH_NAMES }),
    dayOfWeek: parseField(trimmed, '周', dowRaw, 0, 7, { allowQuestion: true, names: DOW_NAMES, sundaySeven: true }),
  }
}

/** cron 是否合法（不抛异常）。 */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 时区换算
// ---------------------------------------------------------------------------

interface LocalParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  /** 0=周日。 */
  readonly dayOfWeek: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone)
  if (cached !== undefined) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  formatterCache.set(timezone, formatter)
  return formatter
}

/** 某个 UTC 时刻在目标时区的墙钟分解。 */
export function localParts(timezone: string, epochMs: number): LocalParts {
  const parts = formatterFor(timezone).formatToParts(new Date(epochMs))
  const get = (type: string): number => {
    const found = parts.find((item) => item.type === type)
    return found === undefined ? 0 : Number(found.value)
  }
  const year = get('year')
  const month = get('month')
  const day = get('day')
  return {
    year,
    month,
    day,
    hour: get('hour') % 24,
    minute: get('minute'),
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  }
}

/** 墙钟 → naive 时间戳（把墙钟当作 UTC 读）。 */
function naiveOf(parts: LocalParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
}

/**
 * 墙钟 naive 时间戳 → 真实 UTC 时间戳。
 *
 * 用锚点时刻的偏移做初猜，再按「墙钟差」迭代修正（最多 4 轮，覆盖 DST 切换）。
 * 无法命中（DST 空洞里的不存在的墙钟）返回 `undefined`。
 */
function naiveToUtc(naive: number, timezone: string, anchorMs: number): number | undefined {
  const anchorMinute = Math.floor(anchorMs / 60_000) * 60_000
  const offset = naiveOf(localParts(timezone, anchorMinute)) - anchorMinute
  let guess = naive - offset
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const diff = naive - naiveOf(localParts(timezone, guess))
    if (diff === 0) return guess
    guess += diff
  }
  return undefined
}

function matchesDay(schedule: CronSchedule, parts: LocalParts): boolean {
  const domRestricted = schedule.dayOfMonth.restricted
  const dowRestricted = schedule.dayOfWeek.restricted
  const domOk = schedule.dayOfMonth.values.includes(parts.day)
  const dowOk = schedule.dayOfWeek.values.includes(parts.dayOfWeek)
  if (domRestricted && dowRestricted) return domOk || dowOk
  if (domRestricted) return domOk
  if (dowRestricted) return dowOk
  return true
}

/**
 * 计算严格大于 `from` 的下一次触发时刻（按 `timezone` 墙钟）。
 *
 * @param schedule {@link parseCron} 的结果。
 * @param from 起始时刻。
 * @param timezone IANA 时区名；缺省 `UTC`（调用方应传显式时区）。
 * @returns 绝对时刻（UTC `Date`）。
 * @throws 5 年内找不到触发时刻时抛错（例如 `0 0 31 2 *`）。
 */
export function next(schedule: CronSchedule, from: Date, timezone = 'UTC'): Date {
  const startMs = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000
  const local = localParts(timezone, startMs)
  let naive = naiveOf(local)

  for (let step = 0; step < MAX_CANDIDATES; step += 1) {
    const cursor = new Date(naive)
    const year = cursor.getUTCFullYear()
    const month = cursor.getUTCMonth() + 1
    const day = cursor.getUTCDate()
    const hour = cursor.getUTCHours()
    const minute = cursor.getUTCMinutes()

    if (!schedule.month.values.includes(month)) {
      naive = Date.UTC(year, month, 1)
      continue
    }
    if (!matchesDay(schedule, { year, month, day, hour, minute, dayOfWeek: cursor.getUTCDay() })) {
      naive = Date.UTC(year, month - 1, day + 1)
      continue
    }
    if (!schedule.hour.values.includes(hour)) {
      naive = Date.UTC(year, month - 1, day, hour + 1)
      continue
    }
    if (!schedule.minute.values.includes(minute)) {
      naive = Date.UTC(year, month - 1, day, hour, minute + 1)
      continue
    }

    const utc = naiveToUtc(naive, timezone, startMs)
    if (utc !== undefined && utc >= startMs) return new Date(utc)
    naive += 60_000
  }

  throw new Error(`[cron] ${JSON.stringify(schedule.expr)} 非法：5 年内无法找到下一触发时刻`)
}

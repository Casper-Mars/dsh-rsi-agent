/**
 * JSONL 落盘 sink（技术方案 §13.2）。
 *
 * 职责：把日志记录按天追加到 `<logsDir>/<UTC 日期>.jsonl`，写盘前统一过
 * {@link redactRecord} 脱敏。设计约束：
 *
 *   1. **同步追加**（`appendFileSync`，单条 JSON + `\n`）：`write()` 返回即已落盘，
 *      进程内天然有序；**不注册任何定时器**（无常驻开销）。
 *   2. **命名空间白名单**：只接受 `name === 'rsi-agent'` 或以 `rsi-agent:` / `rsi:`
 *      开头的记录，其余丢弃（返回 `false`）。sink 可能被宿主其它插件复用，白名单
 *      保证本插件的日志文件里不混入别人的行。
 *   3. **权限**：目录 `0o700`（创建 + chmod 兜底，规避 umask）、文件 `0o600`
 *      （创建 mode + 首次写入后 chmod 兜底）。
 *   4. **失败绝不上抛**：fs / 序列化 / 脱敏异常一律吞掉，置进程内 `degraded`
 *      标记并最多 `console.warn` 一次 —— 日志设施自身不得让业务抛错。
 *   5. **按大小滚动**：单文件 ≥ {@link DEFAULT_LOG_MAX_BYTES}（默认 500 MB，
 *      可用 `DSH_RSI_LOG_MAX_BYTES` 覆盖）→ 使用 `YYYY-MM-DD-1.jsonl`、`-2`… 中
 *      第一个未达阈值的文件。
 *   6. **保留策略**：创建时清理一次；之后每个 UTC 日最多一次（写盘前比较日期）。
 */

import { appendFileSync, chmodSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LogLevel } from './level.js'
import { redactRecord, type RedactOptions } from './redact.js'
import { cleanupExpiredLogs, resolveRetentionDays } from './retention.js'
import type { TraceContext } from './trace.js'

/** 环境变量：单文件大小阈值（字节）。 */
export const LOG_MAX_BYTES_ENV = 'DSH_RSI_LOG_MAX_BYTES'

/** 兼容旧名（`config.ts` 的 `DSH_RSI_LOG_MAX_SIZE`）。 */
export const LOG_MAX_SIZE_ENV = 'DSH_RSI_LOG_MAX_SIZE'

/** 默认单文件阈值：500 MB。 */
export const DEFAULT_LOG_MAX_BYTES = 500 * 1024 * 1024

/** 默认接受的命名空间白名单。 */
export const DEFAULT_SINK_NAMESPACES: readonly string[] = Object.freeze(['rsi-agent', 'rsi'])

/** 日文件名（UTC）。 */
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/

/** 滚动后缀的防御性上限（避免异常配置下死循环）。 */
const MAX_ROTATION_INDEX = 9_999

/** 进程内「已提示降级」标记（跨实例只提示一次）。 */
let warnedDegraded = false

/** 日志记录（sink 的输入形状）。 */
export interface JsonlLogRecord {
  /** 时间戳（epoch ms 或 ISO 字符串）；缺省用 sink 的时钟。 */
  readonly ts?: number | string
  /** 级别。 */
  readonly level: LogLevel
  /** 命名空间（须命中白名单才落盘）。 */
  readonly name: string
  /** 正文。 */
  readonly msg: string
  /** 结构化附加数据（深遍历脱敏）。 */
  readonly meta?: unknown
  /** trace 上下文（由门面自动注入）。 */
  readonly trace?: TraceContext
}

/** {@link createJsonlSink} 选项。 */
export interface JsonlSinkOptions {
  /** 日志目录（必填）。 */
  readonly logsDir: string
  /** 单文件阈值（字节，`<= 0` 关闭滚动）；缺省取环境变量 / 500 MB。 */
  readonly maxBytes?: number
  /** 保留天数；缺省取环境变量 / 30 天。 */
  readonly retentionDays?: number
  /** 脱敏选项（领域扩展键等）。 */
  readonly redact?: RedactOptions
  /** 额外接受的命名空间（与 {@link DEFAULT_SINK_NAMESPACES} 并集）。 */
  readonly namespaces?: readonly string[]
  /** 时钟注入（测试用）；默认 `Date.now`。 */
  readonly now?: () => number
  /** 环境变量来源；缺省 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv
}

/** JSONL sink 契约。 */
export interface JsonlSink {
  /** 写入一条记录；返回 `false` 表示被白名单拒绝或发生降级。 */
  write(record: JsonlLogRecord): boolean
  /** 释放资源（当前实现无句柄，保留幂等接口）。 */
  dispose(): void
  /** 指定日期（`YYYY-MM-DD`）当前应写入的文件路径（含滚动判定）。 */
  filePathFor(date: string): string
  /** 立即执行一次过期清理。 */
  cleanup(): void
  /** 是否已发生降级（写盘失败 / 目录不可用）。 */
  readonly degraded: boolean
}

/** 解析单文件阈值：显式 > `DSH_RSI_LOG_MAX_BYTES` > `DSH_RSI_LOG_MAX_SIZE` > 500 MB。 */
export function resolveMaxBytes(
  explicit?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit)
  }
  for (const key of [LOG_MAX_BYTES_ENV, LOG_MAX_SIZE_ENV]) {
    const raw = env[key]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const parsed = Number(raw.trim())
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return DEFAULT_LOG_MAX_BYTES
}

/** 命名空间判据：`name === ns` 或以 `ns:` 开头。 */
function matchesNamespace(name: string, namespaces: readonly string[]): boolean {
  if (typeof name !== 'string' || name === '') return false
  return namespaces.some((ns) => name === ns || name.startsWith(`${ns}:`))
}

/** epoch ms → ISO 8601。 */
function toIso(ts: number): string {
  return new Date(ts).toISOString()
}

/** epoch ms → `YYYY-MM-DD`（UTC）。 */
function toDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

/** 文件大小；不存在 / 读失败 → 0。 */
function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** sink 实现。 */
class JsonlFileSink implements JsonlSink {
  private readonly logsDir: string
  private readonly maxBytes: number
  private readonly retentionDays: number
  private readonly redactOptions: RedactOptions | undefined
  private readonly namespaces: readonly string[]
  private readonly now: () => number
  private readonly env: NodeJS.ProcessEnv

  /** 目录已就绪（创建 + chmod 成功）。 */
  private dirReady = false
  /** 已收紧为 `0o600` 的文件（避免逐行 chmod）。 */
  private readonly modeFixed = new Set<string>()
  /** 上次清理的 UTC 日期。 */
  private lastCleanupDate: string | undefined
  /** 降级标记。 */
  private degradedFlag = false

  constructor(options: JsonlSinkOptions) {
    this.logsDir = options.logsDir
    this.maxBytes = resolveMaxBytes(options.maxBytes, options.env ?? process.env)
    this.retentionDays = resolveRetentionDays(options.retentionDays, options.env ?? process.env)
    this.redactOptions = options.redact
    this.namespaces = [...new Set([...DEFAULT_SINK_NAMESPACES, ...(options.namespaces ?? [])])]
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.env = options.env ?? process.env

    // 目录若已存在，创建时就把权限收紧（测试会直接 stat 校验）。
    try {
      if (statSync(this.logsDir).isDirectory()) {
        try {
          chmodSync(this.logsDir, 0o700)
        } catch {
          /* 收紧失败不阻断：写入仍会尝试。 */
        }
      }
    } catch {
      /* 目录不存在：留待首次写入时创建。 */
    }

    this.cleanup()
  }

  get degraded(): boolean {
    return this.degradedFlag
  }

  write(record: JsonlLogRecord): boolean {
    try {
      if (!matchesNamespace(record.name, this.namespaces)) return false

      const now = this.now()
      const date = toDate(now)
      this.maybeCleanupDaily(date)
      this.ensureDir()

      const path = this.resolveTargetPath(date)
      const payload = this.buildRecord(record, now)
      appendFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o600 })
      this.ensureFileMode(path)
      return true
    } catch (error) {
      this.markDegraded(error)
      return false
    }
  }

  dispose(): void {
    /* 无长生命周期句柄；保留接口以对齐 sink 生命周期约定。 */
  }

  filePathFor(date: string): string {
    const safe = DATE_RX.test(date) ? date : toDate(this.now())
    return this.resolveTargetPath(safe)
  }

  cleanup(): void {
    try {
      this.lastCleanupDate = toDate(this.now())
      cleanupExpiredLogs(this.logsDir, this.retentionDays, {
        now: this.now(),
        env: this.env,
      })
    } catch {
      /* 清理失败只降级。 */
    }
  }

  /** 组装记录并脱敏（脱敏失败 → 抛给 {@link write} 的 catch，整行丢弃）。 */
  private buildRecord(record: JsonlLogRecord, now: number): Record<string, unknown> {
    const ts =
      typeof record.ts === 'number' && Number.isFinite(record.ts)
        ? toIso(record.ts)
        : typeof record.ts === 'string' && record.ts !== ''
          ? record.ts
          : toIso(now)

    const raw: Record<string, unknown> = {
      ts,
      level: record.level,
      name: record.name,
      msg: record.msg,
    }
    if (record.meta !== undefined) raw.meta = record.meta
    if (record.trace !== undefined) {
      raw.trace = {
        traceId: record.trace.traceId,
        ...(record.trace.taskId === undefined ? {} : { taskId: record.trace.taskId }),
        ...(record.trace.sessionId === undefined ? {} : { sessionId: record.trace.sessionId }),
      }
    }
    raw.pid = process.pid
    return redactRecord(raw, this.redactOptions)
  }

  /** 每个 UTC 日最多清理一次。 */
  private maybeCleanupDaily(today: string): void {
    if (this.lastCleanupDate === today) return
    this.cleanup()
  }

  /** 幂等创建目录并收紧到 `0o700`。 */
  private ensureDir(): void {
    if (this.dirReady) return
    mkdirSync(this.logsDir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(this.logsDir, 0o700)
    } catch {
      /* umask / 平台差异：mkdir mode 已尽量收紧。 */
    }
    this.dirReady = true
  }

  /** 解析目标文件：基础名 → `-1` → `-2`…，取第一个未达阈值的文件。 */
  private resolveTargetPath(date: string): string {
    const base = `${date}.jsonl`
    if (this.maxBytes <= 0) return join(this.logsDir, base)
    for (let index = 0; index <= MAX_ROTATION_INDEX; index += 1) {
      const name = index === 0 ? base : `${date}-${index}.jsonl`
      const path = join(this.logsDir, name)
      const size = sizeOf(path)
      if (size < this.maxBytes) return path
    }
    return join(this.logsDir, `${date}-${MAX_ROTATION_INDEX}.jsonl`)
  }

  /** 首次写入后 chmod `0o600`（规避 umask）。 */
  private ensureFileMode(path: string): void {
    if (this.modeFixed.has(path)) return
    try {
      chmodSync(path, 0o600)
    } catch {
      /* 收紧失败不致命。 */
    }
    this.modeFixed.add(path)
  }

  /** 置降级标记，并最多提示一次。 */
  private markDegraded(error: unknown): void {
    this.degradedFlag = true
    if (warnedDegraded) return
    warnedDegraded = true
    try {
      const detail = error instanceof Error ? error.message : String(error)
      console.warn(`[rsi-agent] 日志写盘降级（后续不再提示）：${detail}`)
    } catch {
      /* 连 console 都不可用时保持静默。 */
    }
  }
}

/**
 * 创建 JSONL sink。
 *
 * @param options 见 {@link JsonlSinkOptions}。
 */
export function createJsonlSink(options: JsonlSinkOptions): JsonlSink {
  return new JsonlFileSink(options)
}

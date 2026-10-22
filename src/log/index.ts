/**
 * 日志门面（技术方案 §13.1）：4 级门面 + JSONL sink 的组合入口。
 *
 * 一条日志的流向：
 *   1. **始终**尝试写 sink（`logsDir` 存在时），sink 内部做白名单 / 级别过滤 /
 *      脱敏 / 权限 / 保留策略；
 *   2. **同时**转发给原生 logger（`ctx.logger`）：有的方法就按
 *      `` `${scope} ${message}` `` 调用，没有则降级 `console`（仅本文件允许
 *      `console` 直写）。
 *
 * 两个关键设计：
 *   - **向后兼容**：`DomainLogger` 签名 `(message, meta?)` 一字不改；`child(scope)`
 *     是可选增量；meta 为对象时才与 trace 字段合并（`Error` / 字符串等原样透传，
 *     避免破坏既有断言）。
 *   - **优先级**：调用级 meta > trace 上下文 > 基础 meta。trace 由 ALS 当前上下文
 *     决定，其次回落到 `DSH_RSI_TRACE_*` 环境变量（跨进程），最后才生成新 id。
 */

import type { DomainLogger } from '../types.js'
import {
  createJsonlSink,
  type JsonlLogRecord,
  type JsonlSink,
} from './exporter.js'
import { resolveLevel, shouldEmit, type LogLevel } from './level.js'
import type { RedactOptions } from './redact.js'
import { currentTrace, ensureTrace, traceFromEnv, type TraceContext } from './trace.js'

export * from './level.js'
export * from './trace.js'
export * from './redact.js'
export * from './retention.js'
export * from './exporter.js'

/** 带 `child()` 的门面（`DomainLogger` 的超集）。 */
export interface LoggingLogger extends DomainLogger {
  /** 派生一个子 scope（`parent:child`），共享同一 sink / level / 基础 meta。 */
  child(scope: string): LoggingLogger
}

/** {@link createLogging} 选项。 */
export interface CreateLoggingOptions {
  /** 门面 scope（也是 sink 的 `name` 前缀），缺省 `rsi-agent`。 */
  readonly scope?: string
  /** 日志目录；缺省不写文件。 */
  readonly logsDir?: string
  /** 原生 logger（`ctx.logger`）；缺失时降级 console。 */
  readonly native?: unknown
  /** 级别阈值；缺省 `DSH_RSI_LOG_LEVEL` → `info`。 */
  readonly level?: LogLevel | string
  /** 保留天数；缺省 `DSH_RSI_LOG_RETENTION_DAYS` → 30 天。 */
  readonly retentionDays?: number
  /** 单文件阈值（字节）；缺省 `DSH_RSI_LOG_MAX_BYTES` → 500 MB。 */
  readonly maxBytes?: number
  /** 领域追加的敏感键。 */
  readonly secretKeys?: readonly string[]
  /** 领域追加的金额 / 成本键。 */
  readonly amountKeys?: readonly string[]
  /** 基础 meta（每条日志都带，优先级最低）。 */
  readonly baseMeta?: Record<string, unknown>
  /** 额外接受的 sink 命名空间。 */
  readonly namespaces?: readonly string[]
  /** 环境变量来源；缺省 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv
  /** 时钟注入（测试用）。 */
  readonly now?: () => number
  /** 复用既有 sink（测试 / 多 logger 共享一个文件）。 */
  readonly sink?: JsonlSink | false
  /** 强制关闭文件写入（`createDomainLogger` 的向后兼容路径）。 */
  readonly writeFile?: boolean
}

/** {@link createLogging} 产物。 */
export interface LoggingHandle {
  /** 结构化门面（满足 `DomainLogger`，额外带 `child`）。 */
  readonly logger: LoggingLogger
  /** 关联的 sink；未启用文件写入时 `undefined`。 */
  readonly sink: JsonlSink | undefined
}

/** 缺失原生 logger 的告警只输出一次（进程级）。 */
let warnedMissingNative = false

/** 判据：非 null 且非数组的对象。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 合并 meta：基础 meta < trace 字段 < 调用级 meta。 */
function mergeMeta(
  base: Record<string, unknown> | undefined,
  trace: TraceContext | undefined,
  callMeta: unknown,
): unknown {
  const traceFields: Record<string, unknown> = {}
  if (trace !== undefined) {
    traceFields.traceId = trace.traceId
    if (trace.taskId !== undefined) traceFields.taskId = trace.taskId
    if (trace.sessionId !== undefined) traceFields.sessionId = trace.sessionId
  }

  const hasTrace = Object.keys(traceFields).length > 0
  if (callMeta === undefined) {
    if (base === undefined && !hasTrace) return undefined
    return { ...base, ...traceFields }
  }
  // 非对象 meta（Error / 字符串等）原样透传：包裹成对象会破坏既有调用方断言。
  if (!isPlainObject(callMeta)) return callMeta
  if (base === undefined && !hasTrace) return callMeta
  return { ...base, ...traceFields, ...callMeta }
}

/** `level` → `console` 方法（`debug` 用 `console.debug`）。 */
function consoleMethod(level: LogLevel): (message: string, ...rest: unknown[]) => void {
  switch (level) {
    case 'error':
      return console.error
    case 'warn':
      return console.warn
    case 'info':
      return console.info
    default:
      return console.debug
  }
}

/** 读取原生 logger 的对应方法（形态非法 → `undefined`）。 */
function nativeMethod(native: unknown, level: LogLevel): ((...args: unknown[]) => void) | undefined {
  if (typeof native !== 'object' && typeof native !== 'function') return undefined
  if (native === null) return undefined
  const candidate = (native as Record<string, unknown>)[level]
  return typeof candidate === 'function' ? (candidate as (...args: unknown[]) => void) : undefined
}

/**
 * 创建日志门面 + sink。
 *
 * @param options 见 {@link CreateLoggingOptions}。
 */
export function createLogging(options: CreateLoggingOptions = {}): LoggingHandle {
  const env = options.env ?? process.env
  const rootScope = options.scope ?? 'rsi-agent'
  const threshold = resolveLevel(options.level, env)
  const baseMeta = options.baseMeta

  const redact: RedactOptions | undefined =
    options.secretKeys !== undefined || options.amountKeys !== undefined
      ? {
          ...(options.secretKeys === undefined ? {} : { secretKeys: options.secretKeys }),
          ...(options.amountKeys === undefined ? {} : { amountKeys: options.amountKeys }),
        }
      : undefined

  let sink: JsonlSink | undefined
  if (options.sink === false || options.writeFile === false) {
    sink = undefined
  } else if (options.sink !== undefined) {
    sink = options.sink
  } else if (typeof options.logsDir === 'string' && options.logsDir !== '') {
    sink = createJsonlSink({
      logsDir: options.logsDir,
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
      ...(options.namespaces === undefined ? {} : { namespaces: options.namespaces }),
      ...(redact === undefined ? {} : { redact }),
      ...(options.now === undefined ? {} : { now: options.now }),
      env,
    })
  }

  /** 解析当前 trace：ALS > 环境变量 > 新建并注入。 */
  const resolveTrace = (): TraceContext | undefined => {
    try {
      return currentTrace() ?? traceFromEnv(env) ?? ensureTrace()
    } catch {
      return undefined
    }
  }

  const makeLogger = (scope: string): LoggingLogger => {
    const prefix = `[${scope}]`

    const emit = (level: LogLevel) => {
      return (message: string, meta?: unknown): void => {
        const trace = resolveTrace()
        const merged = mergeMeta(baseMeta, trace, meta)

        // 1) 文件落地（失败已在 sink 内部吞掉）。
        if (sink !== undefined && shouldEmit(level, threshold)) {
          const record: JsonlLogRecord = {
            level,
            name: scope,
            msg: typeof message === 'string' ? message : String(message),
            ...(merged === undefined ? {} : { meta: merged }),
            ...(trace === undefined ? {} : { trace }),
          }
          sink.write(record)
        }

        // 2) 原生 logger（有自己的级别策略，门面不二次过滤，保持向后兼容）。
        const method = nativeMethod(options.native, level)
        if (method !== undefined) {
          if (merged === undefined) method.call(options.native, `${prefix} ${message}`)
          else method.call(options.native, `${prefix} ${message}`, merged)
          return
        }

        if (options.native === undefined && !warnedMissingNative) {
          warnedMissingNative = true
          console.warn(`${prefix} ctx.logger 缺失，日志降级到 console`)
        }
        const fallback = consoleMethod(level)
        if (merged === undefined) fallback(`${prefix} ${message}`)
        else fallback(`${prefix} ${message}`, merged)
      }
    }

    return {
      error: emit('error'),
      warn: emit('warn'),
      info: emit('info'),
      debug: emit('debug'),
      child: (childScope: string): LoggingLogger => {
        const name = typeof childScope === 'string' && childScope !== '' ? childScope : 'child'
        return makeLogger(`${scope}:${name}`)
      },
    }
  }

  return { logger: makeLogger(rootScope), sink }
}

/**
 * 插件配置层 —— 只描述可调参数与默认值，不涉及任何文件系统副作用。
 *
 * 本文件承载技术方案 §14.1 的 {@link CoreConfig}，并**唯一**负责以下环境变量的
 * 解析（见 {@link resolveCoreConfig}）：
 *
 *   - `DSH_RSI_SESSION_ID`
 *   - `DSH_RSI_LOG_LEVEL`
 *   - `DSH_RSI_LOG_RETENTION_DAYS`
 *   - `DSH_RSI_LOG_MAX_SIZE`
 *
 * `DSH_RSI_HOME` 属于「路径解析」而非「配置解析」，由 `./runtime.js` 的
 * `resolveHomeRoot` 唯一解析（两者合计覆盖全部 `DSH_RSI_*` 变量），从而保证
 * 「环境变量全仓只解析一次」。
 *
 * 兼容性：{@link resolveConfig} 保留 Task-01 的浅合并语义（返回仅含调用方字段 +
 * `logLevel` 默认值），供旧调用方与既有测试使用；新的完整解析走
 * {@link resolveCoreConfig}。
 */

/** 日志级别（`debug` 最详细，`error` 最简）。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 技术方案 §14.1：core 的可调配置。 */
export interface CoreConfig {
  /** 工作区根目录；缺省 `~/.dsh-rsi-agent`（`DSH_RSI_HOME` 优先于本字段）。 */
  homeRoot?: string
  /** 会话 id；缺省由领域包的 `defaultSessionId` 决定。 */
  sessionId?: string
  /** IANA 时区；缺省为领域包 `scheduler.timezone`，再回落系统时区。 */
  timezone?: string
  /** 日志级别，缺省 `info`。 */
  logLevel?: LogLevel
  /** 启动宽限期（毫秒），缺省 500，合法范围 0–5000。 */
  startupGraceMs?: number
  /** 日志保留天数，缺省 30。 */
  logRetentionDays?: number
  /** 单个日志文件大小上限（字节），缺省 500 MB。 */
  logMaxSizeBytes?: number
}

/**
 * 已解析的 core 配置：数值/枚举字段已补全默认值，路径与时区仍保留「未定值」
 * 语义（由 runtime 结合环境变量、领域包与环境探测最终决定）。
 *
 * 说明：`homeRoot` / `timezone` / `sessionId` 不做默认回填，是为了让 runtime 的
 * 优先级链（env > config > pack > 系统默认）保持单点实现，避免两处默认值打架。
 */
export interface ResolvedCoreConfig {
  /** 调用方或环境变量显式给出的 home 根目录（尚未 `resolve()` 归一化）。 */
  readonly homeRoot?: string
  /** 调用方或环境变量显式给出的会话 id（尚未做白名单校验）。 */
  readonly sessionId?: string
  /** 调用方显式给出的时区（尚未做 IANA 校验）。 */
  readonly timezone?: string
  readonly logLevel: LogLevel
  readonly startupGraceMs: number
  readonly logRetentionDays: number
  readonly logMaxSizeBytes: number
}

/** §14.1 默认值（冻结，避免调用方误改共享对象）。 */
export const CORE_CONFIG_DEFAULTS = Object.freeze({
  logLevel: 'info' as LogLevel,
  startupGraceMs: 500,
  logRetentionDays: 30,
  logMaxSizeBytes: 500 * 1024 * 1024,
})

/** `startupGraceMs` 的合法上界（毫秒）。 */
export const STARTUP_GRACE_MAX_MS = 5000

/** 本包读取的环境变量名（集中声明，禁止散落魔法字符串）。 */
export const CORE_CONFIG_ENV = Object.freeze({
  /** 由 `./runtime.js` 解析（路径层）。 */
  home: 'DSH_RSI_HOME',
  sessionId: 'DSH_RSI_SESSION_ID',
  logLevel: 'DSH_RSI_LOG_LEVEL',
  logRetentionDays: 'DSH_RSI_LOG_RETENTION_DAYS',
  logMaxSize: 'DSH_RSI_LOG_MAX_SIZE',
})

/**
 * 旧版配置形状（Task-01 兼容）。`RsiAgentConfig` 现在等价于「`logLevel` 必填的
 * CoreConfig」，因此旧调用方传入的任何 CoreConfig 字段都会被原样保留。
 */
export interface RsiAgentConfig extends CoreConfig {
  logLevel: LogLevel
}

/** 默认配置（冻结，避免调用方误改共享对象）。 */
export const DEFAULT_RSI_AGENT_CONFIG: Readonly<RsiAgentConfig> = Object.freeze({
  logLevel: 'info',
})

const LOG_LEVELS: readonly LogLevel[] = Object.freeze(['debug', 'info', 'warn', 'error'])

const BYTE_SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|kib|mib|gib)?$/i

/**
 * 合并调用方传入的部分配置与旧版默认值（浅合并，**不做**范围校验与默认回填）。
 *
 * 该函数仅为向后兼容保留；需要完整 §14.1 语义请使用 {@link resolveCoreConfig}。
 */
export function resolveConfig(input: Partial<RsiAgentConfig> = {}): RsiAgentConfig {
  const merged = { ...DEFAULT_RSI_AGENT_CONFIG, ...input }
  return { ...merged, logLevel: merged.logLevel ?? DEFAULT_RSI_AGENT_CONFIG.logLevel }
}

function fail(field: string, detail: string): never {
  throw new RangeError(`[coreConfig] 字段 "${field}" 非法：${detail}`)
}

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

/** 解析人类可读的字节数（`1024` / `500MB` / `1.5GiB`）。非法返回 `undefined`。 */
export function parseByteSize(input: string): number | undefined {
  const trimmed = input.trim()
  if (trimmed === '') return undefined
  const match = BYTE_SIZE_PATTERN.exec(trimmed)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount < 0) return undefined
  const unit = (match[2] ?? 'b').toLowerCase()
  const scale: Record<string, number> = {
    b: 1,
    kb: 1024,
    kib: 1024,
    mb: 1024 * 1024,
    mib: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    gib: 1024 * 1024 * 1024,
  }
  return Math.round(amount * scale[unit])
}

function parseInteger(
  field: string,
  raw: string,
  options: { min?: number; max?: number } = {},
): number {
  const trimmed = raw.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) {
    fail(field, `必须是整数，实际为环境变量值 ${JSON.stringify(raw)}`)
  }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value)) {
    fail(field, `必须是安全整数，实际为 ${trimmed}`)
  }
  assertRange(field, value, options)
  return value
}

function assertRange(field: string, value: number, options: { min?: number; max?: number }): void {
  if (!Number.isFinite(value)) fail(field, `必须是有限数字，实际为 ${String(value)}`)
  if (options.min !== undefined && value < options.min) {
    fail(field, `必须 ≥ ${options.min}，实际为 ${value}`)
  }
  if (options.max !== undefined && value > options.max) {
    fail(field, `必须 ≤ ${options.max}，实际为 ${value}`)
  }
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 完整解析 §14.1 配置。
 *
 * 优先级（逐字段）：
 *   - `sessionId` / `logLevel` / `logRetentionDays` / `logMaxSizeBytes`：
 *     **环境变量 > 调用方配置 > 默认值**（环境变量作为运维覆盖层，与
 *     `DSH_RSI_HOME > config.homeRoot` 的语义保持一致）；
 *   - `homeRoot` / `timezone`：**调用方配置**（`DSH_RSI_HOME` 在 runtime 层优先，
 *     故本函数不读它）。
 *
 * 非法值（越界 / 非法枚举 / 非整数）一律抛 `RangeError`，错误信息点名字段或
 * 环境变量与具体原因 —— 配置错误属于契约类错误，不做静默纠偏。
 *
 * @param input 调用方配置（`Partial<CoreConfig>`）。
 * @param env   环境变量来源，缺省 `process.env`（测试可注入，避免污染进程环境）。
 */
export function resolveCoreConfig(
  input: Partial<CoreConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCoreConfig {
  const homeRoot = input.homeRoot?.trim() || undefined
  const timezone = input.timezone?.trim() || undefined

  const envSessionId = readEnv(env, CORE_CONFIG_ENV.sessionId)
  const sessionId = envSessionId ?? (input.sessionId?.trim() || undefined)

  const envLogLevel = readEnv(env, CORE_CONFIG_ENV.logLevel)
  if (envLogLevel !== undefined && !isLogLevel(envLogLevel)) {
    fail(
      CORE_CONFIG_ENV.logLevel,
      `允许 ${LOG_LEVELS.join(' | ')}，实际为 ${JSON.stringify(envLogLevel)}`,
    )
  }
  const logLevel = (envLogLevel ?? input.logLevel ?? CORE_CONFIG_DEFAULTS.logLevel) as LogLevel
  if (!isLogLevel(logLevel)) {
    fail('logLevel', `允许 ${LOG_LEVELS.join(' | ')}，实际为 ${JSON.stringify(logLevel)}`)
  }

  const startupGraceMs = input.startupGraceMs ?? CORE_CONFIG_DEFAULTS.startupGraceMs
  assertRange('startupGraceMs', startupGraceMs, { min: 0, max: STARTUP_GRACE_MAX_MS })

  const envRetention = readEnv(env, CORE_CONFIG_ENV.logRetentionDays)
  const logRetentionDays =
    envRetention !== undefined
      ? parseInteger(CORE_CONFIG_ENV.logRetentionDays, envRetention, { min: 0 })
      : (input.logRetentionDays ?? CORE_CONFIG_DEFAULTS.logRetentionDays)
  assertRange('logRetentionDays', logRetentionDays, { min: 0 })
  if (!Number.isSafeInteger(logRetentionDays)) {
    fail('logRetentionDays', `必须是整数，实际为 ${logRetentionDays}`)
  }

  const envMaxSize = readEnv(env, CORE_CONFIG_ENV.logMaxSize)
  let logMaxSizeBytes: number
  if (envMaxSize !== undefined) {
    const parsed = parseByteSize(envMaxSize)
    if (parsed === undefined) {
      fail(
        CORE_CONFIG_ENV.logMaxSize,
        `无法解析字节数，允许形如 "524288000" / "500MB" / "1GB"，实际为 ${JSON.stringify(envMaxSize)}`,
      )
    }
    logMaxSizeBytes = parsed
  } else {
    logMaxSizeBytes = input.logMaxSizeBytes ?? CORE_CONFIG_DEFAULTS.logMaxSizeBytes
  }
  assertRange('logMaxSizeBytes', logMaxSizeBytes, { min: 0 })

  return Object.freeze({
    homeRoot,
    sessionId,
    timezone,
    logLevel,
    startupGraceMs,
    logRetentionDays,
    logMaxSizeBytes,
  })
}

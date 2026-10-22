/**
 * 日志级别与阈值判定（技术方案 §13.1）。
 *
 * 严重度序固定为 `error < warn < info < debug`（`0` 最严重），与多数日志库把
 * 「数值越小越严重」的约定一致；`shouldEmit(level, threshold)` 仅在
 * `rank(level) <= rank(threshold)` 时放行，即**阈值是「最啰嗦的允许级别」**：
 * 阈值 `info` 会放行 error / warn / info，拦掉 debug。
 *
 * 本文件是级别口径的**唯一真源**：门面（`./index.js`）与 exporter
 * （`./exporter.js`）都从这里取 `LEVEL_RANK` / `resolveLevel`，避免两处实现漂移。
 *
 * 零第三方依赖、无副作用（只读环境变量，且允许注入 `env`）。
 */

/** 日志级别（`error` 最严重，`debug` 最啰嗦）。 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

/** 全部合法级别（按严重度从高到低）。 */
export const LOG_LEVELS: readonly LogLevel[] = Object.freeze([
  'error',
  'warn',
  'info',
  'debug',
])

/** 严重度排序：数值越小越严重。 */
export const LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
})

/** 环境变量：日志级别覆盖（`error` / `warn` / `info` / `debug`）。 */
export const LOG_LEVEL_ENV = 'DSH_RSI_LOG_LEVEL'

/** 默认级别：`info`。 */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info'

/** 判据：是否为合法日志级别。 */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

/**
 * 是否应当输出：`rank(level) <= rank(threshold)`。
 *
 * 非法 level（运行时被塞入任意字符串）按「最严重」处理并放行——日志设施宁可多写
 * 一条，也不因脏数据静默吞掉错误。
 */
export function shouldEmit(level: LogLevel, threshold: LogLevel): boolean {
  const levelRank = LEVEL_RANK[level]
  if (levelRank === undefined) return true
  const thresholdRank = LEVEL_RANK[threshold]
  return levelRank <= (thresholdRank === undefined ? LEVEL_RANK[DEFAULT_LOG_LEVEL] : thresholdRank)
}

/**
 * 解析生效级别：显式选项 > 环境变量 {@link LOG_LEVEL_ENV} > {@link DEFAULT_LOG_LEVEL}。
 *
 * 非法值一律**静默回落**到下一优先级（日志级别配错不应让插件起不来），
 * 与 `config.resolveCoreConfig` 对 `DSH_RSI_LOG_LEVEL` 的严格校验互为补充：
 * 配置层负责在启动期报错，本函数负责运行期的兜底。
 *
 * @param option 显式级别（调用方 / 领域包声明）。
 * @param env    环境变量来源，缺省 `process.env`。
 */
export function resolveLevel(
  option?: LogLevel | string,
  env: NodeJS.ProcessEnv = process.env,
): LogLevel {
  if (isLogLevel(option)) return option
  const fromEnv = env[LOG_LEVEL_ENV]
  if (isLogLevel(fromEnv)) return fromEnv
  return DEFAULT_LOG_LEVEL
}

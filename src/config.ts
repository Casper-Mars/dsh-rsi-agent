/**
 * 插件配置层 —— 只描述可调参数与默认值，不涉及任何运行时副作用。
 */

/** 日志级别。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** `rsi-agent` 插件配置。 */
export interface RsiAgentConfig {
  /** 日志级别，缺省 `info`。 */
  logLevel: LogLevel
}

/** 默认配置（冻结，避免调用方误改共享对象）。 */
export const DEFAULT_RSI_AGENT_CONFIG: Readonly<RsiAgentConfig> = Object.freeze({
  logLevel: 'info',
})

/** 合并调用方传入的部分配置与默认值。 */
export function resolveConfig(input: Partial<RsiAgentConfig> = {}): RsiAgentConfig {
  return { ...DEFAULT_RSI_AGENT_CONFIG, ...input }
}

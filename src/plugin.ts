/**
 * `rsi-agent` 插件契约层：声明 Cordis 插件三要素（name / inject / apply）。
 *
 * Task-01 仅建立可编译骨架，运行时装配（工具注册、技能挂载、循环调度）在
 * 后续任务中逐步补入，本文件保持契约稳定。
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, type RsiAgentConfig } from './config.js'
import { AgentHost } from './service.js'

/** 插件唯一标识。 */
export const name = 'rsi-agent'

/**
 * 依赖服务（契约固定）：
 *   - `tools`  —— dsh 工具注册表
 *   - `skills` —— dsh 技能注册表
 *   - `fs`     —— cordis 标准文件系统服务
 *
 * 必须与 `cordis.patch.yml` 中对应条目的 `inject` 逐项一致。
 */
export const inject = ['tools', 'skills', 'fs']

/** 插件装配入口。 */
export function apply(ctx: Context, config: Partial<RsiAgentConfig> = {}): void {
  // 配置只做浅合并后透传给 `agentHost`；完整解析（§14.1 默认值 / 环境变量 /
  // 范围校验）统一在 `createDomainRuntime` 内完成，避免两处默认值打架。
  const resolved = resolveConfig(config)

  // `agentHost` 是 core 自身提供的服务（不是外部依赖），故不进顶层 `inject`；
  // 以 class plugin 装载，实例随本插件 fiber 卸载自动注销。
  ctx.plugin(AgentHost, { config: resolved })
}

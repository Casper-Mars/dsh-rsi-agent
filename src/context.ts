/**
 * Cordis 上下文读服务的最小工具。
 *
 * 宿主在不同版本 / 不同装配形态下既可能把服务挂在 `ctx` 属性上，也可能只
 * 提供 `ctx.get(name)`。本模块把两种读取方式收敛到一处，避免各业务模块
 * 各写一份 `try/catch` 属性探测。
 *
 * 叶子约束：只依赖 `@deepseek-ai/cordis` 的类型。
 */
import type { Context } from '@deepseek-ai/cordis'

/**
 * 读取一个服务；不存在或读取抛错时返回 `undefined`（**不抛异常**）。
 *
 * @param ctx 任意 cordis 上下文（或结构替身）。
 * @param name 服务名。
 */
export function readService(ctx: Context, name: string): unknown {
  const candidate = ctx as unknown as { get?: (serviceName: string) => unknown }
  if (typeof candidate.get === 'function') {
    try {
      const value = candidate.get.call(ctx, name)
      if (value !== undefined) return value
    } catch {
      // 落到属性读取
    }
  }
  try {
    return (ctx as unknown as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}

/** 读取服务并按调用方声明的结构收窄（仍是 `undefined` 安全的）。 */
export function serviceOf<T>(ctx: Context, name: string): T | undefined {
  return readService(ctx, name) as T | undefined
}

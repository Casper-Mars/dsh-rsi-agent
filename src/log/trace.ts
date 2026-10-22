/**
 * trace 上下文（技术方案 §13.4）——基于 Node 原生 `AsyncLocalStorage`。
 *
 * 目标：给「一次触发链路」（定时触发 → 唤醒 → 任务子进程 → 结果回写）提供稳定的
 * 关联锚点 `traceId`，使散落在各模块的日志行可被同一 id 串联。
 *
 * 设计要点：
 *   1. **零第三方依赖**：只用 `node:async_hooks` + `node:crypto`；
 *   2. **进程内传播**：`AsyncLocalStorage` 只在同一进程的异步调用链内可见；
 *   3. **跨进程显式传递**：子进程通过环境变量携带（{@link TRACE_ENV} +
 *      {@link traceToEnv} / {@link traceFromEnv}），绝不假设 ALS 跨进程生效；
 *   4. **降级不抛**：`AsyncLocalStorage` 不可用时 {@link runWithTrace} 直接执行
 *      `fn`，读取接口返回 `undefined`。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

/** trace 上下文字段。 */
export interface TraceContext {
  /** 单次链路主键（同一链路内一致）。 */
  readonly traceId: string
  /** 触发该链路的任务 id（可选）。 */
  readonly taskId?: string
  /** 关联会话 id（可选）。 */
  readonly sessionId?: string
}

/**
 * 跨进程传递用的环境变量名（唯一真源，避免各处散落魔法字符串）。
 *
 * 三个变量一一对应 {@link TraceContext} 的字段；值为空串的一律视为未设置。
 */
export const TRACE_ENV = Object.freeze({
  traceId: 'DSH_RSI_TRACE_ID',
  taskId: 'DSH_RSI_TASK_ID',
  sessionId: 'DSH_RSI_SESSION_ID',
} as const)

/** 惰性初始化的进程内存储（构造失败时永久降级）。 */
let store: AsyncLocalStorage<TraceContext> | undefined
let initialized = false

function storage(): AsyncLocalStorage<TraceContext> | undefined {
  if (!initialized) {
    initialized = true
    try {
      store = new AsyncLocalStorage<TraceContext>()
    } catch {
      store = undefined
    }
  }
  return store
}

/** 生成新的 traceId（UUID v4）。 */
export function newTraceId(): string {
  return randomUUID()
}

/**
 * 在给定 trace 上下文内执行 `fn`（`AsyncLocalStorage.run` 语义）。
 *
 * `fn` 的返回值即本函数返回值；抛错原样透传。降级模式下直接执行 `fn`。
 */
export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  const als = storage()
  return als === undefined ? fn() : als.run(ctx, fn)
}

/** 读取当前异步上下文的 trace；无上下文 / 降级时 `undefined`。 */
export function currentTrace(): TraceContext | undefined {
  try {
    return storage()?.getStore()
  } catch {
    return undefined
  }
}

/**
 * 确保当前调用链存在 trace 上下文。
 *
 * 已有上下文 → 原样返回；否则用 `seed`（或新 UUID）生成一个并**注入当前链**
 * （`enterWith`），使同一条异步链上后续日志共享同一 `traceId`。
 *
 * @param seed 可选的初始字段（例如从环境变量解析出的 taskId / sessionId）。
 */
export function ensureTrace(seed: Partial<TraceContext> = {}): TraceContext {
  const existing = currentTrace()
  if (existing !== undefined) return existing

  const traceId =
    typeof seed.traceId === 'string' && seed.traceId !== '' ? seed.traceId : newTraceId()
  const ctx: TraceContext = {
    traceId,
    ...(typeof seed.taskId === 'string' && seed.taskId !== '' ? { taskId: seed.taskId } : {}),
    ...(typeof seed.sessionId === 'string' && seed.sessionId !== ''
      ? { sessionId: seed.sessionId }
      : {}),
  }
  try {
    storage()?.enterWith(ctx)
  } catch {
    /* 降级：注入失败不影响返回值与业务。 */
  }
  return ctx
}

/** 判据：非 null 且非数组的对象（可安全展开合并）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把当前 trace 合并进日志 meta。
 *
 * 语义（配合门面的优先级「调用级 meta > trace 上下文 > 基础 meta」）：
 *   - 无 trace → 原样返回；
 *   - `meta` 为空 → 返回 trace 字段对象；
 *   - `meta` 是普通对象 → `{ ...trace, ...meta }`（调用级字段覆盖 trace）；
 *   - `meta` 是其它形态（字符串 / Error / 数组）→ `{ ...trace, meta }`，
 *     保留原值不丢失。
 */
export function withTraceMeta(meta: unknown): unknown {
  const trace = currentTrace()
  if (trace === undefined) return meta

  const traceFields: Record<string, unknown> = { traceId: trace.traceId }
  if (trace.taskId !== undefined) traceFields.taskId = trace.taskId
  if (trace.sessionId !== undefined) traceFields.sessionId = trace.sessionId

  if (meta === undefined) return traceFields
  if (isPlainObject(meta)) return { ...traceFields, ...meta }
  return { ...traceFields, meta }
}

/**
 * 把 trace 序列化为环境变量增量（供子进程 `env` 注入）。
 *
 * @param trace 待注入的上下文；缺省取 {@link currentTrace}。无 trace → 空对象。
 */
export function traceToEnv(trace: TraceContext | undefined = currentTrace()): Record<string, string> {
  if (trace === undefined || typeof trace.traceId !== 'string' || trace.traceId === '') {
    return {}
  }
  const env: Record<string, string> = { [TRACE_ENV.traceId]: trace.traceId }
  if (trace.taskId !== undefined && trace.taskId !== '') env[TRACE_ENV.taskId] = trace.taskId
  if (trace.sessionId !== undefined && trace.sessionId !== '')
    env[TRACE_ENV.sessionId] = trace.sessionId
  return env
}

/**
 * 从环境变量还原 trace 上下文（子进程侧的兜底来源）。
 *
 * 无 `DSH_RSI_TRACE_ID`（或为空）→ `undefined`：此时调用方应视为「无 trace」，
 * 而不是编造一个 id。
 */
export function traceFromEnv(env: NodeJS.ProcessEnv = process.env): TraceContext | undefined {
  const traceId = env[TRACE_ENV.traceId]
  if (typeof traceId !== 'string' || traceId.trim() === '') return undefined
  const taskId = env[TRACE_ENV.taskId]
  const sessionId = env[TRACE_ENV.sessionId]
  return {
    traceId: traceId.trim(),
    ...(typeof taskId === 'string' && taskId.trim() !== '' ? { taskId: taskId.trim() } : {}),
    ...(typeof sessionId === 'string' && sessionId.trim() !== ''
      ? { sessionId: sessionId.trim() }
      : {}),
  }
}

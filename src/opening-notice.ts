/**
 * 开场 notice 投递：把固定会话从「blank」推进到「非 blank」。
 *
 * 背景（harness 事实）：会话经 `agents.create` 建立后若从未发生 `turn/start`，
 * `sessionListMetadata.blank` 恒为 true，前端据此把会话从左侧列表过滤掉。
 * 投递一条 role:user 的开场 notice 可触发首个 `turn/start`，使会话可见。
 *
 * 关键判据（一次性 = 会话是否 blank，而非 ensure 结局）：
 *   - 只要尚未发生 `turn/start` → blank，投递一次；
 *   - 已发生 `turn/start` → 非 blank，不投递（重启不重复）。
 *
 * blank 判读优先级（择一命中即返回，尽量少开句柄）：
 *   1. `sessionProjections.stateOf(session, 'sessionListMetadata').blank`（web 宿主）；
 *   2. `sessionPersistence.open(id,'read')` → `handle.read(0)` 扫 `turn/start`；
 *   3. `sessionPersistence.stat(id).eventCount === 0`（JSONL 后端通常不返回）。
 *
 * 降级固定为 **skip**：服务缺失 / 判读失败 / `followup` 抛错 → 记日志、返回
 * `skipped`，不抛异常、不中断 install。
 */
import { createNoticeMessage, type NoticeUserMessage } from './message-source.js'

/** 通用开场文案（领域未提供 `openingNotice` 时使用）。 */
export const CORE_OPENING_NOTICE_TEXT =
  '【开场引导任务】请以 RSI Agent 的通用方式，向用户输出一段简洁的开场引导（不要复述本段指令）：\n' +
  '1. 请用户用一句话说明想推进的长期目标或当前最想解决的一件事。\n' +
  '2. 说明你会把目标拆成可执行、可检查的小步骤，并先确认验收标准与约束。\n' +
  '3. 说明每次执行都会留下记录，并在阶段结束时复盘、沉淀为可复用资产。\n' +
  '结尾请明确请用户给出第一个目标，作为冷启动第一步。'

/** 通用开场 notice 的一行摘要（≤ 120 字符）。 */
export const CORE_OPENING_NOTICE_SUMMARY = 'RSI Agent 开场引导：确认目标、拆解步骤、记录并复盘'

/** 会话事件的最小结构（仅判读 `turn/start`）。 */
export interface SessionEventLike {
  readonly type?: string
}

/** 只读会话句柄的最小结构。 */
export interface SessionHandleLike {
  read(from?: number): Promise<{ events?: readonly SessionEventLike[] }>
  close?(): Promise<void>
}

/** 支持 `followup` 投递的 agent 最小结构替身。 */
export interface OpeningNoticeAgent {
  readonly id: string
  followup(message: NoticeUserMessage): void
  /** live Session 对象（web 宿主；供 `sessionListMetadata` 投影软取）。 */
  readonly session?: unknown
}

/** `ctx.agents` 的最小结构替身（只需 `get`）。 */
export interface OpeningNoticeAgents {
  get(id: string): OpeningNoticeAgent | undefined
}

/** `sessionProjections.stateOf` 的最小结构替身（web 宿主软取用）。 */
export interface SessionProjectionsLike {
  stateOf?(session: unknown, key: string): unknown
}

/** 供单测注入的判读 + 投递依赖。 */
export interface OpeningNoticeDeps {
  /** 活跃 agent 注册表。 */
  agents: OpeningNoticeAgents
  /** 会话持久化服务。 */
  sessionPersistence: {
    /**
     * 判读 blank：打开只读句柄读事件日志（不存在抛错 → 判读失败）。
     * 缺失时跳过该优先级，直接落到 `stat` 兜底。
     */
    open?(id: string, access: 'read'): Promise<SessionHandleLike>
    /** 兜底快速路径：事件计数（可 `undefined`）。 */
    stat?(id: string): Promise<{ eventCount?: number } | undefined>
  }
  /** 软取 blank 投影（web 宿主有，headless 常无）。 */
  sessionProjections?: SessionProjectionsLike
  /** 目标会话 id。 */
  sessionId: string
  /** 领域开场文案（优先级高于通用文案）。 */
  text?: string
  /** 一行摘要（缺省由正文截断）。 */
  summary?: string
  /** 日志（info 级；缺省静默）。 */
  logger?: (message: string) => void
  /**
   * 投递链路内的取消探测：在 blank 判读**之后**、`followup` **之前**再查一次。
   *
   * 用于收敛「启动计时器已触发、ensure 已返回，但领域 install 恰好落在
   * blank 判读 / 投递窗口内」的竞态：此时通用路径必须让位给领域开场。
   */
  isCancelled?(): boolean
}

/** 判读会话是否 blank（尚未发生 `turn/start`）。 */
export interface BlankCheckDeps {
  sessionPersistence: OpeningNoticeDeps['sessionPersistence']
  sessionProjections?: SessionProjectionsLike
  sessionId: string
}

/**
 * 构造一条开场 notice UserMessage。
 *
 * @param text 正文；缺省 {@link CORE_OPENING_NOTICE_TEXT}。
 * @param summary 一行摘要；缺省 {@link CORE_OPENING_NOTICE_SUMMARY}。
 */
export function buildOpeningNoticeMessage(
  text: string = CORE_OPENING_NOTICE_TEXT,
  summary: string = CORE_OPENING_NOTICE_SUMMARY,
): NoticeUserMessage {
  return createNoticeMessage(text, summary)
}

/**
 * 判读会话是否 blank。
 *
 * @returns `true`（blank，需投递）/ `false`（非 blank，不投递）/
 *          `undefined`（未知 → 调用方按降级 skip 处理，**不抛**）。
 */
export async function isSessionBlank(
  deps: BlankCheckDeps,
  session?: unknown,
): Promise<boolean | undefined> {
  const id = deps.sessionId

  // 1) 软取投影空白位（web 宿主）。
  try {
    const projections = deps.sessionProjections
    if (projections && typeof projections.stateOf === 'function') {
      const state = projections.stateOf(session, 'sessionListMetadata') as
        | { blank?: boolean }
        | undefined
      if (state && typeof state.blank === 'boolean') return state.blank
    }
  } catch {
    // 投影软取失败 → 落入事件日志判读。
  }

  // 2) 打开只读句柄读事件日志（跨宿主 / 跨分支均可靠）。
  try {
    const open = deps.sessionPersistence.open?.bind(deps.sessionPersistence)
    if (!open) throw new Error('open unavailable')
    const handle = await open(id, 'read')
    try {
      const { events } = await handle.read(0)
      if (Array.isArray(events)) {
        return !events.some((event) => event?.type === 'turn/start')
      }
    } finally {
      if (typeof handle.close === 'function') {
        await handle.close().catch(() => {})
      }
    }
  } catch {
    // open/read 失败（会话不存在 / 服务不可用）→ 落入兜底。
  }

  // 3) 兜底：stat.eventCount === 0（JSONL 后端通常不返回 → undefined 即未知）。
  try {
    if (deps.sessionPersistence.stat) {
      const stat = await deps.sessionPersistence.stat(id)
      if (stat && typeof stat.eventCount === 'number') return stat.eventCount === 0
    }
  } catch {
    // 兜底失败 → 判读未知。
  }

  return undefined
}

/** 开场 notice 投递结果。 */
export type OpeningNoticeResult =
  | { kind: 'delivered'; id: string }
  | { kind: 'not-blank'; id: string }
  | { kind: 'skipped'; id: string; detail: string }

/**
 * per-session 投递串行锁：同一 `sessionId` 同时只允许一次投递进入
 * 「判读 + followup」临界区，避免通用路径与领域路径并发时同投 / 互抢。
 *
 * 语义是**排队**而非丢弃：后到者等待前一次完成后再判读一次 blank，
 * 因此前一次已投递时后到者会看到 `turn/start` 而自然跳过。
 */
const deliveryChains = new Map<string, Promise<void>>()

async function withSessionDeliveryLock<T>(
  sessionId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = deliveryChains.get(sessionId) ?? Promise.resolve()
  let release!: () => void
  const ticket = new Promise<void>((resolve) => {
    release = resolve
  })
  const current = previous.then(() => ticket)
  deliveryChains.set(sessionId, current)
  try {
    await previous.catch(() => {})
    return await run()
  } finally {
    release()
    if (deliveryChains.get(sessionId) === current) deliveryChains.delete(sessionId)
  }
}

/**
 * 投递开场 notice（一次性）：判读 blank → blank 则 `followup` 一次，否则跳过。
 *
 * **绝不抛异常**：`agents` 不可达 / `followup` 抛错 / 判读失败 → 记日志、
 * 返回 `skipped`。
 *
 * 同一 `sessionId` 的投递经 {@link withSessionDeliveryLock} 串行化。
 */
export async function deliverOpeningNotice(
  deps: OpeningNoticeDeps,
): Promise<OpeningNoticeResult> {
  return withSessionDeliveryLock(deps.sessionId, () => deliverOpeningNoticeUnlocked(deps))
}

/** {@link deliverOpeningNotice} 的无锁实现（在会话临界区内执行）。 */
async function deliverOpeningNoticeUnlocked(
  deps: OpeningNoticeDeps,
): Promise<OpeningNoticeResult> {
  const log = deps.logger ?? (() => {})
  const id = deps.sessionId

  // 解析投递目标 agent（同时取 live session 供投影软取）。
  let agent: OpeningNoticeAgent | undefined
  try {
    agent = deps.agents.get(id)
  } catch (error) {
    log(`[rsi-agent/notice] 警告 agents.get 失败（降级 skip）：${String(error)}`)
    return { kind: 'skipped', id, detail: `agents.get failed: ${String(error)}` }
  }

  // 判读 blank。
  let blank: boolean | undefined
  try {
    blank = await isSessionBlank(
      {
        sessionPersistence: deps.sessionPersistence,
        sessionProjections: deps.sessionProjections,
        sessionId: id,
      },
      agent?.session,
    )
  } catch (error) {
    log(`[rsi-agent/notice] 警告 判读会话 blank 失败（降级 skip）：${String(error)}`)
    return { kind: 'skipped', id, detail: `blank check failed: ${String(error)}` }
  }

  if (blank === false) {
    // 已非 blank（发生过 turn/start）→ 自愈，不重复投递。
    return { kind: 'not-blank', id }
  }
  if (blank === undefined) {
    log('[rsi-agent/notice] 警告 无法判读会话 blank 状态，跳过开场 notice（降级）')
    return { kind: 'skipped', id, detail: 'blank state unknown' }
  }

  if (!agent || typeof agent.followup !== 'function') {
    log(`[rsi-agent/notice] 警告 会话不可达（${id}），跳过开场 notice（降级）`)
    return { kind: 'skipped', id, detail: 'agent unreachable' }
  }

  // 竞态收口：blank 判读是异步的，期间领域 install 可能已取消通用路径。
  // 在真正 followup 前再查一次 token，避免「通用开场先投、领域开场被判非 blank」。
  if (deps.isCancelled?.() === true) {
    log(`[rsi-agent/notice] 开场投递已取消（会话 ${id}），跳过`)
    return { kind: 'skipped', id, detail: 'cancelled' }
  }

  // 投递（仅当判读为 blank 时）。
  try {
    agent.followup(buildOpeningNoticeMessage(deps.text, deps.summary))
    log(`[rsi-agent/notice] 已投递开场 notice（会话 ${id}）`)
    return { kind: 'delivered', id }
  } catch (error) {
    log(`[rsi-agent/notice] 警告 投递开场 notice 失败（降级 skip）：${String(error)}`)
    return { kind: 'skipped', id, detail: `followup failed: ${String(error)}` }
  }
}

/**
 * 唤醒护栏与投递（技术方案 §12.3 第 6 条）。
 *
 * 三段护栏：
 *   1. **文本预算**：正文 > 2000 字符截断（默认），按**字素簇**截断，绝不切半个
 *      emoji / 代理对；
 *   2. **冷却**：同 `task_id` 5 分钟内不重复唤醒（只记录**成功**投递，失败不写，
 *      避免一次失败把后续正常唤醒也吞掉）；
 *   3. **降级**：投递失败（sink 抛错 / 目标不可达）→ `skipped`，不抛异常、不中断调度。
 *
 * 正文末尾追加领域 `disclaimer`（若领域未声明则不加）。disclaimer 不计入 2000
 * 字符预算（预算是给任务产出的正文，合规声明由领域固定提供）。
 */
import type { Clock, WakeSink } from './types.js'

/** 默认唤醒正文预算（字符数）。 */
export const DEFAULT_WAKE_TEXT_BUDGET = 2000

/** 默认冷却窗口（5 分钟）。 */
export const DEFAULT_WAKE_COOLDOWN_MS = 5 * 60 * 1000

/** notice 摘要字符上限（与 message-source 的 summary 约束对齐）。 */
export const WAKE_SUMMARY_MAX = 120

const graphemeSegmenter =
  typeof (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter ===
  'function'
    ? new (
        Intl as unknown as {
          Segmenter: new (locale?: string, options?: { granularity: string }) => {
            segment(input: string): Iterable<{ segment: string }>
          }
        }
      ).Segmenter(undefined, { granularity: 'grapheme' })
    : undefined

/** 把文本切成字素簇（`Intl.Segmenter` 不可用时退回码点，仍不会切代理对）。 */
export function splitGraphemes(text: string): string[] {
  if (graphemeSegmenter !== undefined) {
    const units: string[] = []
    for (const item of graphemeSegmenter.segment(text)) units.push(item.segment)
    return units
  }
  return Array.from(text)
}

/**
 * 按**字素簇**截断到至多 `max` 个单位。
 *
 * 用码点（`Array.from`）已经不切代理对；用字素簇进一步避免把 `👨‍👩‍👧` 这类
 * ZWJ 组合切成半个家庭 emoji。
 */
export function truncateText(text: string, max: number): string {
  if (max <= 0) return ''
  const units = splitGraphemes(text)
  if (units.length <= max) return text
  return units.slice(0, max).join('')
}

/** 组装唤醒正文：截断后的正文 + 可选领域声明。 */
export function buildWakeText(
  data: string,
  options: { readonly budget?: number; readonly disclaimer?: string } = {},
): string {
  const bounded = truncateText(data, options.budget ?? DEFAULT_WAKE_TEXT_BUDGET)
  const disclaimer = options.disclaimer
  if (typeof disclaimer !== 'string' || disclaimer.trim() === '') return bounded
  return `${bounded}\n\n${disclaimer}`
}

/** 从正文派生一行摘要（首行非空、≤ {@link WAKE_SUMMARY_MAX} 字素）。 */
export function deriveWakeSummary(text: string): string {
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  const base = firstLine ?? '定时任务唤醒'
  return truncateText(base, WAKE_SUMMARY_MAX)
}

/** 唤醒结果（`skipped` 覆盖冷却与投递失败两种降级）。 */
export type WakeResult =
  | { readonly kind: 'woke'; readonly text: string; readonly targets: readonly string[] }
  | { readonly kind: 'skipped'; readonly reason: string; readonly detail?: string }

/** {@link Waker} 选项。 */
export interface WakerOptions {
  /** 投递端口。 */
  readonly sink: WakeSink
  /** 目标会话 id。 */
  readonly sessionId: string
  /** 时钟（冷却判定）。 */
  readonly clock?: Clock
  /** 冷却窗口（毫秒）；`<= 0` 关闭冷却。 */
  readonly cooldownMs?: number
  /** 正文预算（字素）。 */
  readonly budget?: number
  /** 领域合规声明。 */
  readonly disclaimer?: string
  /** 日志出口。 */
  readonly logger?: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void }
}

/**
 * 唤醒投递器：截断 → 冷却 → 投递 → 记录成功时刻。
 *
 * 并发说明：Node 单线程，但 `await sink.deliver()` 会交出执行权。若「检查冷却」与
 * 「写入冷却」之间夹了 `await`，并发两次会**双双通过检查 → 双投递**。因此冷却位在
 * 投递**前**的同步临界区内先占位（reserve），失败再回滚——既保证不双投，又保持
 * 「投递失败不写冷却」的既有语义。
 */
export class Waker {
  private readonly sink: WakeSink
  private readonly sessionId: string
  private readonly clock: Clock
  private readonly cooldownMs: number
  private readonly budget: number
  private readonly disclaimer: string | undefined
  private readonly logger: WakerOptions['logger']
  private readonly lastDeliveredAt = new Map<string, number>()

  constructor(options: WakerOptions) {
    if (typeof options.sessionId !== 'string' || options.sessionId === '') {
      throw new TypeError('[scheduler/wake] sessionId 必须是非空字符串')
    }
    this.sink = options.sink
    this.sessionId = options.sessionId
    this.clock = options.clock ?? { now: () => new Date() }
    this.cooldownMs = options.cooldownMs ?? DEFAULT_WAKE_COOLDOWN_MS
    this.budget = options.budget ?? DEFAULT_WAKE_TEXT_BUDGET
    this.disclaimer = options.disclaimer
    this.logger = options.logger
  }

  /** 冷却剩余毫秒（0 表示可唤醒）。 */
  cooldownRemainingMs(taskId: string): number {
    if (this.cooldownMs <= 0) return 0
    const last = this.lastDeliveredAt.get(taskId)
    if (last === undefined) return 0
    const elapsed = this.clock.now().getTime() - last
    return elapsed >= this.cooldownMs ? 0 : this.cooldownMs - elapsed
  }

  /** 是否处于冷却窗口。 */
  isInCooldown(taskId: string): boolean {
    return this.cooldownRemainingMs(taskId) > 0
  }

  /**
   * 投递一条唤醒。
   *
   * @param taskId 冷却键。
   * @param data   任务产出正文（原文，未截断）。
   */
  async wake(taskId: string, data: string): Promise<WakeResult> {
    const remaining = this.cooldownRemainingMs(taskId)
    if (remaining > 0) {
      return {
        kind: 'skipped',
        reason: `任务 ${taskId} 处于 5 分钟冷却窗口内（剩余 ${remaining}ms），跳过唤醒`,
      }
    }

    const text = buildWakeText(data, {
      budget: this.budget,
      ...(this.disclaimer === undefined ? {} : { disclaimer: this.disclaimer }),
    })

    // 临界区（其内无 await）：检查通过的同一刻就占住冷却位。
    // 这样并发第二次调用在 `cooldownRemainingMs` 处即被拦下，不会双投。
    const previous = this.lastDeliveredAt.get(taskId)
    this.lastDeliveredAt.set(taskId, this.clock.now().getTime())

    try {
      await this.sink.deliver({
        taskId,
        text,
        summary: deriveWakeSummary(text),
        sessionId: this.sessionId,
      })
    } catch (error) {
      // 投递失败：回滚占位，让下一次仍可尝试（不能因一次失败吞掉后续唤醒）。
      if (previous === undefined) this.lastDeliveredAt.delete(taskId)
      else this.lastDeliveredAt.set(taskId, previous)
      const detail = error instanceof Error ? error.message : String(error)
      this.logger?.warn(`任务 ${taskId} 唤醒投递失败（降级 skipped）：${detail}`)
      return { kind: 'skipped', reason: `任务 ${taskId} 唤醒投递失败（已降级）`, detail }
    }

    this.logger?.info(`任务 ${taskId} 已唤醒并投递到 ${this.sessionId}`)
    return { kind: 'woke', text, targets: [this.sessionId] }
  }
}

/** 创建唤醒投递器。 */
export function createWaker(options: WakerOptions): Waker {
  return new Waker(options)
}

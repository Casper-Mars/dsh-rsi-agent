/**
 * dsh-rsi-agent 生产者消息源契约（V4 producer-owned source kind）。
 *
 * 背景：V3 的「plugin 包装」形态（`source.kind === 'plugin'`）已被 harness
 * `session-format-v3-to-v4` 拒绝；notice / 唤醒消息必须声明 producer 自有的
 * `kind`（非空且 ≠ `'plugin'`），否则消息在起 turn 写入会话时被 codec 拒绝，
 * `turn/start` 不落盘，固定会话会一直停留在 blank 状态。
 *
 * 本模块对齐 harness 官方契约（参照 `packages/context/tmux-context`）：
 *   1. 声明 producer 自有 kind `'dsh-rsi-agent'`；
 *   2. 经 `declare module '@deepseek-ai/dsh-llm'` 增补 `MessageSourceMap`；
 *   3. 用官方 `createUserMessage(...)` 构造消息（冻结 + 稳定 id）。
 */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * dsh-rsi-agent 开场 notice / 感知唤醒的生产者归属。
     *
     * `traceId`（可选）为跨进程关联锚点；无 trace 时不写该字段。
     * @persistenceAttribution
     */
    'dsh-rsi-agent':
      | ({ kind: 'dsh-rsi-agent' } & ContextFormed & { readonly traceId?: string })
      | { kind: 'dsh-rsi-agent'; form: 'notice'; summary: string; readonly traceId?: string }
  }
}

/** dsh-rsi-agent 生产者自有 kind（V4 要求非空字符串且 ≠ `'plugin'`）。 */
export const PRODUCER_KIND = 'dsh-rsi-agent' as const

/** notice 形态的消息源：`form: 'notice'` 必须携带 `summary`（one-line account）。 */
export type NoticeMessageSource = {
  readonly kind: typeof PRODUCER_KIND
  readonly form: 'notice'
  readonly summary: string
  /** 跨进程关联锚点（可选）；无 trace 时不写该字段。 */
  readonly traceId?: string
}

/** notice 形态的 user 消息（`role: 'user'`，source 为 dsh-rsi-agent notice）。 */
export type NoticeUserMessage = UserMessage & {
  readonly role: 'user'
  readonly source: NoticeMessageSource
}

/**
 * 构造一条 notice 形态的 user 消息（官方 `createUserMessage`：冻结 + 稳定 id）。
 *
 * @param text 模型可见正文。
 * @param summary notice 一行摘要；缺省按 {@link boundContextSummary} 截断正文。
 * @param traceId 可选跨进程关联锚点；缺省（`undefined`）时**不写**该字段。
 */
export function createNoticeMessage(
  text: string,
  summary?: string,
  traceId?: string,
): NoticeUserMessage {
  const source: NoticeMessageSource = {
    kind: PRODUCER_KIND,
    form: 'notice',
    summary: summary ?? boundContextSummary(text),
    ...(traceId === undefined ? {} : { traceId }),
  }
  return createUserMessage({
    content: [{ type: 'text', text }],
    source,
  })
}

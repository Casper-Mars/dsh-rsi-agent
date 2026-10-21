/**
 * Task-09 · C：开场 notice。
 *
 * 覆盖 blank 三路判读优先级、非 blank 不投、领域文案优先、投递抛错只 log、
 * 以及 `source.kind` / `form` 的精确断言。
 */
import { describe, expect, it } from 'vitest'
import {
  CORE_OPENING_NOTICE_SUMMARY,
  CORE_OPENING_NOTICE_TEXT,
  buildOpeningNoticeMessage,
  deliverOpeningNotice,
  isSessionBlank,
  type OpeningNoticeAgent,
  type OpeningNoticeDeps,
  type SessionHandleLike,
} from '../src/opening-notice'
import type { NoticeUserMessage } from '../src/message-source'

interface Recorder {
  openCalls: string[]
  statCalls: string[]
  followups: NoticeUserMessage[]
  closes: number
}

function makeAgent(followup?: (message: NoticeUserMessage) => void): OpeningNoticeAgent {
  return {
    id: 'sess-1',
    session: { id: 'sess-1' },
    followup:
      followup ??
      (() => {
        /* noop */
      }),
  }
}

function makeDeps(options: {
  agent?: OpeningNoticeAgent | null
  getThrows?: boolean
  projectionBlank?: boolean
  projectionThrows?: boolean
  events?: string[]
  openThrows?: boolean
  statEventCount?: number
  statThrows?: boolean
  omitOpen?: boolean
  omitStat?: boolean
  followupThrows?: boolean
} = {}): {
  deps: OpeningNoticeDeps
  recorder: Recorder
  handle: SessionHandleLike
} {
  const recorder: Recorder = { openCalls: [], statCalls: [], followups: [], closes: 0 }
  const agent =
    options.agent === null
      ? undefined
      : options.agent ??
        makeAgent((message) => {
          if (options.followupThrows) throw new Error('followup boom')
          recorder.followups.push(message)
        })

  const handle: SessionHandleLike = {
    async read() {
      return { events: (options.events ?? []).map((type) => ({ type })) }
    },
    async close() {
      recorder.closes += 1
    },
  }

  const deps: OpeningNoticeDeps = {
    agents: {
      get() {
        if (options.getThrows) throw new Error('get boom')
        return agent
      },
    },
    sessionPersistence: {
      ...(options.omitOpen
        ? {}
        : {
            async open(id: string) {
              recorder.openCalls.push(id)
              if (options.openThrows) throw new Error('open boom')
              return handle
            },
          }),
      ...(options.omitStat
        ? {}
        : {
            async stat(id: string) {
              recorder.statCalls.push(id)
              if (options.statThrows) throw new Error('stat boom')
              return options.statEventCount === undefined
                ? undefined
                : { eventCount: options.statEventCount }
            },
          }),
    },
    ...(options.projectionBlank === undefined
      ? {}
      : {
          sessionProjections: {
            stateOf() {
              if (options.projectionThrows) throw new Error('projection boom')
              return { blank: options.projectionBlank }
            },
          },
        }),
    sessionId: 'sess-1',
  }

  return { deps, recorder, handle }
}

describe('C · 开场 notice', () => {
  it('通用消息：source.kind = dsh-rsi-agent、form = notice、summary 有界', () => {
    const message = buildOpeningNoticeMessage()
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe('dsh-rsi-agent')
    expect(message.source.form).toBe('notice')
    expect(typeof message.source.summary).toBe('string')
    expect(message.source.summary.length).toBeLessThanOrEqual(120)
    expect(message.source.summary).toBe(CORE_OPENING_NOTICE_SUMMARY)
    expect(message.content).toEqual([{ type: 'text', text: CORE_OPENING_NOTICE_TEXT }])
  })

  it('自定义文案与摘要原样进入消息', () => {
    const message = buildOpeningNoticeMessage('DOMAIN TEXT', 'DOMAIN SUMMARY')
    expect(message.content).toEqual([{ type: 'text', text: 'DOMAIN TEXT' }])
    expect(message.source.summary).toBe('DOMAIN SUMMARY')
    expect(message.source.kind).toBe('dsh-rsi-agent')
    expect(message.source.form).toBe('notice')
  })

  it('判读优先级 1：投影 blank=true → 直接 blank，不打开事件日志', async () => {
    const { deps, recorder } = makeDeps({ projectionBlank: true })
    const result = await deliverOpeningNotice(deps)
    expect(result.kind).toBe('delivered')
    expect(recorder.openCalls).toHaveLength(0)
    expect(recorder.statCalls).toHaveLength(0)
    expect(recorder.followups).toHaveLength(1)
  })

  it('投影 blank=false → 非 blank，不投递且不读事件日志', async () => {
    const { deps, recorder } = makeDeps({ projectionBlank: false })
    const result = await deliverOpeningNotice(deps)
    expect(result).toEqual({ kind: 'not-blank', id: 'sess-1' })
    expect(recorder.followups).toHaveLength(0)
    expect(recorder.openCalls).toHaveLength(0)
  })

  it('投影抛错 → 降级到事件日志判读（不中断）', async () => {
    const { deps, recorder } = makeDeps({
      projectionBlank: true,
      projectionThrows: true,
      events: [],
    })
    const result = await deliverOpeningNotice(deps)
    expect(result.kind).toBe('delivered')
    expect(recorder.openCalls).toEqual(['sess-1'])
  })

  it('判读优先级 2：事件日志无 turn/start → blank，投递后关闭句柄', async () => {
    const { deps, recorder } = makeDeps({ events: ['session/init'] })
    const result = await deliverOpeningNotice(deps)
    expect(result.kind).toBe('delivered')
    expect(recorder.followups).toHaveLength(1)
    expect(recorder.closes).toBe(1)
  })

  it('事件日志含 turn/start → 非 blank，不投递', async () => {
    const { deps, recorder } = makeDeps({ events: ['session/init', 'turn/start'] })
    const result = await deliverOpeningNotice(deps)
    expect(result).toEqual({ kind: 'not-blank', id: 'sess-1' })
    expect(recorder.followups).toHaveLength(0)
    expect(recorder.closes).toBe(1)
  })

  it('判读优先级 3：open 抛错 + stat.eventCount === 0 → blank', async () => {
    const { deps, recorder } = makeDeps({ openThrows: true, statEventCount: 0 })
    const result = await deliverOpeningNotice(deps)
    expect(result.kind).toBe('delivered')
    expect(recorder.statCalls).toEqual(['sess-1'])
  })

  it('open 抛错 + stat.eventCount > 0 → 视为非 blank（兜底判据 eventCount === 0）', async () => {
    const { deps, recorder } = makeDeps({ openThrows: true, statEventCount: 3 })
    const result = await deliverOpeningNotice(deps)
    expect(result).toEqual({ kind: 'not-blank', id: 'sess-1' })
    expect(recorder.followups).toHaveLength(0)
  })

  it('open / stat 都不可用 → 判读未知，skip', async () => {
    const { deps, recorder } = makeDeps({ omitOpen: true, omitStat: true })
    const result = await deliverOpeningNotice(deps)
    expect(result.kind).toBe('skipped')
    expect(recorder.followups).toHaveLength(0)
  })

  it('agents.get 抛错 → skip，不抛异常', async () => {
    const { deps } = makeDeps({ getThrows: true })
    const result = await deliverOpeningNotice(deps)
    expect(result.kind).toBe('skipped')
    if (result.kind === 'skipped') expect(result.detail).toContain('agents.get failed')
  })

  it('blank 但 agent 不可达 → skip', async () => {
    const { deps } = makeDeps({ agent: null, events: [] })
    const result = await deliverOpeningNotice(deps)
    expect(result.kind).toBe('skipped')
    if (result.kind === 'skipped') expect(result.detail).toBe('agent unreachable')
  })

  it('followup 抛错 → skip + log，不向上抛', async () => {
    const logs: string[] = []
    const { deps } = makeDeps({ events: [], followupThrows: true })
    const result = await deliverOpeningNotice({ ...deps, logger: (m) => logs.push(m) })
    expect(result.kind).toBe('skipped')
    expect(logs.join('\n')).toContain('投递开场 notice 失败')
  })

  it('领域文案优先于通用文案', async () => {
    const { deps, recorder } = makeDeps({ events: [] })
    await deliverOpeningNotice({ ...deps, text: 'DOMAIN-ONLY' })
    expect(recorder.followups[0].content).toEqual([{ type: 'text', text: 'DOMAIN-ONLY' }])
  })

  it('未提供领域文案时使用通用文案', async () => {
    const { deps, recorder } = makeDeps({ events: [] })
    await deliverOpeningNotice(deps)
    expect(recorder.followups[0].content).toEqual([
      { type: 'text', text: CORE_OPENING_NOTICE_TEXT },
    ])
    expect(recorder.followups[0].source.summary).toBe(CORE_OPENING_NOTICE_SUMMARY)
  })

  it('D2 · blank 判读期间 token 被置位 → 不 followup（投递链路内二次探测）', async () => {
    const followups: NoticeUserMessage[] = []
    let cancelled = false
    const deps: OpeningNoticeDeps = {
      agents: {
        get: () => ({
          id: 'sess-1',
          session: { id: 'sess-1' },
          followup: (message) => followups.push(message),
        }),
      },
      sessionPersistence: {
        async open() {
          await new Promise((resolve) => setTimeout(resolve, 20))
          return { read: async () => ({ events: [] }), close: async () => {} }
        },
      },
      sessionId: 'sess-1',
      isCancelled: () => cancelled,
    }

    const pending = deliverOpeningNotice(deps)
    // 模拟「判读窗口内领域 install 到达」。
    cancelled = true
    const result = await pending

    expect(result.kind).toBe('skipped')
    if (result.kind === 'skipped') expect(result.detail).toBe('cancelled')
    expect(followups).toHaveLength(0)
  })

  it('D2 · 同一会话并发投递串行化：只投 1 条（后者读到非 blank）', async () => {
    const events: string[] = []
    const followups: NoticeUserMessage[] = []
    const deps: OpeningNoticeDeps = {
      agents: {
        get: () => ({
          id: 'sess-1',
          session: { id: 'sess-1' },
          followup: (message) => {
            followups.push(message)
            events.push('turn/start')
          },
        }),
      },
      sessionPersistence: {
        async open() {
          return {
            // 关键：两个并发调用都会先取快照、再一起等待；若没有串行锁，
            // 二者都会在任一方 followup 之前读到「空日志」。
            read: async () => {
              const snapshot = [...events]
              await new Promise((resolve) => setTimeout(resolve, 20))
              return { events: snapshot.map((type) => ({ type })) }
            },
            close: async () => {},
          }
        },
      },
      sessionId: 'sess-1',
    }

    const [first, second] = await Promise.all([
      deliverOpeningNotice(deps),
      deliverOpeningNotice({ ...deps, text: 'DOMAIN-ONLY' }),
    ])

    expect(followups).toHaveLength(1)
    expect(first.kind).toBe('delivered')
    expect(second.kind).toBe('not-blank')
  })

  it('isSessionBlank：投影优先于事件日志（投影可用时不 open）', async () => {
    const { deps, recorder } = makeDeps({ projectionBlank: true })
    const blank = await isSessionBlank(
      {
        sessionPersistence: deps.sessionPersistence,
        sessionProjections: deps.sessionProjections,
        sessionId: 'sess-1',
      },
      { id: 'sess-1' },
    )
    expect(blank).toBe(true)
    expect(recorder.openCalls).toHaveLength(0)
  })

  it('isSessionBlank：open 抛错且无 stat → undefined（未知）', async () => {
    const { deps } = makeDeps({ openThrows: true, omitStat: true })
    const blank = await isSessionBlank({
      sessionPersistence: deps.sessionPersistence,
      sessionId: 'sess-1',
    })
    expect(blank).toBeUndefined()
  })
})

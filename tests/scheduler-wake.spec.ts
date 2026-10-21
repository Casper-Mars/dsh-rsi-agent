/**
 * 唤醒护栏：2000 字符截断（不切 emoji）/ disclaimer / 5 分钟冷却边界 / 投递降级。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WAKE_COOLDOWN_MS,
  DEFAULT_WAKE_TEXT_BUDGET,
  Waker,
  buildWakeText,
  deriveWakeSummary,
  splitGraphemes,
  truncateText,
  type WakeInput,
} from '../src/scheduler/wake'

const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'

function fixedClock(start = Date.parse('2026-01-01T00:00:00Z')): {
  now(): Date
  advance(ms: number): void
} {
  let current = start
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms
    },
  }
}

function recordingSink(): { sink: { deliver(input: WakeInput): void }; calls: WakeInput[] } {
  const calls: WakeInput[] = []
  return { sink: { deliver: (input) => calls.push(input) }, calls }
}

describe('截断 · 字素安全', () => {
  it('默认预算为 2000 字符 / 冷却 5 分钟', () => {
    expect(DEFAULT_WAKE_TEXT_BUDGET).toBe(2000)
    expect(DEFAULT_WAKE_COOLDOWN_MS).toBe(5 * 60 * 1000)
  })

  it('未超预算的文本原样返回', () => {
    expect(truncateText('hello', 2000)).toBe('hello')
  })

  it('超预算按字符数截断', () => {
    const text = 'a'.repeat(2001)
    expect(truncateText(text, 2000)).toHaveLength(2000)
  })

  it('不切半个代理对（emoji 边界）', () => {
    const text = '😀'.repeat(2001)
    const result = truncateText(text, 2000)
    expect(splitGraphemes(result)).toHaveLength(2000)
    expect(result).toBe('😀'.repeat(2000))
    // 末位必须是完整代理对的低位（不能留下孤立高位代理项）。
    const lastCode = result.charCodeAt(result.length - 1)
    expect(lastCode >= 0xdc00 && lastCode <= 0xdfff).toBe(true)
  })

  it('不拆 ZWJ 组合 emoji', () => {
    const text = FAMILY.repeat(3)
    const result = truncateText(text, 2)
    expect(result).toBe(FAMILY.repeat(2))
  })

  it('预算 <= 0 → 空串', () => {
    expect(truncateText('abc', 0)).toBe('')
    expect(truncateText('abc', -1)).toBe('')
  })

  it('splitGraphemes 对 ASCII 与 emoji 逐字素切分', () => {
    expect(splitGraphemes('ab')).toEqual(['a', 'b'])
    expect(splitGraphemes(FAMILY)).toEqual([FAMILY])
  })
})

describe('正文组装 · disclaimer', () => {
  it('无 disclaimer 时正文就只是截断后的 data', () => {
    expect(buildWakeText('hi', { budget: 2000 })).toBe('hi')
  })

  it('有 disclaimer 时追加在末尾（空行分隔）', () => {
    expect(buildWakeText('hi', { budget: 2000, disclaimer: '本内容不构成投资建议' })).toBe(
      'hi\n\n本内容不构成投资建议',
    )
  })

  it('先截断 data 再追加 disclaimer（声明本身不被预算裁剪）', () => {
    const text = buildWakeText('x'.repeat(3000), { budget: 2000, disclaimer: 'DISCLAIMER' })
    expect(text.endsWith('\n\nDISCLAIMER')).toBe(true)
    expect(text.slice(0, 2000)).toBe('x'.repeat(2000))
  })

  it('空白 disclaimer 视为未声明', () => {
    expect(buildWakeText('hi', { disclaimer: '   ' })).toBe('hi')
  })

  it('摘要取首行非空内容并受 120 字符上限约束', () => {
    expect(deriveWakeSummary('\n\n第一行\n第二行')).toBe('第一行')
    expect(deriveWakeSummary('a'.repeat(500))).toHaveLength(120)
    expect(deriveWakeSummary('   \n  ')).toBe('定时任务唤醒')
  })
})

describe('Waker · 冷却与降级', () => {
  it('首次唤醒成功并记录投递目标', async () => {
    const clock = fixedClock()
    const { sink, calls } = recordingSink()
    const waker = new Waker({ sink, sessionId: 'agent', clock })
    const result = await waker.wake('demo', 'hello')
    expect(result).toMatchObject({ kind: 'woke', targets: ['agent'] })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toBe('hello')
    expect(calls[0]?.summary).toBe('hello')
  })

  it('冷却窗口内第二次唤醒 → skipped', async () => {
    const clock = fixedClock()
    const { sink, calls } = recordingSink()
    const waker = new Waker({ sink, sessionId: 'agent', clock })
    await waker.wake('demo', 'a')
    clock.advance(1000)
    const second = await waker.wake('demo', 'b')
    expect(second.kind).toBe('skipped')
    expect(calls).toHaveLength(1)
  })

  it('4 分 59 秒仍在冷却 → 压住', async () => {
    const clock = fixedClock()
    const { sink } = recordingSink()
    const waker = new Waker({ sink, sessionId: 'agent', clock })
    await waker.wake('demo', 'a')
    clock.advance(4 * 60 * 1000 + 59 * 1000)
    expect((await waker.wake('demo', 'b')).kind).toBe('skipped')
    expect(waker.isInCooldown('demo')).toBe(true)
  })

  it('5 分 01 秒 → 放行', async () => {
    const clock = fixedClock()
    const { sink, calls } = recordingSink()
    const waker = new Waker({ sink, sessionId: 'agent', clock })
    await waker.wake('demo', 'a')
    clock.advance(5 * 60 * 1000 + 1000)
    expect((await waker.wake('demo', 'b')).kind).toBe('woke')
    expect(calls).toHaveLength(2)
  })

  it('恰好 5 分整 → 放行（边界闭区间）', async () => {
    const clock = fixedClock()
    const { sink } = recordingSink()
    const waker = new Waker({ sink, sessionId: 'agent', clock })
    await waker.wake('demo', 'a')
    clock.advance(5 * 60 * 1000)
    expect((await waker.wake('demo', 'b')).kind).toBe('woke')
  })

  it('冷却按 task_id 隔离：另一个任务不受影响', async () => {
    const clock = fixedClock()
    const { sink, calls } = recordingSink()
    const waker = new Waker({ sink, sessionId: 'agent', clock })
    await waker.wake('a', 'x')
    expect((await waker.wake('b', 'y')).kind).toBe('woke')
    expect(calls).toHaveLength(2)
  })

  it('cooldownMs <= 0 → 关闭冷却', async () => {
    const clock = fixedClock()
    const { sink, calls } = recordingSink()
    const waker = new Waker({ sink, sessionId: 'agent', clock, cooldownMs: 0 })
    await waker.wake('demo', 'a')
    await waker.wake('demo', 'b')
    expect(calls).toHaveLength(2)
  })

  it('投递抛错 → skipped，且不写入冷却（下一次仍会尝试）', async () => {
    const clock = fixedClock()
    let attempts = 0
    const waker = new Waker({
      sessionId: 'agent',
      clock,
      sink: {
        deliver() {
          attempts += 1
          if (attempts === 1) throw new Error('session gone')
        },
      },
    })
    const first = await waker.wake('demo', 'a')
    expect(first).toMatchObject({ kind: 'skipped' })
    expect(waker.isInCooldown('demo')).toBe(false)
    expect((await waker.wake('demo', 'b')).kind).toBe('woke')
  })

  it('异步 sink reject 同样降级为 skipped', async () => {
    const waker = new Waker({
      sessionId: 'agent',
      sink: {
        async deliver() {
          throw new Error('boom')
        },
      },
    })
    expect((await waker.wake('demo', 'a')).kind).toBe('skipped')
  })

  it('唤醒正文经预算截断后再投递', async () => {
    const { sink, calls } = recordingSink()
    const waker = new Waker({ sink, sessionId: 'agent', budget: 5 })
    await waker.wake('demo', 'abcdefgh')
    expect(calls[0]?.text).toBe('abcde')
  })

  it('disclaimer 出现在实际投递正文末尾', async () => {
    const { sink, calls } = recordingSink()
    const waker = new Waker({ sink, sessionId: 'agent', disclaimer: '声明' })
    await waker.wake('demo', 'hello')
    expect(calls[0]?.text).toBe('hello\n\n声明')
  })

  it('cooldownRemainingMs 递减', async () => {
    const clock = fixedClock()
    const { sink } = recordingSink()
    const waker = new Waker({ sink, sessionId: 'agent', clock })
    await waker.wake('demo', 'a')
    clock.advance(60_000)
    expect(waker.cooldownRemainingMs('demo')).toBe(4 * 60 * 1000)
  })
})


describe('冷却 · 并发不双投（M1）', () => {
  it('同一 task_id 并发两次 wake（异步 sink）→ 只投递一次', async () => {
    let deliveries = 0
    const waker = new Waker({
      sessionId: 'agent',
      sink: {
        async deliver() {
          deliveries += 1
          await new Promise((resolve) => setTimeout(resolve, 20))
        },
      },
    })

    const results = await Promise.all([waker.wake('demo', 'a'), waker.wake('demo', 'b')])

    expect(deliveries).toBe(1)
    expect(results.map((result) => result.kind).sort()).toEqual(['skipped', 'woke'])
  })

  it('占位在投递前写入：投递进行中即视为冷却窗口', async () => {
    let release: (() => void) | undefined
    const waker = new Waker({
      sessionId: 'agent',
      clock: { now: () => new Date('2026-01-01T00:00:00Z') },
      sink: {
        deliver: () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
      },
    })

    const first = waker.wake('demo', 'a')
    // 投递尚未完成，但冷却位已占：第二次立刻被拦。
    expect(waker.isInCooldown('demo')).toBe(true)
    expect((await waker.wake('demo', 'b')).kind).toBe('skipped')
    release?.()
    expect((await first).kind).toBe('woke')
  })
})

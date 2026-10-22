/**
 * Task-09 · D：启动 grace。
 *
 * 纯控制器用例使用 fake timers；AgentHost 集成用例使用真实计时器（避免
 * fake timers 干扰 install 内的 git 子进程）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentHost } from '../src/service'
import { CORE_OPENING_NOTICE_TEXT, type SessionHandleLike } from '../src/opening-notice'
import { runGenericStartup, startStartupSequence } from '../src/startup'
import type { NoticeUserMessage } from '../src/message-source'
import type { EnsureAgentHandle } from '../src/session-ensure'
import { PERSONA_SECTION_NAME, type PromptSectionLike, type SystemPromptLike } from '../src/prompts/persona'
import type { DomainPack } from '../src/types'

interface EnvRecorder {
  getCalls: string[]
  createCalls: Array<Record<string, unknown>>
  notices: NoticeUserMessage[]
  events: Map<string, string[]>
  disposed: string[]
  handles: EnsureAgentHandle[]
}

/** 可复用的会话环境替身：create 后会话 live，followup 即视为发生 turn/start。 */
function makeEnv(seed?: Record<string, string[]>): {
  agents: {
    get(id: string): unknown
    create(options: { sessionId: string }): Promise<EnsureAgentHandle>
    resume(options: { resumeSessionId: string }): Promise<EnsureAgentHandle>
  }
  persistence: {
    stat(id: string): Promise<{ eventCount: number } | undefined>
    open(id: string, access: 'read'): Promise<SessionHandleLike>
  }
  recorder: EnvRecorder
} {
  const recorder: EnvRecorder = {
    getCalls: [],
    createCalls: [],
    notices: [],
    events: new Map(Object.entries(seed ?? {})),
    disposed: [],
    handles: [],
  }
  const sessions = new Map<string, { id: string; session: unknown; followup(m: NoticeUserMessage): void }>()

  const makeHandle = (id: string): EnsureAgentHandle => {
    const handle: EnsureAgentHandle = {
      agent: { id },
      dispose: async () => {
        recorder.disposed.push(id)
        sessions.delete(id)
      },
    }
    recorder.handles.push(handle)
    return handle
  }

  const agents = {
    get(id: string) {
      recorder.getCalls.push(id)
      return sessions.get(id)
    },
    async create(options: { sessionId: string }) {
      recorder.createCalls.push(options as unknown as Record<string, unknown>)
      const id = options.sessionId
      if (!recorder.events.has(id)) recorder.events.set(id, [])
      const agent = {
        id,
        session: { id },
        followup(message: NoticeUserMessage) {
          recorder.notices.push(message)
          recorder.events.get(id)?.push('turn/start')
        },
      }
      sessions.set(id, agent)
      return makeHandle(id)
    },
    async resume(options: { resumeSessionId: string }) {
      const id = options.resumeSessionId
      const agent = {
        id,
        session: { id },
        followup(message: NoticeUserMessage) {
          recorder.notices.push(message)
          recorder.events.get(id)?.push('turn/start')
        },
      }
      sessions.set(id, agent)
      return makeHandle(id)
    },
  }

  const persistence = {
    async stat(id: string) {
      const events = recorder.events.get(id)
      return events ? { eventCount: events.length } : undefined
    },
    async open(id: string): Promise<SessionHandleLike> {
      const events = recorder.events.get(id)
      if (!events) throw new Error('session not found')
      return {
        read: async () => ({ events: events.map((type) => ({ type })) }),
        close: async () => {},
      }
    },
  }

  return { agents, persistence, recorder }
}

function makeDeps(env: ReturnType<typeof makeEnv>, graceMs: number) {
  return {
    graceMs,
    sessionId: 'sess-1',
    workspaceDir: '/tmp/work',
    resolveServices: () => ({
      agents: env.agents,
      sessionPersistence: env.persistence,
    }),
  }
}

function makePack(overrides: Partial<DomainPack> = {}): DomainPack {
  return {
    apiVersion: 1,
    id: 'alpha-domain',
    version: '1.0.0',
    persona: { markdown: () => '# Alpha Persona' },
    defaultSessionId: 'sess-1',
    assets: { types: [{ name: 'notes', prefix: 'notes/' }] },
    scheduler: { timezone: 'Asia/Shanghai' },
    evolutionPolicy: { window: '7d', independentCases: 3 },
    tools: () => [],
    toolNames: [],
    ...overrides,
  }
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 连续 flush 微任务（fake timers 下链式 await 不会被一次 advance 全部排空）。 */
async function flushMicrotasks(times = 12): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

function messageText(message: NoticeUserMessage): string {
  return (message.content[0] as { text: string }).text
}

afterEach(() => {
  vi.useRealTimers()
})

describe('D · 启动 grace（纯控制器）', () => {
  it('grace 到期前不执行通用路径，到期后 ensure + 投递通用开场', async () => {
    vi.useFakeTimers()
    const env = makeEnv()
    const controller = startStartupSequence(makeDeps(env, 1000))

    expect(controller.pending).toBe(true)
    expect(env.recorder.getCalls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(999)
    expect(env.recorder.getCalls).toHaveLength(0)
    expect(env.recorder.notices).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    expect(env.recorder.createCalls).toHaveLength(1)
    expect(env.recorder.notices).toHaveLength(1)
    expect(messageText(env.recorder.notices[0])).toBe(CORE_OPENING_NOTICE_TEXT)
    expect(controller.pending).toBe(false)
  })

  it('grace 内取消 → 计时器被清理，时间推进也永不触发', async () => {
    vi.useFakeTimers()
    const env = makeEnv()
    const controller = startStartupSequence(makeDeps(env, 1000))

    expect(vi.getTimerCount()).toBe(1)
    controller.cancel('domain install')
    expect(controller.cancelled).toBe(true)
    expect(controller.pending).toBe(false)
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(env.recorder.getCalls).toHaveLength(0)
    expect(env.recorder.createCalls).toHaveLength(0)
    expect(env.recorder.notices).toHaveLength(0)
  })

  it('startupGraceMs = 0 → 立即走通用路径，且不产生计时器', async () => {
    vi.useFakeTimers()
    const env = makeEnv()
    const controller = startStartupSequence(makeDeps(env, 0))

    expect(controller.pending).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    // get 在同步段被调用（ensure 直到首个 await 前都是同步的）。
    expect(env.recorder.getCalls).toEqual(['sess-1'])

    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    expect(env.recorder.createCalls).toEqual([{ sessionId: 'sess-1', meta: { cwd: '/tmp/work' } }])
    expect(env.recorder.notices).toHaveLength(1)
  })

  it('ensure 跳过时不再投递开场', async () => {
    const env = makeEnv()
    env.agents.create = async () => {
      throw new Error('create boom')
    }
    const result = await runGenericStartup(makeDeps(env, 0))
    expect(result.kind).toBe('ensure-skipped')
    expect(env.recorder.notices).toHaveLength(0)
  })

  it('服务缺失 → 降级 skip，不抛异常', async () => {
    const result = await runGenericStartup({
      graceMs: 0,
      sessionId: 'sess-1',
      workspaceDir: '/tmp/work',
      resolveServices: () => undefined,
    })
    expect(result.kind).toBe('skipped')
  })

  it('runGenericStartup 把 handle 交给 onSessionHandle（不自行拆除）', async () => {
    const env = makeEnv()
    let bound: EnsureAgentHandle | undefined
    const result = await runGenericStartup({
      ...makeDeps(env, 0),
      onSessionHandle: (handle) => {
        bound = handle
      },
    })
    expect(result.kind).toBe('delivered')
    expect(bound).toBe(env.recorder.handles[0])
    expect(env.recorder.disposed).toHaveLength(0)
  })

  it('重复取消是幂等的（不重复记日志 / 不抛）', () => {
    vi.useFakeTimers()
    const logs: string[] = []
    const env = makeEnv()
    const controller = startStartupSequence({
      ...makeDeps(env, 1000),
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    })
    controller.cancel('first')
    controller.cancel('second')
    expect(logs.filter((line) => line.includes('已取消'))).toHaveLength(1)
  })
})

describe('D · 启动 grace（AgentHost 集成）', () => {
  it('grace 内 install → 取消计时器，只出现领域开场', async () => {
    const env = makeEnv()
    const ctx = new Context()
    ctx.provide('agents', env.agents as never)
    ctx.provide('sessionPersistence', env.persistence as never)

    const host = new AgentHost(ctx, {
      config: { startupGraceMs: 4000, sessionId: 'sess-1' },
    })
    const controller = host.start()
    expect(controller?.pending).toBe(true)

    const dispose = host.install(makePack({ openingNotice: 'DOMAIN-OPEN' }))
    expect(controller?.cancelled).toBe(true)
    expect(controller?.pending).toBe(false)

    await waitFor(() => env.recorder.notices.length === 1)
    await sleep(30)

    expect(env.recorder.notices).toHaveLength(1)
    expect(messageText(env.recorder.notices[0])).toBe('DOMAIN-OPEN')
    dispose()
  })

  it('grace 过期后 install → 不产生第二条开场，persona 切换为领域', async () => {
    const env = makeEnv()
    const sections: PromptSectionLike[] = []
    const systemPrompt: SystemPromptLike = {
      section(section) {
        sections.push(section)
        return () => {}
      },
    }

    const ctx = new Context()
    ctx.provide('agents', env.agents as never)
    ctx.provide('sessionPersistence', env.persistence as never)
    ctx.provide('systemPrompt', systemPrompt as never)

    const host = new AgentHost(ctx, {
      config: { startupGraceMs: 0, sessionId: 'sess-1' },
    })
    host.start()

    // 通用开场先落地（会话因此变为非 blank）。
    await waitFor(() => env.recorder.notices.length === 1)
    expect(messageText(env.recorder.notices[0])).toBe(CORE_OPENING_NOTICE_TEXT)
    await waitFor(() => sections.length === 1)

    const dispose = host.install(
      makePack({ persona: { markdown: () => '# Alpha Persona' }, openingNotice: 'DOMAIN-OPEN' }),
    )

    // 领域 persona 已叠加在 core 之后；会话已 live → 直接复用，不再投第二条开场。
    await waitFor(() => (sections[0].text as () => string)().endsWith('# Alpha Persona'))
    await sleep(50)

    expect(env.recorder.notices).toHaveLength(1)
    expect(env.recorder.createCalls).toHaveLength(1)
    expect(sections).toHaveLength(1)
    expect(sections[0].name).toBe(PERSONA_SECTION_NAME)
    dispose()
  })

  it('D1 · grace 内 install 失败不消耗宽限：到期仍投递通用开场（仅 1 条）', async () => {
    vi.useFakeTimers()
    const env = makeEnv()
    const ctx = new Context()
    ctx.provide('agents', env.agents as never)
    ctx.provide('sessionPersistence', env.persistence as never)

    const host = new AgentHost(ctx, {
      config: { startupGraceMs: 300, sessionId: 'sess-1' },
    })
    host.start()
    expect(vi.getTimerCount()).toBe(1)

    // 校验阶段失败（apiVersion 非法）→ 不得消耗本轮宽限。
    expect(() => host.install(makePack({ apiVersion: 999 }))).toThrow()
    expect(host.active).toBeUndefined()
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(299)
    expect(env.recorder.notices).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(env.recorder.notices).toHaveLength(1)
    expect(messageText(env.recorder.notices[0])).toBe(CORE_OPENING_NOTICE_TEXT)
  })

  it('D1 · install 同步成功时不抢跑：通用开场文案 0 次', async () => {
    const env = makeEnv()
    const ctx = new Context()
    ctx.provide('agents', env.agents as never)
    ctx.provide('sessionPersistence', env.persistence as never)

    const host = new AgentHost(ctx, {
      config: { startupGraceMs: 300, sessionId: 'sess-1' },
    })
    const controller = host.start()
    const dispose = host.install(makePack({ openingNotice: 'DOMAIN-OPEN' }))

    expect(controller?.cancelled).toBe(true)
    await waitFor(() => env.recorder.notices.length === 1)
    // 越过原宽限期：顺延计时器必须已被 cancel 清理。
    await sleep(450)

    expect(env.recorder.notices).toHaveLength(1)
    expect(
      env.recorder.notices.filter((message) => messageText(message) === CORE_OPENING_NOTICE_TEXT),
    ).toHaveLength(0)
    expect(messageText(env.recorder.notices[0])).toBe('DOMAIN-OPEN')
    dispose()
  })

  it('D2 · blank 判读窗口内 install：只投领域开场，通用文案 0 次', async () => {
    const env = makeEnv()
    const originalOpen = env.persistence.open
    // 模拟宿主读事件日志较慢：general 路径的 blank 判读会跨越 install 时刻。
    env.persistence.open = async (id: string) => {
      await sleep(320)
      return originalOpen(id)
    }

    const ctx = new Context()
    ctx.provide('agents', env.agents as never)
    ctx.provide('sessionPersistence', env.persistence as never)

    const host = new AgentHost(ctx, {
      config: { startupGraceMs: 30, sessionId: 'sess-1' },
    })
    host.start()

    await sleep(150)
    const dispose = host.install(makePack({ openingNotice: 'DOMAIN-OPEN' }))

    await waitFor(() => env.recorder.notices.length >= 1, 5000)
    // 再等一轮（domain 路径自己的 blank 判读也延迟 320ms）。
    await sleep(500)

    expect(env.recorder.notices).toHaveLength(1)
    expect(messageText(env.recorder.notices[0])).toBe('DOMAIN-OPEN')
    expect(
      env.recorder.notices.filter((message) => messageText(message) === CORE_OPENING_NOTICE_TEXT),
    ).toHaveLength(0)
    dispose()
  })
})

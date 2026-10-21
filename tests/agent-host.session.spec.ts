/**
 * Task-09 · B/C 集成：AgentHost 安装期的会话 ensure / 开场 notice / 拆除。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentHost } from '../src/service'
import type { NoticeUserMessage } from '../src/message-source'
import type { EnsureAgentHandle } from '../src/session-ensure'
import type { DomainPack } from '../src/types'

function makePack(overrides: Partial<DomainPack> = {}): DomainPack {
  return {
    apiVersion: 1,
    id: 'alpha-domain',
    version: '1.0.0',
    persona: { markdown: () => '# Alpha' },
    defaultSessionId: 'alpha-session',
    assets: { types: [{ name: 'notes', prefix: 'notes/' }] },
    scheduler: { timezone: 'Asia/Shanghai' },
    evolutionPolicy: { window: '7d', independentCases: 3 },
    tools: () => [],
    toolNames: [],
    ...overrides,
  }
}

interface Env {
  agents: Record<string, unknown>
  persistence: Record<string, unknown>
  createCalls: Array<{ sessionId: string; meta?: { cwd?: string } }>
  resumeCalls: Array<{ resumeSessionId: string }>
  notices: NoticeUserMessage[]
  events: Map<string, string[]>
  disposed: string[]
}

function makeEnv(seed?: Record<string, string[]>): Env {
  const events = new Map(Object.entries(seed ?? {}))
  const sessions = new Map<string, { id: string; session: unknown; followup(m: NoticeUserMessage): void }>()
  const env: Env = {
    createCalls: [],
    resumeCalls: [],
    notices: [],
    events,
    disposed: [],
    agents: {},
    persistence: {},
  }

  const makeAgent = (id: string) => ({
    id,
    session: { id },
    followup(message: NoticeUserMessage) {
      env.notices.push(message)
      events.get(id)?.push('turn/start')
    },
  })

  const handle = (id: string): EnsureAgentHandle => ({
    agent: { id },
    dispose: async () => {
      env.disposed.push(id)
      sessions.delete(id)
    },
  })

  env.agents = {
    get: (id: string) => sessions.get(id),
    create: async (options: { sessionId: string; meta?: { cwd?: string } }) => {
      env.createCalls.push(options)
      if (!events.has(options.sessionId)) events.set(options.sessionId, [])
      sessions.set(options.sessionId, makeAgent(options.sessionId))
      return handle(options.sessionId)
    },
    resume: async (options: { resumeSessionId: string }) => {
      env.resumeCalls.push(options)
      sessions.set(options.resumeSessionId, makeAgent(options.resumeSessionId))
      return handle(options.resumeSessionId)
    },
  }

  env.persistence = {
    stat: async (id: string) => (events.has(id) ? { eventCount: events.get(id)!.length } : undefined),
    open: async (id: string) => {
      const list = events.get(id)
      if (!list) throw new Error('missing')
      return {
        read: async () => ({ events: list.map((type) => ({ type })) }),
        close: async () => {},
      }
    },
  }

  return env
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function createContext(env: Env): Context {
  const ctx = new Context()
  ctx.provide('agents', env.agents as never)
  ctx.provide('sessionPersistence', env.persistence as never)
  return ctx
}

describe('B/C · AgentHost 安装期会话', () => {
  it('无持久化 → create，cwd 为领域 workspace；dispose 拆除会话句柄', async () => {
    const env = makeEnv()
    const ctx = createContext(env)
    const host = new AgentHost(ctx)

    const dispose = host.install(makePack())
    await waitFor(() => env.createCalls.length === 1)

    expect(host.active?.sessionId).toBe('alpha-session')
    expect(env.createCalls[0]).toEqual({
      sessionId: 'alpha-session',
      meta: { cwd: host.active?.runtime.workspaceDir },
    })

    await waitFor(() => env.notices.length === 1)
    dispose()
    await waitFor(() => env.disposed.length === 1)
    expect(env.disposed).toEqual(['alpha-session'])
  })

  it('已持久化 → resume 恢复，不调用 create', async () => {
    const env = makeEnv({ 'alpha-session': [] })
    const ctx = createContext(env)
    const host = new AgentHost(ctx)

    const dispose = host.install(makePack())
    await waitFor(() => env.resumeCalls.length === 1)

    expect(env.resumeCalls[0]).toEqual({ resumeSessionId: 'alpha-session' })
    expect(env.createCalls).toHaveLength(0)
    await waitFor(() => env.notices.length === 1)
    dispose()
  })

  it('已有 turn/start（非 blank）→ 重启不重复投递开场', async () => {
    const env = makeEnv({ 'alpha-session': ['turn/start'] })
    const ctx = createContext(env)
    const host = new AgentHost(ctx)

    const dispose = host.install(makePack())
    await waitFor(() => env.resumeCalls.length === 1)
    // 给 notice 判读留出时间，再断言没有投递。
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(env.notices).toHaveLength(0)
    dispose()
  })

  it('agents / sessionPersistence 缺失 → install 仍成功（降级 skip）', () => {
    const ctx = new Context()
    const host = new AgentHost(ctx)
    const dispose = host.install(makePack())
    expect(host.active?.id).toBe('alpha-domain')
    dispose()
    expect(host.active).toBeUndefined()
  })

  it('领域 openingNotice 优先于通用文案（安装期）', async () => {
    const env = makeEnv()
    const ctx = createContext(env)
    const host = new AgentHost(ctx)

    const dispose = host.install(makePack({ openingNotice: 'DOMAIN-ONLY' }))
    await waitFor(() => env.notices.length === 1)

    expect((env.notices[0].content[0] as { text: string }).text).toBe('DOMAIN-ONLY')
    expect(env.notices[0].source.kind).toBe('dsh-rsi-agent')
    expect(env.notices[0].source.form).toBe('notice')
    dispose()
  })
})

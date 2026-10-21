/**
 * Task-09 · B：会话 ensure 三分支。
 *
 * 纯注入式单测：`get` 命中 → 复用；`stat` 命中 → resume；都不存在 → create。
 * 另外覆盖服务异常 / 调用抛错时的 skip 语义（不抛、不中断）。
 */
import { describe, expect, it } from 'vitest'
import {
  ensureSession,
  type EnsureAgentHandle,
  type EnsureAgentsLike,
  type EnsureSessionPersistenceLike,
} from '../src/session-ensure'

interface Recorder {
  getCalls: string[]
  createCalls: Array<Record<string, unknown>>
  resumeCalls: Array<Record<string, unknown>>
  statCalls: string[]
}

function makeDeps(options: {
  live?: boolean
  persisted?: boolean
  getThrows?: boolean
  statThrows?: boolean
  createThrows?: boolean
  resumeThrows?: boolean
  existingHandle?: EnsureAgentHandle
  agentOptions?: { provider?: string; model?: string }
  workspaceDir?: string
  sessionId?: string
} = {}): {
  deps: Parameters<typeof ensureSession>[0]
  recorder: Recorder
  handle: EnsureAgentHandle
} {
  const recorder: Recorder = {
    getCalls: [],
    createCalls: [],
    resumeCalls: [],
    statCalls: [],
  }

  const handle: EnsureAgentHandle = options.existingHandle ?? {
    agent: { id: options.sessionId ?? 'sess-1' },
    dispose: async () => {},
  }

  const agents: EnsureAgentsLike = {
    get(id) {
      recorder.getCalls.push(id)
      if (options.getThrows) throw new Error('get boom')
      return options.live ? { id } : undefined
    },
    async create(input) {
      recorder.createCalls.push(input as unknown as Record<string, unknown>)
      if (options.createThrows) throw new Error('create boom')
      return handle
    },
    async resume(input) {
      recorder.resumeCalls.push(input as unknown as Record<string, unknown>)
      if (options.resumeThrows) throw new Error('resume boom')
      return handle
    },
  }

  const sessionPersistence: EnsureSessionPersistenceLike = {
    async stat(id) {
      recorder.statCalls.push(id)
      if (options.statThrows) throw new Error('stat boom')
      return options.persisted ? { id } : undefined
    },
  }

  return {
    recorder,
    handle,
    deps: {
      agents,
      sessionPersistence,
      sessionId: options.sessionId ?? 'sess-1',
      workspaceDir: options.workspaceDir ?? '/tmp/work',
      ...(options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
    },
  }
}

describe('B · 会话 ensure 三分支', () => {
  it('分支 1：agents.get 命中 → 复用，不调用 stat / resume / create', async () => {
    const { deps, recorder } = makeDeps({ live: true })
    const { outcome, handle } = await ensureSession(deps)

    expect(outcome).toEqual({ kind: 'reuse', id: 'sess-1' })
    expect(handle).toBeUndefined()
    expect(recorder.getCalls).toEqual(['sess-1'])
    expect(recorder.statCalls).toHaveLength(0)
    expect(recorder.resumeCalls).toHaveLength(0)
    expect(recorder.createCalls).toHaveLength(0)
  })

  it('分支 2：stat 命中 → resume，不调用 create', async () => {
    const { deps, recorder, handle } = makeDeps({ persisted: true })
    const result = await ensureSession(deps)

    expect(result.outcome).toEqual({ kind: 'resumed', id: 'sess-1' })
    expect(result.handle).toBe(handle)
    expect(recorder.statCalls).toEqual(['sess-1'])
    expect(recorder.resumeCalls).toEqual([{ resumeSessionId: 'sess-1' }])
    expect(recorder.createCalls).toHaveLength(0)
  })

  it('分支 3：都不存在 → create，cwd 精确等于 workspaceDir', async () => {
    const { deps, recorder, handle } = makeDeps({ workspaceDir: '/tmp/domain workspace' })
    const result = await ensureSession(deps)

    expect(result.outcome).toEqual({ kind: 'created', id: 'sess-1' })
    expect(result.handle).toBe(handle)
    expect(recorder.resumeCalls).toHaveLength(0)
    expect(recorder.createCalls).toEqual([
      { sessionId: 'sess-1', meta: { cwd: '/tmp/domain workspace' } },
    ])
  })

  it('agentOptions 仅在非空时透传（resume / create）', async () => {
    const resumed = makeDeps({
      persisted: true,
      agentOptions: { provider: 'p', model: 'm' },
    })
    await ensureSession(resumed.deps)
    expect(resumed.recorder.resumeCalls[0]).toEqual({
      resumeSessionId: 'sess-1',
      agentOptions: { provider: 'p', model: 'm' },
    })

    const created = makeDeps({ agentOptions: { provider: 'p', model: 'm' } })
    await ensureSession(created.deps)
    expect(created.recorder.createCalls[0]).toEqual({
      sessionId: 'sess-1',
      meta: { cwd: '/tmp/work' },
      agentOptions: { provider: 'p', model: 'm' },
    })
  })

  it('空 agentOptions 不写入选项对象', async () => {
    const { deps, recorder } = makeDeps({ agentOptions: {} })
    await ensureSession(deps)
    expect(recorder.createCalls[0]).toEqual({
      sessionId: 'sess-1',
      meta: { cwd: '/tmp/work' },
    })
  })

  it('agents.get 抛错 → skipped，不抛异常', async () => {
    const { deps } = makeDeps({ getThrows: true })
    const { outcome, handle } = await ensureSession(deps)
    expect(outcome.kind).toBe('skipped')
    expect(handle).toBeUndefined()
    if (outcome.kind === 'skipped') expect(outcome.detail).toContain('agents.get failed')
  })

  it('stat 抛错 → skipped，不继续 create', async () => {
    const { deps, recorder } = makeDeps({ statThrows: true })
    const { outcome } = await ensureSession(deps)
    expect(outcome.kind).toBe('skipped')
    expect(recorder.createCalls).toHaveLength(0)
    expect(recorder.resumeCalls).toHaveLength(0)
  })

  it('resume 抛错 → skipped，不回落 create', async () => {
    const { deps, recorder } = makeDeps({ persisted: true, resumeThrows: true })
    const { outcome, handle } = await ensureSession(deps)
    expect(outcome.kind).toBe('skipped')
    expect(handle).toBeUndefined()
    expect(recorder.createCalls).toHaveLength(0)
    if (outcome.kind === 'skipped') expect(outcome.detail).toContain('resume failed')
  })

  it('create 抛错 → skipped，不抛异常', async () => {
    const { deps } = makeDeps({ createThrows: true })
    const { outcome } = await ensureSession(deps)
    expect(outcome.kind).toBe('skipped')
    if (outcome.kind === 'skipped') expect(outcome.detail).toContain('create failed')
  })

  it('skipped 时仍记录可读日志（含目标会话 id）', async () => {
    const logs: string[] = []
    const { deps } = makeDeps({ createThrows: true })
    await ensureSession({ ...deps, logger: (message) => logs.push(message) })
    expect(logs.join('\n')).toContain('sess-1')
    expect(logs.join('\n')).toContain('新建会话失败')
    expect(logs.join('\n')).toContain('create boom')
  })
})

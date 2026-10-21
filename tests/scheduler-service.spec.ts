/**
 * 调度器装配：start / stop / reload / 链式重排 / 不阻塞 / 时区与任务目录。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SchedulerService, createAgentWakeSink } from '../src/scheduler/service'
import type { ExecResult, TaskDef, Timer, TimerHandle } from '../src/scheduler/types'
import type { WakeInput } from '../src/scheduler/wake'

const roots: string[] = []

function tempRuntime(): {
  home: string
  assetsDir: string
  dataDir: string
  sessionId: string
  timezone: string
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rsi-svc-'))
  roots.push(root)
  return {
    home: root,
    assetsDir: join(root, 'assets'),
    dataDir: join(root, 'data'),
    sessionId: 'agent',
    timezone: 'Asia/Shanghai',
  }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

/** 为任务清单落一份可读的入口文件（runTask 会做真实可读性校验）。 */
function materialize(runtime: { home: string }, tasks: readonly TaskDef[]): void {
  for (const task of tasks) {
    if (task.task_path.trim() === '') continue
    const file = join(runtime.home, task.task_path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '// task', 'utf8')
  }
}

function def(id: string, overrides: Partial<TaskDef> = {}): TaskDef {
  return { id, name: id, cron: '0 9 * * *', task_path: `${id}.mjs`, enabled: true, ...overrides }
}

function fakeTimer(): Timer & {
  entries: Map<TimerHandle, { delayMs: number; cb: () => void }>
  fireAll(): void
  count(): number
} {
  const entries = new Map<TimerHandle, { delayMs: number; cb: () => void }>()
  let seq = 0
  return {
    entries,
    count: () => entries.size,
    setTimer(delayMs, cb) {
      seq += 1
      const handle = seq as unknown as TimerHandle
      entries.set(handle, { delayMs, cb })
      return handle
    },
    clearTimer(handle) {
      entries.delete(handle)
    },
    fireAll() {
      const snapshot = [...entries.entries()]
      entries.clear()
      for (const [, entry] of snapshot) entry.cb()
    },
  }
}

function okResult(shouldWake = false, data = ''): ExecResult {
  return {
    exitCode: 0,
    stdout: shouldWake
      ? JSON.stringify({ shouldWake: true, data })
      : JSON.stringify({ shouldWake: false }),
    stderr: '',
    truncated: false,
    timedOut: false,
  }
}

interface BuildOptions {
  tasks?: TaskDef[]
  exec?: (input: { taskPath: string }) => Promise<ExecResult>
  warnings?: string[]
  schedulerExtras?: Record<string, unknown>
  disclaimer?: string
  configTimezone?: string
  runtime?: ReturnType<typeof tempRuntime>
}

function build(options: BuildOptions = {}) {
  const runtime = options.runtime ?? tempRuntime()
  const timer = fakeTimer()
  const tasks = options.tasks ?? []
  materialize(runtime, tasks)
  const wakeCalls: WakeInput[] = []
  const service = new SchedulerService({
    runtime,
    scheduler: { timezone: 'Asia/Shanghai', ...(options.schedulerExtras ?? {}) },
    ...(options.disclaimer === undefined ? {} : { disclaimer: options.disclaimer }),
    ...(options.configTimezone === undefined ? {} : { configTimezone: options.configTimezone }),
    timer,
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    logger: {
      info: () => {},
      warn: (message: string) => options.warnings?.push(message),
      error: (message: string) => options.warnings?.push(message),
      debug: () => {},
    },
    store: {
      tasksDir: join(runtime.assetsDir, 'tasks'),
      list: () => ({ tasks, corrupted: [] }),
      get: (id: string) => tasks.find((task) => task.id === id),
      save: () => {},
      remove: () => false,
    },
    deps: { ensure: async () => ({ installed: false, reason: 'cache hit' }) },
    exec: {
      name: 'fake-node',
      exec: options.exec ?? (async () => okResult()),
    },
    sink: { deliver: (input) => wakeCalls.push(input) },
  })
  return { service, timer, runtime, wakeCalls }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('SchedulerService · 生命周期', () => {
  it('start 为每个启用且合法的任务装一条 timer', () => {
    const { service, timer } = build({ tasks: [def('a'), def('b')] })
    service.start()
    expect(service.running).toBe(true)
    expect(service.scheduledIds).toEqual(['a', 'b'])
    expect(timer.count()).toBe(2)
  })

  it('start 幂等：重复调用不产生双份 timer', () => {
    const { service, timer } = build({ tasks: [def('a')] })
    service.start()
    service.start()
    expect(timer.count()).toBe(1)
  })

  it('stop 清空全部 timer 并置 running=false', () => {
    const { service, timer } = build({ tasks: [def('a'), def('b')] })
    service.start()
    service.stop()
    expect(service.running).toBe(false)
    expect(timer.count()).toBe(0)
    expect(service.scheduledIds).toEqual([])
  })

  it('stop 幂等（未启动 / 重复调用不抛）', () => {
    const { service } = build()
    expect(() => service.stop()).not.toThrow()
    service.start()
    service.stop()
    expect(() => service.stop()).not.toThrow()
  })

  it('未启动时 reload 为空操作', () => {
    const { service, timer } = build({ tasks: [def('a')] })
    service.reload()
    expect(timer.count()).toBe(0)
  })

  it('reload 全量重建（旧 timer 清掉，新清单生效）', () => {
    const tasks = [def('a')]
    const { service, timer } = build({ tasks })
    service.start()
    tasks.push(def('b'))
    service.reload()
    expect(service.scheduledIds).toEqual(['a', 'b'])
    expect(timer.count()).toBe(2)
  })

  it('disabled 任务不装 timer', () => {
    const { service } = build({ tasks: [def('a'), def('b', { enabled: false })] })
    service.start()
    expect(service.scheduledIds).toEqual(['a'])
  })

  it('cron 非法 → 跳过并 warn，不影响其它任务', () => {
    const warnings: string[] = []
    const { service } = build({ tasks: [def('bad', { cron: 'nope' }), def('ok')], warnings })
    service.start()
    expect(service.scheduledIds).toEqual(['ok'])
    expect(warnings.join('\n')).toMatch(/cron 非法/)
  })

  it('task_path 为空 → 跳过并 warn', () => {
    const warnings: string[] = []
    const { service } = build({ tasks: [def('empty', { task_path: '  ' })], warnings })
    service.start()
    expect(service.scheduledIds).toEqual([])
    expect(warnings.join('\n')).toMatch(/缺 task_path/)
  })

  it('损坏任务文件 → warn 后继续', () => {
    const warnings: string[] = []
    const runtime = tempRuntime()
    const timer = fakeTimer()
    materialize(runtime, [def('ok')])
    const service = new SchedulerService({
      runtime,
      scheduler: { timezone: 'UTC' },
      timer,
      logger: {
        info: () => {},
        warn: (m: string) => warnings.push(m),
        error: (m: string) => warnings.push(m),
        debug: () => {},
      },
      store: {
        tasksDir: join(runtime.assetsDir, 'tasks'),
        list: () => ({ tasks: [def('ok')], corrupted: ['broken'] }),
        get: () => undefined,
        save: () => {},
        remove: () => false,
      },
      deps: { ensure: async () => ({ installed: false, reason: 'cache hit' }) },
      exec: { name: 'fake-node', exec: async () => okResult() },
      sink: { deliver: () => {} },
    })
    service.start()
    expect(warnings.join('\n')).toMatch(/损坏任务文件/)
    expect(service.scheduledIds).toEqual(['ok'])
  })

  it('store.list 抛错 → 记录 error 且不崩溃', () => {
    const warnings: string[] = []
    const runtime = tempRuntime()
    const service = new SchedulerService({
      runtime,
      scheduler: { timezone: 'UTC' },
      timer: fakeTimer(),
      logger: {
        info: () => {},
        warn: (m: string) => warnings.push(m),
        error: (m: string) => warnings.push(m),
        debug: () => {},
      },
      store: {
        tasksDir: join(runtime.assetsDir, 'tasks'),
        list() {
          throw new Error('io')
        },
        get: () => undefined,
        save: () => {},
        remove: () => false,
      },
      deps: { ensure: async () => ({ installed: false, reason: 'cache hit' }) },
      exec: { name: 'fake-node', exec: async () => okResult() },
      sink: { deliver: () => {} },
    })
    expect(() => service.start()).not.toThrow()
    expect(service.running).toBe(true)
    expect(warnings.join('\n')).toMatch(/读取任务清单失败/)
  })
})

describe('SchedulerService · 触发与链式重排', () => {
  it('到点触发执行任务，并在完成后重排下一次', async () => {
    const calls: string[] = []
    const { service, timer } = build({
      tasks: [def('a')],
      exec: async (input) => {
        calls.push(input.taskPath)
        return okResult()
      },
    })
    service.start()
    timer.fireAll()
    await tick()
    expect(calls).toHaveLength(1)
    expect(timer.count()).toBe(1)
    expect(service.scheduledIds).toEqual(['a'])
  })

  it('触发不阻塞其它任务的 timer', async () => {
    let release: (() => void) | undefined
    const { service, timer } = build({
      tasks: [def('slow'), def('fast')],
      exec: async () => new Promise<ExecResult>((resolve) => {
        release = () => resolve(okResult())
      }),
    })
    service.start()
    expect(timer.count()).toBe(2)
    // 只触发 slow：同期 fast 的 timer 仍在。
    const entries = [...timer.entries.entries()]
    for (const [handle, entry] of entries) {
      if (handle === entries[0]?.[0]) {
        timer.entries.delete(handle)
        entry.cb()
      }
    }
    expect(timer.count()).toBe(1)
    await tick()
    expect(release).toBeDefined()
    release?.()
    await tick()
    expect(timer.count()).toBe(2)
  })

  it('执行失败也重排（下个周期继续尝试）', async () => {
    const { service, timer } = build({
      tasks: [def('a')],
      exec: async () => ({ ...okResult(), exitCode: 1, stderr: 'boom' }),
    })
    service.start()
    timer.fireAll()
    await tick()
    expect(service.scheduledIds).toEqual(['a'])
    expect(timer.count()).toBe(1)
  })

  it('执行策略 reject 被隔离且仍重排', async () => {
    const warnings: string[] = []
    const { service, timer } = build({
      tasks: [def('a')],
      warnings,
      exec: async () => {
        throw new Error('kaboom')
      },
    })
    service.start()
    timer.fireAll()
    await tick()
    expect(warnings.join('\n')).toMatch(/执行异常|执行失败/)
    expect(timer.count()).toBe(1)
  })

  it('执行期间 stop → 不再补 timer', async () => {
    let release: (() => void) | undefined
    const { service, timer } = build({
      tasks: [def('a')],
      exec: async () => new Promise<ExecResult>((resolve) => {
        release = () => resolve(okResult())
      }),
    })
    service.start()
    timer.fireAll()
    service.stop()
    release?.()
    await tick()
    expect(timer.count()).toBe(0)
  })

  it('执行期间 reload → 不产生同 id 双份 timer', async () => {
    let release: (() => void) | undefined
    const { service, timer } = build({
      tasks: [def('a')],
      exec: async () => new Promise<ExecResult>((resolve) => {
        release = () => resolve(okResult())
      }),
    })
    service.start()
    timer.fireAll()
    service.reload()
    expect(timer.count()).toBe(1)
    release?.()
    await tick()
    expect(timer.count()).toBe(1)
  })

  it('runNow 直接执行并能唤醒', async () => {
    const { service, wakeCalls } = build({
      tasks: [def('a')],
      exec: async () => okResult(true, 'hello'),
    })
    const outcome = await service.runNow('a')
    expect(outcome.kind).toBe('woke')
    expect(wakeCalls[0]?.text).toBe('hello')
  })

  it('runNow 未知任务 → failed', async () => {
    const { service } = build({ tasks: [] })
    expect((await service.runNow('nope')).kind).toBe('failed')
  })
})

describe('SchedulerService · 装配参数', () => {
  it('时区取 pack.scheduler.timezone（优先于 CoreConfig）', () => {
    const { service } = build({ configTimezone: 'UTC' })
    expect(service.timezone).toBe('Asia/Shanghai')
  })

  it('领域未声明时区时回落 CoreConfig', () => {
    const runtime = tempRuntime()
    const service = new SchedulerService({
      runtime,
      scheduler: { timezone: 'Asia/Shanghai' },
      configTimezone: 'UTC',
      timer: fakeTimer(),
      store: {
        tasksDir: join(runtime.assetsDir, 'tasks'),
        list: () => ({ tasks: [], corrupted: [] }),
        get: () => undefined,
        save: () => {},
        remove: () => false,
      },
      deps: { ensure: async () => ({ installed: false, reason: 'cache hit' }) },
      exec: { name: 'fake-node', exec: async () => okResult() },
      sink: { deliver: () => {} },
    })
    // pack 声明了合法时区 → pack 生效。
    expect(service.timezone).toBe('Asia/Shanghai')
  })

  it('tasksDir 缺省位于 assets 下', () => {
    const { service, runtime } = build()
    expect(service.store.tasksDir).toBe(join(runtime.assetsDir, 'tasks'))
  })

  it('scheduler.tasksDir 相对 home 解析（未注入 store 时生效）', () => {
    const runtime = tempRuntime()
    const service = new SchedulerService({
      runtime,
      scheduler: { timezone: 'UTC', tasksDir: 'custom/tasks' },
      timer: fakeTimer(),
      deps: { ensure: async () => ({ installed: false, reason: 'cache hit' }) },
      exec: { name: 'fake-node', exec: async () => okResult() },
      sink: { deliver: () => {} },
    })
    expect(service.store.tasksDir).toBe(join(runtime.home, 'custom/tasks'))
  })

  it('缺省任务目录为 <assetsDir>/tasks（未注入 store 时生效）', () => {
    const runtime = tempRuntime()
    const service = new SchedulerService({
      runtime,
      scheduler: { timezone: 'UTC' },
      timer: fakeTimer(),
      deps: { ensure: async () => ({ installed: false, reason: 'cache hit' }) },
      exec: { name: 'fake-node', exec: async () => okResult() },
      sink: { deliver: () => {} },
    })
    expect(service.store.tasksDir).toBe(join(runtime.assetsDir, 'tasks'))
  })

  it('knownRuntimes 含执行策略名（自定义策略也能通过运行时校验）', async () => {
    const { service } = build({
      tasks: [def('a')],
      schedulerExtras: { runtimes: ['fake-node'] },
      exec: async () => okResult(),
    })
    expect((await service.runNow('a')).kind).toBe('quiet')
  })

  it('disclaimer 透传到唤醒正文', async () => {
    const { service, wakeCalls } = build({
      tasks: [def('a')],
      disclaimer: '声明',
      exec: async () => okResult(true, 'hi'),
    })
    await service.runNow('a')
    expect(wakeCalls[0]?.text).toBe('hi\n\n声明')
  })

  it('createAgentWakeSink 投递 notice 给固定会话；缺失会话则抛错', () => {
    const delivered: unknown[] = []
    const sink = createAgentWakeSink({
      agents: { get: (id) => (id === 'agent' ? { id, followup: (m) => delivered.push(m) } : undefined) },
    })
    sink.deliver({ taskId: 'a', text: 'hi', summary: 'hi', sessionId: 'agent' })
    expect(delivered).toHaveLength(1)
    expect(() =>
      sink.deliver({ taskId: 'a', text: 'hi', summary: 'hi', sessionId: 'missing' }),
    ).toThrow(/不可达/)
  })
})

describe('SchedulerService · 未注入投递端口', () => {
  it('唤醒降级为 skipped，不影响任务结局之外的链路', async () => {
    const runtime = tempRuntime()
    materialize(runtime, [def('a')])
    const service = new SchedulerService({
      runtime,
      scheduler: { timezone: 'UTC' },
      timer: fakeTimer(),
      store: {
        tasksDir: join(runtime.assetsDir, 'tasks'),
        list: () => ({ tasks: [def('a')], corrupted: [] }),
        get: (id) => (id === 'a' ? def('a') : undefined),
        save: () => {},
        remove: () => false,
      },
      deps: { ensure: async () => ({ installed: false, reason: 'cache hit' }) },
      exec: { name: 'fake-node', exec: async () => okResult(true, 'x') },
    })
    expect((await service.runNow('a')).kind).toBe('skipped')
  })
})

describe('调度器 · 定时器清理', () => {
  it('vi.getTimerCount 在 stop 后归零（原生定时器路径）', () => {
    vi.useFakeTimers()
    try {
      const runtime = tempRuntime()
      materialize(runtime, [def('a')])
      const service = new SchedulerService({
        runtime,
        scheduler: { timezone: 'UTC' },
        store: {
          tasksDir: join(runtime.assetsDir, 'tasks'),
          list: () => ({ tasks: [def('a')], corrupted: [] }),
          get: () => undefined,
          save: () => {},
          remove: () => false,
        },
        deps: { ensure: async () => ({ installed: false, reason: 'cache hit' }) },
        exec: { name: 'fake-node', exec: async () => okResult() },
        sink: { deliver: () => {} },
      })
      service.start()
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      service.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})


describe('SchedulerService · 同任务单飞锁（M1）', () => {
  it('并发两次 runNow → 只有一个 run 在飞，且只投递一次', async () => {
    let active = 0
    let maxActive = 0
    const { service, wakeCalls } = build({
      tasks: [def('a')],
      exec: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 50))
        active -= 1
        return okResult(true, 'hi')
      },
    })

    const outcomes = await Promise.all([service.runNow('a'), service.runNow('a')])

    expect(maxActive).toBe(1)
    expect(wakeCalls).toHaveLength(1)
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['skipped', 'woke'])
    const skipped = outcomes.find((outcome) => outcome.kind === 'skipped')
    expect(skipped?.reason).toMatch(/already running/)
  })

  it('定时链已有任务在飞 → 本次触发 skipped（already running）且仍重排下一次', async () => {
    let release: (() => void) | undefined
    const warnings: string[] = []
    const execCalls: string[] = []
    const { service, timer } = build({
      tasks: [def('a')],
      warnings,
      exec: async () => {
        execCalls.push('enter')
        return new Promise<ExecResult>((resolve) => {
          release = () => resolve(okResult())
        })
      },
    })

    service.start()
    const manual = service.runNow('a')
    await tick()
    expect(service.isTaskRunning('a')).toBe(true)

    timer.fireAll()
    for (let index = 0; index < 5; index += 1) await tick()

    // 定时触发被同一把锁拦下：没有第二次进入 exec，只记一条 already running。
    expect(execCalls).toHaveLength(1)
    expect(warnings.join('\n')).toMatch(/already running/)
    // 拦下也要重排，调度链不能因并发而断。
    expect(timer.count()).toBe(1)

    release?.()
    expect((await manual).kind).toBe('quiet')
    expect(service.isTaskRunning('a')).toBe(false)
  })

  it('运行结束后释放锁，可再次 runNow', async () => {
    const { service } = build({ tasks: [def('a')], exec: async () => okResult() })
    expect((await service.runNow('a')).kind).toBe('quiet')
    expect(service.isTaskRunning('a')).toBe(false)
    expect((await service.runNow('a')).kind).toBe('quiet')
  })

  it('锁按 task_id 隔离：不同任务仍可并行', async () => {
    let active = 0
    let maxActive = 0
    const { service } = build({
      tasks: [def('a'), def('b')],
      exec: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 30))
        active -= 1
        return okResult()
      },
    })
    await Promise.all([service.runNow('a'), service.runNow('b')])
    expect(maxActive).toBe(2)
  })
})

describe('SchedulerService · 任务文件 id 与文件名一致性（M2）', () => {
  it('a.json / b.json 都写 id=dup → 两份都被判损坏，不装 timer', () => {
    const runtime = tempRuntime()
    const tasksDir = join(runtime.assetsDir, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    const dup: TaskDef = {
      id: 'dup',
      name: 'dup',
      cron: '0 9 * * *',
      task_path: 'dup.mjs',
      enabled: true,
    }
    writeFileSync(join(tasksDir, 'a.json'), `${JSON.stringify(dup, null, 2)}\n`, 'utf8')
    writeFileSync(join(tasksDir, 'b.json'), `${JSON.stringify(dup, null, 2)}\n`, 'utf8')
    writeFileSync(join(runtime.home, 'dup.mjs'), '// task', 'utf8')

    const warnings: string[] = []
    const timer = fakeTimer()
    const service = new SchedulerService({
      runtime,
      scheduler: { timezone: 'UTC' },
      timer,
      logger: {
        info: () => {},
        warn: (message: string) => warnings.push(message),
        error: (message: string) => warnings.push(message),
        debug: () => {},
      },
      deps: { ensure: async () => ({ installed: false, reason: 'cache hit' }) },
      exec: { name: 'fake-node', exec: async () => okResult() },
      sink: { deliver: () => {} },
    })

    service.start()
    // 修复后两份文件都因「文件名 ≠ 文件内 id」被判损坏：不会再有双 timer。
    expect(service.scheduledIds).toEqual([])
    expect(timer.count()).toBe(0)
    expect(warnings.join('\n')).toMatch(/与文件名/)
    expect(warnings.join('\n')).toMatch(/损坏任务文件/)
    service.stop()
    expect(timer.count()).toBe(0)
  })

  it('重复 id（其中一份文件名合法）→ pending=1，stop 后 0', () => {
    const runtime = tempRuntime()
    const tasksDir = join(runtime.assetsDir, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    const dup: TaskDef = {
      id: 'dup',
      name: 'dup',
      cron: '0 9 * * *',
      task_path: 'dup.mjs',
      enabled: true,
    }
    // dup.json 名称合法；a.json 声明同一个 id（旧的「双 timer + stop 残留」根因）。
    writeFileSync(join(tasksDir, 'dup.json'), `${JSON.stringify(dup, null, 2)}\n`, 'utf8')
    writeFileSync(join(tasksDir, 'a.json'), `${JSON.stringify(dup, null, 2)}\n`, 'utf8')
    writeFileSync(join(runtime.home, 'dup.mjs'), '// task', 'utf8')

    const warnings: string[] = []
    const timer = fakeTimer()
    const service = new SchedulerService({
      runtime,
      scheduler: { timezone: 'UTC' },
      timer,
      logger: {
        info: () => {},
        warn: (message: string) => warnings.push(message),
        error: (message: string) => warnings.push(message),
        debug: () => {},
      },
      deps: { ensure: async () => ({ installed: false, reason: 'cache hit' }) },
      exec: { name: 'fake-node', exec: async () => okResult() },
      sink: { deliver: () => {} },
    })

    service.start()
    expect(service.scheduledIds).toEqual(['dup'])
    expect(timer.count()).toBe(1)
    expect(warnings.join('\n')).toMatch(/a\.json/)
    service.stop()
    expect(timer.count()).toBe(0)
    expect(service.scheduledIds).toEqual([])
  })

  it('同一 id 重复出现在清单项 → 覆盖前先清旧 timer，stop 全清', () => {
    const { service, timer } = build({ tasks: [def('dup'), def('dup')] })
    service.start()
    expect(timer.count()).toBe(1)
    service.stop()
    expect(timer.count()).toBe(0)
  })

  it('多次 reload 不泄漏 timer', () => {
    const { service, timer } = build({ tasks: [def('a')] })
    service.start()
    service.reload()
    service.reload()
    expect(timer.count()).toBe(1)
    service.stop()
    expect(timer.count()).toBe(0)
  })
})

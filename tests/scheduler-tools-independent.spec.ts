/**
 * 独立复验（Task t100487）：不引用开发者断言，全部自建夹具与反例。
 *
 * 覆盖：
 *   A. 真实 git 仓库（非 mock）：create/update/disable/enable/delete 各恰好 1 次 commit
 *   B. 真实 SchedulerService + 假 Timer/Clock：禁用后不再触发、启用后恢复、未 start 无副作用
 *   C. task_path 白名单对抗（穿越 / 绝对路径 / 反斜杠 / .git / 软链接逃逸 / 目录 / 不可读）
 *   D. id 唯一性与 update 不存在的零副作用
 *   E. task_list 严格字段与损坏文件容错
 *   F. AgentHost.install 注册链路（真实 ToolRuntime，7 个工具可执行，dispose 后消失）
 *   G. 执行链路径基准探针（记录当前行为，供缺陷判定）
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit } from '../src/assets/git'
import { createSchedulerService } from '../src/scheduler/service'
import { createTaskStore, type TaskStore } from '../src/scheduler/store'
import { resolveTaskPath } from '../src/scheduler/task'
import { SCHEDULER_TOOL_NAMES, createSchedulerTools } from '../src/scheduler/tools'
import type { TaskDef } from '../src/scheduler/types'
import { AgentHost } from '../src/service'
import type { DomainPack, ToolDefinition } from '../src/types'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      chmodSync(join(root, 'assets', 'programs', 'secret.ts'), 0o644)
    } catch {
      /* 文件可能不存在 */
    }
    rmSync(root, { recursive: true, force: true })
  }
})

interface Fixture {
  readonly root: string
  readonly assetsDir: string
  readonly tasksDir: string
  readonly programsDir: string
  readonly store: TaskStore
  readonly tools: Map<string, ToolDefinition>
  readonly warns: string[]
  readonly state: { reloads: number }
}

function setup(withGit = true): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rsi-indep-'))
  roots.push(root)
  const assetsDir = join(root, 'assets')
  const tasksDir = join(assetsDir, 'tasks')
  const programsDir = join(assetsDir, 'programs')
  mkdirSync(join(programsDir, 'demo'), { recursive: true })
  mkdirSync(tasksDir, { recursive: true })
  writeFileSync(
    join(programsDir, 'demo', 'task.ts'),
    'console.log(JSON.stringify({ shouldWake: false }))\n',
    'utf8',
  )

  if (withGit) {
    expect(runGit(['init', '--quiet', '-b', 'main', '.'], assetsDir).ok).toBe(true)
    expect(runGit(['add', '-A'], assetsDir).ok).toBe(true)
    const initial = runGit(['commit', '-m', 'chore: initial assets'], assetsDir)
    expect(initial.ok, initial.stderr).toBe(true)
  }

  const warns: string[] = []
  const store = createTaskStore({
    tasksDir,
    assetsDir,
    logger: (message: string) => warns.push(message),
  })
  const state = { reloads: 0 }
  const tools = new Map(
    createSchedulerTools({
      store,
      assetsDir,
      onChange: () => {
        state.reloads += 1
      },
    }).map((definition) => [definition.name, definition]),
  )
  return { root, assetsDir, tasksDir, programsDir, store, tools, warns, state }
}

async function call(fixture: Fixture, name: string, args: unknown = {}): Promise<unknown> {
  const definition = fixture.tools.get(name)
  if (definition === undefined) throw new Error(`工具 ${name} 未注册`)
  return definition.execute(args, {} as never)
}

function commitCount(assetsDir: string): number {
  const result = runGit(['rev-list', '--count', 'HEAD'], assetsDir)
  expect(result.ok, result.stderr).toBe(true)
  return Number(result.stdout.trim())
}

function subjects(assetsDir: string): string[] {
  const result = runGit(['log', '--pretty=format:%s'], assetsDir)
  expect(result.ok, result.stderr).toBe(true)
  return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

function bodies(assetsDir: string): string[] {
  const result = runGit(['log', '--pretty=format:%B%x00'], assetsDir)
  expect(result.ok, result.stderr).toBe(true)
  return result.stdout
    .split('\u0000')
    .map((entry) => entry.replace(/^\n+/, '').trimEnd())
    .filter((entry) => entry !== '')
}

const VALID = {
  id: 'demo',
  name: '示例任务',
  cron: '0 9 * * *',
  task_path: 'programs/demo/task.ts',
  enabled: true,
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

// ---------------------------------------------------------------------------
// A. 真实 git：五次操作各恰好一次 commit
// ---------------------------------------------------------------------------

describe('A · 真实 git 提交（非 mock）', () => {
  it('create/update/disable/enable/delete 各产生恰好 1 次 commit，首行动作词正确', async () => {
    const fixture = setup()
    const base = commitCount(fixture.assetsDir)
    const programBefore = readFileSync(join(fixture.programsDir, 'demo', 'task.ts'), 'utf8')

    // 1) create
    await call(fixture, 'task_create', VALID)
    expect(commitCount(fixture.assetsDir)).toBe(base + 1)
    expect(subjects(fixture.assetsDir)[0]).toBe('tasks: create demo')
    expect(bodies(fixture.assetsDir)[0].split('\n')[0]).toBe('tasks: create demo')
    expect(bodies(fixture.assetsDir)[0]).toContain('assets: create tasks/demo.json')
    expect(runGit(['ls-files', '--error-unmatch', 'tasks/demo.json'], fixture.assetsDir).ok).toBe(true)

    // 2) update
    const afterCreate = commitCount(fixture.assetsDir)
    await call(fixture, 'task_update', { id: 'demo', name: '改名', cron: '*/30 * * * *' })
    expect(commitCount(fixture.assetsDir)).toBe(afterCreate + 1)
    expect(subjects(fixture.assetsDir)[0]).toBe('tasks: update demo')
    expect(bodies(fixture.assetsDir)[0]).toContain('assets: update tasks/demo.json')

    // 3) disable
    const afterUpdate = commitCount(fixture.assetsDir)
    await call(fixture, 'task_disable', { id: 'demo' })
    expect(commitCount(fixture.assetsDir)).toBe(afterUpdate + 1)
    expect(subjects(fixture.assetsDir)[0]).toBe('tasks: disable demo')
    expect(bodies(fixture.assetsDir)[0]).toContain('assets: update tasks/demo.json')

    // 4) enable
    const afterDisable = commitCount(fixture.assetsDir)
    await call(fixture, 'task_enable', { id: 'demo' })
    expect(commitCount(fixture.assetsDir)).toBe(afterDisable + 1)
    expect(subjects(fixture.assetsDir)[0]).toBe('tasks: enable demo')

    // 5) delete
    const afterEnable = commitCount(fixture.assetsDir)
    await call(fixture, 'task_delete', { id: 'demo' })
    expect(commitCount(fixture.assetsDir)).toBe(afterEnable + 1)
    expect(subjects(fixture.assetsDir)[0]).toBe('tasks: remove demo')
    expect(bodies(fixture.assetsDir)[0]).toContain('assets: delete tasks/demo.json')

    // 五次写操作 → 恰好 5 次新提交
    expect(commitCount(fixture.assetsDir)).toBe(base + 5)

    // 定义消失，程序文件仍在（且未被 git 删除）
    expect(existsSync(join(fixture.tasksDir, 'demo.json'))).toBe(false)
    expect(existsSync(join(fixture.programsDir, 'demo', 'task.ts'))).toBe(true)
    expect(readFileSync(join(fixture.programsDir, 'demo', 'task.ts'), 'utf8')).toBe(programBefore)
    expect(runGit(['ls-files', '--error-unmatch', 'programs/demo/task.ts'], fixture.assetsDir).ok).toBe(true)

    // 工作区干净：没有遗留未提交改动
    expect(runGit(['status', '--porcelain'], fixture.assetsDir).stdout.trim()).toBe('')
  })

  it('内容无变化时不产生空 commit（enable 连按两次）', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', { ...VALID, enabled: false })
    await call(fixture, 'task_enable', { id: 'demo' })
    const afterFirst = commitCount(fixture.assetsDir)
    await call(fixture, 'task_enable', { id: 'demo' })
    expect(commitCount(fixture.assetsDir)).toBe(afterFirst)
    expect(runGit(['status', '--porcelain'], fixture.assetsDir).stdout.trim()).toBe('')
  })

  it('重复 create 不覆盖、不提交', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)
    const before = readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')
    const count = commitCount(fixture.assetsDir)
    await expect(call(fixture, 'task_create', { ...VALID, name: '二写' })).rejects.toThrow(/已存在/)
    expect(readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')).toBe(before)
    expect(commitCount(fixture.assetsDir)).toBe(count)
  })

  it('update 不存在 id：报错、文件数不变、零提交', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)
    const files = readdirSync(fixture.tasksDir).sort()
    const count = commitCount(fixture.assetsDir)
    await expect(call(fixture, 'task_update', { id: 'ghost', name: 'x' })).rejects.toThrow(
      /任务 ghost 不存在/,
    )
    expect(readdirSync(fixture.tasksDir).sort()).toEqual(files)
    expect(commitCount(fixture.assetsDir)).toBe(count)
    expect(existsSync(join(fixture.tasksDir, 'ghost.json'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// B. 端到端禁用语义
// ---------------------------------------------------------------------------

interface FakeTimerHandle {
  readonly delay: number
  readonly cb: () => void
  cleared: boolean
}

function makeService(fixture: Fixture, overrides: { home?: string } = {}) {
  const home = overrides.home ?? fixture.root
  const timers: FakeTimerHandle[] = []
  const execCalls: string[] = []
  const timer = {
    setTimer(delay: number, cb: () => void) {
      const handle: FakeTimerHandle = { delay, cb, cleared: false }
      timers.push(handle)
      return handle as never
    },
    clearTimer(handle: unknown) {
      ;(handle as FakeTimerHandle).cleared = true
    },
  }
  const service = createSchedulerService({
    runtime: {
      home,
      assetsDir: fixture.assetsDir,
      dataDir: join(home, 'data'),
      sessionId: 'indep-session',
      timezone: 'Asia/Shanghai',
    },
    scheduler: { timezone: 'Asia/Shanghai' },
    store: fixture.store,
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    timer,
    deps: { ensure: async () => ({ installed: false, reason: 'cache-hit' }) },
    exec: {
      name: 'node',
      exec: async (input: { taskPath: string }) => {
        execCalls.push(input.taskPath)
        return {
          exitCode: 0,
          stdout: '{"shouldWake":false}\n',
          stderr: '',
          truncated: false,
          timedOut: false,
        }
      },
    },
  })
  return { service, timers, execCalls }
}

describe('B · 端到端禁用语义（真实 SchedulerService + 假 Timer）', () => {
  it('start 后已排定；disable 移出调度但保留定义；enable 恢复；stale 回调不再触发', async () => {
    const fixture = setup()
    // 用可被 runTask 解析的写法（相对 home 也可用），以验证「是否真的触发」。
    const taskPath = 'assets/programs/demo/task.ts'

    const { service, timers, execCalls } = makeService(fixture)
    // 与生产一致：写工具通过 onChange 触发 service.reload()。
    const tools = new Map(
      createSchedulerTools({
        store: fixture.store,
        assetsDir: fixture.assetsDir,
        onChange: () => service.reload(),
      }).map((definition) => [definition.name, definition]),
    )
    const invoke = async (name: string, args: unknown = {}): Promise<unknown> =>
      (tools.get(name) as ToolDefinition).execute(args, {} as never)

    await invoke('task_create', { ...VALID, task_path: taskPath })

    // 未 start：调用工具不崩溃、不排定任何 timer
    await invoke('task_disable', { id: 'demo' })
    expect(service.running).toBe(false)
    expect(service.scheduledIds).toEqual([])
    expect(timers).toHaveLength(0)
    await invoke('task_enable', { id: 'demo' })
    expect(timers).toHaveLength(0)

    service.start()
    expect(service.running).toBe(true)
    expect(service.scheduledIds).toEqual(['demo'])
    expect(timers).toHaveLength(1)
    // 08:00 Asia/Shanghai → 09:00 当天 = 1 小时
    expect(timers[0].delay).toBe(60 * 60 * 1000)

    // 触发一次：真实执行链走到 exec，并链式重排下一次
    timers[0].cb()
    await flush()
    expect(execCalls).toHaveLength(1)
    expect(timers).toHaveLength(2)

    // disable：移出调度、定义文件仍在且 enabled=false、commit 动作词 disable
    await invoke('task_disable', { id: 'demo' })
    expect(service.scheduledIds).toEqual([])
    expect(timers[1].cleared).toBe(true)
    const disabled = JSON.parse(readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')) as TaskDef
    expect(disabled.enabled).toBe(false)
    expect(subjects(fixture.assetsDir)[0]).toBe('tasks: disable demo')
    expect(existsSync(join(fixture.programsDir, 'demo', 'task.ts'))).toBe(true)

    // 已排定的旧回调在 disable 后触发：不得执行、不得补装 timer
    timers[1].cb()
    await flush()
    expect(execCalls).toHaveLength(1)
    expect(timers).toHaveLength(2)

    // enable：恢复调度
    await invoke('task_enable', { id: 'demo' })
    expect(service.scheduledIds).toEqual(['demo'])
    expect(timers).toHaveLength(3)
    expect(subjects(fixture.assetsDir)[0]).toBe('tasks: enable demo')

    service.stop()
    expect(service.scheduledIds).toEqual([])
    // 仅断言 stop 时仍然存活的那个句柄被清理（timers[0] 已触发、timers[1] 已被 disable 清理）
    expect(timers).toHaveLength(3)
    expect(timers[2].cleared).toBe(true)
  })

  it('未 start 时写工具仅有落盘 + 提交，不产生 timer / 不调用 reload 副作用', async () => {
    const fixture = setup()
    const { service, timers } = makeService(fixture)
    const tools = new Map(
      createSchedulerTools({
        store: fixture.store,
        assetsDir: fixture.assetsDir,
        onChange: () => service.reload(),
      }).map((definition) => [definition.name, definition]),
    )
    const invoke = async (name: string, args: unknown = {}): Promise<unknown> =>
      (tools.get(name) as ToolDefinition).execute(args, {} as never)

    await invoke('task_create', { ...VALID, task_path: 'assets/programs/demo/task.ts' })
    expect(existsSync(join(fixture.tasksDir, 'demo.json'))).toBe(true)
    expect(timers).toHaveLength(0)
    expect(service.running).toBe(false)
    expect(service.scheduledIds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// C. 路径白名单对抗
// ---------------------------------------------------------------------------

describe('C · task_path 白名单对抗（零落盘零提交）', () => {
  const cases: Array<[string, RegExp]> = [
    ['../programs/demo/task.ts', /非法路径段|\.\./],
    ['programs/../../x.ts', /非法路径段|\.\./],
    ['/etc/passwd', /绝对路径/],
    ['programs\\demo\\task.ts', /反斜杠/],
    ['programs/.git/config', /非法路径段/],
    ['programs/demo/.git/x', /非法路径段/],
    ['tasks/demo.json', /programs/],
    ['programs//demo/task.ts', /非法路径段/],
    ['programs/demo/task.ts/', /非法路径段/],
    ['C:/Windows/x.ts', /绝对路径|盘符/],
    ['~/task.ts', /programs/],
    ['programs/demo', /不是普通文件/],
    ['programs/missing.ts', /不存在/],
  ]

  it.each(cases)('拒绝 %s（%s）', async (taskPath, pattern) => {
    const fixture = setup()
    const before = readdirSync(fixture.tasksDir).sort()
    const count = commitCount(fixture.assetsDir)
    await expect(call(fixture, 'task_create', { ...VALID, task_path: taskPath })).rejects.toThrow(
      pattern,
    )
    expect(readdirSync(fixture.tasksDir).sort()).toEqual(before)
    expect(commitCount(fixture.assetsDir)).toBe(count)
    expect(runGit(['status', '--porcelain'], fixture.assetsDir).stdout.trim()).toBe('')
  })

  it('拒绝软链接指向资产根之外（文件 / 中间目录两种）', async () => {
    const fixture = setup()
    const outsideDir = join(fixture.root, 'outside')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(outsideDir, 'evil.ts'), '// evil\n', 'utf8')
    symlinkSync(join(outsideDir, 'evil.ts'), join(fixture.programsDir, 'escape.ts'))
    symlinkSync(outsideDir, join(fixture.programsDir, 'linkdir'))

    const count = commitCount(fixture.assetsDir)
    await expect(
      call(fixture, 'task_create', { ...VALID, task_path: 'programs/escape.ts' }),
    ).rejects.toThrow(/软链接/)
    await expect(
      call(fixture, 'task_create', { ...VALID, task_path: 'programs/linkdir/evil.ts' }),
    ).rejects.toThrow(/软链接/)
    expect(readdirSync(fixture.tasksDir)).toHaveLength(0)
    expect(commitCount(fixture.assetsDir)).toBe(count)
  })

  it('资产根内软链接可用（不误杀）', async () => {
    const fixture = setup()
    symlinkSync(join(fixture.programsDir, 'demo', 'task.ts'), join(fixture.programsDir, 'alias.ts'))
    const result = (await call(fixture, 'task_create', {
      ...VALID,
      task_path: 'programs/alias.ts',
    })) as { task: TaskDef }
    // P0 修复后的正确语义：入参可写 programs/…，落盘统一归一化为相对 home 的
    // assets/programs/…（不是绝对路径，也不与执行链基准错位）。
    expect(result.task.task_path).toBe('assets/programs/alias.ts')
    expect(isAbsolute(result.task.task_path)).toBe(false)
    // 强断言：磁盘 JSON 的落盘值同样归一化，且被执行链解析回同一真实文件。
    const onDisk = JSON.parse(readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')) as TaskDef
    expect(onDisk.task_path).toBe('assets/programs/alias.ts')
    expect(realpathSync(join(fixture.root, onDisk.task_path))).toBe(
      realpathSync(join(fixture.programsDir, 'demo', 'task.ts')),
    )

    // 执行链同样可用：exec 收到别名路径，realpath 仍指向同一个真实程序文件。
    const { service, execCalls } = makeService(fixture)
    const outcome = await service.runNow('demo')
    expect(outcome.kind).toBe('quiet')
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0]).toBe(join(fixture.assetsDir, 'programs', 'alias.ts'))
    expect(realpathSync(execCalls[0])).toBe(
      realpathSync(join(fixture.programsDir, 'demo', 'task.ts')),
    )
    expect(commitCount(fixture.assetsDir)).toBe(2)
  })

  it('无读权限文件被拒绝（R_OK）', async () => {
    const fixture = setup()
    const secret = join(fixture.programsDir, 'secret.ts')
    writeFileSync(secret, '// secret\n', 'utf8')
    chmodSync(secret, 0o000)
    const count = commitCount(fixture.assetsDir)
    await expect(
      call(fixture, 'task_create', { ...VALID, task_path: 'programs/secret.ts' }),
    ).rejects.toThrow(/不可读|不可用/)
    expect(readdirSync(fixture.tasksDir)).toHaveLength(0)
    expect(commitCount(fixture.assetsDir)).toBe(count)
  })

  it('update 传入非法路径：原定义不变、零提交', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)
    const before = readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')
    const count = commitCount(fixture.assetsDir)
    await expect(
      call(fixture, 'task_update', { id: 'demo', task_path: '../etc/passwd' }),
    ).rejects.toThrow(/task_path/)
    expect(readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')).toBe(before)
    expect(commitCount(fixture.assetsDir)).toBe(count)
  })

  it('非法 id 不得越界写盘（../x、a/b、反斜杠）', async () => {
    const fixture = setup()
    for (const id of ['../x', 'a/b', 'a\\b', '..']) {
      await expect(call(fixture, 'task_create', { ...VALID, id })).rejects.toThrow(/id/)
    }
    expect(readdirSync(fixture.tasksDir)).toHaveLength(0)
    expect(existsSync(join(fixture.assetsDir, 'x.json'))).toBe(false)
    expect(existsSync(join(fixture.root, 'x.json'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// D. cron 5 段（独立反例）
// ---------------------------------------------------------------------------

describe('D · cron 只接受 5 段', () => {
  it.each([
    '0 0 9 * * *', // 6 段（秒）
    '*/5 * * * * *', // 6 段（秒 + 步进）
    '0 9 * *', // 4 段
    '0 0 9 * * ? *', // 7 段
  ])('拒绝 %s', async (cron) => {
    const fixture = setup()
    await expect(call(fixture, 'task_create', { ...VALID, cron })).rejects.toThrow(
      /应含 5 段（分 时 日 月 周）/,
    )
    expect(readdirSync(fixture.tasksDir)).toHaveLength(0)
    expect(commitCount(fixture.assetsDir)).toBe(1)
  })

  it('首尾空白的 5 段表达式被接受', async () => {
    const fixture = setup()
    await expect(call(fixture, 'task_create', { ...VALID, cron: '  0 9 * * *  ' })).resolves
      .toBeDefined()
  })

  it('update 传 6 段 cron：拒绝且原文件不变', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)
    const before = readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')
    await expect(call(fixture, 'task_update', { id: 'demo', cron: '0 0 9 * * *' })).rejects.toThrow(
      /应含 5 段/,
    )
    expect(readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// E. task_list 严格字段 / 损坏容错
// ---------------------------------------------------------------------------

describe('E · task_list 严格字段与损坏容错', () => {
  it('磁盘多出的业务字段不会泄漏；损坏 JSON / 文件名 id 不一致不拖垮整表', async () => {
    const fixture = setup()
    writeFileSync(
      join(fixture.tasksDir, 'btc.json'),
      JSON.stringify({
        id: 'btc',
        name: 'BTC 监控',
        cron: '*/5 * * * *',
        task_path: 'programs/demo/task.ts',
        enabled: true,
        symbol: 'BTC',
        positions: [],
      }),
      'utf8',
    )
    writeFileSync(join(fixture.tasksDir, 'broken.json'), '{ not json', 'utf8')
    writeFileSync(
      join(fixture.tasksDir, 'dup.json'),
      JSON.stringify({
        id: 'other',
        name: 'x',
        cron: '0 9 * * *',
        task_path: 'programs/demo/task.ts',
        enabled: true,
      }),
      'utf8',
    )

    const listed = (await call(fixture, 'task_list')) as {
      tasks: Array<Record<string, unknown>>
      corrupted?: string[]
    }
    expect(listed.tasks).toHaveLength(1)
    expect(Object.keys(listed.tasks[0]).sort()).toEqual([
      'cron',
      'enabled',
      'id',
      'name',
      'task_path',
    ])
    expect(listed.tasks[0].symbol).toBeUndefined()
    expect(listed.tasks[0].positions).toBeUndefined()
    expect([...(listed.corrupted ?? [])].sort()).toEqual(['broken', 'dup'])

    // task_get 同样不泄漏
    const got = (await call(fixture, 'task_get', { id: 'btc' })) as { task: Record<string, unknown> }
    expect(Object.keys(got.task).sort()).toEqual(['cron', 'enabled', 'id', 'name', 'task_path'])

    // update 重写后磁盘上也只剩 5 字段（顺带记录 sanitize 行为）
    await call(fixture, 'task_update', { id: 'btc', name: 'BTC 监控 v2' })
    const onDisk = JSON.parse(readFileSync(join(fixture.tasksDir, 'btc.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(Object.keys(onDisk).sort()).toEqual(['cron', 'enabled', 'id', 'name', 'task_path'])
  })

  it('空目录返回空数组且不出现 corrupted 字段', async () => {
    const fixture = setup()
    const listed = (await call(fixture, 'task_list')) as { tasks: unknown[]; corrupted?: string[] }
    expect(listed.tasks).toEqual([])
    expect('corrupted' in listed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// F. 注册链路（真实 ToolRuntime + AgentHost）
// ---------------------------------------------------------------------------

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} 测试工具`,
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { echoed: { type: 'string' } },
        required: ['echoed'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown) => [
        { type: 'text' as const, text: JSON.stringify(value) },
      ],
    },
    execute: async (args: unknown) => ({
      echoed: String((args as { text?: unknown } | undefined)?.text ?? ''),
    }),
  } as unknown as ToolDefinition
}

function makePack(): DomainPack {
  return {
    apiVersion: 1,
    id: 'indep-domain',
    version: '1.0.0',
    displayName: 'Independent Domain',
    persona: { markdown: () => '# Independent' },
    defaultSessionId: 'indep-session-1',
    assets: { types: [{ name: 'notes', prefix: 'notes/' }, { name: 'skills', prefix: 'skills/' }] },
    firmwareSkills: [],
    scheduler: { timezone: 'Asia/Shanghai' },
    evolutionPolicy: { window: '7d', independentCases: 10, maxIterations: 3 },
    tools: () => [makeTool('alpha-lookup')],
    toolNames: ['alpha-lookup'],
  } as unknown as DomainPack
}

function systemPromptStub(): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get: (_target, property) => (property === 'then' ? undefined : () => () => {}),
    },
  ) as Record<string, unknown>
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('F · 注册链路（真实 ToolRuntime）', () => {
  it('install 后 7 个 task_* 工具真实可执行，与 asset_* 无冲突；dispose 后全部消失', async () => {
    const ctx = new Context()
    ctx.provide('systemPrompt', systemPromptStub() as never)
    ctx.plugin(ToolRuntime)
    await waitFor(() => ctx.tools !== undefined)
    const host = new AgentHost(ctx)

    const dispose = host.install(makePack())
    const assetsDir = host.active?.assetsDir as string
    mkdirSync(join(assetsDir, 'programs', 'demo'), { recursive: true })
    writeFileSync(
      join(assetsDir, 'programs', 'demo', 'task.ts'),
      'console.log(JSON.stringify({ shouldWake: false }))\n',
      'utf8',
    )

    for (const name of SCHEDULER_TOOL_NAMES) {
      expect(ctx.tools.get(name), `install 后 ${name} 必须真实存在`).toBeDefined()
    }
    // 既有 core 资产工具未被覆盖 / 未被挤掉
    for (const name of ['asset_commit', 'asset_history', 'asset_show']) {
      expect(ctx.tools.get(name), `${name} 应仍存在`).toBeDefined()
    }

    const created = (await ctx.tools.get('task_create')!.execute(
      {
        id: 'demo',
        name: '注册链路',
        cron: '0 9 * * *',
        task_path: 'programs/demo/task.ts',
      },
      {} as never,
    )) as { task: TaskDef }
    expect(created.task.id).toBe('demo')

    // 生产装配（mountScheduler 传 runtime.home）下，落盘值必须能被执行链解析到真实文件。
    expect(created.task.task_path).toBe('assets/programs/demo/task.ts')
    const wiredDef = JSON.parse(
      readFileSync(join(assetsDir, 'tasks', 'demo.json'), 'utf8'),
    ) as TaskDef
    expect(wiredDef.task_path).toBe('assets/programs/demo/task.ts')
    const wiredResolved = resolveTaskPath(host.active!.runtime.home, wiredDef.task_path)
    expect(wiredResolved.error).toBeUndefined()
    expect(realpathSync(wiredResolved.path as string)).toBe(
      realpathSync(join(assetsDir, 'programs', 'demo', 'task.ts')),
    )

    const listed = (await ctx.tools.get('task_list')!.execute({}, {} as never)) as {
      tasks: TaskDef[]
    }
    expect(listed.tasks.map((task) => task.id)).toEqual(['demo'])
    expect(existsSync(join(assetsDir, 'tasks', 'demo.json'))).toBe(true)
    // 真实 git 提交（install 时 ensureAssetsRepo 建仓）
    expect(subjects(assetsDir)[0]).toBe('tasks: create demo')

    dispose()
    for (const name of SCHEDULER_TOOL_NAMES) {
      expect(ctx.tools.get(name), `dispose 后 ${name} 必须消失`).toBeUndefined()
    }
    expect(ctx.tools.get('asset_commit')).toBeUndefined()
    expect(host.active).toBeUndefined()

    // 可重装（工具再次出现，且不因重名失败）
    const again = host.install(makePack())
    expect(ctx.tools.get('task_create')).toBeDefined()
    again()
    expect(ctx.tools.get('task_create')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// G. task_path 归一化（P0 修复后的正确语义）
// ---------------------------------------------------------------------------

describe('G · task_path 归一化与执行链一致性', () => {
  it('programs/… 与 assets/programs/… 落盘值完全一致，且都能被 runNow 执行', async () => {
    const fixture = setup()
    const disk = join(fixture.programsDir, 'demo', 'task.ts')

    const viaAssetsRel = (await call(fixture, 'task_create', {
      ...VALID,
      id: 'via-assets-rel',
      task_path: 'programs/demo/task.ts',
    })) as { task: TaskDef }
    const viaHomeRel = (await call(fixture, 'task_create', {
      ...VALID,
      id: 'via-home-rel',
      task_path: 'assets/programs/demo/task.ts',
    })) as { task: TaskDef }

    // 两种写法 → 同一个落盘值（返回值 + 磁盘 JSON 双重确认）。
    expect(viaAssetsRel.task.task_path).toBe('assets/programs/demo/task.ts')
    expect(viaHomeRel.task.task_path).toBe(viaAssetsRel.task.task_path)
    expect(isAbsolute(viaAssetsRel.task.task_path)).toBe(false)
    for (const id of ['via-assets-rel', 'via-home-rel']) {
      const stored = JSON.parse(
        readFileSync(join(fixture.tasksDir, `${id}.json`), 'utf8'),
      ) as TaskDef
      expect(stored.task_path).toBe('assets/programs/demo/task.ts')
    }

    // 恰好两次 create commit（初始 1 + 2）。
    expect(commitCount(fixture.assetsDir)).toBe(3)
    expect(subjects(fixture.assetsDir).slice(0, 2)).toEqual([
      'tasks: create via-home-rel',
      'tasks: create via-assets-rel',
    ])

    const { service, execCalls } = makeService(fixture)
    const first = await service.runNow('via-assets-rel')
    const second = await service.runNow('via-home-rel')
    expect(first.kind).toBe('quiet')
    expect(second.kind).toBe('quiet')
    expect(execCalls).toHaveLength(2)
    // exec 收到的绝对路径两次相同，realpath 指向磁盘真实程序文件。
    expect(execCalls[0]).toBe(join(fixture.assetsDir, 'programs', 'demo', 'task.ts'))
    expect(execCalls[1]).toBe(execCalls[0])
    expect(realpathSync(execCalls[0])).toBe(realpathSync(disk))
  })
})

// ---------------------------------------------------------------------------
// H. P0 修复独立验证（本文件自建断言，不复用开发者用例）
// ---------------------------------------------------------------------------

describe('H · P0 修复独立验证', () => {
  it('显式注入 home（与 mountScheduler 一致）：create 后 runNow 为 quiet，exec 路径 realpath 等于磁盘程序', async () => {
    const fixture = setup()
    const home = fixture.root
    const disk = join(fixture.programsDir, 'demo', 'task.ts')
    const state = { reloads: 0 }
    const tools = new Map(
      createSchedulerTools({
        store: fixture.store,
        assetsDir: fixture.assetsDir,
        home,
        onChange: () => {
          state.reloads += 1
        },
      }).map((definition) => [definition.name, definition]),
    )
    const created = (await tools.get('task_create')!.execute(
      { ...VALID, task_path: 'programs/demo/task.ts' },
      {} as never,
    )) as { task: TaskDef }

    // 落盘值必须以 home 为基准（相对、posix、无机器绝对路径），并经执行链解析回真实文件。
    expect(created.task.task_path).toBe('assets/programs/demo/task.ts')
    expect(isAbsolute(created.task.task_path)).toBe(false)
    const stored = JSON.parse(
      readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8'),
    ) as TaskDef
    expect(stored.task_path).toBe('assets/programs/demo/task.ts')
    const resolved = resolveTaskPath(home, stored.task_path)
    expect(resolved.error).toBeUndefined()
    expect(realpathSync(resolved.path as string)).toBe(realpathSync(disk))

    // 恰好一次 create commit。
    expect(commitCount(fixture.assetsDir)).toBe(2)
    expect(subjects(fixture.assetsDir)[0]).toBe('tasks: create demo')
    expect(state.reloads).toBe(1)

    // 真实 SchedulerService + 假 exec/timer：runNow 必须 quiet（修复前为 failed）。
    const { service, execCalls, timers } = makeService(fixture)
    const outcome = await service.runNow('demo')
    expect(outcome.kind).toBe('quiet')
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0]).toBe(join(fixture.assetsDir, 'programs', 'demo', 'task.ts'))
    expect(realpathSync(execCalls[0])).toBe(realpathSync(disk))
    // runNow 不装 timer（不影响既有调度）。
    expect(timers).toHaveLength(0)
  })

  it('assetsDir 在 home 之外：落盘绝对路径、不逃逸校验失配，且仍可执行', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-rsi-indep-out-'))
    roots.push(base)
    const home = join(base, 'home')
    const assetsDir = join(base, 'elsewhere', 'assets')
    const tasksDir = join(assetsDir, 'tasks')
    const programsDir = join(assetsDir, 'programs')
    mkdirSync(join(programsDir, 'demo'), { recursive: true })
    mkdirSync(tasksDir, { recursive: true })
    mkdirSync(home, { recursive: true })
    const disk = join(programsDir, 'demo', 'task.ts')
    writeFileSync(disk, 'console.log(JSON.stringify({ shouldWake: false }))\n', 'utf8')
    expect(runGit(['init', '--quiet', '-b', 'main', '.'], assetsDir).ok).toBe(true)
    expect(runGit(['add', '-A'], assetsDir).ok).toBe(true)
    expect(runGit(['commit', '-m', 'chore: initial assets'], assetsDir).ok).toBe(true)

    const warns: string[] = []
    const store = createTaskStore({ tasksDir, assetsDir, logger: (m: string) => warns.push(m) })
    const tools = new Map(
      createSchedulerTools({ store, assetsDir, home }).map((definition) => [
        definition.name,
        definition,
      ]),
    )
    const created = (await tools.get('task_create')!.execute(
      { ...VALID, task_path: 'programs/demo/task.ts' },
      {} as never,
    )) as { task: TaskDef }

    // 退化语义：相对 home 会以 .. 开头 → 落绝对路径（显式记录，可移植性受限）。
    const expected = join(assetsDir, 'programs', 'demo', 'task.ts')
    expect(created.task.task_path).toBe(expected)
    expect(isAbsolute(created.task.task_path)).toBe(true)
    expect(relative(home, created.task.task_path).startsWith('..')).toBe(true)
    const stored = JSON.parse(
      readFileSync(join(tasksDir, 'demo.json'), 'utf8'),
    ) as TaskDef
    expect(stored.task_path).toBe(expected)

    // 仍可执行：exec 收到该绝对路径，realpath 等于磁盘程序。
    const { service, execCalls } = makeService(
      { root: base, assetsDir, tasksDir, programsDir, store, tools, warns, state: { reloads: 0 } },
      { home },
    )

    const outcome = await service.runNow('demo')
    expect(outcome.kind).toBe('quiet')
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0]).toBe(expected)
    expect(realpathSync(execCalls[0])).toBe(realpathSync(disk))
  })

  it('反向验证：落盘值被人为改成不存在的 home 相对路径 → runNow 必须 failed（任务程序不存在）', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)

    const file = join(fixture.tasksDir, 'demo.json')
    const def = JSON.parse(readFileSync(file, 'utf8')) as TaskDef
    expect(def.task_path).toBe('assets/programs/demo/task.ts')
    // 人为篡改（模拟错误落盘）：仍是 home 相对，但目标文件不存在。
    writeFileSync(
      file,
      `${JSON.stringify({ ...def, task_path: 'assets/programs/demo/ghost.ts' }, null, 2)}\n`,
      'utf8',
    )

    const { service, execCalls } = makeService(fixture)
    const outcome = await service.runNow('demo')
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.failureKind).toBe('exec')
      expect(outcome.reason).toContain('任务程序不存在')
      // detail 是执行链解析出的绝对路径，证明修复没有把错误路径「吞掉」。
      expect(outcome.detail).toBe(join(fixture.assetsDir, 'programs', 'demo', 'ghost.ts'))
    }
    expect(execCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// I. 已知限制：legacy `programs/…` 定义不自愈，update 可显式修正
// ---------------------------------------------------------------------------

describe('I · 已知限制：legacy 定义不自愈', () => {
  it('磁盘上的 programs/… 旧定义保持 failed；list/get/enable 不改写；task_update 显式传 task_path 后恢复', async () => {
    const fixture = setup()
    const disk = join(fixture.programsDir, 'demo', 'task.ts')
    // 模拟旧版本（落盘基准 = assets）写下的定义：直接落盘，不经当前工具层。
    const legacy: TaskDef = {
      id: 'legacy',
      name: '旧定义',
      cron: '0 9 * * *',
      task_path: 'programs/demo/task.ts',
      enabled: true,
    }
    const file = join(fixture.tasksDir, 'legacy.json')
    writeFileSync(file, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')
    const before = readFileSync(file, 'utf8')

    const { service, execCalls } = makeService(fixture)
    const broken = await service.runNow('legacy')
    expect(broken.kind).toBe('failed')
    if (broken.kind === 'failed') {
      expect(broken.reason).toContain('任务程序不存在')
      expect(broken.detail).toBe(join(fixture.root, 'programs', 'demo', 'task.ts'))
    }
    expect(execCalls).toHaveLength(0)

    // 只读工具 + enable 都不会「自愈」：磁盘定义保持原样。
    const listed = (await call(fixture, 'task_list')) as { tasks: TaskDef[] }
    expect(listed.tasks.find((task) => task.id === 'legacy')?.task_path).toBe(
      'programs/demo/task.ts',
    )
    await call(fixture, 'task_get', { id: 'legacy' })
    expect(readFileSync(file, 'utf8')).toBe(before)

    await call(fixture, 'task_enable', { id: 'legacy' })
    expect((JSON.parse(readFileSync(file, 'utf8')) as TaskDef).task_path).toBe(
      'programs/demo/task.ts',
    )
    const stillBroken = await service.runNow('legacy')
    expect(stillBroken.kind).toBe('failed')
    expect(execCalls).toHaveLength(0)

    // 显式传 task_path（即使写法与 legacy 相同）即修正为可执行。
    const updated = (await call(fixture, 'task_update', {
      id: 'legacy',
      task_path: 'programs/demo/task.ts',
    })) as { task: TaskDef }
    expect(updated.task.task_path).toBe('assets/programs/demo/task.ts')
    expect((JSON.parse(readFileSync(file, 'utf8')) as TaskDef).task_path).toBe(
      'assets/programs/demo/task.ts',
    )

    const fixed = await service.runNow('legacy')
    expect(fixed.kind).toBe('quiet')
    expect(execCalls).toHaveLength(1)
    expect(realpathSync(execCalls[0])).toBe(realpathSync(disk))
  })
})

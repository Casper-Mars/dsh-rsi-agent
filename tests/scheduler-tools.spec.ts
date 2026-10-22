/**
 * 任务定义工具（7 个 task_*）：验收 1–7 + 校验反例。
 *
 * 全部使用临时目录 + 真实 `TaskStore`（git 执行器注入，用于断言 commit message），
 * 不触碰宿主机真实资产仓库；`onChange` 用计数器 / 真实 `SchedulerService` 验证。
 */
import {
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
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitResult, GitRunner } from '../src/assets/git'
import { createSchedulerService } from '../src/scheduler/service'
import { createTaskStore, type TaskStore } from '../src/scheduler/store'
import { resolveTaskPath } from '../src/scheduler/task'
import {
  SCHEDULER_TOOL_NAMES,
  createSchedulerTools,
  resolveTaskProgramPath,
} from '../src/scheduler/tools'
import type { TaskDef } from '../src/scheduler/types'
import type { ToolDefinition } from '../src/types'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

const ok = (stdout = ''): GitResult => ({ ok: true, stdout, stderr: '', code: 0 })

/** 记录 commit message 的假 git（diff 恒报「有 staged 变更」，commit 只记录不执行）。 */
function fakeGit(commits: string[]): GitRunner {
  return (args) => {
    const sep = args.indexOf('--')
    const paths = sep >= 0 ? args.slice(sep + 1) : []
    switch (args[0]) {
      case 'diff': {
        if (args.includes('-z')) return ok(paths.map((path) => `${path}\0`).join(''))
        const path = paths[0] ?? ''
        return ok(`A\t${path}\n`)
      }
      case 'commit': {
        const at = args.indexOf('-m')
        const message = at >= 0 ? args[at + 1] : undefined
        if (typeof message === 'string') commits.push(message)
        return ok()
      }
      case 'rev-parse':
        return ok('0123456789abcdef0123456789abcdef01234567\n')
      default:
        return ok()
    }
  }
}

interface Fixture {
  readonly root: string
  /** 领域 home：`task_path` 落盘归一化基准（执行链同基准）。 */
  readonly home: string
  readonly assetsDir: string
  readonly tasksDir: string
  readonly programsDir: string
  readonly store: TaskStore
  readonly tools: Map<string, ToolDefinition>
  readonly commits: string[]
  readonly state: { reloads: number }
}

/**
 * 建临时资产仓库 + 真实 TaskStore + 7 个工具。
 *
 * `assetsOutsideHome` 模拟 legacy 安装选项：`assetsDir` 被指到 `home` 之外
 * （此时 task_path 只能落绝对路径）。
 */
function setup(options: { assetsOutsideHome?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rsi-sched-tools-'))
  roots.push(root)
  const home = options.assetsOutsideHome === true ? join(root, 'home') : root
  mkdirSync(home, { recursive: true })
  const assetsDir = join(root, 'assets')
  const tasksDir = join(assetsDir, 'tasks')
  const programsDir = join(assetsDir, 'programs')
  mkdirSync(join(assetsDir, '.git'), { recursive: true })
  mkdirSync(tasksDir, { recursive: true })
  mkdirSync(join(programsDir, 'demo'), { recursive: true })
  writeFileSync(join(programsDir, 'demo', 'task.ts'), 'console.log("{}")\n', 'utf8')

  const commits: string[] = []
  const store = createTaskStore({ tasksDir, assetsDir, git: fakeGit(commits) })
  const state = { reloads: 0 }
  const defs = createSchedulerTools({
    store,
    home,
    assetsDir,
    onChange: () => {
      state.reloads += 1
    },
  })
  const tools = new Map(defs.map((definition) => [definition.name, definition]))
  return { root, home, assetsDir, tasksDir, programsDir, store, tools, commits, state }
}

/** 调工具（工具实现不使用 exec，传空上下文即可）。 */
async function call(fixture: Fixture, name: string, args: unknown = {}): Promise<unknown> {
  const definition = fixture.tools.get(name)
  if (definition === undefined) throw new Error(`工具 ${name} 未注册`)
  return definition.execute(args, {} as never)
}

const VALID: Omit<TaskDef, 'task_path'> & { task_path: string } = {
  id: 'demo',
  name: '示例任务',
  cron: '0 9 * * *',
  task_path: 'programs/demo/task.ts',
  enabled: true,
}

/**
 * `VALID` 落盘后的期望值：入参写法归一化为**相对 home 的 posix 路径**
 * （home 是 `<root>`，assetsDir 是 `<root>/assets`）。
 */
const STORED: TaskDef = { ...VALID, task_path: 'assets/programs/demo/task.ts' }

/** 真实 SchedulerService + 假 exec（记录被执行的任务入口路径）。 */
function makeRunner(fixture: Fixture) {
  const execCalls: string[] = []
  const service = createSchedulerService({
    runtime: {
      home: fixture.home,
      assetsDir: fixture.assetsDir,
      dataDir: join(fixture.root, 'data'),
      sessionId: 'tools-session',
      timezone: 'Asia/Shanghai',
    },
    scheduler: { timezone: 'Asia/Shanghai' },
    store: fixture.store,
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    timer: { setTimer: () => ({}) as never, clearTimer: () => {} },
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
  return { service, execCalls }
}

/** 读磁盘上的任务定义。 */
function readTask(fixture: Fixture, id: string): TaskDef {
  return JSON.parse(readFileSync(join(fixture.tasksDir, `${id}.json`), 'utf8')) as TaskDef
}

describe('工具集合', () => {
  it('恰好注册 7 个任务工具，名字与约定一致', () => {
    const fixture = setup()
    expect([...fixture.tools.keys()].sort()).toEqual([...SCHEDULER_TOOL_NAMES].sort())
    expect(fixture.tools.size).toBe(7)
  })
})

describe('验收 1 · task_create 落盘 + commit 含 create', () => {
  it('写入 assets/tasks/<id>.json，产生一次 commit，message 首行为 tasks: create <id>', async () => {
    const fixture = setup()
    const result = (await call(fixture, 'task_create', VALID)) as { ok: boolean; task: TaskDef }

    const file = join(fixture.tasksDir, 'demo.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(STORED)
    expect(result.ok).toBe(true)
    expect(result.task).toEqual(STORED)

    expect(fixture.commits).toHaveLength(1)
    expect(fixture.commits[0].split('\n')[0]).toBe('tasks: create demo')
    expect(fixture.commits[0]).toContain('create')
    expect(fixture.state.reloads).toBe(1)
  })

  it('enabled 缺省为 true', async () => {
    const fixture = setup()
    const { enabled: _ignored, ...rest } = VALID
    const result = (await call(fixture, 'task_create', rest)) as { task: TaskDef }
    expect(result.task.enabled).toBe(true)
  })

  it('programs/... 与 assets/programs/... 两种写法归一化为同一落盘值', async () => {
    const fixture = setup()
    const a = (await call(fixture, 'task_create', {
      ...VALID,
      id: 'via-assets-rel',
      task_path: 'programs/demo/task.ts',
    })) as { task: TaskDef }
    const b = (await call(fixture, 'task_create', {
      ...VALID,
      id: 'via-home-rel',
      task_path: 'assets/programs/demo/task.ts',
    })) as { task: TaskDef }

    for (const task of [a.task, b.task]) expect(task.task_path).toBe(STORED.task_path)
    expect(readTask(fixture, 'via-assets-rel').task_path).toBe(STORED.task_path)
    expect(readTask(fixture, 'via-home-rel').task_path).toBe(STORED.task_path)
  })

  it('重复 id → 报错且不覆盖已有定义', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)
    const before = readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')
    await expect(
      call(fixture, 'task_create', { ...VALID, name: '第二次' }),
    ).rejects.toThrow(/已存在/)
    expect(readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')).toBe(before)
    expect(fixture.commits).toHaveLength(1)
  })
})

describe('验收 2 · cron 只接受 5 段', () => {
  it.each([
    ['0 0 9 * * *', '6 段（带秒）'],
    ['*/5 * * * * *', '步进 + 秒'],
    ['0 0 9 * * ? *', '7 段'],
    ['0 9 * *', '4 段'],
  ])('拒绝 %s（%s），错误信息指出 5 段要求', async (cron) => {
    const fixture = setup()
    await expect(call(fixture, 'task_create', { ...VALID, cron })).rejects.toThrow(
      /应含 5 段（分 时 日 月 周）/,
    )
    expect(readdirSync(fixture.tasksDir)).toHaveLength(0)
    expect(fixture.commits).toHaveLength(0)
    expect(fixture.state.reloads).toBe(0)
  })

  it('task_update 传入 6 段 cron 同样被拒绝，且原文件不变', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)
    const before = readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')
    await expect(
      call(fixture, 'task_update', { id: 'demo', cron: '0 0 9 * * *' }),
    ).rejects.toThrow(/应含 5 段（分 时 日 月 周）/)
    expect(readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')).toBe(before)
  })
})

describe('验收 3 · task_path 文件必须存在且可读', () => {
  it('指向不存在的文件 → create 失败，零落盘 / 零提交', async () => {
    const fixture = setup()
    await expect(
      call(fixture, 'task_create', { ...VALID, task_path: 'programs/demo/missing.ts' }),
    ).rejects.toThrow(/任务程序不可用|不存在/)
    expect(readdirSync(fixture.tasksDir)).toHaveLength(0)
    expect(fixture.commits).toHaveLength(0)
  })

  it('task_update 传入不存在的 task_path → 失败且原文件不变', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)
    const before = readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')
    await expect(
      call(fixture, 'task_update', { id: 'demo', task_path: 'programs/demo/nope.ts' }),
    ).rejects.toThrow(/任务程序不可用|不存在/)
    expect(readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')).toBe(before)
  })

  it.each([
    ['programs/../tasks/demo.json', '上级目录穿越'],
    ['../programs/demo/task.ts', '逃出资产根'],
    ['/etc/passwd', '绝对路径'],
    ['programs\\demo\\task.ts', '反斜杠'],
    ['tasks/demo.json', '不在 programs/ 下'],
    ['programs/.git/config', '.git 段'],
    ['programs/demo/', '结尾斜杠（空段）'],
    ['', '空串'],
  ])('拒绝 %s（%s）', async (taskPath) => {
    const fixture = setup()
    await expect(
      call(fixture, 'task_create', { ...VALID, task_path: taskPath }),
    ).rejects.toThrow(/task_path/)
    expect(readdirSync(fixture.tasksDir)).toHaveLength(0)
  })

  it('软链接指向资产根之外 → 拒绝', async () => {
    const fixture = setup()
    const outside = join(fixture.root, 'outside.ts')
    writeFileSync(outside, '// outside\n', 'utf8')
    symlinkSync(outside, join(fixture.programsDir, 'escape.ts'))
    await expect(
      call(fixture, 'task_create', { ...VALID, task_path: 'programs/escape.ts' }),
    ).rejects.toThrow(/软链接/)
    expect(() => resolveTaskProgramPath(fixture.assetsDir, 'programs/escape.ts')).toThrow(/软链接/)
  })

  it('资产根内的软链接可正常使用', async () => {
    const fixture = setup()
    symlinkSync(
      join(fixture.programsDir, 'demo', 'task.ts'),
      join(fixture.programsDir, 'alias.ts'),
    )
    const target = resolveTaskProgramPath(fixture.assetsDir, 'programs/alias.ts')
    expect(target).toBe(join(fixture.programsDir, 'alias.ts'))
  })
})

describe('验收 4 · disable 后不触发，enable 后恢复', () => {
  it('真实 SchedulerService：disable → 移出调度；enable → 重新装配', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)

    const handles: Array<{ cleared: boolean }> = []
    const service = createSchedulerService({
      runtime: {
        home: fixture.root,
        assetsDir: fixture.assetsDir,
        dataDir: join(fixture.root, 'data'),
        sessionId: 'test-session',
        timezone: 'Asia/Shanghai',
      },
      scheduler: { timezone: 'Asia/Shanghai' },
      store: fixture.store,
      clock: { now: () => new Date('2026-01-01T00:00:00Z') },
      timer: {
        setTimer: () => {
          const handle = { cleared: false }
          handles.push(handle)
          return handle as never
        },
        clearTimer: (handle) => {
          ;(handle as unknown as { cleared: boolean }).cleared = true
        },
      },
    })

    // 工具注册时注入的 onChange 指向同一个 reload 语义。
    const tools = new Map(
      createSchedulerTools({
        store: fixture.store,
        assetsDir: fixture.assetsDir,
        onChange: () => service.reload(),
      }).map((definition) => [definition.name, definition]),
    )
    const invoke = async (name: string, args: unknown = {}): Promise<unknown> =>
      (tools.get(name) as ToolDefinition).execute(args, {} as never)

    service.start()
    expect(service.scheduledIds).toEqual(['demo'])

    await invoke('task_disable', { id: 'demo' })
    expect(service.scheduledIds).toEqual([])
    // 定义保留，仅 enabled=false。
    const disabled = JSON.parse(readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')) as TaskDef
    expect(disabled.enabled).toBe(false)
    expect(fixture.commits.at(-1)?.split('\n')[0]).toBe('tasks: disable demo')

    await invoke('task_enable', { id: 'demo' })
    expect(service.scheduledIds).toEqual(['demo'])
    const enabled = JSON.parse(readFileSync(join(fixture.tasksDir, 'demo.json'), 'utf8')) as TaskDef
    expect(enabled.enabled).toBe(true)
    expect(fixture.commits.at(-1)?.split('\n')[0]).toBe('tasks: enable demo')

    service.stop()
  })
})

describe('验收 5 · task_update 不存在 id 报错且零副作用', () => {
  it('明确错误信息 + 不产生任何新文件', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)
    const before = readdirSync(fixture.tasksDir).sort()
    const commitsBefore = fixture.commits.length

    await expect(call(fixture, 'task_update', { id: 'ghost', name: 'x' })).rejects.toThrow(
      /任务 ghost 不存在/,
    )
    expect(readdirSync(fixture.tasksDir).sort()).toEqual(before)
    expect(fixture.commits).toHaveLength(commitsBefore)
    expect(existsSync(join(fixture.tasksDir, 'ghost.json'))).toBe(false)
  })

  it('更新已存在任务：写盘 + commit 含 update', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)
    const result = (await call(fixture, 'task_update', {
      id: 'demo',
      name: '改名',
      cron: '*/30 * * * *',
    })) as { task: TaskDef }
    expect(result.task.name).toBe('改名')
    expect(result.task.cron).toBe('*/30 * * * *')
    expect(result.task.task_path).toBe(STORED.task_path)
    expect(fixture.commits.at(-1)?.split('\n')[0]).toBe('tasks: update demo')
  })
})

describe('验收 6 · task_delete 只删定义，保留程序', () => {
  it('定义消失、programs/ 文件仍在、commit 含 remove', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)
    await call(fixture, 'task_delete', { id: 'demo' })

    expect(existsSync(join(fixture.tasksDir, 'demo.json'))).toBe(false)
    expect(existsSync(join(fixture.programsDir, 'demo', 'task.ts'))).toBe(true)
    expect(fixture.commits.at(-1)?.split('\n')[0]).toBe('tasks: remove demo')
    expect(fixture.state.reloads).toBe(2)
  })

  it('删除不存在的 id → 报错', async () => {
    const fixture = setup()
    await expect(call(fixture, 'task_delete', { id: 'ghost' })).rejects.toThrow(/不存在/)
  })
})

describe('验收 7 · task_list 字段与 TaskDef 完全一致', () => {
  it('每个任务严格 5 字段，无多余业务字段', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)
    const result = (await call(fixture, 'task_list')) as { tasks: TaskDef[] }
    expect(result.tasks).toHaveLength(1)
    expect(Object.keys(result.tasks[0]).sort()).toEqual([
      'cron',
      'enabled',
      'id',
      'name',
      'task_path',
    ])
    expect(result.tasks[0]).toEqual(STORED)
    expect('corrupted' in result).toBe(false)
  })

  it('磁盘上多出的业务字段不会泄漏到工具输出', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)
    writeFileSync(
      join(fixture.tasksDir, 'demo.json'),
      JSON.stringify({ ...VALID, extra: 'should-be-dropped' }),
      'utf8',
    )
    const result = (await call(fixture, 'task_list')) as { tasks: Array<Record<string, unknown>> }
    expect(result.tasks[0]).toEqual(VALID)
    expect(result.tasks[0].extra).toBeUndefined()
  })

  it('损坏文件只在顶层 corrupted 暴露，不进入任务对象', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)
    writeFileSync(join(fixture.tasksDir, 'broken.json'), '{ not json', 'utf8')
    const result = (await call(fixture, 'task_list')) as { tasks: TaskDef[]; corrupted?: string[] }
    expect(result.tasks).toEqual([STORED])
    expect(result.corrupted).toEqual(['broken'])
  })
})

describe('读类工具与 id 校验', () => {
  it('task_get 命中返回严格 5 字段', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)
    const result = (await call(fixture, 'task_get', { id: 'demo' })) as { task: TaskDef }
    expect(result.task).toEqual(STORED)
  })

  it('task_get 不存在 → 报错', async () => {
    const fixture = setup()
    await expect(call(fixture, 'task_get', { id: 'ghost' })).rejects.toThrow(/任务 ghost 不存在/)
  })

  it.each(['../evil', 'a/b', 'a\\b', ''])('非法 id %s 被拒绝', async (id) => {
    const fixture = setup()
    await expect(call(fixture, 'task_get', { id })).rejects.toThrow(/id/)
  })

  it('enable / disable 不存在 id → 报错', async () => {
    const fixture = setup()
    await expect(call(fixture, 'task_enable', { id: 'ghost' })).rejects.toThrow(/不存在/)
    await expect(call(fixture, 'task_disable', { id: 'ghost' })).rejects.toThrow(/不存在/)
  })

  it('入参不是对象 → 报错', async () => {
    const fixture = setup()
    await expect(call(fixture, 'task_create', null)).rejects.toThrow(/入参必须是对象/)
  })
})

describe('验收 8 · task_path 落盘基准 = home（P0 回归）', () => {
  it('create 落盘后真实 runNow 走到 exec 且不是 failed（任务程序不存在）', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)

    // 落盘值是相对 home 的路径（不是调用方原文的 programs/...）。
    expect(readTask(fixture, 'demo').task_path).toBe('assets/programs/demo/task.ts')

    const { service, execCalls } = makeRunner(fixture)
    const outcome = await service.runNow('demo')

    expect(outcome.kind).toBe('quiet')
    if (outcome.kind === 'failed') {
      expect(outcome.reason).not.toMatch(/任务程序不存在/)
    }
    expect(execCalls).toEqual([join(fixture.programsDir, 'demo', 'task.ts')])
  })

  it('落盘值可被 resolveTaskPath(home, ...) 解析回真实存在的文件', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)

    const stored = readTask(fixture, 'demo').task_path
    const resolved = resolveTaskPath(fixture.home, stored)
    expect(resolved.error).toBeUndefined()
    expect(resolved.path).toBeDefined()
    const path = resolved.path as string
    expect(existsSync(path)).toBe(true)
    expect(realpathSync(path)).toBe(realpathSync(join(fixture.programsDir, 'demo', 'task.ts')))
    // 与执行链同一基准：resolveTaskPath 的入参 home 必须是落盘基准。
    expect(path).toBe(join(fixture.assetsDir, 'programs', 'demo', 'task.ts'))
  })

  it('assetsDir 在 home 之外（legacy 安装选项）→ 落绝对路径且 runNow 可执行', async () => {
    const fixture = setup({ assetsOutsideHome: true })
    const result = (await call(fixture, 'task_create', VALID)) as { task: TaskDef }

    const stored = result.task.task_path
    expect(isAbsolute(stored)).toBe(true)
    expect(stored).toBe(join(fixture.programsDir, 'demo', 'task.ts'))
    expect(readTask(fixture, 'demo').task_path).toBe(stored)
    // 绝对路径仍能被执行链解析（runTask 对绝对 task_path 显式放行）。
    expect(resolveTaskPath(fixture.home, stored).path).toBe(stored)

    const { service, execCalls } = makeRunner(fixture)
    const outcome = await service.runNow('demo')
    expect(outcome.kind).toBe('quiet')
    expect(execCalls).toEqual([stored])
  })

  it('update 走同一归一化：改 task_path 后 runNow 仍可执行', async () => {
    const fixture = setup()
    await call(fixture, 'task_create', VALID)
    writeFileSync(join(fixture.programsDir, 'demo', 'other.ts'), 'console.log("{}")\n', 'utf8')

    const updated = (await call(fixture, 'task_update', {
      id: 'demo',
      task_path: 'programs/demo/other.ts',
    })) as { task: TaskDef }
    expect(updated.task.task_path).toBe('assets/programs/demo/other.ts')

    const { service, execCalls } = makeRunner(fixture)
    expect((await service.runNow('demo')).kind).toBe('quiet')
    expect(execCalls).toEqual([join(fixture.programsDir, 'demo', 'other.ts')])
  })
})

/**
 * 完整触发链 `runTask`：读任务 → 可读性 → 依赖 → 执行 → 解析 → 结局 → 唤醒。
 *
 * 依赖 / 执行 / 唤醒全部注入 fake：本文件不启动真实子进程，也不跑 pnpm。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExecResult, ExecStrategy, TaskDef } from '../src/scheduler/types'
import { inferRuntime, resolveTaskPath, runTask, type RunTaskDeps } from '../src/scheduler/task'
import { Waker, type WakeInput } from '../src/scheduler/wake'

const roots: string[] = []

function home(files: Record<string, string> = { 'task.mjs': 'console.log("x")' }): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rsi-task-'))
  roots.push(root)
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

function taskDef(overrides: Partial<TaskDef> = {}): TaskDef {
  return {
    id: 'demo',
    name: '示例',
    cron: '0 9 * * *',
    task_path: 'task.mjs',
    enabled: true,
    ...overrides,
  }
}

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    stdout: '{"shouldWake":false}\n',
    stderr: '',
    truncated: false,
    timedOut: false,
    ...overrides,
  }
}

interface Harness {
  deps: RunTaskDeps
  wakeCalls: WakeInput[]
  execCalls: Array<Parameters<ExecStrategy['exec']>[0]>
  depsCalls: Array<[string, string]>
  root: string
  waker: Waker
}

function harness(options: {
  task?: TaskDef
  exec?: ExecResult
  root?: string
  installError?: Error
  declaredRuntimes?: readonly string[]
  checkReadable?: (path: string) => string | undefined
  execStrategy?: ExecStrategy
  disclaimer?: string
} = {}): Harness {
  const root = options.root ?? home()
  const task = options.task ?? taskDef()
  const wakeCalls: WakeInput[] = []
  const execCalls: Array<Parameters<ExecStrategy['exec']>[0]> = []
  const depsCalls: Array<[string, string]> = []

  const waker = new Waker({
    sessionId: 'agent',
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    ...(options.disclaimer === undefined ? {} : { disclaimer: options.disclaimer }),
    sink: { deliver: (input) => wakeCalls.push(input) },
  })

  const deps: RunTaskDeps = {
    store: { get: (id) => (id === task.id ? task : undefined) },
    deps: {
      async ensure(taskId, taskDir) {
        depsCalls.push([taskId, taskDir])
        if (options.installError !== undefined) throw options.installError
        return { installed: false, reason: 'cache hit' }
      },
    },
    exec:
      options.execStrategy ??
      ({
        name: 'fake-node',
        async exec(input) {
          execCalls.push(input)
          return options.exec ?? execResult()
        },
      } satisfies ExecStrategy),
    waker,
    home: root,
    ...(options.declaredRuntimes === undefined
      ? {}
      : { declaredRuntimes: options.declaredRuntimes }),
    ...(options.checkReadable === undefined ? {} : { checkReadable: options.checkReadable }),
  }

  return { deps, wakeCalls, execCalls, depsCalls, root, waker }
}

describe('runTask · 读取与可读性', () => {
  it('任务不存在 → failed / exec', async () => {
    const { deps } = harness()
    const outcome = await runTask('missing', deps)
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'exec' })
  })

  it('store.get 抛错 → failed / exec（不穿透）', async () => {
    const { deps } = harness()
    const outcome = await runTask('demo', {
      ...deps,
      store: {
        get() {
          throw new Error('disk gone')
        },
      },
    })
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'exec' })
  })

  it('task_path 为空 → failed / exec', async () => {
    const root = home()
    const { deps } = harness({ root, task: taskDef({ task_path: '  ' }) })
    expect(await runTask('demo', deps)).toMatchObject({ kind: 'failed', failureKind: 'exec' })
  })

  it('task_path 逃逸出 home → failed / exec', async () => {
    const root = home()
    const { deps } = harness({ root, task: taskDef({ task_path: '../evil.mjs' }) })
    const outcome = await runTask('demo', deps)
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'exec' })
    expect(outcome.kind === 'failed' && outcome.reason).toMatch(/路径非法/)
  })

  it('程序文件不存在 → failed / exec，detail 为绝对路径', async () => {
    const root = home({})
    const { deps } = harness({ root })
    const outcome = await runTask('demo', deps)
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'exec' })
    expect(outcome.kind === 'failed' && outcome.detail).toBe(join(root, 'task.mjs'))
  })

  it('程序路径是目录 → failed / exec', async () => {
    const root = home()
    mkdirSync(join(root, 'adir'), { recursive: true })
    const { deps } = harness({ root, task: taskDef({ task_path: 'adir' }) })
    const outcome = await runTask('demo', deps)
    expect(outcome.kind === 'failed' && outcome.reason).toMatch(/不是普通文件/)
  })

  it('注入 checkReadable 的拒绝原因原样呈现', async () => {
    const { deps } = harness({ checkReadable: () => '权限不足' })
    const outcome = await runTask('demo', deps)
    expect(outcome.kind === 'failed' && outcome.reason).toMatch(/权限不足/)
  })

  it('绝对 task_path 可执行', async () => {
    const root = home()
    const { deps } = harness({ root, task: taskDef({ task_path: join(root, 'task.mjs') }) })
    expect(await runTask('demo', deps)).toMatchObject({ kind: 'quiet' })
  })
})

describe('runTask · 运行时策略', () => {
  it('inferRuntime 识别 node 家族与未知扩展名', () => {
    expect(inferRuntime('a/b/task.ts')).toBe('node')
    expect(inferRuntime('a/b/task.mjs')).toBe('node')
    expect(inferRuntime('a/b/task')).toBe('node')
    expect(inferRuntime('a/b/task.py')).toBe('python')
  })

  it('未知运行时（.py）→ failed / install 并点名 python', async () => {
    const root = home({ 'task.py': 'print(1)' })
    const { deps } = harness({ root, task: taskDef({ task_path: 'task.py' }) })
    const outcome = await runTask('demo', deps)
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'install' })
    expect(outcome.kind === 'failed' && outcome.reason).toMatch(/"python"/)
  })

  it('领域声明未知运行时（deno）→ failed / install 并点名 deno', async () => {
    const { deps } = harness({ declaredRuntimes: ['deno'] })
    const outcome = await runTask('demo', deps)
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'install' })
    expect(outcome.kind === 'failed' && outcome.reason).toMatch(/"deno"/)
  })

  it('领域声明 node → 正常执行', async () => {
    const { deps } = harness({ declaredRuntimes: ['node'] })
    expect((await runTask('demo', deps)).kind).toBe('quiet')
  })
})

describe('runTask · 依赖', () => {
  it('依赖检查以任务目录为参数', async () => {
    const { deps, depsCalls, root } = harness()
    await runTask('demo', deps)
    expect(depsCalls).toEqual([['demo', root]])
  })

  it('安装失败 → failed / install，且不执行任务', async () => {
    const { deps, execCalls, wakeCalls } = harness({ installError: new Error('registry down') })
    const outcome = await runTask('demo', deps)
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'install' })
    expect(outcome.kind === 'failed' && outcome.detail).toMatch(/registry down/)
    expect(execCalls).toHaveLength(0)
    expect(wakeCalls).toHaveLength(0)
  })
})

describe('runTask · 执行与解析', () => {
  it('spawn 失败 → failed / spawn', async () => {
    const { deps } = harness({ exec: execResult({ spawnError: 'EACCES' }) })
    expect(await runTask('demo', deps)).toMatchObject({ kind: 'failed', failureKind: 'spawn' })
  })

  it('超时 → failed / exec', async () => {
    const { deps } = harness({ exec: execResult({ timedOut: true }) })
    const outcome = await runTask('demo', deps)
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'exec' })
    expect(outcome.kind === 'failed' && outcome.reason).toMatch(/超时/)
  })

  it('stdout 截断 → failed / exec（标记已生效）', async () => {
    const { deps } = harness({ exec: execResult({ truncated: true }) })
    const outcome = await runTask('demo', deps)
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'exec' })
    expect(outcome.kind === 'failed' && outcome.reason).toMatch(/超限/)
  })

  it('非零退出 → failed / exec，detail 带 stderr', async () => {
    const { deps } = harness({ exec: execResult({ exitCode: 2, stderr: 'boom' }) })
    const outcome = await runTask('demo', deps)
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'exec' })
    expect(outcome.kind === 'failed' && outcome.detail).toBe('boom')
  })

  it('无输出 → failed / parse', async () => {
    const { deps } = harness({ exec: execResult({ stdout: '' }) })
    expect(await runTask('demo', deps)).toMatchObject({ kind: 'failed', failureKind: 'parse' })
  })

  it('末行非法 JSON → failed / parse', async () => {
    const { deps } = harness({ exec: execResult({ stdout: 'log\n{broken' }) })
    expect(await runTask('demo', deps)).toMatchObject({ kind: 'failed', failureKind: 'parse' })
  })

  it('shouldWake=false → quiet，不唤醒', async () => {
    const { deps, wakeCalls } = harness()
    expect(await runTask('demo', deps)).toMatchObject({ kind: 'quiet' })
    expect(wakeCalls).toHaveLength(0)
  })

  it('多行日志 + 末行结果 → 正常解析', async () => {
    const { deps } = harness({
      exec: execResult({ stdout: 'a\nb\n{"shouldWake":false}\n\n' }),
    })
    expect((await runTask('demo', deps)).kind).toBe('quiet')
  })

  it('shouldWake=true → woke，投递正文与目标正确', async () => {
    const { deps, wakeCalls } = harness({
      exec: execResult({ stdout: '{"shouldWake":true,"data":"今日有 3 条信号"}' }),
    })
    const outcome = await runTask('demo', deps)
    expect(outcome).toMatchObject({ kind: 'woke', data: '今日有 3 条信号', targets: ['agent'] })
    expect(wakeCalls).toHaveLength(1)
    expect(wakeCalls[0]?.taskId).toBe('demo')
  })

  it('shouldWake=true 且带 disclaimer → 正文末尾追加', async () => {
    const { deps, wakeCalls } = harness({
      exec: execResult({ stdout: '{"shouldWake":true,"data":"信号"}' }),
      disclaimer: '本内容不构成投资建议',
    })
    const outcome = await runTask('demo', deps)
    expect(outcome.kind === 'woke' && outcome.data).toBe('信号\n\n本内容不构成投资建议')
    expect(wakeCalls[0]?.text).toBe('信号\n\n本内容不构成投资建议')
  })

  it('超长 data 截断到 2000 字素（不切 emoji）', async () => {
    const data = '😀'.repeat(2500)
    const { deps, wakeCalls } = harness({
      exec: execResult({ stdout: JSON.stringify({ shouldWake: true, data }) }),
    })
    const outcome = await runTask('demo', deps)
    const text = outcome.kind === 'woke' ? outcome.data : ''
    expect([...text].length).toBe(2000)
    expect(text).toBe('😀'.repeat(2000))
    expect(wakeCalls[0]?.text).toBe('😀'.repeat(2000))
  })

  it('投递失败 → skipped（不抛）', async () => {
    const { deps } = harness({
      exec: execResult({ stdout: '{"shouldWake":true,"data":"x"}' }),
    })
    const failing = {
      ...deps,
      waker: new Waker({
        sessionId: 'agent',
        sink: {
          deliver() {
            throw new Error('session gone')
          },
        },
      }),
    }
    expect(await runTask('demo', failing)).toMatchObject({ kind: 'skipped' })
  })

  it('冷却中 → skipped', async () => {
    const { deps, waker } = harness({
      exec: execResult({ stdout: '{"shouldWake":true,"data":"x"}' }),
    })
    await waker.wake('demo', 'first')
    expect(await runTask('demo', deps)).toMatchObject({ kind: 'skipped' })
  })

  it('执行输入包含超时 / 缓冲参数与任务目录', async () => {
    const { deps, execCalls, root } = harness()
    await runTask('demo', deps)
    expect(execCalls[0]).toMatchObject({
      taskPath: join(root, 'task.mjs'),
      cwd: root,
      timeoutMs: 60_000,
      maxStdoutBytes: 1_048_576,
    })
  })

  it('执行策略抛错 → failed / exec（兜底隔离）', async () => {
    const { deps } = harness({
      execStrategy: {
        name: 'boom',
        async exec() {
          throw new Error('unexpected')
        },
      },
    })
    const outcome = await runTask('demo', deps)
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'exec' })
    expect(outcome.kind === 'failed' && outcome.detail).toMatch(/unexpected/)
  })
})

describe('resolveTaskPath', () => {
  it('相对路径基于 home 解析', () => {
    expect(resolveTaskPath('/home/x', 'a/b.mjs')).toEqual({ path: '/home/x/a/b.mjs' })
  })

  it('绝对路径原样使用', () => {
    expect(resolveTaskPath('/home/x', '/tmp/t.mjs')).toEqual({ path: '/tmp/t.mjs' })
  })

  it('逃逸 home 的相对路径被拒绝', () => {
    expect(resolveTaskPath('/home/x', '../y.mjs').error).toMatch(/逃逸/)
  })

  it('空路径被拒绝', () => {
    expect(resolveTaskPath('/home/x', '  ').error).toMatch(/为空/)
  })
})


describe('软链接逃逸（L1）', () => {
  it('软链接指向 home 之外 → 拒绝（failed / exec，且不执行）', async () => {
    const root = home({})
    const outside = mkdtempSync(join(tmpdir(), 'dsh-rsi-outside-'))
    roots.push(outside)
    const evil = join(outside, 'evil.mjs')
    writeFileSync(evil, 'console.log(JSON.stringify({shouldWake:false}))\n', 'utf8')
    mkdirSync(join(root, 'job'), { recursive: true })
    symlinkSync(evil, join(root, 'job', 'link.mjs'))

    const { deps, execCalls } = harness({
      root,
      task: taskDef({ task_path: 'job/link.mjs' }),
    })
    const outcome = await runTask('demo', deps)

    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'exec' })
    expect(outcome.reason).toMatch(/路径非法/)
    expect('detail' in outcome ? outcome.detail : '').toMatch(/软链接/)
    expect(execCalls).toHaveLength(0)
  })

  it('软链接指向 home 之内的文件 → 放行', async () => {
    const root = home({ 'real/task.mjs': 'console.log(JSON.stringify({shouldWake:false}))\n' })
    mkdirSync(join(root, 'job'), { recursive: true })
    symlinkSync(join(root, 'real', 'task.mjs'), join(root, 'job', 'link.mjs'))

    const { deps, execCalls } = harness({
      root,
      task: taskDef({ task_path: 'job/link.mjs' }),
    })
    expect((await runTask('demo', deps)).kind).toBe('quiet')
    expect(execCalls).toHaveLength(1)
  })

  it('软链接的中间目录指向 home 之外 → 同样拒绝', async () => {
    const root = home({})
    const outside = mkdtempSync(join(tmpdir(), 'dsh-rsi-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'evil.mjs'), '// x', 'utf8')
    symlinkSync(outside, join(root, 'job'))

    const { deps } = harness({ root, task: taskDef({ task_path: 'job/evil.mjs' }) })
    const outcome = await runTask('demo', deps)
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'exec' })
    expect(outcome.reason).toMatch(/路径非法/)
  })

  it('悬空软链接（目标不存在）→ 走原逻辑给出 failed / exec', async () => {
    const root = home({})
    mkdirSync(join(root, 'job'), { recursive: true })
    symlinkSync(join(root, 'missing', 'gone.mjs'), join(root, 'job', 'dangling.mjs'))

    const { deps } = harness({ root, task: taskDef({ task_path: 'job/dangling.mjs' }) })
    const outcome = await runTask('demo', deps)
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'exec' })
    expect(outcome.reason).toMatch(/程序不可用/)
  })

  it('resolveTaskPath 直接断言：外部软链接返回 error，内部放行', () => {
    const root = home({ 'real/task.mjs': '// x' })
    const outside = mkdtempSync(join(tmpdir(), 'dsh-rsi-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'evil.mjs'), '// x', 'utf8')
    mkdirSync(join(root, 'job'), { recursive: true })
    symlinkSync(join(outside, 'evil.mjs'), join(root, 'job', 'out.mjs'))
    symlinkSync(join(root, 'real', 'task.mjs'), join(root, 'job', 'in.mjs'))

    expect(resolveTaskPath(root, 'job/out.mjs').error).toMatch(/软链接/)
    expect(resolveTaskPath(root, 'job/in.mjs')).toEqual({ path: join(root, 'job', 'in.mjs') })
  })
})

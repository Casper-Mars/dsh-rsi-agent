/**
 * Task-12 · trace 上下文（§13.4）与跨进程注入（验收 5）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogging } from '../src/log/index'
import {
  TRACE_ENV,
  currentTrace,
  ensureTrace,
  newTraceId,
  runWithTrace,
  traceFromEnv,
  traceToEnv,
  withTraceMeta,
  type TraceContext,
} from '../src/log/trace'
import { createNodeExecStrategy } from '../src/scheduler/runner'
import { SchedulerService } from '../src/scheduler/service'
import type { ExecResult } from '../src/scheduler/types'

const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rsi-trace-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function makeNative(): { calls: { level: string; message: string; meta?: unknown }[]; logger: Record<string, unknown> } {
  const calls: { level: string; message: string; meta?: unknown }[] = []
  const push = (level: string) => (message: string, meta?: unknown) => {
    calls.push({ level, message, ...(meta === undefined ? {} : { meta }) })
  }
  return {
    calls,
    logger: { error: push('error'), warn: push('warn'), info: push('info'), debug: push('debug') },
  }
}

describe('trace · ALS 基础语义', () => {
  it('runWithTrace 内可见、域外不可见', async () => {
    const ctx: TraceContext = { traceId: 't-1', taskId: 'job' }
    expect(currentTrace()).toBeUndefined()

    await runWithTrace(ctx, async () => {
      expect(currentTrace()).toEqual(ctx)
      await sleep(1)
      // 异步派生调用链仍可见
      expect(currentTrace()?.traceId).toBe('t-1')
    })

    expect(currentTrace()).toBeUndefined()
  })

  it('嵌套 runWithTrace 内层覆盖外层', () => {
    runWithTrace({ traceId: 'outer' }, () => {
      runWithTrace({ traceId: 'inner' }, () => {
        expect(currentTrace()?.traceId).toBe('inner')
      })
      expect(currentTrace()?.traceId).toBe('outer')
    })
  })

  it('ensureTrace 无上下文时生成并注入，二次调用稳定', () => {
    const first = ensureTrace()
    expect(first.traceId).toBeTruthy()
    expect(currentTrace()?.traceId).toBe(first.traceId)
    expect(ensureTrace().traceId).toBe(first.traceId)
  })

  it('ensureTrace 接受 seed（traceId / taskId / sessionId）', () => {
    const ctx = ensureTrace({ traceId: 'seeded', taskId: 'job', sessionId: 's1' })
    expect(ctx).toEqual({ traceId: 'seeded', taskId: 'job', sessionId: 's1' })
  })

  it('newTraceId 生成互不相同的 UUID', () => {
    expect(newTraceId()).not.toBe(newTraceId())
  })
})

describe('trace · 环境变量往返（跨进程）', () => {
  it('traceToEnv / traceFromEnv 对称', () => {
    const ctx: TraceContext = { traceId: 't-2', taskId: 'job', sessionId: 'sess' }
    const env = traceToEnv(ctx)
    expect(env[TRACE_ENV.traceId]).toBe('t-2')
    expect(env[TRACE_ENV.taskId]).toBe('job')
    expect(env[TRACE_ENV.sessionId]).toBe('sess')
    expect(traceFromEnv(env)).toEqual(ctx)
  })

  it('无 trace 时 env 为空对象；缺 traceId 时 traceFromEnv 返回 undefined', () => {
    expect(traceToEnv(undefined)).toEqual({})
    expect(traceFromEnv({})).toBeUndefined()
    expect(traceFromEnv({ [TRACE_ENV.traceId]: '   ' })).toBeUndefined()
  })

  it('withTraceMeta 按「trace < meta」合并；无 trace 原样返回', () => {
    expect(withTraceMeta({ a: 1 })).toEqual({ a: 1 })
    runWithTrace({ traceId: 't-3', taskId: 'job' }, () => {
      expect(withTraceMeta({ a: 1 })).toEqual({ traceId: 't-3', taskId: 'job', a: 1 })
      expect(withTraceMeta({ traceId: 'call-level' })).toMatchObject({ traceId: 'call-level' })
      expect(withTraceMeta(undefined)).toEqual({ traceId: 't-3', taskId: 'job' })
      expect(withTraceMeta('plain')).toEqual({ traceId: 't-3', taskId: 'job', meta: 'plain' })
    })
  })
})

describe('trace · 门面日志的 traceId（验收 5 · 进程内）', () => {
  it('同一 trace 内多条日志 traceId 相同；不同 trace 不同', () => {
    const dir = tempDir()
    const { logger: native } = makeNative()
    const { logger } = createLogging({ scope: 'rsi-agent', logsDir: dir, native })

    runWithTrace({ traceId: 'trace-A', taskId: 'job-1' }, () => {
      logger.info('first')
      logger.warn('second')
    })
    runWithTrace({ traceId: 'trace-B' }, () => {
      logger.info('third')
    })

    const file = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`)
    const records = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const traces = records.map((record) => (record.trace as Record<string, unknown>).traceId)
    expect(traces).toEqual(['trace-A', 'trace-A', 'trace-B'])
  })

  it('无 ALS 上下文时回落 DSH_RSI_TRACE_* 环境变量', () => {
    const dir = tempDir()
    const { logger: native } = makeNative()
    const { logger } = createLogging({
      scope: 'rsi-agent',
      logsDir: dir,
      native,
      env: {
        ...process.env,
        [TRACE_ENV.traceId]: 'from-env',
        [TRACE_ENV.taskId]: 'env-job',
      },
    })
    logger.info('with-env')
    const file = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`)
    const record = JSON.parse(readFileSync(file, 'utf8').trim()) as Record<string, unknown>
    expect(record.trace).toEqual({ traceId: 'from-env', taskId: 'env-job' })
  })
})

describe('trace · 跨进程 env 注入（验收 5 · 实测）', () => {
  it('runner spawn 的子进程能读到 DSH_RSI_TRACE_ID', async () => {
    const dir = tempDir()
    const file = join(dir, 'task.mjs')
    writeFileSync(file, '// dummy\n', 'utf8')

    const strategy = createNodeExecStrategy({
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({t:process.env.DSH_RSI_TRACE_ID,j:process.env.DSH_RSI_TASK_ID}))',
      ],
    })

    const result: ExecResult = await runWithTrace({ traceId: 'trace-xproc', taskId: 'job-9' }, () =>
      strategy.exec({
        taskPath: file,
        cwd: dir,
        timeoutMs: 10_000,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      }),
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ t: 'trace-xproc', j: 'job-9' })
  })
})

describe('trace · 调度链端到端（服务 → runTask → exec）', () => {
  it('同一任务的日志与子进程 env 共享 traceId / taskId / sessionId', async () => {
    const root = tempDir()
    const logsDir = join(root, 'logs')
    const assetsDir = join(root, 'assets')
    const dataDir = join(root, 'data')
    const { mkdirSync } = await import('node:fs')
    for (const dir of [assetsDir, dataDir]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(root, 'task.mjs'), '// dummy\n', 'utf8')

    const { logger: native } = makeNative()
    const logging = createLogging({ scope: 'rsi-agent', logsDir, native, level: 'debug' })
    const logger = logging.logger

    let capturedEnv: Record<string, string> = {}
    const task = {
      id: 'job',
      name: 'job',
      cron: '0 0 * * *',
      task_path: 'task.mjs',
      enabled: true,
    }

    const service = new SchedulerService({
      runtime: {
        home: root,
        assetsDir,
        dataDir,
        sessionId: 'sess-1',
        timezone: 'UTC',
        logger,
      },
      scheduler: { timezone: 'Asia/Shanghai' },
      logger,
      clock: { now: () => new Date('2026-01-01T00:00:00Z') },
      timer: { setTimer: () => 0 as never, clearTimer: () => {} },
      store: {
        tasksDir: join(assetsDir, 'tasks'),
        list: () => ({ tasks: [task], corrupted: [] }),
        get: (id: string) => (id === task.id ? task : undefined),
        save: () => {},
        remove: () => false,
      },
      deps: {
        ensure: async () => {
          // 在 runTask 的同一异步链内记一条日志（模拟依赖层日志）。
          logger.info('deps ensure token=abc')
          return { installed: false, reason: 'cache hit' }
        },
      },
      exec: {
        name: 'fake-node',
        exec: async () => {
          capturedEnv = traceToEnv()
          return {
            exitCode: 0,
            stdout: '{"shouldWake":false}',
            stderr: '',
            truncated: false,
            timedOut: false,
          }
        },
      },
      sink: { deliver: () => {} },
    })

    const outcome = await service.runNow('job')
    expect(outcome.kind).toBe('quiet')

    const envTrace = traceFromEnv(capturedEnv)
    expect(envTrace).toBeDefined()
    expect(envTrace?.taskId).toBe('job')
    expect(envTrace?.sessionId).toBe('sess-1')

    const file = join(logsDir, `${new Date().toISOString().slice(0, 10)}.jsonl`)
    expect(existsSync(file)).toBe(true)
    const records = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records.length).toBeGreaterThanOrEqual(2)
    for (const record of records) {
      const trace = record.trace as Record<string, unknown>
      expect(trace.traceId).toBe(envTrace?.traceId)
      expect(trace.taskId).toBe('job')
      expect(trace.sessionId).toBe('sess-1')
    }
    // 依赖层日志同样经过脱敏
    expect(readFileSync(file, 'utf8')).not.toContain('abc')
  })
})

/**
 * Task-12 · JSONL exporter + 门面接线（§13.2 / §13.3）。
 *
 * 覆盖验收 1–4、7：脱敏落盘、跨天双文件、目录 700 / 文件 600、写盘失败不抛错、
 * 命名空间白名单；另覆盖滚动、保留策略、级别过滤与 `createDomainRuntime` 接线。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_LOG_MAX_BYTES,
  createJsonlSink,
  resolveMaxBytes,
} from '../src/log/exporter'
import { createLogging } from '../src/log/index'
import { REDACTED } from '../src/log/redact'
import { cleanupExpiredLogs, isDatedLogFileName, resolveRetentionDays } from '../src/log/retention'
import { createDomainRuntime, type RuntimePack } from '../src/runtime'
import { createDomainLogger } from '../src/runtime'
import type { DomainLogger } from '../src/types'

const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rsi-log-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop() as string
    try {
      chmodSync(dir, 0o700)
    } catch {
      /* 忽略 */
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 读取某个日文件的全部记录。 */
function readRecords(dir: string, file: string): Record<string, unknown>[] {
  return readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** 记录一个内存 logger（用于确认原生转发仍在）。 */
function memoryLogger(): { calls: { level: string; message: string; meta?: unknown }[]; logger: DomainLogger } {
  const calls: { level: string; message: string; meta?: unknown }[] = []
  const push = (level: string) => (message: string, meta?: unknown) => {
    calls.push({ level, message, ...(meta === undefined ? {} : { meta }) })
  }
  return {
    calls,
    logger: { error: push('error'), warn: push('warn'), info: push('info'), debug: push('debug') },
  }
}

describe('exporter · 落盘与脱敏（验收 1）', () => {
  it('token=abc 与 meta 深层 token 全部为 [REDACTED]，无明文残留', () => {
    const dir = tempDir()
    const now = Date.UTC(2026, 0, 10, 12, 0, 0)
    const sink = createJsonlSink({ logsDir: dir, now: () => now })

    expect(
      sink.write({
        level: 'info',
        name: 'rsi-agent',
        msg: 'login token=abc',
        meta: { user: 'u1', token: 'abc', nested: { apiKey: 'abc' } },
      }),
    ).toBe(true)

    const file = `${new Date(now).toISOString().slice(0, 10)}.jsonl`
    const content = readFileSync(join(dir, file), 'utf8')
    expect(content).toContain(REDACTED)
    expect(content).not.toContain('abc')

    const [record] = readRecords(dir, file)
    expect(record.level).toBe('info')
    expect(record.name).toBe('rsi-agent')
    expect(record.pid).toBe(process.pid)
    expect(typeof record.ts).toBe('string')
    expect((record.meta as Record<string, unknown>).token).toBe(REDACTED)
  })

  it('trace 字段随记录落盘（可选字段不写 undefined）', () => {
    const dir = tempDir()
    const sink = createJsonlSink({ logsDir: dir })
    sink.write({
      level: 'warn',
      name: 'rsi-agent',
      msg: 'm',
      trace: { traceId: 't-1', taskId: 'job' },
    })
    const files = readFileSync(sink.filePathFor(new Date().toISOString().slice(0, 10)), 'utf8')
    const record = JSON.parse(files.trim()) as Record<string, unknown>
    expect(record.trace).toEqual({ traceId: 't-1', taskId: 'job' })
    expect(record.meta).toBeUndefined()
  })
})

describe('exporter · 跨天与滚动（验收 2）', () => {
  it('注入时钟跨天 → 生成两个 YYYY-MM-DD.jsonl', () => {
    const dir = tempDir()
    let now = Date.UTC(2026, 0, 10, 23, 59, 0)
    const sink = createJsonlSink({ logsDir: dir, now: () => now })

    sink.write({ level: 'info', name: 'rsi-agent', msg: 'day-1' })
    now = Date.UTC(2026, 0, 11, 0, 1, 0)
    sink.write({ level: 'info', name: 'rsi-agent', msg: 'day-2' })

    const first = readRecords(dir, '2026-01-10.jsonl')
    const second = readRecords(dir, '2026-01-11.jsonl')
    expect(first.map((r) => r.msg)).toEqual(['day-1'])
    expect(second.map((r) => r.msg)).toEqual(['day-2'])
  })

  it('单文件达阈值 → 滚动到 -1 / -2 后缀', () => {
    const dir = tempDir()
    const sink = createJsonlSink({
      logsDir: dir,
      maxBytes: 260,
      now: () => Date.UTC(2026, 0, 10, 8, 0, 0),
    })

    for (let i = 0; i < 12; i += 1) {
      expect(sink.write({ level: 'info', name: 'rsi-agent', msg: `record-${i}` })).toBe(true)
    }

    const names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    expect(names).toContain('2026-01-10.jsonl')
    expect(names).toContain('2026-01-10-1.jsonl')
    const total = names.reduce((sum, name) => sum + readRecords(dir, name).length, 0)
    expect(total).toBe(12)
  })

  it('dispose 幂等（无句柄可释放）', () => {
    const dir = tempDir()
    const sink = createJsonlSink({ logsDir: dir })
    expect(() => {
      sink.dispose()
      sink.dispose()
    }).not.toThrow()
    expect(sink.write({ level: 'info', name: 'rsi-agent', msg: 'after-dispose' })).toBe(true)
  })

  it('resolveMaxBytes：显式 > 环境变量 > 默认', () => {
    expect(resolveMaxBytes(1024, {})).toBe(1024)
    expect(resolveMaxBytes(undefined, { DSH_RSI_LOG_MAX_BYTES: '2048' })).toBe(2048)
    expect(resolveMaxBytes(undefined, {})).toBe(DEFAULT_LOG_MAX_BYTES)
  })
})

describe('exporter · 权限（验收 3）', () => {
  it('目录 700、文件 600', () => {
    const root = tempDir()
    const dir = join(root, 'logs')
    const sink = createJsonlSink({ logsDir: dir })
    sink.write({ level: 'info', name: 'rsi-agent', msg: 'perm' })

    expect(statSync(dir).mode & 0o777).toBe(0o700)
    const file = sink.filePathFor(new Date().toISOString().slice(0, 10))
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('目录已存在且权限过宽 → 创建时收紧为 700', () => {
    const root = tempDir()
    const dir = join(root, 'logs')
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    chmodSync(dir, 0o755)
    createJsonlSink({ logsDir: dir })
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})

describe('exporter · 失败降级（验收 4）', () => {
  it('logsDir 不可用（是普通文件）时 write 返回 false 且不抛错', () => {
    const root = tempDir()
    const notADir = join(root, 'not-a-dir')
    writeFileSync(notADir, 'x')
    const sink = createJsonlSink({ logsDir: notADir })
    expect(() => sink.write({ level: 'info', name: 'rsi-agent', msg: 'x' })).not.toThrow()
    expect(sink.write({ level: 'info', name: 'rsi-agent', msg: 'x' })).toBe(false)
    expect(sink.degraded).toBe(true)
  })

  it('门面在写盘失败时对业务不抛错', () => {
    const root = tempDir()
    const notADir = join(root, 'blocked')
    writeFileSync(notADir, 'x')
    const { logger } = createLogging({ scope: 'rsi-agent', logsDir: notADir })
    expect(() => logger.info('业务日志', { a: 1 })).not.toThrow()
    expect(() => logger.error('业务错误')).not.toThrow()
  })
})

describe('exporter · 命名空间白名单（验收 7）', () => {
  it('非 rsi 命名空间不落盘且返回 false', () => {
    const dir = tempDir()
    const sink = createJsonlSink({ logsDir: dir })
    expect(sink.write({ level: 'info', name: 'dsh-core', msg: 'core' })).toBe(false)
    expect(sink.write({ level: 'info', name: 'skill-filesystem', msg: 'skill' })).toBe(false)
    expect(sink.write({ level: 'info', name: 'rsi-agent:scheduler', msg: 'ours' })).toBe(true)
    expect(sink.write({ level: 'info', name: 'rsi:child', msg: 'ours2' })).toBe(true)

    const file = sink.filePathFor(new Date().toISOString().slice(0, 10))
    const content = readFileSync(file, 'utf8')
    expect(content).not.toContain('core')
    expect(content).not.toContain('skill-filesystem')
    expect(content).toContain('rsi-agent:scheduler')
  })
})

describe('retention · 过期清理（验收 6）', () => {
  it('40 天前文件被清理，保留期内文件留存', () => {
    const dir = tempDir()
    const now = Date.UTC(2026, 2, 1)
    for (const name of ['2026-01-01.jsonl', '2026-02-20.jsonl', '2026-02-20-1.jsonl', 'notes.txt']) {
      writeFileSync(join(dir, name), 'x')
    }
    const result = cleanupExpiredLogs(dir, 30, { now })
    expect(result.deleted.map((p) => p.split('/').pop())).toEqual(['2026-01-01.jsonl'])
    expect(existsSync(join(dir, '2026-01-01.jsonl'))).toBe(false)
    expect(existsSync(join(dir, '2026-02-20.jsonl'))).toBe(true)
    expect(existsSync(join(dir, '2026-02-20-1.jsonl'))).toBe(true)
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
  })

  it('保留天数解析：显式 > 环境变量 > 默认 30', () => {
    expect(resolveRetentionDays(7, { DSH_RSI_LOG_RETENTION_DAYS: '3' })).toBe(7)
    expect(resolveRetentionDays(undefined, { DSH_RSI_LOG_RETENTION_DAYS: '3' })).toBe(3)
    expect(resolveRetentionDays(undefined, {})).toBe(30)
    expect(resolveRetentionDays(0, { DSH_RSI_LOG_RETENTION_DAYS: 'bad' })).toBe(30)
  })

  it('sink 创建时执行一次清理', () => {
    const dir = tempDir()
    const now = Date.UTC(2026, 2, 1)
    writeFileSync(join(dir, '2026-01-01.jsonl'), 'old')
    createJsonlSink({ logsDir: dir, now: () => now, retentionDays: 30 })
    expect(existsSync(join(dir, '2026-01-01.jsonl'))).toBe(false)
  })

  it('isDatedLogFileName 只认日 / 滚动命名', () => {
    expect(isDatedLogFileName('2026-01-10.jsonl')).toBe(true)
    expect(isDatedLogFileName('2026-01-10-2.jsonl')).toBe(true)
    expect(isDatedLogFileName('tasks.log')).toBe(false)
    expect(isDatedLogFileName('2026-13-40.jsonl')).toBe(false)
  })

  it('目录不存在 / 非目录 → 无操作不抛错', () => {
    expect(() => cleanupExpiredLogs(join(tempDir(), 'missing'), 30)).not.toThrow()
    expect(cleanupExpiredLogs('', 30)).toEqual({ deleted: [], scanned: 0 })
  })

  it('清理跨天最多一次（同一天第二次写盘不重复扫描）', () => {
    const dir = tempDir()
    const now = Date.UTC(2026, 2, 1)
    const sink = createJsonlSink({ logsDir: dir, now: () => now })
    sink.write({ level: 'info', name: 'rsi-agent', msg: 'a' })
    // 写入过程中新出现的旧文件不会被同日第二次扫描删除（每天最多一次）。
    writeFileSync(join(dir, '2020-01-01.jsonl'), 'old')
    sink.write({ level: 'info', name: 'rsi-agent', msg: 'b' })
    expect(existsSync(join(dir, '2020-01-01.jsonl'))).toBe(true)
  })
})

describe('门面 · createLogging 与 runtime 接线', () => {
  it('原生 logger 与文件同时收到（native 带 scope 前缀）', () => {
    const dir = tempDir()
    const { calls, logger: native } = memoryLogger()
    const { logger } = createLogging({ scope: 'rsi-agent', logsDir: dir, native })

    logger.info('hello', { taskId: 't1' })
    expect(calls).toHaveLength(1)
    expect(calls[0].message).toBe('[rsi-agent] hello')
    expect(calls[0].meta).toMatchObject({ taskId: 't1' })

    const file = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`)
    const record = JSON.parse(readFileSync(file, 'utf8').trim()) as Record<string, unknown>
    expect(record.msg).toBe('hello')
    expect((record.meta as Record<string, unknown>).taskId).toBe('t1')
  })

  it('child(scope) 生成 rsi-agent:xxx 命名空间（命中白名单）', () => {
    const dir = tempDir()
    const { logger: native } = memoryLogger()
    const { logger } = createLogging({ scope: 'rsi-agent', logsDir: dir, native })
    const child = logger.child('scheduler')
    child.warn('child-line')
    const file = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`)
    const record = JSON.parse(readFileSync(file, 'utf8').trim()) as Record<string, unknown>
    expect(record.name).toBe('rsi-agent:scheduler')
    expect(record.level).toBe('warn')
  })

  it('级别阈值只过滤文件；原生 logger 保持全量（向后兼容）', () => {
    const dir = tempDir()
    const { calls, logger: native } = memoryLogger()
    const { logger } = createLogging({ scope: 'rsi-agent', logsDir: dir, native, level: 'info' })
    logger.debug('debug-line')
    logger.info('info-line')
    expect(calls.map((c) => c.level)).toEqual(['debug', 'info'])
    const file = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`)
    const records = readRecords(dir, file.split('/').pop() as string)
    expect(records.map((r) => r.msg)).toEqual(['info-line'])
  })

  it('createDomainRuntime 构造的门面写盘到 <home>/<domain>/logs', () => {
    const root = tempDir()
    const pack: RuntimePack = { id: 'demo', version: '1.0.0', defaultSessionId: 'demo-session' }
    const { logger: native } = memoryLogger()
    const runtime = createDomainRuntime(pack, {
      installOptions: { home: root },
      nativeLogger: native,
    })
    runtime.logger.info('runtime token=xyz')
    expect(typeof runtime.logger.child).toBe('function')

    const file = join(runtime.logsDir, `${new Date().toISOString().slice(0, 10)}.jsonl`)
    const content = readFileSync(file, 'utf8')
    expect(content).toContain(REDACTED)
    expect(content).not.toContain('xyz')
    expect((JSON.parse(content.trim()) as Record<string, unknown>).name).toBe('rsi-agent')
  })

  it('pack.logging 的 level / secretKeys 透传到 sink', () => {
    const root = tempDir()
    const { logger: native } = memoryLogger()
    const pack: RuntimePack = {
      id: 'demo',
      version: '1.0.0',
      defaultSessionId: 'demo-session',
      logging: { level: 'warn', secretKeys: ['nickname'] },
    }
    const runtime = createDomainRuntime(pack, {
      installOptions: { home: root },
      nativeLogger: native,
    })
    runtime.logger.info('nickname=reach info-line')
    runtime.logger.warn('nickname=reach warn-line')

    const file = join(runtime.logsDir, `${new Date().toISOString().slice(0, 10)}.jsonl`)
    const content = readFileSync(file, 'utf8')
    expect(content).not.toContain('reach')
    expect(content).not.toContain('info-line')
    expect(content).toContain('warn-line')
  })

  it('createDomainLogger 保持旧行为：不写文件、转发原生 logger', () => {
    const { calls, logger: native } = memoryLogger()
    const logger = createDomainLogger(native, 'agentHost')
    logger.warn('legacy', { a: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0].message).toBe('[agentHost] legacy')
    expect(calls[0].meta).toMatchObject({ a: 1 })
  })
})

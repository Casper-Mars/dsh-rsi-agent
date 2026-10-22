/**
 * Task-12 独立复验用例（Tester 自写，不复用开发者断言）。
 *
 * 覆盖：脱敏（文本/深层/数组/Error）、跨天切分、权限、只读降级、
 * trace 进程内/跨进程、保留策略、命名空间白名单、滚动、fail-closed、
 * 长文本截断、JSONL 完整性、dispose 行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlSink } from '../src/log/exporter.js'
import { createLogging } from '../src/log/index.js'
import {
  CIRCULAR_MARKER,
  REDACTED,
  TRUNCATED_SUFFIX,
  redactRecord,
  redactText,
} from '../src/log/redact.js'
import { cleanupExpiredLogs, isDatedLogFileName } from '../src/log/retention.js'
import { currentTrace, runWithTrace, traceFromEnv } from '../src/log/trace.js'
import { createNodeExecStrategy } from '../src/scheduler/runner.js'

const DAY = 86_400_000
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task12-verify-'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function logsDir(): string {
  return join(root, 'logs')
}

function lines(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((x) => x !== '')
}

function readJsonl(path: string): Record<string, unknown>[] {
  return lines(path).map((line) => JSON.parse(line) as Record<string, unknown>)
}

function fixedNow(iso: string): () => number {
  const ms = Date.parse(iso)
  return () => ms
}

// ---------------------------------------------------------------------------
// 1. 脱敏
// ---------------------------------------------------------------------------
describe('1. 脱敏（msg 文本级 + meta 深层 + 数组 + 各类凭证键）', () => {
  it('msg 含 token=abc 落盘后无明文', async () => {
    const { logger, sink } = createLogging({
      logsDir: logsDir(),
      now: fixedNow('2026-06-01T00:00:00Z'),
      env: {},
    })
    logger.info('call api token=abc123XYZ done')
    sink?.dispose()
    const raw = readFileSync(join(logsDir(), '2026-06-01.jsonl'), 'utf8')
    expect(raw).toContain(REDACTED)
    expect(raw.includes('abc123XYZ')).toBe(false)
    expect(JSON.parse(raw.trim()).msg).toContain(REDACTED)
  })

  it('meta 深层 / 嵌套数组 / authorization / password / apiKey 全部遮蔽', async () => {
    const { logger } = createLogging({
      logsDir: logsDir(),
      now: fixedNow('2026-06-02T00:00:00Z'),
      env: {},
    })
    logger.info('deep meta', {
      token: 'abc',
      nested: { authorization: 'Bearer x', password: 'p@ss', apiKey: 'k-123' },
      arr: [{ accessKey: 'ak-1' }, 'Bearer abcdefghijklmn'],
      ok: 'visible-value',
    })
    const [row] = readJsonl(join(logsDir(), '2026-06-02.jsonl'))
    const meta = row.meta as Record<string, any>
    expect(meta.token).toBe(REDACTED)
    expect(meta.nested.authorization).toBe(REDACTED)
    expect(meta.nested.password).toBe(REDACTED)
    expect(meta.nested.apiKey).toBe(REDACTED)
    expect(meta.arr[0].accessKey).toBe(REDACTED)
    expect(meta.arr[1]).toBe(REDACTED)
    expect(meta.ok).toBe('visible-value')
    const raw = readFileSync(join(logsDir(), '2026-06-02.jsonl'), 'utf8')
    expect(raw).not.toContain('p@ss')
    expect(raw).not.toContain('k-123')
    expect(raw).not.toContain('Bearer x')
    expect(raw).not.toContain('abcdefghijklmn')
  })
})

// ---------------------------------------------------------------------------
// 2. 跨天（UTC 边界）
// ---------------------------------------------------------------------------
describe('2. 跨天写入生成两个日文件', () => {
  it('23:59:59.999Z → 00:00:00.000Z', () => {
    let now = Date.parse('2026-03-10T23:59:59.999Z')
    const sink = createJsonlSink({ logsDir: logsDir(), now: () => now, env: {} })
    sink.write({ level: 'info', name: 'rsi-agent', msg: 'before-midnight' })
    now = Date.parse('2026-03-11T00:00:00.000Z')
    sink.write({ level: 'info', name: 'rsi-agent', msg: 'after-midnight' })

    const files = readdirSync(logsDir()).filter((f) => f.endsWith('.jsonl')).sort()
    expect(files).toEqual(['2026-03-10.jsonl', '2026-03-11.jsonl'])
    console.log('[evidence] cross-day files =', files.join(', '))
    expect(readJsonl(join(logsDir(), '2026-03-10.jsonl'))[0].msg).toBe('before-midnight')
    expect(readJsonl(join(logsDir(), '2026-03-11.jsonl'))[0].msg).toBe('after-midnight')
  })
})

// ---------------------------------------------------------------------------
// 4. 只读目录降级（放前面，模块级 warnedDegraded 需新鲜实例）
// ---------------------------------------------------------------------------
describe('4. 日志目录只读 → 业务不抛错且只 warn 一次', () => {
  it('chmod 500 后 info 不抛，恢复后继续写', async () => {
    vi.resetModules()
    const fresh = await import('../src/log/index.js')
    const dir = logsDir()
    // 目录只读时「追加到已存在文件」不需要目录写权限（POSIX），故用「跨天新建文件」
    // 触发真实的 EACCES，这才是目录只读的实际故障路径。
    let day = Date.parse('2026-07-01T00:00:00Z')
    const { logger, sink } = fresh.createLogging({
      logsDir: dir,
      now: () => day,
      env: {},
    })
    logger.info('first-ok')
    const path = join(dir, '2026-07-01.jsonl')
    expect(lines(path)).toHaveLength(1)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    chmodSync(dir, 0o500)
    try {
      day = Date.parse('2026-07-02T00:00:00Z')
      expect(() => logger.info('while-readonly-1')).not.toThrow()
      day = Date.parse('2026-07-03T00:00:00Z')
      expect(() => logger.error('while-readonly-2')).not.toThrow()
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(sink?.degraded).toBe(true)
    expect(existsSync(join(dir, '2026-07-02.jsonl'))).toBe(false)

    // 恢复权限后继续写
    day = Date.parse('2026-07-02T00:00:00Z')
    expect(() => logger.info('after-restore')).not.toThrow()
    expect(readJsonl(path).map((r) => r.msg)).toEqual(['first-ok'])
    expect(readJsonl(join(dir, '2026-07-02.jsonl')).map((r) => r.msg)).toEqual(['after-restore'])
  })
})

// ---------------------------------------------------------------------------
// 3. 权限位
// ---------------------------------------------------------------------------
describe('3. 目录 700 / 文件 600（umask 022）', () => {
  it('umask=022 下仍为 700/600', () => {
    const previous = process.umask(0o022)
    try {
      const sink = createJsonlSink({
        logsDir: logsDir(),
        now: fixedNow('2026-04-01T00:00:00Z'),
        env: {},
      })
      expect(sink.write({ level: 'info', name: 'rsi-agent', msg: 'perm' })).toBe(true)
      const dirMode = statSync(logsDir()).mode & 0o777
      const fileMode = statSync(join(logsDir(), '2026-04-01.jsonl')).mode & 0o777
      expect(dirMode).toBe(0o700)
      expect(fileMode).toBe(0o600)
      console.log('[evidence] dir mode =', dirMode.toString(8), 'file mode =', fileMode.toString(8), 'umask=022')
    } finally {
      process.umask(previous)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. trace
// ---------------------------------------------------------------------------
describe('5. trace 关联', () => {
  it('同一 trace 内多条日志 traceId 相同；不同 trace 不同', async () => {
    const sink = createJsonlSink({ logsDir: logsDir(), now: fixedNow('2026-08-01T00:00:00Z'), env: {} })
    const { logger } = createLogging({ sink, now: fixedNow('2026-08-01T00:00:00Z'), env: {} })

    await runWithTrace({ traceId: 'trace-A', taskId: 't1' }, async () => {
      logger.info('a1')
      await new Promise((r) => setTimeout(r, 5))
      logger.warn('a2')
      logger.child('scheduler').info('a3')
    })
    await runWithTrace({ traceId: 'trace-B' }, async () => {
      logger.info('b1')
    })

    const rows = readJsonl(join(logsDir(), '2026-08-01.jsonl'))
    const traces = rows.map((r) => (r.trace as any)?.traceId)
    expect(traces).toEqual(['trace-A', 'trace-A', 'trace-A', 'trace-B'])
    expect(rows[0].name).toBe('rsi-agent')
    expect(rows[2].name).toBe('rsi-agent:scheduler')
    // meta 同样带 traceId（可检索）
    expect((rows[0].meta as any).traceId).toBe('trace-A')
  })

  it('真实 spawn 子进程继承同一 traceId', async () => {
    const script = join(root, 'task.mjs')
    const traceMod = new URL('../src/log/trace.ts', import.meta.url).href
    writeFileSync(
      script,
      [
        `import { traceFromEnv } from ${JSON.stringify(traceMod)}`,
        `console.log(JSON.stringify({ env: traceFromEnv(process.env) }))`,
        `console.log(JSON.stringify({ shouldWake: false }))`,
      ].join('\n'),
    )

    const strategy = createNodeExecStrategy()
    const seen: unknown[] = []
    await runWithTrace({ traceId: 'trace-child-42', taskId: 'task-9', sessionId: 'sess-7' }, async () => {
      expect(currentTrace()?.traceId).toBe('trace-child-42')
      const result = await strategy.exec({
        taskPath: script,
        cwd: root,
        timeoutMs: 15_000,
        maxStdoutBytes: 65_536,
        maxStderrBytes: 65_536,
      })
      seen.push(result.stdout.trim().split('\n')[0])
      expect(result.exitCode, result.stderr).toBe(0)
    })

    const echoed = JSON.parse(String(seen[0])) as {
      env: { traceId: string; taskId?: string; sessionId?: string }
    }
    expect(echoed.env.traceId).toBe('trace-child-42')
    expect(echoed.env.taskId).toBe('task-9')
    expect(echoed.env.sessionId).toBe('sess-7')
    expect(traceFromEnv({ DSH_RSI_TRACE_ID: '' } as NodeJS.ProcessEnv)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 6. 保留策略
// ---------------------------------------------------------------------------
describe('6. 保留策略清理', () => {
  it('40 天前删除，保留期内保留，非日期文件不动', () => {
    const dir = logsDir()
    mkdirSync(dir, { recursive: true })
    const now = Date.parse('2026-10-22T12:00:00Z')
    const iso = (offset: number) => new Date(now - offset * DAY).toISOString().slice(0, 10)
    const old = `${iso(40)}.jsonl`
    const oldRoll = `${iso(41)}-3.jsonl`
    const recent = `${iso(10)}.jsonl`
    const today = `${iso(0)}.jsonl`
    for (const name of [old, oldRoll, recent, today, 'notes.txt', '2026-13-40.jsonl', 'backup.jsonl']) {
      writeFileSync(join(dir, name), '{}\n')
    }
    mkdirSync(join(dir, `${iso(50)}.jsonl`), { recursive: true })

    const result = cleanupExpiredLogs(dir, 30, { now, env: {} })
    const remaining = readdirSync(dir).sort()

    expect(remaining).not.toContain(old)
    expect(remaining).not.toContain(oldRoll)
    expect(remaining).toContain(recent)
    expect(remaining).toContain(today)
    expect(remaining).toContain('notes.txt')
    expect(remaining).toContain('2026-13-40.jsonl')
    expect(remaining).toContain('backup.jsonl')
    // 目录不得被当文件删除
    expect(statSync(join(dir, `${iso(50)}.jsonl`)).isDirectory()).toBe(true)
    expect(result.deleted.map((p) => p.split('/').pop()).sort()).toEqual([oldRoll, old].sort())
    console.log('[evidence] deleted =', result.deleted.map((p) => p.split('/').pop()).join(', '), '| remaining =', remaining.join(', '))
  })

  it('sink 每个 UTC 日最多清理一次', () => {
    let now = Date.parse('2026-09-20T08:00:00Z')
    const dir = logsDir()
    const sink = createJsonlSink({ logsDir: dir, now: () => now, retentionDays: 30, env: {} })
    sink.write({ level: 'info', name: 'rsi-agent', msg: 'day1' })

    // 同日内新增一个 60 天前的过期文件：当天不应再扫描
    const stale = join(dir, '2026-01-01.jsonl')
    writeFileSync(stale, '{}\n')
    sink.write({ level: 'info', name: 'rsi-agent', msg: 'day1b' })
    expect(existsSync(stale)).toBe(true)

    // 次日首次写入触发一次清理
    now += DAY
    sink.write({ level: 'info', name: 'rsi-agent', msg: 'day2' })
    expect(existsSync(stale)).toBe(false)
  })

  it('非日志日期命名判定', () => {
    expect(isDatedLogFileName('2026-01-02.jsonl')).toBe(true)
    expect(isDatedLogFileName('2026-01-02-7.jsonl')).toBe(true)
    expect(isDatedLogFileName('2026-1-2.jsonl')).toBe(false)
    expect(isDatedLogFileName('2026-01-02.log')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. 命名空间白名单
// ---------------------------------------------------------------------------
describe('7. 命名空间白名单', () => {
  it('非 rsi 命名空间不落盘；rsi-agent / rsi-agent:* / rsi:* 落盘', () => {
    const dir = logsDir()
    const sink = createJsonlSink({ logsDir: dir, now: fixedNow('2026-02-02T00:00:00Z'), env: {} })
    expect(sink.write({ level: 'info', name: 'dsh-core', msg: 'x' })).toBe(false)
    expect(sink.write({ level: 'info', name: 'skill-filesystem', msg: 'x' })).toBe(false)
    expect(sink.write({ level: 'info', name: 'rsi-agent-other', msg: 'x' })).toBe(false)
    expect(existsSync(dir)).toBe(false)

    expect(sink.write({ level: 'info', name: 'rsi-agent', msg: 'a' })).toBe(true)
    expect(sink.write({ level: 'info', name: 'rsi-agent:scheduler', msg: 'b' })).toBe(true)
    expect(sink.write({ level: 'info', name: 'rsi:child', msg: 'c' })).toBe(true)
    const rows = readJsonl(join(dir, '2026-02-02.jsonl'))
    expect(rows.map((r) => r.name)).toEqual(['rsi-agent', 'rsi-agent:scheduler', 'rsi:child'])
    console.log('[evidence] namespaces accepted =', rows.map((r) => r.name).join(', '), '| files =', readdirSync(dir).join(','))
  })
})

// ---------------------------------------------------------------------------
// 对抗：滚动
// ---------------------------------------------------------------------------
describe('对抗：小阈值滚动选择 -1 / -2', () => {
  it('已存在 -1 且未达阈值 → 继续写 -1；达阈值 → 新建 -2', () => {
    const dir = logsDir()
    mkdirSync(dir, { recursive: true })
    const date = '2026-05-01'
    const base = join(dir, `${date}.jsonl`)
    const part1 = join(dir, `${date}-1.jsonl`)
    writeFileSync(base, 'x'.repeat(1200))
    writeFileSync(part1, 'y'.repeat(100))

    const sink = createJsonlSink({ logsDir: dir, maxBytes: 1024, now: fixedNow(`${date}T00:00:00Z`), env: {} })
    expect(sink.filePathFor(date)).toBe(part1)

    sink.write({ level: 'info', name: 'rsi-agent', msg: 'goes-to-1' })
    expect(lines(part1).some((l) => l.includes('goes-to-1'))).toBe(true)
    expect(existsSync(join(dir, `${date}-2.jsonl`))).toBe(false)

    // 填满 -1 至阈值
    writeFileSync(part1, 'z'.repeat(1100))
    expect(sink.filePathFor(date)).toBe(join(dir, `${date}-2.jsonl`))
    sink.write({ level: 'info', name: 'rsi-agent', msg: 'goes-to-2' })
    expect(lines(join(dir, `${date}-2.jsonl`)).some((l) => l.includes('goes-to-2'))).toBe(true)
    console.log('[evidence] rotation files =', readdirSync(dir).sort().join(', '), '| sizes =', readdirSync(dir).sort().map((f) => `${f}:${statSync(join(dir, f)).size}`).join(' '))
  })
})

// ---------------------------------------------------------------------------
// 对抗：fail-closed 脱敏
// ---------------------------------------------------------------------------
describe('对抗：fail-closed 脱敏', () => {
  it('Proxy getter 抛错 → 不抛、字段 [REDACTED]', () => {
    const nasty = new Proxy(
      { token: 'abc', plain: 'plain-value' },
      {
        get() {
          throw new Error('boom-get')
        },
        getOwnPropertyDescriptor() {
          return { enumerable: true, configurable: true, value: 1 }
        },
        ownKeys() {
          return ['token', 'plain']
        },
      },
    )
    let out: Record<string, unknown> | undefined
    expect(() => {
      out = redactRecord({ level: 'info', meta: nasty })
    }).not.toThrow()
    const meta = out?.meta as Record<string, unknown>
    expect(meta.token).toBe(REDACTED)
    expect(meta.plain).toBe(REDACTED)
    expect(JSON.stringify(out)).not.toContain('plain-value')
  })

  it('循环引用 → 明确标记而非崩溃', () => {
    const a: Record<string, unknown> = { token: 'abc', name: 'node' }
    a.self = a
    a.list = [a]
    let out: any
    expect(() => {
      out = redactRecord({ meta: a })
    }).not.toThrow()
    expect(out.meta.self).toBe(CIRCULAR_MARKER)
    expect(out.meta.list[0]).toBe(CIRCULAR_MARKER)
    expect(JSON.stringify(out)).not.toContain('"abc"')
  })

  it('嵌套 Proxy ownKeys 抛错 → 不抛、值被遮蔽', () => {
    const evil = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom-keys')
        },
        get() {
          throw new Error('boom-get')
        },
      },
    )
    let out: any
    expect(() => {
      out = redactRecord({ meta: { inner: evil } })
    }).not.toThrow()
    expect(out.meta.inner).toBe(REDACTED)
  })

  it('Symbol 描述中的敏感文本（对抗探测）', () => {
    const out = redactRecord({ meta: { s: Symbol('token=abc') } })
    console.log('[probe] symbol =>', JSON.stringify(out.meta))
  })

  it('BigInt / Symbol / Error 子类 / Map / Set 不抛', () => {
    class AuthError extends Error {
      code = 'E_AUTH'
      token = 'secret-token-value'
    }
    const err = new AuthError('bad token=abc failed')
    const input = {
      meta: {
        big: 9007199254740993n,
        sym: Symbol('sym-token'),
        err,
        map: new Map([['password', 'p@ss'], ['ok', 1]]),
        set: new Set([1, 2]),
        fn: () => 1,
      },
    }
    let out: any
    expect(() => {
      out = redactRecord(input)
    }).not.toThrow()
    expect(out.meta.big).toBe('9007199254740993')
    expect(out.meta.err.name).toBe('Error')
    expect(out.meta.err.message).toContain(REDACTED)
    expect(out.meta.err.details.token).toBe(REDACTED)
    expect(out.meta.map.password).toBe(REDACTED)
    expect(out.meta.map.ok).toBe(1)
    expect(out.meta.set).toEqual([1, 2])
    expect(out.meta.fn).toBe('[Function]')
    const text = JSON.stringify(out)
    expect(text).not.toContain('secret-token-value')
    expect(text).not.toContain('p@ss')
  })
})

// ---------------------------------------------------------------------------
// 对抗：长文本截断
// ---------------------------------------------------------------------------
describe('对抗：长文本截断（2000 边界 / UTF-8）', () => {
  const hasLoneSurrogate = (s: string) =>
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

  it('1999 / 2000 不截断，2001 截断', () => {
    expect(redactText('a'.repeat(1999))).toHaveLength(1999)
    expect(redactText('a'.repeat(2000))).toHaveLength(2000)
    const cut = redactText('a'.repeat(2001))
    expect(cut.endsWith(TRUNCATED_SUFFIX)).toBe(true)
    expect(cut).toHaveLength(2000 + TRUNCATED_SUFFIX.length)
  })

  it('中文 / emoji 在边界处不被切坏', () => {
    const zh = '中'.repeat(2001)
    const outZh = redactText(zh)
    expect(outZh.endsWith(TRUNCATED_SUFFIX)).toBe(true)
    expect(hasLoneSurrogate(outZh)).toBe(false)

    const emoji = 'a'.repeat(1999) + '😀' + 'tail'
    const outEmoji = redactText(emoji)
    // 落盘侧证据：孤立代理对会被 JSON.stringify 成 \ud83d
    const sink = createJsonlSink({ logsDir: logsDir(), maxBytes: 0, now: fixedNow('2026-10-09T00:00:00Z'), env: {} })
    sink.write({ level: 'info', name: 'rsi-agent', msg: emoji })
    const raw = readFileSync(join(logsDir(), '2026-10-09.jsonl'), 'utf8')
    console.log('[probe] emoji tail =>', JSON.stringify(raw.slice(-40)))
    expect(hasLoneSurrogate(outEmoji)).toBe(false)
    expect(outEmoji.endsWith(TRUNCATED_SUFFIX)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 对抗：Error 折叠
// ---------------------------------------------------------------------------
describe('对抗：Error 折叠', () => {
  it('只留 message + 栈前 10 行，栈内 token 被脱敏', () => {
    const err = new Error('failed token=super-secret-123')
    err.stack = [
      'Error: failed token=super-secret-123',
      ...Array.from({ length: 20 }, (_, i) => `    at frame${i} (file.ts:${i}:1)`),
    ].join('\n')
    const out = redactRecord({ err })
    const folded = out.err as Record<string, any>
    expect(Object.keys(folded).sort()).toEqual(['message', 'name', 'stack'])
    expect(folded.message).toContain(REDACTED)
    expect(String(folded.stack).split('\n')).toHaveLength(10)
    expect(String(folded.stack)).not.toContain('super-secret-123')
  })
})

// ---------------------------------------------------------------------------
// 对抗：JSONL 完整性
// ---------------------------------------------------------------------------
describe('对抗：JSONL 完整性（1000 条）', () => {
  it('每行合法 JSON 且含 ts/level/name/msg/pid', () => {
    const dir = logsDir()
    const sink = createJsonlSink({ logsDir: dir, maxBytes: 0, now: fixedNow('2026-11-11T00:00:00Z'), env: {} })
    for (let i = 0; i < 1000; i += 1) {
      const ok = sink.write({
        level: i % 2 === 0 ? 'info' : 'warn',
        name: 'rsi-agent',
        msg: `entry-${i} 中文😀 "quoted" \\ slash`,
        meta: { i, nested: { a: [i] } },
      })
      expect(ok).toBe(true)
    }
    const raw = readFileSync(join(dir, '2026-11-11.jsonl'), 'utf8')
    const rows = raw.split('\n').filter((x) => x !== '')
    expect(rows).toHaveLength(1000)
    rows.forEach((line, index) => {
      const row = JSON.parse(line) as Record<string, unknown>
      expect(row.ts).toBe('2026-11-11T00:00:00.000Z')
      expect(row.level).toBe(index % 2 === 0 ? 'info' : 'warn')
      expect(row.name).toBe('rsi-agent')
      expect(row.msg).toBe(`entry-${index} 中文😀 "quoted" \\ slash`)
      expect(row.pid).toBe(process.pid)
    })
  })

  it('并发写入（Promise.all）仍逐行合法', async () => {
    const dir = logsDir()
    const sink = createJsonlSink({ logsDir: dir, maxBytes: 0, now: fixedNow('2026-11-12T00:00:00Z'), env: {} })
    await Promise.all(
      Array.from({ length: 200 }, async (_, i) => {
        await new Promise((r) => setTimeout(r, i % 5))
        sink.write({ level: 'info', name: 'rsi-agent', msg: `c-${i}` })
      }),
    )
    const rows = readJsonl(join(dir, '2026-11-12.jsonl'))
    expect(rows).toHaveLength(200)
    expect(rows.every((r) => typeof r.msg === 'string' && typeof r.pid === 'number')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 对抗：dispose 后写入
// ---------------------------------------------------------------------------
describe('对抗：dispose 后行为确定', () => {
  it('dispose() 后写入不抛错且行为确定', () => {
    const sink = createJsonlSink({ logsDir: logsDir(), now: fixedNow('2026-12-01T00:00:00Z'), env: {} })
    sink.write({ level: 'info', name: 'rsi-agent', msg: 'before' })
    expect(() => sink.dispose()).not.toThrow()
    let first: boolean | undefined
    expect(() => {
      first = sink.write({ level: 'info', name: 'rsi-agent', msg: 'after' })
    }).not.toThrow()
    // 当前实现：dispose 无副作用 → 继续写入（确定性行为，非静默丢弃）
    expect(first).toBe(true)
    expect(lines(join(logsDir(), '2026-12-01.jsonl')).map((l) => JSON.parse(l).msg)).toEqual([
      'before',
      'after',
    ])
    expect(() => sink.dispose()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 级别过滤（补充）
// ---------------------------------------------------------------------------
describe('补充：级别阈值', () => {
  it('阈值 info 拦 debug，保留 error/warn/info', () => {
    const { logger } = createLogging({
      logsDir: logsDir(),
      level: 'info',
      now: fixedNow('2026-07-07T00:00:00Z'),
      env: {},
    })
    logger.debug('dbg')
    logger.info('inf')
    logger.warn('wrn')
    logger.error('err')
    const msgs = readJsonl(join(logsDir(), '2026-07-07.jsonl')).map((r) => r.msg)
    expect(msgs).toEqual(['inf', 'wrn', 'err'])
  })

  it('非法 level 环境变量回落 info', () => {
    const { logger } = createLogging({
      logsDir: logsDir(),
      env: { DSH_RSI_LOG_LEVEL: 'loud' } as NodeJS.ProcessEnv,
      now: fixedNow('2026-07-08T00:00:00Z'),
    })
    logger.debug('dbg')
    logger.info('inf')
    expect(readJsonl(join(logsDir(), '2026-07-08.jsonl')).map((r) => r.msg)).toEqual(['inf'])
  })
})

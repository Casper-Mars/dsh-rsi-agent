/**
 * 日志保留 / 脱敏 / cron 的边界补充（Task-14 覆盖审计补齐）。
 *
 * 审计结论：`log-redact` / `zz-task12-*` / `scheduler-cron` 已相当完整，
 * 本文件按任务要求每条补 1–2 个**边界或反例**，不复述既有 happy path：
 *   1. retention：恰好落在 cutoff 的日文件保留、早 1ms 删除；非法日期文件名
 *      不参与清理；显式 0 天回落默认值（不是「删光」）；
 *   2. redact：空文本 / 纯空白不抛错；文本末尾的裸令牌也要遮蔽；
 *      空对象键不误判为敏感；
 *   3. cron：`*\/100` 步长大于范围时只命中起点；`7` 与 `0` 同为周日；
 *      `SUN-SAT` 区间合法；字段前导零合法；秒级 6 段仍拒绝。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_LOG_RETENTION_DAYS,
  cleanupExpiredLogs,
  resolveRetentionDays,
} from '../src/log/retention'
import { REDACTED, redactRecord, redactText } from '../src/log/redact'
import { next, parseCron } from '../src/scheduler/cron'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rsi-edge-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop() as string
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0)

describe('retention · cutoff 边界', () => {
  it('文件名日期恰好等于 cutoff → 保留；早一天 → 删除（>= cutoff 即保留）', () => {
    const dir = tempDir()
    // now = 2026-10-22T00:00Z，保留 1 天 ⇒ cutoff = 2026-10-21T00:00Z。
    // 10-21 的 UTC 00:00 恰好等于 cutoff（>= 成立）→ 保留；10-20 → 删除。
    writeFileSync(join(dir, '2026-10-20.jsonl'), '{}\n')
    writeFileSync(join(dir, '2026-10-21.jsonl'), '{}\n')

    const result = cleanupExpiredLogs(dir, 1, { now: Date.UTC(2026, 9, 22, 0, 0, 0) })
    expect(result.deleted.map((path) => path.split('/').pop())).toEqual(['2026-10-20.jsonl'])
  })

  it('滚动后缀（-1 / -2）与主文件同口径处理', () => {
    const dir = tempDir()
    writeFileSync(join(dir, '2026-10-20-1.jsonl'), '{}\n')
    writeFileSync(join(dir, '2026-10-20-2.jsonl'), '{}\n')
    writeFileSync(join(dir, '2026-10-21-1.jsonl'), '{}\n')

    const result = cleanupExpiredLogs(dir, 1, { now: Date.UTC(2026, 9, 22, 0, 0, 0) })
    expect(result.deleted).toHaveLength(2)
    expect(result.deleted.every((path) => path.includes('2026-10-20'))).toBe(true)
  })

  it('非法日期（2026-13-40）与非法命名不参与清理（scanned 不计入）', () => {
    const dir = tempDir()
    writeFileSync(join(dir, '2026-13-40.jsonl'), '{}\n')
    writeFileSync(join(dir, 'notes.jsonl'), '{}\n')

    const result = cleanupExpiredLogs(dir, 1, { now: NOW })
    expect(result.deleted).toEqual([])
    expect(result.scanned).toBe(0)
  })

  it('显式 0 天 / 负数 / NaN 一律回落默认值（不是删光）', () => {
    expect(resolveRetentionDays(0, {})).toBe(DEFAULT_LOG_RETENTION_DAYS)
    expect(resolveRetentionDays(-5, {})).toBe(DEFAULT_LOG_RETENTION_DAYS)
    expect(resolveRetentionDays(Number.NaN, {})).toBe(DEFAULT_LOG_RETENTION_DAYS)
  })

  it('环境变量为非法字符串时回落默认值；为 "1" 时生效', () => {
    expect(resolveRetentionDays(undefined, { DSH_RSI_LOG_RETENTION_DAYS: 'abc' })).toBe(
      DEFAULT_LOG_RETENTION_DAYS,
    )
    expect(resolveRetentionDays(undefined, { DSH_RSI_LOG_RETENTION_DAYS: '1' })).toBe(1)
  })

  it('logsDir 为空串 / 不存在 → 返回空结果且不抛错', () => {
    expect(cleanupExpiredLogs('', 30, { now: NOW })).toEqual({ deleted: [], scanned: 0 })
    expect(cleanupExpiredLogs(join(tempDir(), 'missing'), 30, { now: NOW })).toEqual({
      deleted: [],
      scanned: 0,
    })
  })
})

describe('redact · 边界与反例', () => {
  it('空字符串 / 纯空白 / 无敏感内容 → 原样返回', () => {
    expect(redactText('')).toBe('')
    expect(redactText('   ')).toBe('   ')
    expect(redactText('普通日志一行')).toBe('普通日志一行')
  })

  it('裸令牌位于文本末尾（无后续分隔符）也要遮蔽', () => {
    expect(redactText('token=abc')).toContain(REDACTED)
    expect(redactText('token=abc')).not.toContain('abc')
    expect(redactText('Bearer sk-live-1234567890')).not.toContain('sk-live-1234567890')
  })

  it('空键 / 普通键不被误判为敏感键', () => {
    const redacted = redactRecord({ '': 'plain', name: 'alice', token: 'secret' })
    expect(redacted['']).toBe('plain')
    expect(redacted.name).toBe('alice')
    expect(redacted.token).toBe(REDACTED)
  })

  it('数值型敏感值同样遮蔽（不因非字符串而放行）', () => {
    const redacted = redactRecord({ apiKey: 123456 })
    expect(redacted.apiKey).toBe(REDACTED)
  })
})

describe('cron · 边界与反例', () => {
  it('步长大于字段范围（*/100）→ 只命中起点 0', () => {
    const schedule = parseCron('*/100 * * * *')
    expect(schedule.minute.values).toEqual([0])
  })

  it('周字段 `7` 与 `0` 等价（都表示周日）', () => {
    expect(parseCron('0 0 * * 7').dayOfWeek.values).toEqual([0])
    expect(parseCron('0 0 * * 0').dayOfWeek.values).toEqual([0])
  })

  it('`SUN-SAT` 名称区间合法且命中 0..6', () => {
    expect(parseCron('0 0 * * SUN-SAT').dayOfWeek.values).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('前导零（`05`）按十进制解析', () => {
    expect(parseCron('05 09 * * *').minute.values).toEqual([5])
    expect(parseCron('05 09 * * *').hour.values).toEqual([9])
  })

  it('6 段（含秒）→ 拒绝（最小粒度是分钟）', () => {
    expect(() => parseCron('0 0 9 * * *')).toThrow(/5 段/)
  })

  it('日/周同时受限时从周六推进到「周日或 1 号」中更早者', () => {
    // 2026-10-24 是周六 00:00Z；`0 0 1 * 0` 表示「每月 1 号或每周日」。
    const from = new Date(Date.UTC(2026, 9, 24, 0, 0, 0))
    const result = next(parseCron('0 0 1 * 0'), from, 'UTC')
    // 下一个周日是 2026-10-25，早于 11-01。
    expect(result.toISOString()).toBe('2026-10-25T00:00:00.000Z')
  })
})

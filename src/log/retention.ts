/**
 * 日志保留策略（技术方案 §13.2「日志治理」）。
 *
 * 目标：避免 `logs/` 无限增长——按文件名里的**日期**判断过期，删除超过保留天数的
 * 日文件（含滚动后缀 `YYYY-MM-DD-1.jsonl`）。
 *
 * 口径：
 *   1. 默认保留 {@link DEFAULT_LOG_RETENTION_DAYS}（30）天，可用
 *      {@link LOG_RETENTION_DAYS_ENV}（`DSH_RSI_LOG_RETENTION_DAYS`）或显式参数覆盖；
 *      非正数 / 非法值一律回落默认值。
 *   2. **只处理本目录下的普通文件**，文件名必须匹配 `YYYY-MM-DD*.jsonl`
 *      （exporter 的按天 / 滚动命名）；不递归、不跟随符号链接。
 *   3. **过期判据用文件名日期（UTC 00:00）而非 mtime**：日志被复制 / 触碰后
 *      mtime 会变新，用 mtime 会漏删。
 *   4. **失败只吞**：任何单个文件删除 / 读取失败都不抛异常——日志设施自身不得
 *      影响主流程；返回已删除列表供测试 / 诊断使用。
 */

import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 环境变量：日志保留天数。 */
export const LOG_RETENTION_DAYS_ENV = 'DSH_RSI_LOG_RETENTION_DAYS'

/** 默认保留天数。 */
export const DEFAULT_LOG_RETENTION_DAYS = 30

/** 一天毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** exporter 的日文件名：`YYYY-MM-DD`，可选 `-N` 滚动后缀，扩展名 `.jsonl`。 */
const DATED_LOG_RX = /^(\d{4})-(\d{2})-(\d{2})(?:-\d+)?\.jsonl$/

/** {@link cleanupExpiredLogs} 结果。 */
export interface CleanupExpiredLogsResult {
  /** 已删除的文件绝对路径。 */
  readonly deleted: string[]
  /** 扫描到的候选文件数。 */
  readonly scanned: number
}

/** 保留天数解析：显式（> 0）> 环境变量（> 0）> 默认 30。 */
export function resolveRetentionDays(
  explicit?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit)
  }
  const raw = env[LOG_RETENTION_DAYS_ENV]
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return DEFAULT_LOG_RETENTION_DAYS
}

/** 文件名 → UTC 日期毫秒；非日文件 / 非法日期 → `undefined`。 */
function parseDatedFileMs(name: string): number | undefined {
  const match = DATED_LOG_RX.exec(name)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const ms = Date.UTC(year, month - 1, day)
  const date = new Date(ms)
  // 严格校验（`2026-13-40` 之类的非法日期不参与清理，交由人工排查）。
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined
  }
  return ms
}

/** {@link cleanupExpiredLogs} 的可选参数。 */
export interface CleanupExpiredLogsOptions {
  /** 当前时刻（epoch ms）；缺省 `Date.now()`，便于测试注入。 */
  readonly now?: number
  /** 环境变量来源（保留天数回落用），缺省 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv
}

/**
 * 清理过期日志（**不抛异常**）。
 *
 * @param logsDir       日志目录（不存在 / 非目录 → 无操作）。
 * @param retentionDays 保留天数；缺省取环境变量 / 30 天。
 * @param options       时钟注入等（见 {@link CleanupExpiredLogsOptions}）。
 * @returns 已删除文件列表与扫描数。
 */
export function cleanupExpiredLogs(
  logsDir: string,
  retentionDays?: number,
  options: CleanupExpiredLogsOptions = {},
): CleanupExpiredLogsResult {
  const deleted: string[] = []
  let scanned = 0

  if (typeof logsDir !== 'string' || logsDir.trim() === '') {
    return { deleted, scanned }
  }

  const days = resolveRetentionDays(retentionDays, options.env ?? process.env)
  const now =
    typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now()
  const cutoff = now - days * DAY_MS

  let entries: string[]
  try {
    entries = readdirSync(logsDir)
  } catch {
    return { deleted, scanned }
  }

  for (const name of entries) {
    const dated = parseDatedFileMs(name)
    if (dated === undefined) continue
    const path = join(logsDir, name)
    try {
      // 只删普通文件：目录 / 符号链接一律跳过（避免误删链接目标）。
      if (!statSync(path).isFile()) continue
    } catch {
      continue
    }
    scanned += 1
    if (dated >= cutoff) continue
    try {
      rmSync(path, { force: true })
      deleted.push(path)
    } catch {
      /* 删除失败只吞：清理不完整不影响写盘。 */
    }
  }

  return { deleted, scanned }
}

/** 判据辅助：是否为 exporter 的日 / 滚动日志文件名。 */
export function isDatedLogFileName(name: string): boolean {
  return typeof name === 'string' && parseDatedFileMs(name) !== undefined
}

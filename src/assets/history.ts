/**
 * 资产历史查询 —— 技术方案 §9.4（历史工具）、§19（命令注入风险）。
 *
 * 只读能力：`git log` 走参数化 `execFile` 家族（{@link GitRunner}），argv 逐项
 * 传参、从不经 shell，因此路径 / 分支名里的 `;`、`$()`、反引号都只是普通字符。
 *
 * 契约：
 *   1. `path` 必须落在领域声明的 `assetTypes[].prefix` 之下 —— 复用
 *      {@link validateAssetPaths}（与写入路径**同一份**白名单实现，不复制）；
 *   2. `limit` 缺省 {@link ASSET_HISTORY_DEFAULT_LIMIT}，上限
 *      {@link ASSET_HISTORY_MAX_LIMIT}，必须是正整数；非法值属于调用方错误，
 *      **抛 {@link AssetHistoryLimitError}**；
 *   3. git 故障（仓库缺失 / 命令失败 / 超时）**不抛**，返回
 *      `{ entries: [], degraded: true, reason }`；路径非法仍然抛（契约错误）。
 */
import type { AssetType } from '../types.js'
import { validateAssetPaths, type CommitAssetsLogger } from './commit.js'
import { runGit, type GitRunner } from './git.js'

/** `limit` 缺省值。 */
export const ASSET_HISTORY_DEFAULT_LIMIT = 20

/** `limit` 上限。 */
export const ASSET_HISTORY_MAX_LIMIT = 100

/** `git log --format` 的字段分隔符（US，正文里几乎不可能出现）。 */
const FIELD_SEP = '\x1f'

/** `git log --format` 的记录分隔符（RS）。 */
const RECORD_SEP = '\x1e'

/** 单条历史记录。 */
export interface AssetHistoryEntry {
  /** 完整提交 SHA（40 位小写十六进制）。 */
  sha: string
  /** 作者，形如 `dsh-rsi-agent <dsh-rsi-agent@localhost>`。 */
  author: string
  /** 作者时间，ISO 8601（`%aI`）。 */
  date: string
  /** 提交标题（`%s`，单行）。 */
  subject: string
}

/** `limit` 非法（调用方编程错误）。 */
export class AssetHistoryLimitError extends Error {
  /** 被拒绝的原始值。 */
  readonly value: unknown

  constructor(value: unknown) {
    super(
      `[assets] limit 非法：${JSON.stringify(value)}；` +
        `必须是 1..${ASSET_HISTORY_MAX_LIMIT} 之间的正整数（缺省 ${ASSET_HISTORY_DEFAULT_LIMIT}）`,
    )
    this.name = 'AssetHistoryLimitError'
    this.value = value
  }
}

/** {@link assetHistory} 需要的运行时最小面。 */
export interface AssetHistoryRuntime {
  /** 资产仓库根目录（`<home>/assets`）。 */
  assetsDir: string
  /** 运行时日志门面（可选，用于降级告警）。 */
  logger?: CommitAssetsLogger
}

/** {@link assetHistory} 入参。 */
export interface AssetHistoryInput {
  /** 运行时（含 `assetsDir`）。 */
  runtime: AssetHistoryRuntime
  /** 领域声明的资产类型（前缀白名单）。 */
  assetTypes: readonly AssetType[]
  /** 相对资产根目录的路径。 */
  path: string
  /** 返回条数上限；缺省 20，范围 1..100。 */
  limit?: number
  /** 自定义 git 执行器（测试注入；缺省 {@link runGit}）。 */
  git?: GitRunner
  /** 自定义日志出口（优先于 `runtime.logger`）。 */
  logger?: CommitAssetsLogger
  /** git 命令超时。 */
  timeoutMs?: number
}

/** {@link assetHistory} 结果。 */
export interface AssetHistoryResult {
  /** 历史记录（新 → 旧）；降级时为空数组。 */
  entries: AssetHistoryEntry[]
  /** 是否因 git 故障降级（不中断业务）。 */
  degraded: boolean
  /** 降级原因。 */
  reason?: string
}

/** 归一化日志出口为 warn 函数（缺省静默）。 */
function warnOf(logger: CommitAssetsLogger | undefined): (message: string) => void {
  if (logger === undefined) return () => {}
  if (typeof logger === 'function') return logger
  return (message: string) => logger.warn(message)
}

/**
 * 校验并归一化 `limit`。
 *
 * @throws {AssetHistoryLimitError} 非整数 / ≤ 0 / > 100 / 非数字。
 */
export function resolveHistoryLimit(value: unknown = ASSET_HISTORY_DEFAULT_LIMIT): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > ASSET_HISTORY_MAX_LIMIT
  ) {
    throw new AssetHistoryLimitError(value)
  }
  return value
}

/** `git log` 的格式化串：SHA / 作者 / ISO 时间 / 标题，字段与记录双分隔。 */
function logFormat(): string {
  return `--format=%H${FIELD_SEP}%an <%ae>${FIELD_SEP}%aI${FIELD_SEP}%s${RECORD_SEP}`
}

/** 解析 `git log` 输出；无法解析的记录直接跳过（不污染其余条目）。 */
export function parseAssetHistory(stdout: string): AssetHistoryEntry[] {
  const entries: AssetHistoryEntry[] = []
  for (const chunk of stdout.split(RECORD_SEP)) {
    const record = chunk.replace(/^\r?\n/, '')
    if (record.trim() === '') continue
    const parts = record.split(FIELD_SEP)
    if (parts.length < 4) continue
    const [sha, author, date, subject] = parts
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) continue
    entries.push({
      sha: sha as string,
      author: author ?? '',
      date: date ?? '',
      subject: (subject ?? '').replace(/\r?\n$/, ''),
    })
  }
  return entries
}

/**
 * 查询单个资产文件的提交历史。
 *
 * @throws {AssetPathError} `path` 非法（发生在任何 git 操作之前）。
 * @throws {AssetHistoryLimitError} `limit` 非法（同上）。
 */
export function assetHistory(input: AssetHistoryInput): AssetHistoryResult {
  const limit = resolveHistoryLimit(input.limit)
  const paths = validateAssetPaths([input.path], input.assetTypes)
  const path = paths[0]

  const dir = input.runtime?.assetsDir
  if (typeof dir !== 'string' || dir === '') {
    throw new TypeError('[assets] assetHistory 需要 runtime.assetsDir（非空字符串）')
  }

  const warn = warnOf(input.logger ?? input.runtime.logger)
  const timeoutMs = input.timeoutMs
  const run = (args: readonly string[]): ReturnType<GitRunner> =>
    input.git !== undefined
      ? input.git(args, dir)
      : runGit(args, dir, timeoutMs === undefined ? {} : { timeoutMs })

  // `-C` 与 cwd 双保险：即使执行器忽略 cwd，也只会读 <assetsDir> 这个仓库。
  const result = run([
    '-C',
    dir,
    'log',
    `--max-count=${limit}`,
    logFormat(),
    '--',
    path as string,
  ])

  if (!result.ok) {
    const reason = `git log 失败（exit ${result.code}）：${result.stderr.trim()}`
    warn(`[assets] ${reason}`)
    return { entries: [], degraded: true, reason }
  }

  return { entries: parseAssetHistory(result.stdout), degraded: false }
}

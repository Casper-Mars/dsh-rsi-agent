/**
 * 资产「写入即 commit」统一入口 —— 技术方案 §9.2 / §9.3。
 *
 * 语义：资产改动没有进入 git，就等于没有发生。任何写资产的路径都必须经过
 * {@link commitAssets} 提交一次；本模块把「校验 → add → 判空 → 判定动作 →
 * 只提交本次 paths」收敛在一处。
 *
 * 关键约束：
 *   1. **只接受相对 assets 根的路径**，且必须落在某个 `assetTypes[].prefix`
 *      之下（前缀白名单由领域包声明，core 不硬编码任何目录名）。绝对路径、
 *      `..` / `.` 段、`.git` 段、反斜杠、空数组 / 非字符串一律逐条拒绝，
 *      错误信息带上每一条的具体原因；
 *   2. 前缀比较走 `posix` 归一化 + **路径段**比较，不用裸 `startsWith`：
 *      `records2/x.md` 不会命中 `records/`；
 *   3. `git add -- <paths>` 后对**这些路径**做 `git diff --cached --name-only`；
 *      无 staged 变更 → no-op，**不产生空 commit**（重复写相同内容不涨历史）；
 *   4. 动作（`create` / `update` / `delete`）来自
 *      `git diff --cached --name-status -- <path>`，message 形如
 *      `assets: create records/a.md, update skills/x/SKILL.md`；
 *   5. **只提交本次 paths**：`git commit -m <msg> -- <paths>`。git 的 pathspec
 *      语义会忽略仓库里其它已 staged 内容，它们仍留在暂存区；
 *   6. git 任何一步失败 → `logger.warn` + `{ committed: false, degraded: true,
 *      reason }`，**不抛**。唯一会抛的是**路径非法**（调用方编程错误，应在
 *      写文件之前修正）。
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join, posix } from 'node:path'
import type { AssetType } from '../types.js'
import { runGit, type GitResult, type GitRunner } from './git.js'

/** 单个资产文件的变更动作。 */
export type AssetAction = 'create' | 'update' | 'delete'

/** 单个资产的相对路径 + 动作。 */
export interface AssetActionRecord {
  /** 相对 assets 根目录的 posix 路径（例如 `records/a.md`）。 */
  path: string
  /** 本次变更动作。 */
  action: AssetAction
}

/** 提交日志出口：只要求 warn（兼容统一日志门面与简单回调）。 */
export type CommitAssetsLogger =
  | { warn(message: string, meta?: unknown): void }
  | ((message: string) => void)

/** {@link commitAssets} 需要的运行时最小面。 */
export interface CommitAssetsRuntime {
  /** 资产仓库根目录（`<home>/assets`）。 */
  assetsDir: string
  /** 运行时日志门面（可选，用于降级告警）。 */
  logger?: CommitAssetsLogger
}

/** {@link commitAssets} 入参。 */
export interface CommitAssetsInput {
  /** 运行时（含 `assetsDir`，可含 `logger`）。 */
  runtime: CommitAssetsRuntime
  /** 领域声明的资产类型（前缀白名单）。 */
  assetTypes: readonly AssetType[]
  /** 本次写入的相对路径（至少 1 项）。 */
  paths: readonly string[]
  /** 自定义提交说明前缀；实际 message 会追加动作行。 */
  message?: string
  /** 自定义 git 执行器（测试注入；缺省 {@link runGit}）。 */
  git?: GitRunner
  /** 自定义日志出口（优先于 `runtime.logger`）。 */
  logger?: CommitAssetsLogger
  /** git 命令超时。 */
  timeoutMs?: number
}

/** {@link commitAssets} 结果。 */
export interface CommitAssetsResult {
  /** 是否产生了新提交。 */
  committed: boolean
  /** 提交的完整 SHA（仅成功提交时存在）。 */
  sha?: string
  /** 是否因 git 故障降级（不中断业务）。 */
  degraded: boolean
  /** 降级原因 / no-op 判据。 */
  reason?: string
  /** 本次实际变更的文件与动作；no-op / 降级时为空数组。 */
  actions: AssetActionRecord[]
}

/**
 * 拒绝原因码（稳定、机器可判）。
 *
 * 为什么需要它：错误信息会回显调用方传入的原始路径，任何「用 `toContain('..')`
 * 断言被拒」的写法都是恒真的。原因码与文案解耦，既不依赖路径回显，也能让
 * 不同守卫（`..` 段 / 归一化 / 前缀白名单）互相区分 —— 删掉其中任何一个
 * 守卫，对应断言都会变红。
 */
export type AssetPathReasonCode =
  | 'asset_types_not_array'
  | 'asset_type_prefix_invalid'
  | 'asset_type_prefix_git'
  | 'asset_type_prefix_backslash'
  | 'paths_not_array'
  | 'paths_empty'
  | 'path_not_string'
  | 'path_blank'
  | 'path_backslash'
  | 'path_nul'
  | 'path_absolute'
  | 'path_trailing_slash'
  | 'path_empty_segment'
  | 'path_dot_segment'
  /** 唯一由 `..` 守卫产生的原因码：其它守卫一律不会产出它。 */
  | 'path_dotdot_segment'
  | 'path_git_segment'
  | 'path_not_normalized'
  | 'no_asset_prefix'
  | 'path_outside_prefix'

/** 路径非法（调用方编程错误）。`reasons` 逐条列出每个被拒路径的原因。 */
export class AssetPathError extends Error {
  /** 逐条拒绝原因（与 `paths` 一一对应，可能多条针对同一路径）。 */
  readonly reasons: readonly string[]

  /** 与 {@link reasons} 下标一一对应的稳定原因码。 */
  readonly reasonCodes: readonly AssetPathReasonCode[]

  constructor(reasons: readonly string[], reasonCodes: readonly AssetPathReasonCode[] = []) {
    const detail =
      reasons.length === 0 ? '路径非法' : `路径非法（${reasons.length} 条）：\n- ${reasons.join('\n- ')}`
    super(`[assets] ${detail}`)
    this.name = 'AssetPathError'
    this.reasons = [...reasons]
    this.reasonCodes = [...reasonCodes]
  }

  /** 是否含有某个原因码（调用方 / 测试的精确判据）。 */
  hasReason(code: AssetPathReasonCode): boolean {
    return this.reasonCodes.includes(code)
  }
}

/** 收集拒绝原因的出口：文案与原因码必须成对写入，避免下标错位。 */
interface ReasonSink {
  reject(code: AssetPathReasonCode, message: string): void
}

/** 归一化日志出口为 warn 函数（缺省静默）。 */
function warnOf(logger: CommitAssetsLogger | undefined): (message: string) => void {
  if (logger === undefined) return () => {}
  if (typeof logger === 'function') return logger
  return (message: string) => logger.warn(message)
}

/** 非法段的类别：空段 / `.` / `..` 各有独立原因码与文案。 */
function classifyIllegalSegment(segment: string): AssetPathReasonCode | undefined {
  if (segment === '') return 'path_empty_segment'
  if (segment === '.') return 'path_dot_segment'
  if (segment === '..') return 'path_dotdot_segment'
  return undefined
}

/** 非法段 → 人类可读文案（`..` 的文案与归一化 / 前缀检查明确区分）。 */
const ILLEGAL_SEGMENT_TEXT: Partial<Record<AssetPathReasonCode, string>> = {
  path_empty_segment: '不得包含空路径段（"//"）',
  path_dot_segment: '不得包含 "." 路径段（当前目录）',
  path_dotdot_segment: '不得包含 ".." 路径段（不允许上溯父目录）',
}

/** 取某个资产类型前缀的路径段（不含结尾空段）。 */
function prefixSegments(prefix: string): string[] {
  return prefix.split('/').filter((segment) => segment !== '')
}

/** 路径是否**严格位于**某个前缀之下（路径段级比较，非裸 startsWith）。 */
function isUnderPrefix(segments: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length === 0 || segments.length <= prefix.length) return false
  return prefix.every((segment, index) => segments[index] === segment)
}

/** 收集可用的资产前缀（顺带拒绝非法的 `assetTypes` 声明）。 */
function resolvePrefixes(assetTypes: readonly AssetType[], sink: ReasonSink): string[][] {
  if (!Array.isArray(assetTypes)) {
    sink.reject('asset_types_not_array', 'assetTypes 必须是数组')
    return []
  }
  const result: string[][] = []
  assetTypes.forEach((assetType, index) => {
    const prefix = assetType?.prefix
    if (typeof prefix !== 'string' || prefix === '' || !prefix.endsWith('/')) {
      sink.reject(
        'asset_type_prefix_invalid',
        `assetTypes[${index}].prefix 非法：必须以 "/" 结尾的相对路径`,
      )
      return
    }
    const segments = prefixSegments(prefix)
    if (segments.length === 0 || segments.some((segment) => classifyIllegalSegment(segment) !== undefined)) {
      sink.reject(
        'asset_type_prefix_invalid',
        `assetTypes[${index}].prefix 非法：${JSON.stringify(prefix)}`,
      )
      return
    }
    if (segments.some((segment) => segment.toLowerCase() === '.git')) {
      sink.reject(
        'asset_type_prefix_git',
        `assetTypes[${index}].prefix 不得指向 .git：${JSON.stringify(prefix)}`,
      )
      return
    }
    if (prefix.includes('\\')) {
      sink.reject(
        'asset_type_prefix_backslash',
        `assetTypes[${index}].prefix 不得包含反斜杠：${JSON.stringify(prefix)}`,
      )
      return
    }
    result.push(segments)
  })
  return result
}

/** 前缀白名单的人类可读描述（用于错误信息）。 */
function describePrefixes(assetTypes: readonly AssetType[]): string {
  const names = assetTypes
    .map((assetType) => assetType?.prefix)
    .filter((prefix): prefix is string => typeof prefix === 'string' && prefix !== '')
  return names.length === 0 ? '（未声明任何 assetTypes）' : names.join('、')
}

/**
 * 校验并归一化一组资产相对路径（去重，保留首次出现顺序）。
 *
 * 逐条检查：非字符串 / 空串 / 反斜杠 / 绝对路径 / 空段 / `.` / `..` /
 * `.git` 段 / 结尾斜杠 / 前缀白名单。**收集全部原因后一次性抛出**，
 * 便于调用方一次看到所有问题。
 *
 * @throws {AssetPathError} 存在任一非法路径。
 */
export function validateAssetPaths(
  raw: unknown,
  assetTypes: readonly AssetType[],
): string[] {
  const reasons: string[] = []
  const codes: AssetPathReasonCode[] = []
  const sink: ReasonSink = {
    reject(code, message) {
      codes.push(code)
      reasons.push(message)
    },
  }
  const prefixes = resolvePrefixes(assetTypes, sink)

  if (!Array.isArray(raw)) {
    sink.reject('paths_not_array', `paths 必须是字符串数组，实际为 ${typeof raw}`)
    throw new AssetPathError(reasons, codes)
  }
  if (raw.length === 0) {
    sink.reject('paths_empty', 'paths 不能为空数组（至少 1 项）')
    throw new AssetPathError(reasons, codes)
  }

  const seen = new Set<string>()
  const result: string[] = []

  raw.forEach((value: unknown, index: number) => {
    const at = `paths[${index}]`
    if (typeof value !== 'string') {
      sink.reject(
        'path_not_string',
        `${at} 必须是字符串，实际为 ${value === null ? 'null' : typeof value}`,
      )
      return
    }
    const path = value
    if (path.trim() === '') {
      sink.reject('path_blank', `${at} 不能为空字符串`)
      return
    }
    if (path.includes('\\')) {
      sink.reject(
        'path_backslash',
        `${at} ${JSON.stringify(path)}：不得包含反斜杠（只接受 posix 路径）`,
      )
      return
    }
    if (path.includes('\0')) {
      sink.reject('path_nul', `${at} ${JSON.stringify(path)}：不得包含空字符`)
      return
    }
    if (path.startsWith('/') || isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
      sink.reject('path_absolute', `${at} ${JSON.stringify(path)}：不得为绝对路径`)
      return
    }
    if (path.endsWith('/')) {
      sink.reject(
        'path_trailing_slash',
        `${at} ${JSON.stringify(path)}：不得以 "/" 结尾（必须是文件路径）`,
      )
      return
    }

    const segments = path.split('/')
    let rejected = false
    for (const segment of segments) {
      // `..` 在这里拥有独立的失败模式：它是唯一一个「上溯父目录」的语义，
      // 必须与「归一化后不一致」「不在前缀之下」两类守卫区分开，否则删掉
      // 本守卫时用例仍会因为别的守卫而变绿（突变不敏感）。
      const illegal = classifyIllegalSegment(segment)
      if (illegal !== undefined) {
        sink.reject(illegal, `${at} ${JSON.stringify(path)}：${ILLEGAL_SEGMENT_TEXT[illegal]}`)
        rejected = true
        break
      }
      if (segment.toLowerCase() === '.git') {
        sink.reject('path_git_segment', `${at} ${JSON.stringify(path)}：不得包含 ".git" 路径段`)
        rejected = true
        break
      }
    }
    if (rejected) return

    const normalized = posix.normalize(segments.join('/'))
    if (normalized !== segments.join('/')) {
      sink.reject(
        'path_not_normalized',
        `${at} ${JSON.stringify(path)}：归一化后路径不一致（${normalized}）`,
      )
      return
    }

    if (prefixes.length === 0) {
      sink.reject(
        'no_asset_prefix',
        `${at} ${JSON.stringify(path)}：没有可用的资产前缀（${describePrefixes(assetTypes)}）`,
      )
      return
    }
    if (!prefixes.some((prefix) => isUnderPrefix(segments, prefix))) {
      sink.reject(
        'path_outside_prefix',
        `${at} ${JSON.stringify(path)}：不在任何资产前缀之下（允许：${describePrefixes(assetTypes)}）`,
      )
      return
    }

    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  })

  if (reasons.length > 0) throw new AssetPathError(reasons, codes)
  return result
}

/** 拆分 `-z` 输出（NUL 分隔，天然兼容中文 / 空格路径）。 */
function splitNul(stdout: string): string[] {
  return stdout.split('\0').filter((item) => item !== '')
}

/** 组装动作行：`assets: create a, update b`；调用方 message 作为首段。 */
function buildMessage(actions: readonly AssetActionRecord[], message?: string): string {
  const detail = actions.map((action) => `${action.action} ${action.path}`).join(', ')
  const line = `assets: ${detail}`
  const prefix = typeof message === 'string' ? message.trim() : ''
  return prefix === '' ? line : `${prefix}\n\n${line}`
}

/** 读取单条路径的 staged 动作；`undefined` 表示该路径没有 staged 变更。 */
function readAction(
  run: (args: readonly string[]) => GitResult,
  path: string,
): { action?: AssetAction; error?: string } {
  const result = run(['diff', '--cached', '--name-status', '--', path])
  if (!result.ok) {
    return { error: `git diff --cached 失败（exit ${result.code}）：${result.stderr.trim()}` }
  }
  const line = result.stdout
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item !== '')
  if (line === undefined) return {}
  // 状态字母始终是首字符（路径可能被 core.quotePath 转义，无需解析路径本身）。
  const status = line[0]
  if (status === 'A') return { action: 'create' }
  if (status === 'D') return { action: 'delete' }
  return { action: 'update' }
}

/**
 * 提交一批资产变更（写入即 commit 的统一入口）。
 *
 * @throws {AssetPathError} `paths` 非法（发生在任何 git 操作之前）。
 */
export function commitAssets(input: CommitAssetsInput): CommitAssetsResult {
  const paths = validateAssetPaths(input.paths, input.assetTypes)

  const dir = input.runtime?.assetsDir
  if (typeof dir !== 'string' || dir === '') {
    throw new TypeError('[assets] commitAssets 需要 runtime.assetsDir（非空字符串）')
  }

  const warn = warnOf(input.logger ?? input.runtime.logger)
  const timeoutMs = input.timeoutMs
  const run = (args: readonly string[]): GitResult =>
    input.git !== undefined
      ? input.git(args, dir)
      : runGit(args, dir, timeoutMs === undefined ? {} : { timeoutMs })

  const fail = (reason: string): CommitAssetsResult => {
    warn(`[assets] ${reason}`)
    return { committed: false, degraded: true, reason, actions: [] }
  }

  if (!existsSync(dir) || !existsSync(join(dir, '.git'))) {
    return fail(`资产仓库未就绪（缺少 ${join(dir, '.git')}），跳过提交`)
  }

  // 1) 把本次写入（含删除）纳入暂存区。
  const add = run(['add', '--', ...paths])
  if (!add.ok) return fail(`git add 失败（exit ${add.code}）：${add.stderr.trim()}`)

  // 2) 只检查本次 paths 的 staged 变更；空输出 ⇒ 与 HEAD 一致 ⇒ no-op。
  const staged = run(['diff', '--cached', '--name-only', '-z', '--', ...paths])
  if (!staged.ok) {
    return fail(`git diff --cached 失败（exit ${staged.code}）：${staged.stderr.trim()}`)
  }
  if (splitNul(staged.stdout).length === 0) {
    return { committed: false, degraded: false, reason: '资产无变更（no-op）', actions: [] }
  }

  // 3) 逐条判定动作（A/M/D）。
  const actions: AssetActionRecord[] = []
  for (const path of paths) {
    const { action, error } = readAction(run, path)
    if (error !== undefined) return fail(error)
    if (action !== undefined) actions.push({ path, action })
  }
  if (actions.length === 0) {
    return { committed: false, degraded: false, reason: '资产无变更（no-op）', actions: [] }
  }

  // 4) 只提交本次 paths：pathspec 语义会让其它已 staged 文件留在暂存区。
  const message = buildMessage(actions, input.message)
  const commit = run(['commit', '-m', message, '--', ...paths])
  if (!commit.ok) {
    return fail(`git commit 失败（exit ${commit.code}）：${commit.stderr.trim()}`)
  }

  const rev = run(['rev-parse', 'HEAD'])
  const result: CommitAssetsResult = { committed: true, degraded: false, actions }
  if (rev.ok) result.sha = rev.stdout.trim()
  return result
}

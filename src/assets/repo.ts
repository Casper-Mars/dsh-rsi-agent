/**
 * assets 资产仓库就绪 —— 技术方案 §9.1（单仓）。
 *
 * `<home>/assets` 是资产层**唯一**的 git 仓库：`records/`、`skills/` 等
 * 所有资产目录都是它的普通子目录，不存在嵌套仓库。本模块只负责「仓库就绪」
 * 与 `.gitignore` 的初始化（不写业务资产）：
 *
 * ```
 * <assetsDir>/                  # 唯一仓库根（.git 由本模块初始化）
 *   .git/
 *   .gitignore                  # 仅忽略系统 / 临时文件（纳入首次 commit）
 *   <prefix>/...                # 由 assetTypes 声明的资产分区
 * ```
 *
 * 幂等约定：
 *   - 目录不存在 → 创建；
 *   - `.git` 不存在 → `git init -b main`（不支持 `-b` 时回落 `git init`），
 *     写 local 身份配置；
 *   - `.gitignore` 不存在 → `flag: 'wx'` 创建默认内容，并以
 *     `chore: init assets repository` 纳入首次 commit（仅当此前无任何 commit）；
 *   - `.gitignore` 已存在 → **绝不覆盖**；仅在缺少必要忽略项且尚无本工具
 *     区块时追加一段带标记的区块（幂等），改动后提交 `.gitignore` 这一路径；
 *   - `.git` 已存在 → 不重复 init、不产生空 commit。
 *
 * 降级约定：git 不可用 / 初始化失败 / 参数非法 → 返回 `degraded: true` +
 * `reason`，**绝不抛错**，由调用方决定是否继续（`install` 只 warn）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUNTIME_LAYOUT } from '../runtime.js'
import {
  ensureRepoConfig,
  initGitRepo,
  isGitAvailable,
  runGit,
  type GitRunner,
} from './git.js'

/** 默认 `.gitignore` 的说明行。 */
export const ASSETS_GITIGNORE_HEADER =
  '# 仅忽略系统 / 临时文件；资产内容（records / skills 等）一律纳入版本管理。'

/** 必须忽略的条目。 */
export const ASSETS_GITIGNORE_ENTRIES = ['.DS_Store', '*.tmp', '*.log'] as const

/** 默认 `.gitignore`：只忽略系统 / 临时文件，资产内容一律入库。 */
export const ASSETS_GITIGNORE = [
  ASSETS_GITIGNORE_HEADER,
  ...ASSETS_GITIGNORE_ENTRIES,
  '',
].join('\n')

/** 追加区块的起始 / 结束标记（幂等判据）。 */
export const ASSETS_GITIGNORE_BLOCK_START = '# >>> dsh-rsi-agent assets >>>'
export const ASSETS_GITIGNORE_BLOCK_END = '# <<< dsh-rsi-agent assets <<<'

/** `.gitignore` 本次实际动作。 */
export type GitignoreAction = 'created' | 'appended' | 'unchanged'

/** 资产仓库日志出口：只要求 warn（兼容统一日志门面与简单回调）。 */
export type AssetsRepoLogger =
  | { warn(message: string, meta?: unknown): void }
  | ((message: string) => void)

/** {@link ensureAssetsRepo} 依赖（测试注入用）。 */
export interface EnsureAssetsRepoDeps {
  /** 资产目录覆盖；缺省 `<home>/assets`。 */
  assetsDir?: string
  /** 日志出口；缺省静默（由调用方按返回值决定是否告警）。 */
  logger?: AssetsRepoLogger
  /** 自定义 git 执行器。 */
  git?: GitRunner
  /** 自定义可用性探测（缺省 `git --version`）。 */
  isGitAvailable?: () => boolean
  /** git 命令超时。 */
  timeoutMs?: number
}

/** {@link ensureAssetsRepo} 结果。 */
export interface EnsureAssetsRepoResult {
  /** 仓库绝对路径（`<assetsDir>`）。 */
  dir: string
  /** 本次是否执行了 `git init`（已存在时为 false）。 */
  initialized: boolean
  /** 是否降级（git 不可用 / 命令失败 / 参数非法）。 */
  degraded: boolean
  /** 降级原因或判据说明。 */
  reason?: string
  /** 本次对 `.gitignore` 的动作（created / appended / unchanged）。 */
  gitignore?: GitignoreAction
}

/** `.gitignore` 处理结果。 */
interface GitignoreState {
  action: GitignoreAction
  /** 文件内容是否被改动（需要提交）。 */
  changed: boolean
  reason?: string
}

/** 计算缺失的忽略条目（按整行比较，忽略首尾空白）。 */
function missingIgnoreEntries(text: string): string[] {
  const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()))
  return ASSETS_GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry))
}

/** 构造要追加的忽略区块（只包含缺失条目 + 注释标记）。 */
function buildIgnoreBlock(missing: readonly string[]): string {
  return [
    ASSETS_GITIGNORE_BLOCK_START,
    '# 系统 / 临时文件（本区块由 dsh-rsi-agent 维护，重复执行不会重复追加）',
    ...missing,
    ASSETS_GITIGNORE_BLOCK_END,
    '',
  ].join('\n')
}

/**
 * 幂等写入 `.gitignore`：
 *
 *   1. 文件不存在 → `flag: 'wx'` 创建默认内容（`created`）；
 *   2. 文件已存在 → **绝不覆盖**；只在缺少必要忽略项且尚无本工具区块时
 *      追加一段带注释标记的区块（`appended`）；区块已存在则视为已处理
 *      （`unchanged`，重复执行不会重复追加）。
 */
function ensureGitignoreFile(dir: string): GitignoreState {
  const file = join(dir, '.gitignore')
  try {
    writeFileSync(file, ASSETS_GITIGNORE, { encoding: 'utf8', flag: 'wx' })
    return { action: 'created', changed: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
      return {
        action: 'unchanged',
        changed: false,
        reason: `写入 .gitignore 失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  let existing: string
  try {
    existing = readFileSync(file, 'utf8')
  } catch (error) {
    return {
      action: 'unchanged',
      changed: false,
      reason: `读取既有 .gitignore 失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (existing.includes(ASSETS_GITIGNORE_BLOCK_START)) {
    return { action: 'unchanged', changed: false }
  }
  const missing = missingIgnoreEntries(existing)
  if (missing.length === 0) return { action: 'unchanged', changed: false }

  const lead = existing === '' ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  const next = `${existing}${lead}${buildIgnoreBlock(missing)}`
  try {
    writeFileSync(file, next, 'utf8')
  } catch (error) {
    return {
      action: 'unchanged',
      changed: false,
      reason: `追加 .gitignore 失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { action: 'appended', changed: true }
}

/**
 * 把 `.gitignore` 纳入版本管理。
 *
 * - 仓库此前没有任何 commit → `chore: init assets repository`；
 * - 已有 commit → `chore: 同步 .gitignore`；
 * - 只提交 `.gitignore` 这一个 pathspec，**不会**顺手带上任何其它待提交内容；
 * - 无实际差异（`git diff --cached` 为空）→ 不产生空 commit；
 * - 失败只 warn（不阻断仓库就绪）。
 */
function commitGitignore(
  dir: string,
  run: (args: readonly string[]) => ReturnType<GitRunner>,
  warn: (message: string) => void,
): void {
  const add = run(['add', '--', '.gitignore'])
  if (!add.ok) {
    warn(`[assets] git add .gitignore 失败（exit ${add.code}）：${add.stderr.trim()}`)
    return
  }
  const staged = run(['diff', '--cached', '--name-only', '--', '.gitignore'])
  if (!staged.ok) {
    warn(`[assets] git diff --cached 失败（exit ${staged.code}）：${staged.stderr.trim()}`)
    return
  }
  if (staged.stdout.trim() === '') return

  const head = run(['rev-parse', '--verify', 'HEAD'])
  const message = head.ok ? 'chore: 同步 .gitignore' : 'chore: init assets repository'
  const commit = run(['commit', '-m', message, '--', '.gitignore'])
  if (!commit.ok) {
    warn(`[assets] git commit .gitignore 失败（exit ${commit.code}）：${commit.stderr.trim()}`)
  }
}

/** 归一化日志出口为 warn 函数。 */
function warnOf(logger: AssetsRepoLogger | undefined): (message: string) => void {
  if (logger === undefined) return () => {}
  if (typeof logger === 'function') return logger
  return (message: string) => logger.warn(message)
}

/**
 * 确保资产仓库就绪（幂等；仅在 `.gitignore` 缺失 / 需追加时产生一次提交）。
 *
 * @param home 领域 home（`<homeRoot>/<domainId>`）；仓库位于 `<home>/assets`。
 * @param deps 资产目录覆盖 / git 执行器 / 日志出口（测试注入）。
 * @returns 就绪结果；任何基础设施失败都以 `degraded: true` 返回，不抛错。
 */
export function ensureAssetsRepo(
  home: string,
  deps: EnsureAssetsRepoDeps = {},
): EnsureAssetsRepoResult {
  const warn = warnOf(deps.logger)
  const dir =
    typeof deps.assetsDir === 'string' && deps.assetsDir.trim() !== ''
      ? deps.assetsDir
      : typeof home === 'string' && home.trim() !== ''
        ? join(home, RUNTIME_LAYOUT.assets)
        : ''

  if (dir === '') {
    const reason = 'ensureAssetsRepo：home 必须是非空字符串'
    warn(`[assets] ${reason}`)
    return { dir, initialized: false, degraded: true, reason }
  }

  const git = deps.git ?? runGit
  const probe = deps.isGitAvailable ?? (() => isGitAvailable())
  const timeoutMs = deps.timeoutMs

  try {
    if (!probe()) {
      const reason = 'git 不可用：PATH 中未找到可执行的 git，资产仓库跳过初始化'
      warn(`[assets] ${reason}`)
      return { dir, initialized: false, degraded: true, reason }
    }

    mkdirSync(dir, { recursive: true })

    const hasRepo = existsSync(join(dir, '.git'))
    if (!hasRepo) {
      const init = initGitRepo(dir, { timeoutMs })
      if (!init.ok) {
        const reason = `git init 失败（exit ${init.code}）：${init.stderr.trim()}`
        warn(`[assets] ${reason}`)
        return { dir, initialized: false, degraded: true, reason }
      }
    }

    // 已有仓库也补齐 local 身份 / 字节配置（幂等，不产生提交）。
    const config = ensureRepoConfig(dir, { timeoutMs })
    if (!config.ok) {
      const reason = `写入仓库 local config 失败（exit ${config.code}）：${config.stderr.trim()}`
      warn(`[assets] ${reason}`)
      return { dir, initialized: !hasRepo, degraded: true, reason }
    }

    // `.gitignore`：仅在缺失时创建（wx），既有文件绝不覆盖，只按需追加区块；
    // 有改动则纳入版本管理（否则工作区恒 dirty、clone 后还会丢）。
    const ignore = ensureGitignoreFile(dir)
    if (ignore.reason !== undefined) warn(`[assets] ${ignore.reason}`)
    // 内容有改动，或文件尚未被追踪（clone 后 / 预置文件 / 无 HEAD）→ 纳入版本管理。
    const tracked = git(['ls-files', '--error-unmatch', '--', '.gitignore'], dir).ok
    if (ignore.changed || !tracked) commitGitignore(dir, (args) => git(args, dir), warn)

    // 防御：仓库存在但 HEAD 指向不存在的分支属于异常态，交由调用方感知。
    if (hasRepo) {
      const head = git(['rev-parse', '--git-dir'], dir)
      if (!head.ok) {
        const reason = `既有目录不是可用 git 仓库：${head.stderr.trim()}`
        warn(`[assets] ${reason}`)
        return { dir, initialized: false, degraded: true, reason }
      }
    }

    return {
      dir,
      initialized: !hasRepo,
      degraded: false,
      reason: hasRepo ? '资产仓库已就绪（复用既有仓库）' : '资产仓库缺失，已初始化',
      gitignore: ignore.action,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warn(`[assets] 资产仓库初始化失败（降级）：${reason}`)
    return { dir, initialized: false, degraded: true, reason }
  }
}

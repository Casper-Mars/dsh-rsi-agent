/**
 * assets 资产仓库就绪 —— 技术方案 §9.1（单仓）。
 *
 * `<home>/assets` 是资产层**唯一**的 git 仓库：`records/`、`skills/` 等
 * 所有资产目录都是它的普通子目录，不存在嵌套仓库。本模块只负责「仓库就绪」，
 * 不产生任何提交：
 *
 * ```
 * <assetsDir>/                  # 唯一仓库根（.git 由本模块初始化）
 *   .git/
 *   .gitignore                  # 仅忽略系统 / 临时文件
 *   <prefix>/...                # 由 assetTypes 声明的资产分区
 * ```
 *
 * 幂等约定：
 *   - 目录不存在 → 创建；
 *   - `.git` 不存在 → `git init -b main`（不支持 `-b` 时回落 `git init`），
 *     写默认 `.gitignore`，写 local 身份配置；
 *   - `.git` 已存在 → **只补齐 local config**，不重复 init、不写 `.gitignore`
 *     （尊重用户既有内容）、不产生空 commit。
 *
 * 降级约定：git 不可用 / 初始化失败 / 参数非法 → 返回 `degraded: true` +
 * `reason`，**绝不抛错**，由调用方决定是否继续（`install` 只 warn）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUNTIME_LAYOUT } from '../runtime.js'
import {
  ensureRepoConfig,
  initGitRepo,
  isGitAvailable,
  runGit,
  type GitRunner,
} from './git.js'

/** 默认 `.gitignore`：只忽略系统 / 临时文件，资产内容一律入库。 */
export const ASSETS_GITIGNORE = [
  '# 仅忽略系统 / 临时文件；资产内容（records / skills 等）一律纳入版本管理。',
  '.DS_Store',
  '*.tmp',
  '*.log',
  '',
].join('\n')

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
}

/** 归一化日志出口为 warn 函数。 */
function warnOf(logger: AssetsRepoLogger | undefined): (message: string) => void {
  if (logger === undefined) return () => {}
  if (typeof logger === 'function') return logger
  return (message: string) => logger.warn(message)
}

/**
 * 确保资产仓库就绪（幂等，**不产生提交**）。
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
      writeFileSync(join(dir, '.gitignore'), ASSETS_GITIGNORE, 'utf8')
    }

    // 已有仓库也补齐 local 身份 / 字节配置（幂等，不产生提交）。
    const config = ensureRepoConfig(dir, { timeoutMs })
    if (!config.ok) {
      const reason = `写入仓库 local config 失败（exit ${config.code}）：${config.stderr.trim()}`
      warn(`[assets] ${reason}`)
      return { dir, initialized: !hasRepo, degraded: true, reason }
    }

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
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warn(`[assets] 资产仓库初始化失败（降级）：${reason}`)
    return { dir, initialized: false, degraded: true, reason }
  }
}

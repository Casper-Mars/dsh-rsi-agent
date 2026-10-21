/**
 * 领域资产写入器 `AssetWriter` —— 技术方案 §11.1 / §11.2。
 *
 * 领域包在 `assets.bootstrap(writer)` 里**同步**注册资产；本模块把
 * 「类型归属校验 → 路径白名单 → 类型级 validate → 落盘 → 统一 commit」
 * 收敛在一处，向领域作者只暴露 `register` / `list` / `read`。
 *
 * 硬约束：
 *   1. **同步**：`register` 不返回 Promise；`bootstrap` 若返回 thenable 由
 *      `runAssetsBootstrap` 判失败（见 `../validate.js`）。
 *   2. **批量原子**：一次 `register([...])` 先全量校验，任一 spec 失败 ⇒
 *      **一个字节都不写**；全部通过才进入写盘阶段。
 *   3. **一次一个 commit**：落盘后统一走 `commitAssets`（唯一 git 入口），
 *      一批文件只产生一个提交；message 含每个路径的动作与各 spec 的 `message`。
 *   4. **幂等**：`seed` 目标已存在 ⇒ `skipped`（`reason: seed already exists`）；
 *      `upsert` 内容与磁盘完全一致 ⇒ `skipped`（`reason: content unchanged`）；
 *      两者都不写盘、不产生 commit。`upsert` 仅在内容**真的变化**时覆盖并
 *      返回 `updated`（带 `sha`），避免调用方把 no-op 误判成一次变更。
 *   5. **路径白名单**：`..`、绝对路径、`.git`、反斜杠一律拒绝；路径还必须
 *      落在**自己声明的类型**的 prefix 下，且不得命中其它类型的 prefix。
 *   6. **git 降级**：资产已落盘但未进版本库时返回 `degraded: true` + reason，
 *      warn 后继续，不抛错。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import {
  AssetPathError,
  commitAssets,
  validateAssetPaths,
  type CommitAssetsLogger,
  type CommitAssetsResult,
  type CommitAssetsRuntime,
} from './commit.js'
import type { GitRunner } from './git.js'
import type {
  AssetEntry,
  AssetSpec,
  AssetType,
  AssetWriter,
  RegisterResult,
} from '../types.js'

/** {@link createAssetWriter} 依赖。 */
export interface CreateAssetWriterOptions {
  /** 运行时（至少含 `assetsDir`；可含 logger）。 */
  runtime: CommitAssetsRuntime
  /** 领域声明的资产类型（顺序即 list 的扫描顺序）。 */
  assetTypes: readonly AssetType[]
  /** 日志出口（优先于 `runtime.logger`）。 */
  logger?: CommitAssetsLogger
  /** 自定义 git 执行器（测试注入）。 */
  git?: GitRunner
  /** git 命令超时。 */
  timeoutMs?: number
}

/** 资产写入器通用错误（`list` / `read` 的契约错误）。 */
export class AssetWriterError extends Error {
  constructor(message: string) {
    super(`[assets] ${message}`)
    this.name = 'AssetWriterError'
  }
}

/** 注册请求形状非法（调用方编程错误）。 */
export class AssetRegisterError extends AssetWriterError {
  constructor(message: string) {
    super(`register 失败：${message}`)
    this.name = 'AssetRegisterError'
  }
}

/** 归一化日志出口为 warn 函数（缺省静默）。 */
function warnOf(logger: CommitAssetsLogger | undefined): (message: string) => void {
  if (logger === undefined) return () => {}
  if (typeof logger === 'function') return logger
  return (message: string) => logger.warn(message)
}

/** 路径 → 路径段。 */
function segmentsOf(path: string): string[] {
  return path.split('/')
}

/** 前缀 → 路径段（不含结尾空段）。 */
function prefixSegments(prefix: string): string[] {
  return prefix.split('/').filter((segment) => segment !== '')
}

/** `path` 是否**严格位于** `prefix` 之下（路径段级比较，非裸 startsWith）。 */
function isUnderPrefix(pathSegments: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length === 0 || pathSegments.length <= prefix.length) return false
  return prefix.every((segment, index) => pathSegments[index] === segment)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把 assets 相对路径拼成绝对路径（调用前必须已通过白名单校验）。 */
function resolveAssetPath(assetsDir: string, path: string): string {
  return join(assetsDir, ...segmentsOf(path))
}

/**
 * 创建资产写入器。
 *
 * @param options.runtime 运行时（`assetsDir` 必填）。
 * @param options.assetTypes 领域声明的资产类型（作为路径白名单真源）。
 */
export function createAssetWriter(options: CreateAssetWriterOptions): AssetWriter {
  const { runtime, assetTypes } = options
  const assetsDir = runtime?.assetsDir
  if (typeof assetsDir !== 'string' || assetsDir === '') {
    throw new TypeError('[assets] createAssetWriter 需要 runtime.assetsDir（非空字符串）')
  }
  if (!Array.isArray(assetTypes)) {
    throw new TypeError('[assets] createAssetWriter 需要 assetTypes 数组')
  }

  const logger = options.logger ?? runtime.logger
  const warn = warnOf(logger)

  const declared = new Map<string, AssetType>()
  for (const assetType of assetTypes) {
    if (assetType && typeof assetType.name === 'string') declared.set(assetType.name, assetType)
  }

  /**
   * 路径白名单校验：复用 `validateAssetPaths`（与 core 工具**同一份**实现）。
   *
   * @throws {AssetPathError} 非法路径；`label` 会写进拒绝原因。
   */
  function assertAllowed(path: unknown, label: string): string {
    try {
      const [normalized] = validateAssetPaths([path], assetTypes)
      return normalized as string
    } catch (error) {
      if (error instanceof AssetPathError) {
        throw new AssetPathError([`${label}：${error.reasons.join('；')}`])
      }
      throw error
    }
  }

  /** 找出某一资产路径除 `owner` 之外命中的类型（命中即非法）。 */
  function findForeignType(pathSegments: readonly string[], owner: string): AssetType | undefined {
    for (const assetType of assetTypes) {
      if (!assetType || assetType.name === owner) continue
      if (!isUnderPrefix(pathSegments, prefixSegments(assetType.prefix))) continue
      return assetType
    }
    return undefined
  }

  interface Plan {
    readonly spec: AssetSpec
    readonly type: AssetType
    readonly path: string
    /** 是否需要落盘（`skipped` 恒为 false）。 */
    readonly write: boolean
    readonly status: 'created' | 'skipped' | 'updated'
    /** `skipped` 的原因（区分「seed 已存在」与「upsert 无变化」）。 */
    readonly reason?: string
  }

  function planSpec(spec: unknown, index: number): Plan {
    const at = `spec[${index}]`
    if (!isRecord(spec)) {
      throw new AssetRegisterError(`${at} 必须是对象，实际为 ${Array.isArray(spec) ? '数组' : typeof spec}`)
    }

    const typeName = spec.type
    if (typeof typeName !== 'string' || typeName === '') {
      throw new AssetRegisterError(`${at}.type 必须是非空字符串`)
    }
    const type = declared.get(typeName)
    if (type === undefined) {
      throw new AssetRegisterError(
        `${at}.type "${typeName}" 未在 assets.types 中声明（已声明：[${[...declared.keys()].join(', ')}]）`,
      )
    }

    const path = assertAllowed(spec.path, `${at}.path`)
    const pathSegments = segmentsOf(path)

    if (!isUnderPrefix(pathSegments, prefixSegments(type.prefix))) {
      throw new AssetRegisterError(
        `${at}.path "${path}" 不在类型 "${type.name}" 的 prefix "${type.prefix}" 之下`,
      )
    }
    const foreign = findForeignType(pathSegments, type.name)
    if (foreign !== undefined) {
      throw new AssetRegisterError(
        `${at}.path "${path}" 同时命中类型 "${foreign.name}" 的 prefix "${foreign.prefix}"；` +
          '资产路径必须且只能属于一个类型',
      )
    }

    const content = spec.content
    if (typeof content !== 'string') {
      throw new AssetRegisterError(`${at}.content 必须是字符串，实际为 ${typeof content}`)
    }

    const mode = spec.mode ?? 'seed'
    if (mode !== 'seed' && mode !== 'upsert') {
      throw new AssetRegisterError(`${at}.mode 只能是 "seed" 或 "upsert"，实际为 ${String(mode)}`)
    }
    if (spec.message !== undefined && typeof spec.message !== 'string') {
      throw new AssetRegisterError(`${at}.message 若提供必须是字符串`)
    }

    // 领域自定义校验：抛错**原样透传**（不包裹，领域作者需看到自己的原因）。
    if (type.validate !== undefined && typeof type.validate !== 'function') {
      throw new AssetRegisterError(`${at}.type "${type.name}" 的 validate 必须是函数`)
    }
    type.validate?.(path, content)

    const file = resolveAssetPath(assetsDir, path)
    const existed = existsSync(file)
    if (mode === 'seed' && existed) {
      return {
        spec: spec as unknown as AssetSpec,
        type,
        path,
        write: false,
        status: 'skipped',
        reason: 'seed already exists',
      }
    }

    // upsert 的 no-op：内容逐字节相同 ⇒ 不写盘、不 commit，返回 skipped。
    // 若仍返回 updated，调用方会拿到 `sha: undefined` 却以为产生了变更。
    if (mode === 'upsert' && existed && readFileSync(file, 'utf8') === content) {
      return {
        spec: spec as unknown as AssetSpec,
        type,
        path,
        write: false,
        status: 'skipped',
        reason: 'content unchanged',
      }
    }

    return {
      spec: spec as unknown as AssetSpec,
      type,
      path,
      write: true,
      status: existed ? 'updated' : 'created',
    }
  }

  /** 组装本次提交说明：逐条 spec.message（动作行由 commitAssets 追加）。 */
  function buildMessage(plans: readonly Plan[]): string | undefined {
    const lines: string[] = []
    for (const plan of plans) {
      const message = plan.spec.message
      if (typeof message === 'string' && message.trim() !== '') {
        lines.push(`${plan.path}: ${message.trim()}`)
      }
    }
    return lines.length === 0 ? undefined : lines.join('\n')
  }

  function register(input: AssetSpec | readonly AssetSpec[]): RegisterResult[] {
    const raw: readonly unknown[] = Array.isArray(input) ? input : [input]
    if (raw.length === 0) {
      throw new AssetRegisterError('至少需要 1 个 spec（空数组不产生任何动作）')
    }

    // 阶段 1：全量校验（含领域 validate）。任何一条失败 ⇒ 整批不写盘。
    const plans = raw.map((spec, index) => planSpec(spec, index))

    const seen = new Set<string>()
    for (const plan of plans) {
      if (seen.has(plan.path)) {
        throw new AssetRegisterError(`同一批次内路径重复："${plan.path}"（请拆成多次 register）`)
      }
      seen.add(plan.path)
    }

    // 阶段 2：统一落盘。
    const written = plans.filter((plan) => plan.write)
    for (const plan of written) {
      const file = resolveAssetPath(assetsDir, plan.path)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, plan.spec.content, 'utf8')
    }

    // 阶段 3：一次 register 只产生一个 commit（无写入则不提交）。
    let commit: CommitAssetsResult | undefined
    if (written.length > 0) {
      commit = commitAssets({
        runtime: { assetsDir, ...(logger === undefined ? {} : { logger }) },
        assetTypes,
        paths: written.map((plan) => plan.path),
        ...(buildMessage(written) === undefined ? {} : { message: buildMessage(written) as string }),
        ...(options.git === undefined ? {} : { git: options.git }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
      if (commit.degraded) {
        warn(`[assets] register 已落盘但提交降级：${commit.reason ?? '未知原因'}`)
      }
    }

    return plans.map((plan): RegisterResult => {
      const result: RegisterResult = { path: plan.path, type: plan.type.name, status: plan.status }
      if (!plan.write && plan.reason !== undefined) result.reason = plan.reason
      if (plan.write && commit !== undefined) {
        if (commit.committed && commit.sha !== undefined) result.sha = commit.sha
        if (commit.degraded) {
          result.degraded = true
          if (commit.reason !== undefined) result.reason = commit.reason
        }
      }
      return result
    })
  }

  function list(type?: string): AssetEntry[] {
    let targets: readonly AssetType[]
    if (type === undefined) {
      targets = assetTypes
    } else {
      const found = declared.get(type)
      if (found === undefined) {
        throw new AssetWriterError(
          `list 的 type "${type}" 未在 assets.types 中声明（已声明：[${[...declared.keys()].join(', ')}]）`,
        )
      }
      targets = [found]
    }

    const entries: AssetEntry[] = []
    for (const assetType of targets) {
      const base = prefixSegments(assetType.prefix)
      const root = join(assetsDir, ...base)
      if (!existsSync(root)) continue

      const walk = (dir: string, segments: string[]): void => {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
          if (item.isSymbolicLink()) {
            warn(`[assets] list 跳过符号链接：${join(dir, item.name)}`)
            continue
          }
          const next = [...segments, item.name]
          if (item.isDirectory()) {
            walk(join(dir, item.name), next)
            continue
          }
          if (!item.isFile()) continue
          const path = next.join('/')
          // 白名单双保险：目录名也可能出现 `.git` 等非法段。
          try {
            assertAllowed(path, 'list')
          } catch {
            warn(`[assets] list 跳过非法路径：${path}`)
            continue
          }
          entries.push({
            path,
            type: assetType.name,
            size: statSync(join(dir, item.name)).size,
          })
        }
      }

      walk(root, base)
    }

    return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  }

  function read(path: string): string {
    const normalized = assertAllowed(path, 'read')
    const file = resolveAssetPath(assetsDir, normalized)
    if (!existsSync(file)) {
      throw new AssetWriterError(`read 的资产不存在："${normalized}"（${file}）`)
    }

    // 符号链接可能把读取面引到 assetsDir 之外：用 realpath 再做一次边界检查。
    const realRoot = realpathSync(assetsDir)
    const real = realpathSync(file)
    const rel = relative(realRoot, real)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new AssetPathError([`read 的路径越界（realpath 落在 assetsDir 之外）："${normalized}"`])
    }

    return readFileSync(real, 'utf8')
  }

  return { register, list, read }
}

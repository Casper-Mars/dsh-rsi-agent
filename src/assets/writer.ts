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
 *      **一个字节都不写**；全部通过才进入写盘阶段。写盘阶段若任一文件失败
 *      （权限、`EEXIST`、父路径是文件等）⇒ 本批**已写入的文件全部回滚**
 *      （新建的删除、覆盖的恢复原字节），不留未提交文件与脏工作区；原始错误
 *      照常抛给调用方。
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
 *   7. **大小写折叠唯一**：目标平台是 macOS（APFS 默认大小写不敏感），
 *      `records/A.md` 与 `records/a.md` 是同一个目录项。批内折叠后重复、
 *      或与磁盘已有条目「仅大小写不同」一律在**写盘前**拒绝，避免内容被静默
 *      覆盖（大小写敏感文件系统上也按同一规则处理，保证跨平台行为一致）。
 *   8. **可插拔路径守卫**：`guard` 在**写盘前**逐条调用，返回字符串即拒绝
 *      并作为原因。守卫是纯函数，本模块不赋予它任何领域语义（「哪些路径
 *      属于保留路径」由调用方决定）；拒绝同样发生在校验阶段，整批零副作用。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
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
  /**
   * 写盘前的路径守卫（可选）。
   *
   * 入参是**已通过白名单归一化**的资产相对路径（`/` 分隔）。返回字符串
   * 表示拒绝，字符串即拒绝原因（会写进 {@link AssetRegisterError}）；返回
   * `undefined` 表示放行。守卫在校验阶段调用，任一 spec 被拒不产生任何
   * 文件 / commit 副作用。
   */
  guard?: AssetPathGuard
}

/** 资产路径守卫：返回拒绝原因，或 `undefined` 放行。 */
export type AssetPathGuard = (path: string) => string | undefined

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
 * 大小写折叠键。
 *
 * macOS 的 APFS / HFS+ 默认大小写不敏感：`records/A.md` 与 `records/a.md`
 * 指向同一个目录项，先后写入不会报错，只会**静默覆盖**。本仓统一按
 * 「折叠后唯一」处理；Linux 等大小写敏感文件系统上也沿用同一规则，
 * 避免同一份领域包在不同平台表现不一致。
 */
function foldCase(path: string): string {
  return path.toLowerCase()
}

/** 一条写盘记录，用于失败回滚。 */
interface WrittenFile {
  /** 绝对路径。 */
  readonly file: string
  /** 写盘前的字节；`undefined` 表示该文件此前不存在（回滚时删除）。 */
  readonly previous?: Buffer
}

/** 递归建目录，并记录本次可能新建的目录（由浅到深），供回滚时清理。 */
function ensureDir(dir: string, createdDirs: string[]): void {
  const missing: string[] = []
  let cursor = dir
  while (!existsSync(cursor)) {
    missing.push(cursor)
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  // 先登记再 mkdir：即使递归创建中途失败，已创建的浅层目录也会被回滚清理。
  createdDirs.push(...missing.reverse())
  mkdirSync(dir, { recursive: true })
}

/** 回滚本批写盘：删除新建文件、恢复被覆盖文件的原始字节，再清理空目录。 */
function rollbackWrites(applied: readonly WrittenFile[], createdDirs: readonly string[]): string[] {
  const failures: string[] = []
  for (const item of [...applied].reverse()) {
    try {
      if (item.previous === undefined) {
        rmSync(item.file, { force: true })
      } else {
        writeFileSync(item.file, item.previous)
      }
    } catch (error) {
      failures.push(`${item.file}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // 只删除本次新建且已空的目录（rmdir 对非空目录会失败，忽略即可）。
  for (const dir of [...createdDirs].reverse()) {
    try {
      rmdirSync(dir)
    } catch {
      // 目录非空 / 从未创建：保留现状。git 不跟踪空目录，不会产生脏状态。
    }
  }
  return failures
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
  const guard = options.guard
  if (guard !== undefined && typeof guard !== 'function') {
    throw new TypeError('[assets] createAssetWriter 的 guard 必须是函数')
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

  /**
   * 在磁盘上按大小写折叠查找与 `path` 冲突的已存在条目。
   *
   * 逐段向下走：若某一层的真实文件名与声明大小写不同但折叠后相同，返回
   * 「磁盘真实相对路径」（用于在错误里点名两条路径）；完全一致或不存在
   * 返回 `undefined`。
   */
  function findDiskCaseConflict(path: string): string | undefined {
    const segments = segmentsOf(path)
    const actual: string[] = []
    let dir = assetsDir
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string
      let names: string[]
      try {
        names = readdirSync(dir).filter((name) => foldCase(name) === foldCase(segment))
      } catch {
        // 父目录不存在 / 不可读 ⇒ 没有可冲突的条目。
        return undefined
      }
      if (names.length === 0) return undefined
      const exact = names.find((name) => name === segment)
      const chosen = exact ?? (names[0] as string)
      actual.push(chosen)
      if (chosen !== segment) {
        // 保留磁盘真实大小写，剩余段用声明值拼出「磁盘上将被命中的路径」。
        return [...actual, ...segments.slice(index + 1)].join('/')
      }
      dir = join(dir, chosen)
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

    // 调用方注入的路径守卫：在校验阶段拒绝，保证整批零副作用。
    if (guard !== undefined) {
      const rejection = guard(path)
      if (rejection !== undefined) {
        if (typeof rejection !== 'string') {
          throw new AssetRegisterError(
            `${at}.path "${path}" 的 guard 返回值必须是字符串或 undefined`,
          )
        }
        throw new AssetRegisterError(`${at}.path "${path}" 被拒绝：${rejection}`)
      }
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

    // 大小写折叠检查（写盘前，零副作用）：批内仅大小写不同 ⇒ 直接拒绝。
    const seenFolded = new Map<string, string>()
    for (const plan of plans) {
      const folded = foldCase(plan.path)
      const previous = seenFolded.get(folded)
      if (previous !== undefined && previous !== plan.path) {
        throw new AssetRegisterError(
          `同一批次内路径仅大小写不同："${previous}" 与 "${plan.path}"；` +
            '目标平台文件系统大小写不敏感，两者会互相覆盖（按折叠后唯一处理）',
        )
      }
      seenFolded.set(folded, plan.path)
    }

    // 与磁盘已有条目「仅大小写不同」同样拒绝：APFS 上 `existsSync` 会命中，
    // 不拦截就会 seed 静默 skipped / upsert 覆盖掉另一个大小写的文件。
    for (const plan of plans) {
      const conflict = findDiskCaseConflict(plan.path)
      if (conflict !== undefined) {
        throw new AssetRegisterError(
          `路径 "${plan.path}" 与磁盘已有条目 "${conflict}" 仅大小写不同；` +
            '目标平台文件系统大小写不敏感，写入会静默覆盖（按折叠后唯一处理）',
        )
      }
    }

    // 阶段 2：统一落盘；任一失败 ⇒ 回滚本批已写入的文件后原样抛错。
    const written = plans.filter((plan) => plan.write)
    const applied: WrittenFile[] = []
    const createdDirs: string[] = []
    try {
      for (const plan of written) {
        const file = resolveAssetPath(assetsDir, plan.path)
        const existed = existsSync(file)
        // 备份原始字节：写失败时可能已截断文件，必须按字节恢复。
        const previous = existed ? readFileSync(file) : undefined
        // 先登记再写：`writeFileSync` 可能在截断/写入中途失败，此时该文件必须
        // 已在回滚名单里，否则会留下半截内容（新建的）或丢失原内容（被覆盖的）。
        applied.push({ file, ...(previous === undefined ? {} : { previous }) })
        ensureDir(dirname(file), createdDirs)
        writeFileSync(file, plan.spec.content, 'utf8')
      }
    } catch (error) {
      const rollbackFailures = rollbackWrites(applied, createdDirs)
      if (rollbackFailures.length > 0) {
        warn(`[assets] register 写盘失败后回滚未完全成功：${rollbackFailures.join('；')}`)
      }
      // 原始错误照常抛给调用方（不包裹、不吞）。
      throw error
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

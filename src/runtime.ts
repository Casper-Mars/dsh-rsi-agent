/**
 * 领域运行时（DomainRuntime）与路径体系 —— 技术方案 §7。
 *
 * 职责：
 *   1. **唯一**的 `DSH_RSI_HOME` 解析点（{@link resolveHomeRoot}）；
 *   2. 会话 id 的白名单校验与优先级解析（{@link resolveSessionId}）；
 *   3. 目录布局与权限落地（{@link createDomainRuntime}）；
 *   4. 运行时所需的最小基础设施实现：日志门面（{@link createDomainLogger}）与
 *      默认提交端口（{@link createDefaultCommitPort}）。
 *
 * 为什么日志/提交端口在本文件：`createDomainRuntime` 的产物必须自带 `logger`
 * 与 `commit`，若它们留在 `service.ts` 会形成 `service → runtime → service`
 * 的循环依赖。两者均是「运行时依赖的最小实现」，与 runtime 同层最自然。
 * `service.ts` / `index.ts` 仍原样 re-export，公开 API 不变。
 *
 * 叶子约束：只依赖 `node:*` 与纯契约/配置模块（`./types.js`、`./config.js`），
 * 不依赖 `service.ts` / `validate.ts` / `plugin.ts` 等业务模块。
 *
 * 环境变量：本文件只读 `DSH_RSI_HOME`（路径层）与 `DSH_HOME`（dsh 宿主 home
 * 隔离用，见 {@link resolveHomeRoot}）；`DSH_RSI_*` 的配置类变量由
 * `./config.js` 统一解析。
 */
import { accessSync, chmodSync, constants, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import {
  resolveCoreConfig,
  type CoreConfig,
  type ResolvedCoreConfig,
} from './config.js'
import {
  DOMAIN_API_VERSION,
  type CommitOptions,
  type CommitPort,
  type CommitResult,
  type DomainLogger,
  type DomainPackLogging,
  type DomainRuntime,
  type InstallOptions,
} from './types.js'
import { createLogging } from './log/index.js'

/** 默认工作区根目录名（位于用户主目录下）。 */
export const RSI_AGENT_HOME_NAME = '.dsh-rsi-agent'

/** 无领域（core 自身）时使用的目录段 / 领域 id。 */
export const CORE_DOMAIN_ID = 'core'

/** 目录布局（相对 `<home>`）。 */
export const RUNTIME_LAYOUT = Object.freeze({
  assets: 'assets',
  data: 'data',
  logs: 'logs',
  workspace: 'workspace',
})

/** 目录权限：`data` / `logs` 含用户私有数据，仅属主可访问。 */
export const PRIVATE_DIR_MODE = 0o700

/** 目录权限：`assets` / `workspace` 允许同机其他用户读取（缺省选择，见报告）。 */
export const SHARED_DIR_MODE = 0o755

/** 会话 id 白名单：字母 / 数字 / `.` / `_` / `-`。 */
export const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]+$/

/** 会话 id 长度上限（字符数）。 */
export const SESSION_ID_MAX_LENGTH = 128

/** 未提供任何会话 id 时的最终回落值（与插件名一致）。 */
export const DEFAULT_SESSION_ID = 'rsi-agent'

/** 会话 id 非法。`reason` 给出具体原因，便于调用方直接展示。 */
export class InvalidSessionIdError extends Error {
  /** 具体原因（空 / 特殊路径段 / 非法字符 / 超长）。 */
  readonly reason: string
  /** 被拒绝的原始值。 */
  readonly value: unknown

  constructor(value: unknown, reason: string) {
    super(`[runtime] sessionId 非法：${reason}`)
    this.name = 'InvalidSessionIdError'
    this.value = value
    this.reason = reason
  }
}

/**
 * 校验会话 id 并返回**具体原因**；合法返回 `undefined`。
 *
 * 规则（与 `DomainPack.defaultSessionId` 一致）：
 *   - 必须是非空字符串；
 *   - 长度 ≤ {@link SESSION_ID_MAX_LENGTH}；
 *   - 匹配 {@link SESSION_ID_PATTERN}；
 *   - 额外拒绝 `.` / `..`（二者满足字符白名单，但作为目录段会逃逸父目录）。
 */
export function describeSessionIdError(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return `必须是字符串，实际为 ${value === null ? 'null' : typeof value}`
  }
  if (value.length === 0) {
    return '不能为空字符串'
  }
  if (value.length > SESSION_ID_MAX_LENGTH) {
    return `超长：${value.length} 字符，上限 ${SESSION_ID_MAX_LENGTH}`
  }
  if (value === '.' || value === '..') {
    return `"${value}" 是特殊路径段，不能作为会话 id`
  }
  const illegal = [...value].find((char) => !SESSION_ID_PATTERN.test(char))
  if (illegal !== undefined) {
    return `含非法字符 ${JSON.stringify(illegal)}：仅允许 [a-zA-Z0-9._-]`
  }
  return undefined
}

function assertValidSessionId(value: unknown, source: string): string {
  const reason = describeSessionIdError(value)
  if (reason !== undefined) {
    throw new InvalidSessionIdError(value, `${reason}（来源：${source}）`)
  }
  return value as string
}

/** 会话 id 的三个来源（按优先级从高到低）。 */
export interface SessionIdSources {
  /** `install(options.sessionId)`。 */
  readonly options?: Pick<InstallOptions, 'sessionId'> | undefined
  /** 已解析配置（含 `DSH_RSI_SESSION_ID`）。 */
  readonly config?: Pick<CoreConfig, 'sessionId'> | undefined
  /** 领域包默认值。 */
  readonly pack?: { readonly defaultSessionId?: string } | undefined
}

/**
 * 解析会话 id。优先级：
 * `options.sessionId > config.sessionId > pack.defaultSessionId > 'rsi-agent'`。
 *
 * 任一「显式提供」的值非法都会立刻抛 {@link InvalidSessionIdError}（含具体原因），
 * 不做静默跳过 —— 否则配置错误会退化成难以排查的行为漂移。
 */
export function resolveSessionId(sources: SessionIdSources = {}): string {
  const { options, config, pack } = sources

  if (options?.sessionId !== undefined) {
    return assertValidSessionId(options.sessionId, 'install.options.sessionId')
  }
  if (config?.sessionId !== undefined) {
    return assertValidSessionId(config.sessionId, 'config.sessionId')
  }
  if (pack?.defaultSessionId !== undefined) {
    return assertValidSessionId(pack.defaultSessionId, 'pack.defaultSessionId')
  }
  return DEFAULT_SESSION_ID
}

/**
 * 解析 home 根目录（**不做**目录创建）。
 *
 * 优先级：`DSH_RSI_HOME`（非空）> `config.homeRoot` > `$DSH_HOME/.dsh-rsi-agent`
 * > `~/.dsh-rsi-agent`。
 *
 * `DSH_HOME` 是 dsh 宿主的 home 隔离变量：设置后 dsh 会把「`~`」重定向到该目录，
 * 插件若直接用 `os.homedir()` 会绕过隔离、污染真实 `~/.dsh`。故显式支持它，
 * 使「只设 `DSH_HOME` 即可整机隔离」成立（冒烟测试依赖此语义）。
 *
 * 返回值为 `path.resolve()` 归一化后的绝对路径。
 */
export function resolveHomeRoot(
  config: Pick<CoreConfig, 'homeRoot'> = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const envHome = env[RSI_AGENT_HOME_ENV]
  if (typeof envHome === 'string' && envHome.trim() !== '') {
    return resolve(envHome.trim())
  }
  const configured = config.homeRoot
  if (typeof configured === 'string' && configured.trim() !== '') {
    return resolve(configured.trim())
  }
  const dshHome = env.DSH_HOME
  const base =
    typeof dshHome === 'string' && dshHome.trim() !== ''
      ? resolve(dshHome.trim())
      : homedir()
  return resolve(base, RSI_AGENT_HOME_NAME)
}

/** 环境变量：覆盖工作区根目录。 */
export const RSI_AGENT_HOME_ENV = 'DSH_RSI_HOME'

const SAFE_SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/

/** 校验单段目录名：拒绝空串、`.`/`..`、路径分隔符与非法字符。 */
function assertSafeSegment(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[runtime] ${field} 必须是非空字符串，实际为 ${String(value)}`)
  }
  if (value === '.' || value === '..' || !SAFE_SEGMENT_PATTERN.test(value)) {
    throw new Error(
      `[runtime] ${field} 不能作为目录名（不允许 "." / ".." / 路径分隔符），实际为 ${JSON.stringify(value)}`,
    )
  }
  return value
}

/**
 * 断言 `child` 严格位于 `root` 之下（`root` 本身不算）。
 *
 * 用 `path.relative` 判断而非字符串 `startsWith`：后者会把 `/a/bc` 误判为
 * `/a/b` 的子路径。
 */
function assertWithin(root: string, child: string, field: string): void {
  const rel = relative(root, child)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `[runtime] ${field} 逃逸出 homeRoot：homeRoot=${root}，解析结果=${child}`,
    )
  }
}

/**
 * 幂等创建目录并**强制**权限为 `mode`。
 *
 * `mkdir` 的 `mode` 会被进程 umask 削减（例如 umask=077 时 `0o755` 会变成
 * `0o700`），故创建后显式 `chmod` 兜底。
 */
function ensureDir(dir: string, mode: number): string {
  mkdirSync(dir, { recursive: true, mode })
  try {
    chmodSync(dir, mode)
  } catch {
    /* 平台差异 / 权限不足：mkdir mode 已尽量收紧，不因 chmod 失败阻断启动。 */
  }
  return dir
}

/**
 * 幂等创建上层目录（`homeRoot` / `home`），**不** chmod 既有目录。
 *
 * 上层目录可能由用户预先创建（例如把 homeRoot 指到权限 0o700 的私有目录），
 * 强行放宽到 0o755 会造成权限回退，故只保证存在。
 */
function ensureParentDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: SHARED_DIR_MODE })
  return dir
}

/** 系统时区（`Intl` 不可用时回落 `UTC`）。 */
export function resolveSystemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/** {@link resolveTimezone} 的优先级选项。 */
export interface ResolveTimezoneOptions {
  /**
   * 谁优先：`config`（缺省，`CoreConfig.timezone` 优先）或 `pack`
   * （领域包 `scheduler.timezone` 优先）。
   *
   * 调度器按技术方案 §7 使用 `pack`：领域声明了时区就以领域为准，运维配置
   * 只作为领域未声明时的兜底；安装期（runtime）仍沿用 `config` 优先，保证
   * 既有语义与测试不变。
   */
  readonly prefer?: 'config' | 'pack'
}

/**
 * 解析运行时区：缺省 `config.timezone` > 领域包 `scheduler.timezone` > 系统时区；
 * `options.prefer === 'pack'` 时反转为 `pack > config > 系统`。
 *
 * 非法 IANA 名称直接抛 `RangeError`（和 `DomainPack` 校验的契约类错误一致）。
 */
export function resolveTimezone(
  config: Pick<CoreConfig, 'timezone'> = {},
  pack?: { readonly scheduler?: { readonly timezone?: string } } | undefined,
  options: ResolveTimezoneOptions = {},
): string {
  const fromConfig = (): string | undefined => {
    const configured = config.timezone
    if (typeof configured !== 'string' || configured.trim() === '') return undefined
    const timezone = configured.trim()
    if (!isValidTimezone(timezone)) {
      throw new RangeError(`[runtime] 时区非法：不是合法的 IANA 时区 ${JSON.stringify(timezone)}`)
    }
    return timezone
  }

  // 领域包的时区由 `validateDomainPack` 负责裁决（契约类错误必须由校验层抛出，
  // 否则错误类型会从 DomainPackValidationError 退化成 RangeError）；此处只取值。
  const fromPack = (): string | undefined => {
    const declared = pack?.scheduler?.timezone
    if (typeof declared !== 'string' || declared.trim() === '') return undefined
    return declared.trim()
  }

  // 显式给出的 CoreConfig 时区即使是「被领域包覆盖」的一方也必须先校验：
  // 静默忽略一个非法配置会让运维错误永久隐身。
  const configValue = fromConfig()
  const packValue = fromPack()
  if (options.prefer === 'pack') {
    return packValue ?? configValue ?? resolveSystemTimezone()
  }
  return configValue ?? packValue ?? resolveSystemTimezone()
}

/** 创建运行时所需的最小领域包形状（core 自身可为 `undefined`）。 */
export interface RuntimePack {
  readonly id: string
  readonly version: string
  readonly defaultSessionId?: string
  readonly scheduler?: { readonly timezone?: string }
  /** 可选的领域日志配置（见 `DomainPack.logging`）。 */
  readonly logging?: DomainPackLogging
}

/**
 * `createDomainRuntime` 的构造上下文。
 *
 * 注意：第二参数不是 cordis `Context`，而是显式列出的运行时依赖 —— 安装选项、
 * 日志/提交端口覆盖、环境变量注入都在这里，避免 runtime 反向依赖 `service.ts`
 * 的内部状态。需要读 `ctx.logger` 时通过 `nativeLogger` 传入。
 */
export interface CreateDomainRuntimeContext {
  /** 调用方/插件配置（`Partial<CoreConfig>`）。 */
  readonly config?: Partial<CoreConfig>
  /** 安装选项：`home` / `sessionId` 优先级高于 config。 */
  readonly installOptions?: InstallOptions
  /** 已解析好的日志门面（优先于 `nativeLogger`）。 */
  readonly logger?: DomainLogger
  /** 已解析好的提交端口（优先于默认端口）。 */
  readonly commit?: CommitPort
  /** 原生 logger（`ctx.logger`），用于构造 `DomainLogger`。 */
  readonly nativeLogger?: unknown
  /** 环境变量来源，缺省 `process.env`（测试注入用）。 */
  readonly env?: NodeJS.ProcessEnv
}

/** `DomainRuntime.config` 的形状：已解析配置 + 最终 homeRoot。 */
export type DomainRuntimeConfig = ResolvedCoreConfig & {
  /** 最终生效的 home 根目录（绝对路径）。 */
  readonly homeRoot: string
}

/** `createDomainRuntime` 的产物：契约字段 + 具体路径。 */
export interface CreatedDomainRuntime extends DomainRuntime {
  /** 本领域 home（`<homeRoot>/<pack.id>` 或 `<homeRoot>/core`）。 */
  readonly home: string
  readonly dataDir: string
  readonly logsDir: string
  readonly workspaceDir: string
  readonly timezone: string
  readonly config: DomainRuntimeConfig
}

/**
 * 创建领域运行时：解析 home / sessionId / timezone，落地目录，装配 logger 与
 * commit 端口。返回冻结对象（领域包只读消费）。
 *
 * 路径布局：`<home>/{assets,data,logs,workspace}`；有领域时
 * `<homeRoot>/<pack.id>`，无领域时 `<homeRoot>/core`。
 *
 * 目录权限：`data` / `logs` = `0o700`，`assets` / `workspace` = `0o755`。
 * `homeRoot` / `home` 以 `0o755` 创建（不 chmod 已存在的上层目录，避免收紧
 * 用户既有目录权限）。
 *
 * @param pack 领域包（core 自身传 `undefined`）。
 * @param ctx  运行时依赖（见 {@link CreateDomainRuntimeContext}）。
 */
export function createDomainRuntime(
  pack: RuntimePack | undefined,
  ctx: CreateDomainRuntimeContext = {},
): CreatedDomainRuntime {
  const env = ctx.env ?? process.env
  const installOptions = ctx.installOptions ?? {}
  const resolved = resolveCoreConfig(ctx.config ?? {}, env)

  const domainId = pack === undefined ? CORE_DOMAIN_ID : assertSafeSegment(pack.id, 'pack.id')
  const domainVersion = pack?.version ?? '0.0.0'

  // 安装选项的 `home` 显式指定时优先级最高（call-site 覆盖运维环境变量）。
  const homeRoot =
    typeof installOptions.home === 'string' && installOptions.home.trim() !== ''
      ? resolve(installOptions.home.trim())
      : resolveHomeRoot({ homeRoot: resolved.homeRoot }, env)

  const home = resolve(homeRoot, domainId)
  assertWithin(homeRoot, home, 'home')

  ensureParentDir(homeRoot)
  ensureParentDir(home)

  const assetsDir = ensureDir(join(home, RUNTIME_LAYOUT.assets), SHARED_DIR_MODE)
  const dataDir = ensureDir(join(home, RUNTIME_LAYOUT.data), PRIVATE_DIR_MODE)
  const logsDir = ensureDir(join(home, RUNTIME_LAYOUT.logs), PRIVATE_DIR_MODE)
  const workspaceDir = ensureDir(join(home, RUNTIME_LAYOUT.workspace), SHARED_DIR_MODE)

  // legacy `InstallOptions.assetsDir` 仍可覆盖（不创建、不 chmod，由调用方负责）。
  const effectiveAssetsDir =
    typeof installOptions.assetsDir === 'string' && installOptions.assetsDir.trim() !== ''
      ? resolve(installOptions.assetsDir.trim())
      : assetsDir

  const sessionId = resolveSessionId({ options: installOptions, config: resolved, pack })
  const timezone = resolveTimezone(resolved, pack)
  // 日志门面：无论 `ctx.logger` 是否存在，都组合「原生转发 + JSONL 落盘」。
  // 原生 logger 优先用调用方显式传入的 `ctx.logger`（已解析的 DomainLogger），
  // 否则用 cordis 的 `nativeLogger`；两者都缺失时门面内部降级 console。
  const logging = createLogging({
    scope: 'rsi-agent',
    logsDir,
    native: ctx.logger ?? ctx.nativeLogger,
    level: pack?.logging?.level ?? resolved.logLevel,
    retentionDays: pack?.logging?.retentionDays ?? resolved.logRetentionDays,
    maxBytes: resolved.logMaxSizeBytes,
    ...(pack?.logging?.secretKeys === undefined
      ? {}
      : { secretKeys: pack.logging.secretKeys }),
    ...(pack?.logging?.amountKeys === undefined
      ? {}
      : { amountKeys: pack.logging.amountKeys }),
    env,
  })
  const logger: DomainLogger = logging.logger
  const commit = ctx.commit ?? createDefaultCommitPort({ env })

  // 最终 config 反映「生效值」：homeRoot / sessionId / timezone 均已定值，
  // 便于领域包与排障代码直接读取实际运行参数。
  const config: DomainRuntimeConfig = Object.freeze({
    ...resolved,
    homeRoot,
    sessionId,
    timezone,
  })

  return Object.freeze({
    apiVersion: DOMAIN_API_VERSION,
    domainId,
    domainVersion,
    home,
    assetsDir: effectiveAssetsDir,
    dataDir,
    logsDir,
    workspaceDir,
    sessionId,
    timezone,
    config,
    logger,
    commit,
  })
}

// ---------------------------------------------------------------------------
// 日志门面
// ---------------------------------------------------------------------------

/**
 * 创建领域日志门面（向后兼容入口）。
 *
 * 内部委托 {@link createLogging}，但**不写文件**（`writeFile: false`），保持旧行为：
 * 有原生 logger 就转发，没有就降级 console。`child()` 由新门面顺带提供。
 *
 * `level` 传 `debug`（最啰嗦）：原生 logger 自带级别策略，门面不替它二次过滤，
 * 避免旧调用方的 `debug` 日志被默认阈值静默吞掉。
 */
export function createDomainLogger(native: unknown, scope: string): DomainLogger {
  return createLogging({ scope, native, level: 'debug', writeFile: false }).logger
}

// ---------------------------------------------------------------------------
// 默认提交端口（仅探测 + 降级；真正提交由后续任务实现）
// ---------------------------------------------------------------------------

/** 后续任务尚未实现的能力被调用时抛出。 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedError'
  }
}

/** 默认提交端口的可注入依赖（便于测试替换 PATH / 平台）。 */
export interface DefaultCommitPortOptions {
  /** 环境变量，缺省 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv
  /** 平台，缺省 `process.platform`。 */
  readonly platform?: NodeJS.Platform
  /** 可执行文件名，缺省 `git`。 */
  readonly executable?: string
  /** 可执行性探测，缺省用 `fs.accessSync`。 */
  readonly isExecutable?: (path: string) => boolean
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findExecutable(
  executable: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isExecutable: (path: string) => boolean,
): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? ''
  const extensions =
    platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']

  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, `${executable}${extension}`)
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * 默认提交端口：实时探测 `git` 是否在 PATH。
 *
 * - 不可用 → `commit()` 返回 `{ degraded: true, reason }`，安装流程不失败；
 * - 可用 → 抛 {@link NotImplementedError}，真正的资产提交由后续任务补齐。
 *
 * 探测不缓存，确保「运行期摘除 PATH 中的 git」能被立刻观察到。
 */
export function createDefaultCommitPort(options: DefaultCommitPortOptions = {}): CommitPort {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const executable = options.executable ?? 'git'
  const isExecutable = options.isExecutable ?? defaultIsExecutable

  const locate = (): string | undefined => findExecutable(executable, env, platform, isExecutable)

  return {
    isAvailable(): boolean {
      return locate() !== undefined
    },
    async commit(_options: CommitOptions): Promise<CommitResult> {
      if (!locate()) {
        return {
          degraded: true,
          reason: `git 不可用：PATH 中未找到可执行文件 "${executable}"`,
        }
      }
      throw new NotImplementedError(
        '[agentHost] commit 尚未实现：资产仓库提交由后续任务补齐（当前仅打通降级路径）',
      )
    },
  }
}

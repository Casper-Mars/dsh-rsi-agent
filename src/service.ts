/**
 * `agentHost` 服务实现。
 *
 * 职责边界（技术方案 §4 / §5）：
 *   - 同步装配：`install` 内完成契约校验与最小运行时创建，返回**幂等** Disposable；
 *   - 单领域：同一时刻只允许一个领域激活，第二个 `install` 直接抛错；
 *   - 逆序拆卸：按 {@link TEARDOWN_ORDER}（stop scheduler → dispose tools →
 *     restore persona → unregister firmware skills → unmount skill provider →
 *     clear active）执行；本任务只有 `active` 一步会入栈，后续任务通过
 *     {@link TeardownRegistry.add} 往对应阶段补步骤即可；
 *   - 基础设施降级：`git` 不可用、`ctx.logger` / `agents` / `sessionPersistence`
 *     缺失只 `warn`，不阻断安装。
 *
 * 本文件**不**实现 runtime 目录布局、资产 git 仓库、scheduler、persona 渲染、
 * skill provider 与固件 SKILL —— 这些属于后续任务。
 */
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { Service, type Context, type Disposable } from '@deepseek-ai/cordis'
import {
  DOMAIN_API_VERSION,
  type ActiveDomain,
  type AgentHostService,
  type CommitOptions,
  type CommitPort,
  type CommitResult,
  type DomainLogger,
  type DomainPack,
  type DomainRuntime,
  type InstallOptions,
} from './types.js'
import {
  validateDomainIdentity,
  validateDomainPack,
  type CoreSurface,
} from './validate.js'

/** 拆卸阶段，顺序即执行顺序（技术方案 §4）。 */
export type TeardownStage =
  | 'scheduler'
  | 'tools'
  | 'persona'
  | 'firmwareSkills'
  | 'skillProvider'
  | 'active'

/** 拆卸阶段的固定执行顺序。 */
export const TEARDOWN_ORDER: readonly TeardownStage[] = Object.freeze([
  'scheduler',
  'tools',
  'persona',
  'firmwareSkills',
  'skillProvider',
  'active',
])

/** 单个拆卸步骤。 */
export type Teardown = () => void

interface TeardownEntry {
  readonly label: string
  readonly run: Teardown
}

/** 拆卸注册表选项。 */
export interface TeardownRegistryOptions {
  /** 单个步骤失败时的回调（默认 `console.error`）；失败不会中断后续步骤。 */
  onError?: (error: unknown, label: string) => void
}

/**
 * 装配步骤注册表。
 *
 * 装配期按「先装后拆」的直觉调用 `add(stage, ...)`；`dispose()` 时按
 * {@link TEARDOWN_ORDER} 正序、同阶段内逆序（LIFO）执行。`dispose()` 幂等：
 * 第二次调用直接返回，不重复执行任何步骤，也不重复触发 `onError`。
 */
export class TeardownRegistry {
  private readonly stages = new Map<TeardownStage, TeardownEntry[]>()
  private readonly onError: (error: unknown, label: string) => void
  private disposed = false

  /** 稳定的幂等拆卸器（可直接作为 `Disposable` 返回）。 */
  readonly disposer: Disposable<void> = () => {
    this.dispose()
  }

  constructor(options: TeardownRegistryOptions = {}) {
    this.onError =
      options.onError ??
      ((error, label) => {
        console.error(`[agentHost] teardown "${label}" 失败`, error)
      })
  }

  /** 已登记的步骤数。 */
  get size(): number {
    let total = 0
    for (const list of this.stages.values()) total += list.length
    return total
  }

  /** 是否已完成拆卸。 */
  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * 登记一个拆卸步骤。已拆卸后再登记为 no-op（避免在失活上下文上补装）。
   */
  add(stage: TeardownStage, label: string, run: Teardown): void {
    if (this.disposed) return
    let list = this.stages.get(stage)
    if (!list) {
      list = []
      this.stages.set(stage, list)
    }
    list.push({ label, run })
  }

  /**
   * 执行全部拆卸步骤。幂等；单步失败被隔离并上报，不阻断其余步骤。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    for (const stage of TEARDOWN_ORDER) {
      const list = this.stages.get(stage)
      if (!list) continue
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const entry = list[index]
        try {
          entry.run()
        } catch (error) {
          this.onError(error, `${stage}:${entry.label}`)
        }
      }
      list.length = 0
    }
    this.stages.clear()
  }
}

/** `agentHost` 服务配置（Cordis class plugin 装载时作为第二个参数传入）。 */
export interface AgentHostConfig {
  /** core 已注册的工具名（无法从 `ctx.tools` 枚举时的补充来源）。 */
  readonly toolNames?: readonly string[]
  /** 缺省资产根目录。 */
  readonly assetsDir?: string
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

/** 后续任务尚未实现的能力被调用时抛出。 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedError'
  }
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

/** 日志降级前的告警只输出一次。 */
let warnedMissingLogger = false

/**
 * 创建领域日志门面。
 *
 * `ctx.logger` 缺失或形态非法时降级到 `console`（技术方案 §4.5：基础设施类
 * 错误 `warn` 后继续）。
 */
export function createDomainLogger(native: unknown, scope: string): DomainLogger {
  const prefix = `[${scope}]`
  const emit = (level: 'error' | 'warn' | 'info' | 'debug') => {
    return (message: string, meta?: unknown): void => {
      const method =
        typeof native === 'object' || typeof native === 'function'
          ? (native as Record<string, unknown>)[level]
          : undefined
      if (typeof method === 'function') {
        const call = method as (message: string, ...rest: unknown[]) => void
        if (meta === undefined) call.call(native, `${prefix} ${message}`)
        else call.call(native, `${prefix} ${message}`, meta)
        return
      }
      const fallback = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'info' ? console.info : console.debug
      if (meta === undefined) fallback(`${prefix} ${message}`)
      else fallback(`${prefix} ${message}`, meta)
    }
  }

  if (native === undefined && !warnedMissingLogger) {
    warnedMissingLogger = true
    console.warn(`${prefix} ctx.logger 缺失，日志降级到 console`)
  }

  return {
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
  }
}

/** 最小运行时工厂的选项。 */
export interface DefaultDomainRuntimeOptions {
  readonly assetsDir?: string
  readonly sessionId?: string
  readonly logger?: DomainLogger
  readonly commit?: CommitPort
}

/**
 * 最小领域运行时工厂。
 *
 * 仅回填调用方提供的字段，不推导目录布局、不切 home、不创建任何文件 ——
 * 这些是后续 runtime 任务的职责。
 */
export function createDefaultDomainRuntime(
  pack: Pick<DomainPack, 'id' | 'version' | 'defaultSessionId'>,
  options: DefaultDomainRuntimeOptions = {},
): DomainRuntime {
  const logger = options.logger ?? createDomainLogger(undefined, `domain:${pack.id}`)
  return Object.freeze({
    apiVersion: DOMAIN_API_VERSION,
    domainId: pack.id,
    domainVersion: pack.version,
    sessionId: options.sessionId ?? pack.defaultSessionId,
    assetsDir: options.assetsDir ?? '',
    logger,
    commit: options.commit ?? createDefaultCommitPort(),
  })
}

function readService(ctx: Context, name: string): unknown {
  const getter = (ctx as unknown as { get?: (serviceName: string) => unknown }).get
  if (typeof getter === 'function') {
    try {
      const value = getter.call(ctx, name)
      if (value !== undefined) return value
    } catch {
      // 落到属性读取
    }
  }
  try {
    return (ctx as unknown as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}

function safeId(pack: unknown): string {
  if (typeof pack === 'object' && pack !== null) {
    const id = (pack as { id?: unknown }).id
    if (typeof id === 'string') return id
  }
  return '<unknown>'
}

/**
 * `agentHost` Cordis Service。
 *
 * 作为 class plugin 装载（`ctx.plugin(AgentHost)`）或直接
 * `new AgentHost(ctx)` 均可；`super(ctx, 'agentHost')` 会把实例注册为
 * `ctx.agentHost`，并随所属 fiber 卸载自动注销。
 */
export class AgentHost extends Service<never> implements AgentHostService {
  /** 服务实现的契约版本。 */
  readonly apiVersion: typeof DOMAIN_API_VERSION = DOMAIN_API_VERSION

  private readonly config: AgentHostConfig
  private readonly logger: DomainLogger
  private current: ActiveDomain | undefined

  constructor(ctx: Context, config: AgentHostConfig = {}) {
    super(ctx, 'agentHost')
    this.config = config
    const nativeLogger = readService(ctx, 'logger')
    this.logger = createDomainLogger(nativeLogger, 'agentHost')
  }

  /** 当前激活领域；只读访问器，外部无法赋值。 */
  get active(): ActiveDomain | undefined {
    return this.current
  }

  /**
   * 同步安装领域包。
   *
   * 契约类错误直接抛出（插件加载失败），基础设施类错误 `warn` 后继续。
   */
  install(pack: DomainPack, options: InstallOptions = {}): Disposable<void> {
    const current = this.current
    if (current) {
      throw new Error(
        `[agentHost] 单领域约束：领域 "${current.id}" (version ${current.version}) 已激活，` +
          `无法再安装领域 "${safeId(pack)}"；请先 dispose 现有安装`,
      )
    }

    const logger = options.logger ?? this.logger
    const core = this.buildCoreSurface(logger)

    // 身份字段先校验，避免用未校验字段构造运行时。
    const identity = validateDomainIdentity(pack)

    const commit = options.commit ?? createDefaultCommitPort()
    const runtime = options.createRuntime
      ? options.createRuntime(identity.pack, this.ctx)
      : createDefaultDomainRuntime(identity.pack, {
          assetsDir: options.assetsDir ?? this.config.assetsDir ?? '',
          sessionId: options.sessionId,
          logger,
          commit,
        })

    // 全量契约校验（含 tools() 返回值与 core 工具重名检查）。
    const validated = validateDomainPack(pack, {
      ...core,
      runtime,
      toolContext: this.ctx,
    })

    if (!runtime.commit.isAvailable()) {
      logger.warn(
        `领域 "${identity.id}" 的 git 不可用：安装继续，commit 将返回 degraded:true（降级）`,
      )
    }

    const registry = new TeardownRegistry({
      onError: (error, label) => {
        logger.warn(`拆卸步骤 "${label}" 失败（已继续后续步骤）`, error)
      },
    })

    const disposable = registry.disposer
    const active: ActiveDomain = Object.freeze({
      id: identity.id,
      version: identity.version,
      displayName: identity.pack.displayName,
      sessionId: runtime.sessionId,
      assetsDir: runtime.assetsDir,
      installedAt: Date.now(),
      toolNames: Object.freeze([...validated.toolNames]),
      pack: identity.pack,
      runtime,
      disposable,
    })

    try {
      this.current = active
      // 本任务唯一已实现的装配步骤：active 快照。后续任务把 scheduler / tools /
      // persona / firmwareSkills / skillProvider 的 teardown 加到对应阶段即可，
      // 无需改动 dispose 逻辑。
      registry.add('active', 'clear active domain', () => {
        if (this.current === active) this.current = undefined
      })
    } catch (error) {
      registry.dispose()
      throw error
    }

    return disposable
  }

  private buildCoreSurface(logger: DomainLogger): CoreSurface {
    const tools = readService(this.ctx, 'tools') as
      | { get?: (name: string) => unknown }
      | undefined

    if (!tools) {
      logger.warn('tools 服务缺失，跳过 core 工具重名检查（降级继续）')
    }

    for (const name of ['agents', 'sessionPersistence'] as const) {
      if (!readService(this.ctx, name)) {
        logger.warn(`依赖服务 "${name}" 缺失，相关能力降级（继续安装）`)
      }
    }

    return {
      toolNames: this.config.toolNames,
      hasTool:
        tools && typeof tools.get === 'function'
          ? (name: string) => tools.get?.(name) !== undefined
          : undefined,
    }
  }
}

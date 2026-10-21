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
import { Service, type Context, type Disposable } from '@deepseek-ai/cordis'
import { ensureAssetsRepo } from './assets/repo.js'
import { createAssetTools } from './assets/tools.js'
import type { CoreConfig } from './config.js'
import {
  evolutionPolicyOverridesFromPack,
  mergeEvolutionPolicy,
} from './evolution/policy.js'
import { registerFirmwareSkills } from './evolution/skills.js'
import { createDomainLogger, createDomainRuntime } from './runtime.js'
import {
  DOMAIN_API_VERSION,
  type ActiveDomain,
  type AgentHostService,
  type DomainLogger,
  type DomainPack,
  type InstallOptions,
  type ToolDefinition,
} from './types.js'
import {
  DomainPackValidationError,
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
  /** 插件配置（§14.1）；`install` 的 `options.home/sessionId` 优先级更高。 */
  readonly config?: Partial<CoreConfig>
  /** 环境变量来源（仅测试注入；本文件不直接读取环境变量）。 */
  readonly env?: NodeJS.ProcessEnv
}

/**
 * 运行时实现已迁至 `./runtime.js`（避免 `service → runtime → service` 循环依赖）。
 * 这里原样 re-export，保持既有公开 API 与导入路径不变。
 */
export {
  createDefaultCommitPort,
  createDomainLogger,
  createDomainRuntime,
  InvalidSessionIdError,
  NotImplementedError,
  RSI_AGENT_HOME_NAME,
  SESSION_ID_MAX_LENGTH,
  SESSION_ID_PATTERN,
  DEFAULT_SESSION_ID,
  resolveHomeRoot,
  resolveSessionId,
  resolveTimezone,
  type CreatedDomainRuntime,
  type CreateDomainRuntimeContext,
  type DefaultCommitPortOptions,
  type DomainRuntimeConfig,
  type RuntimePack,
  type SessionIdSources,
} from './runtime.js'

/** `ctx.tools` 的最小结构：只依赖 dsh-tools 的公开方法，不引入运行时依赖。 */
interface ToolRegistryLike {
  /** 注册一个工具，返回它的 unregister 函数（dsh-tools 契约）。 */
  register(definition: ToolDefinition): () => void
  /** 查当前可见工具；用于注册前的重名预检。 */
  get?(name: string): unknown
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
  private readonly nativeLogger: unknown
  private readonly env: NodeJS.ProcessEnv | undefined
  private current: ActiveDomain | undefined

  constructor(ctx: Context, config: AgentHostConfig = {}) {
    super(ctx, 'agentHost')
    this.config = config
    this.nativeLogger = readService(ctx, 'logger')
    this.logger = createDomainLogger(this.nativeLogger, 'agentHost')
    this.env = config.env
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

    const runtime = options.createRuntime
      ? options.createRuntime(identity.pack, this.ctx)
      : createDomainRuntime(identity.pack, {
          config: this.config.config,
          installOptions: {
            // `AgentHostConfig.assetsDir` 是服务级默认值，优先级低于 install 选项。
            assetsDir: options.assetsDir ?? this.config.assetsDir,
            home: options.home,
            sessionId: options.sessionId,
          },
          logger,
          nativeLogger: this.nativeLogger,
          env: this.env,
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
      // §4.2 装配顺序：runtime → assets 仓库 → core 工具 → 领域工具 → active。
      // 仓库不可用只 warn（资产能力降级），不阻断领域安装；仓库不随拆卸删除。
      const repo = ensureAssetsRepo(runtime.home, {
        assetsDir: runtime.assetsDir,
        logger: { warn: (message: string) => logger.warn(message) },
      })
      if (repo.degraded) {
        logger.warn(
          `资产仓库不可用（降级）：${repo.reason ?? '未知原因'}；asset_commit 将返回 degraded:true`,
        )
      }

      // core 工具（asset_commit / asset_history / asset_show）先注册：领域工具
      // 若与之重名，会在下一步的重名检查里被点名，从而不留半个激活领域。
      this.registerCoreTools(
        createAssetTools({ runtime, assetTypes: identity.pack.assetTypes }),
        registry,
        logger,
      )

      // 工具真正落盘到 ctx.tools 必须先于 active 快照：注册失败不留半个激活领域。
      this.registerTools(validated.tools, validated.toolNames, registry, logger)

      // 固件 SKILL：静态注册（rsi-evolution 按生效策略渲染）。重名属于契约错误，
      // 会在 catch 中连同已注册工具一起回滚；`ctx.skills` 缺失只 warn 降级。
      const firmwareUnregisters = registerFirmwareSkills(this.ctx, {
        pack: identity.pack,
        policy: mergeEvolutionPolicy(
          evolutionPolicyOverridesFromPack(identity.pack.evolutionPolicy),
        ),
        assetTypes: identity.pack.assetTypes,
      })
      // 按注册顺序入栈；同阶段 LIFO ⇒ dispose 时逆序反注销。
      for (const unregister of firmwareUnregisters) {
        registry.add('firmwareSkills', 'unregister firmware skill', unregister)
      }

      this.current = active
      // 后续任务把 scheduler / persona / firmwareSkills / skillProvider 的 teardown
      // 加到对应阶段即可，无需改动 dispose 逻辑。
      registry.add('active', 'clear active domain', () => {
        if (this.current === active) this.current = undefined
      })
    } catch (error) {
      registry.dispose()
      throw error
    }

    return disposable
  }

  /**
   * 注册 core 自带工具（`asset_commit` / `asset_history` / `asset_show`）。
   *
   * 复用 {@link registerTools} 的**同一条**注册路径：重名预检（含领域工具
   * 与 `ctx.tools` 已有工具）、失败回滚、`tools` 阶段反注册。core 工具名同样
   * 受契约保护，不允许被领域包覆盖。
   */
  private registerCoreTools(
    tools: readonly ToolDefinition[],
    registry: TeardownRegistry,
    logger: DomainLogger,
  ): void {
    this.registerTools(
      tools,
      tools.map((definition) => definition.name),
      registry,
      logger,
    )
  }

  /**
   * 把领域声明的工具（以及 core 工具）逐个注册到 `ctx.tools`，并把 unregister
   * 压入 teardown 的 `tools` 阶段（同阶段 LIFO ⇒ dispose 时逆序反注册）。
   *
   * 失败语义：
   *   - 重名（含 `ctx.tools` 已注册的同名工具）→ 抛契约错误并列出冲突名；
   *   - 任一工具注册失败 → 回滚已注册的工具，再抛契约错误（错误信息含已回滚
   *     的工具名与底层原因）。
   *
   * 降级：`tools` 服务缺失（或不是 dsh-tools 注册表）时只 `warn`，与既有
   * “基础设施缺失不阻断安装”的契约一致（见类注释）。
   */
  private registerTools(
    tools: readonly ToolDefinition[],
    toolNames: readonly string[],
    registry: TeardownRegistry,
    logger: DomainLogger,
  ): void {
    const native = readService(this.ctx, 'tools')
    const target =
      native && typeof native === 'object' && typeof (native as ToolRegistryLike).register === 'function'
        ? (native as ToolRegistryLike)
        : undefined

    if (!target) {
      logger.warn('tools 服务缺失或不支持 register()，跳过工具注册（降级继续）')
      return
    }

    const conflicts = toolNames.filter((name) => target.get?.(name) !== undefined)
    if (conflicts.length > 0) {
      throw new DomainPackValidationError(
        'tools',
        `与已注册工具重名：[${conflicts.join(', ')}]`,
      )
    }

    const registered: Array<{ name: string; unregister: () => void }> = []
    let failing = '<unknown>'
    try {
      for (const definition of tools) {
        failing = definition.name
        const unregister = target.register(definition)
        if (typeof unregister !== 'function') {
          throw new TypeError(
            `ctx.tools.register("${definition.name}") 未返回 unregister 函数（实际为 ${typeof unregister}）`,
          )
        }
        registered.push({ name: definition.name, unregister })
      }
    } catch (error) {
      const rolledBack = this.rollbackTools(registered, logger)
      const detail = error instanceof Error ? error.message : String(error)
      throw new DomainPackValidationError(
        'tools',
        `注册工具 "${failing}" 失败（冲突/非法工具名，已回滚 [${rolledBack.join(', ')}]）：${detail}`,
      )
    }

    // 按注册顺序入栈；同阶段 LIFO ⇒ dispose 时逆序反注册。
    for (const entry of registered) {
      registry.add('tools', `unregister tool "${entry.name}"`, entry.unregister)
    }
  }

  /** 逆序反注册；单步失败只 warn，不阻断回滚。返回已成功回滚的工具名。 */
  private rollbackTools(
    registered: ReadonlyArray<{ name: string; unregister: () => void }>,
    logger: DomainLogger,
  ): string[] {
    const done: string[] = []
    for (let index = registered.length - 1; index >= 0; index -= 1) {
      const entry = registered[index]
      try {
        entry.unregister()
        done.push(entry.name)
      } catch (error) {
        logger.warn(`回滚工具 "${entry.name}" 失败`, error)
      }
    }
    return done
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

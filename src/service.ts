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
import { createAssetWriter } from './assets/writer.js'
import type { CoreConfig } from './config.js'
import {
  evolutionPolicyOverridesFromPack,
  mergeEvolutionPolicy,
} from './evolution/policy.js'
import { createFirmwareSkillGuard } from './evolution/firmware-guard.js'
import { registerFirmwareSkills } from './evolution/skills.js'
import { readService, serviceOf } from './context.js'
import {
  CORE_OPENING_NOTICE_SUMMARY,
  CORE_OPENING_NOTICE_TEXT,
  deliverOpeningNotice,
  type OpeningNoticeAgents,
  type OpeningNoticeDeps,
  type SessionProjectionsLike,
} from './opening-notice.js'
import { createPersonaSlot, mountPersonaSlot, type PersonaSlot } from './prompts/persona.js'
import { createAgentWakeSink, createSchedulerService, type SchedulerService } from './scheduler/index.js'
import type { WakeAgentsLike } from './scheduler/service.js'
import { createDomainLogger, createDomainRuntime } from './runtime.js'
import {
  ensureSession,
  type EnsureAgentHandle,
  type EnsureAgentsLike,
  type EnsureSessionPersistenceLike,
} from './session-ensure.js'
import { hasSkillAssetType, mountSkillFilesystemProvider } from './skills/provider.js'
import { startStartupSequence, type StartupController, type StartupServices } from './startup.js'
import {
  DOMAIN_API_VERSION,
  type ActiveDomain,
  type AgentHostService,
  type DomainLogger,
  type DomainPack,
  type DomainRuntime,
  type InstallOptions,
  type ToolDefinition,
} from './types.js'
import {
  DomainPackValidationError,
  runAssetsBootstrap,
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

/** 会话持久化服务：ensure 需要 `stat`，notice 判读需要 `open`（可选）。 */
type SessionPersistenceService = EnsureSessionPersistenceLike &
  Partial<Pick<OpeningNoticeDeps['sessionPersistence'], 'open'>>

/** `ctx.tools` 的最小结构：只依赖 dsh-tools 的公开方法，不引入运行时依赖。 */
interface ToolRegistryLike {
  /** 注册一个工具，返回它的 unregister 函数（dsh-tools 契约）。 */
  register(definition: ToolDefinition): () => void
  /** 查当前可见工具；用于注册前的重名预检。 */
  get?(name: string): unknown
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
  /** 最近一次 install 的 provider 就绪信号；未挂载时为已 resolve。 */
  private providerReady: Promise<void> = Promise.resolve()
  /** persona 单槽位：全程只注册一个 section，领域装/卸只切内部文案。 */
  private readonly persona: PersonaSlot
  /** 启动宽限控制器；`start()` 只允许创建一次。 */
  private startupController: StartupController | undefined
  /**
   * 正在同步装配的 install 计数（`> 0` 表示装配中）。
   *
   * 供启动计时器判断是否顺延：install 结果出来之前不投通用开场。
   */
  private installingDepth = 0

  constructor(ctx: Context, config: AgentHostConfig = {}) {
    super(ctx, 'agentHost')
    this.config = config
    this.nativeLogger = readService(ctx, 'logger')
    this.logger = createDomainLogger(this.nativeLogger, 'agentHost')
    this.env = config.env

    // 通用人设槽位：core 启动即注册唯一 section；内容随领域 install 切换。
    this.persona = createPersonaSlot({
      logger: {
        info: (message, meta) => this.logger.info(message, meta),
        warn: (message, meta) => this.logger.warn(message, meta),
      },
    })
    mountPersonaSlot(this.ctx, this.persona, {
      warn: (message, meta) => this.logger.warn(message, meta),
    })
  }

  /** 当前激活领域；只读访问器，外部无法赋值。 */
  get active(): ActiveDomain | undefined {
    return this.current
  }

  /**
   * 最近一次 `install` 的 SKILL provider 就绪信号。
   *
   * - 领域声明了 `skills/` 前缀：`await` 后 `ctx.skills.list()` **立即**可见
   *   provider 贡献的 SKILL（含依赖缺失降级场景，此时为已 resolve）；
   * - 未声明 / 尚未安装：已 resolve 的 Promise，`await` 不产生等待。
   *
   * 只读；由 `install` 内部维护，测试与诊断用它替代 sleep。
   */
  get skillProviderReady(): Promise<void> {
    return this.providerReady
  }

  /**
   * 同步安装领域包。
   *
   * 契约类错误直接抛出（插件加载失败），基础设施类错误 `warn` 后继续。
   *
   * 装配全程递增 {@link installingDepth}：启动计时器到期时若仍在装配，会
   * 顺延而不是抢跑投递通用开场。
   */
  install(pack: DomainPack, options: InstallOptions = {}): Disposable<void> {
    this.installingDepth += 1
    try {
      return this.installDomain(pack, options)
    } finally {
      this.installingDepth -= 1
    }
  }

  /** {@link install} 的装配主体（由计数包装器调用）。 */
  private installDomain(pack: DomainPack, options: InstallOptions = {}): Disposable<void> {
    const current = this.current
    if (current) {
      throw new Error(
        `[agentHost] 单领域约束：领域 "${current.id}" (version ${current.version}) 已激活，` +
          `无法再安装领域 "${safeId(pack)}"；请先 dispose 现有安装`,
      )
    }

    const logger = options.logger ?? this.logger
    // 新一轮安装：先归零就绪信号，避免外部读到上一次安装的 Promise。
    this.providerReady = Promise.resolve()
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
      // §4.2 装配顺序：runtime → assets 仓库 → 固件 Skill → core 工具 → 领域工具
      // → 领域资产 bootstrap → active。仓库不可用只 warn（资产能力降级），不阻断
      // 领域安装；仓库不随拆卸删除。
      const repo = ensureAssetsRepo(runtime.home, {
        assetsDir: runtime.assetsDir,
        logger: { warn: (message: string) => logger.warn(message) },
      })
      if (repo.degraded) {
        logger.warn(
          `资产仓库不可用（降级）：${repo.reason ?? '未知原因'}；asset_commit 将返回 degraded:true`,
        )
      }

      // 固件 SKILL：静态注册（rsi-evolution 按生效策略渲染）。重名属于契约错误，
      // 会在 catch 中连同已注册工具一起回滚；`ctx.skills` 缺失只 warn 降级。
      const firmwareUnregisters = registerFirmwareSkills(this.ctx, {
        pack: identity.pack,
        policy: mergeEvolutionPolicy(
          evolutionPolicyOverridesFromPack(identity.pack.evolutionPolicy),
        ),
        assetTypes: identity.pack.assets.types,
        // secondary 防线：拦历史落盘的固件同名资产（首次安装时目录为空）。
        assetsDir: runtime.assetsDir,
      })
      // 按注册顺序入栈；同阶段 LIFO ⇒ dispose 时逆序反注销。
      for (const unregister of firmwareUnregisters) {
        registry.add('firmwareSkills', 'unregister firmware skill', unregister)
      }

      // core 工具（asset_commit / asset_history / asset_show）先于领域工具注册：
      // 领域工具若与之重名，会在下一步的重名检查里被点名，从而不留半个激活领域。
      this.registerCoreTools(
        createAssetTools({ runtime, assetTypes: identity.pack.assets.types }),
        registry,
        logger,
      )

      // 工具真正落盘到 ctx.tools 必须先于 active 快照：注册失败不留半个激活领域。
      this.registerTools(validated.tools, validated.toolNames, registry, logger)

      // 领域自己的资产注册（§11.1）：同步执行；抛错则整个 install 失败，
      // registry.dispose() 回滚已装配的工具 / 固件 Skill。
      // 注意：bootstrap 内 register 的资产**不进 teardown**（磁盘资产按 §4.3 保留）。
      const writer = createAssetWriter({
        runtime,
        assetTypes: identity.pack.assets.types,
        logger: { warn: (message: string) => logger.warn(message) },
        // primary 防线：bootstrap 在固件注册之后执行，只有写盘边界能在
        // **首次安装**时拦住 `skills/<固件名>/...`（校验阶段拒绝 ⇒ 整批零副作用）。
        guard: createFirmwareSkillGuard(),
      })
      runAssetsBootstrap(identity.pack, writer)

      // 可进化 SKILL（§11.1 / §11.2）：领域声明了 `skills/` 前缀才挂 provider。
      // 同步装配 + 惰性异步加载；依赖缺失 / 挂载失败只 warn 降级（验收 7）。
      // 注销压入 `skillProvider` 阶段，`registry.dispose()` 时同步触发。
      if (hasSkillAssetType(identity.pack.assets.types)) {
        const provider = mountSkillFilesystemProvider(this.ctx, {
          assetsDir: runtime.assetsDir,
          logger,
        })
        this.providerReady = provider.ready
        registry.add('skillProvider', 'unmount skill provider', () => {
          void provider.dispose()
        })
      }

      // 人设切换（§8.1 / §8.2）：只改单 section 的动态 text，**不重建会话**。
      // 放在所有装配动作之后：任何一步失败都不会留下「半个领域人设」。
      this.persona.useDomain(validated.personaMarkdown, identity.id)
      registry.add('persona', 'restore core persona', () => {
        this.persona.restore(identity.id)
      })

      // 调度器装配（§12）：任务定义目录缺省 `<assetsDir>/tasks`；时区优先级
      // `pack.scheduler.timezone > CoreConfig.timezone > 系统`。装配失败只 warn
      // （定时能力降级，不影响领域安装）。start 放在 active 落地之后，避免任务
      // 在「安装尚未成功」的窗口里被触发。
      const scheduler = this.mountScheduler(identity.pack, runtime, logger, registry)

      this.current = active
      // 领域已成功落地 → 取消启动宽限，本轮只由领域路径投递开场。
      // 位置必须在所有校验 / 装配动作之后：install 失败不得消耗宽限，
      // 否则无重试时默认会话将一直 blank（D1）。
      this.cancelStartup(`install domain ${identity.id}`)
      // 后续任务把 scheduler / firmwareSkills / skillProvider 的 teardown
      // 加到对应阶段即可，无需改动 dispose 逻辑。
      registry.add('active', 'clear active domain', () => {
        if (this.current === active) this.current = undefined
        this.providerReady = Promise.resolve()
      })

      scheduler?.start()

      // 会话 ensure + 开场 notice（§8.3 / §8.4）：异步执行、失败只 warn 不抛。
      this.startDomainSession(active, identity.pack, logger, registry)
    } catch (error) {
      // 不出现「表面成功」：安装失败必须留下 error 日志（含 bootstrap 中途失败）。
      logger.error(
        `领域 "${identity.id}" 安装失败，回滚已装配的工具 / 固件 Skill / skill provider`,
        error,
      )
      registry.dispose()
      this.providerReady = Promise.resolve()
      throw error
    }

    return disposable
  }

  /**
   * 启动核心序列（由 `plugin.apply` 在 core 启动时调用一次）。
   *
   * 行为：
   *   - 以 `startupGraceMs` 起计时器（`ctx.effect` 托管，插件卸载自动清理）；
   *   - 计时器到期且期间没有领域 install → 通用路径 ensure + 通用开场；
   *   - 宽限期内 `install` **成功**后才调用 {@link cancelStartup}（装配失败不消耗
   *     宽限）；install 装配期间计时器到期会顺延 50ms；
   *   - `startupGraceMs === 0` → 立即执行通用路径（同步/微任务内可见）。
   *
   * 幂等：重复调用只保留第一次的控制器。
   */
  start(): StartupController | undefined {
    if (this.startupController) return this.startupController

    let runtime
    try {
      runtime = createDomainRuntime(undefined, {
        config: this.config.config,
        logger: this.logger,
        nativeLogger: this.nativeLogger,
        env: this.env,
      })
    } catch (error) {
      this.logger.error('[rsi-agent/startup] 通用运行时创建失败，跳过启动序列', error)
      return undefined
    }

    const controller = startStartupSequence({
      graceMs: runtime.config.startupGraceMs,
      sessionId: runtime.sessionId,
      workspaceDir: runtime.workspaceDir,
      resolveServices: () => this.startupServices(),
      isInstalling: () => this.installingDepth > 0,
      logger: this.logger,
      noticeText: CORE_OPENING_NOTICE_TEXT,
      noticeSummary: CORE_OPENING_NOTICE_SUMMARY,
      onSessionHandle: (handle) => this.bindSessionHandle(handle),
    })

    // 计时器由插件 fiber 托管：插件卸载时取消，绝不会在失活上下文里投递。
    try {
      this.ctx.effect(() => () => controller.cancel('plugin unload'), 'rsi-agent startup grace')
    } catch (error) {
      this.logger.warn('[rsi-agent/startup] 启动计时器 effect 绑定失败（降级）', error)
    }

    this.startupController = controller
    return controller
  }

  /** 取消启动宽限（领域 install / 插件卸载）。 */
  private cancelStartup(reason: string): void {
    this.startupController?.cancel(reason)
  }

  /** 读取启动期所需的会话服务（缺失即降级，由 startup 模块记录日志）。 */
  private startupServices(): StartupServices {
    return {
      agents: serviceOf<EnsureAgentsLike>(this.ctx, 'agents'),
      sessionPersistence: serviceOf<SessionPersistenceService>(this.ctx, 'sessionPersistence'),
      sessionProjections: serviceOf<SessionProjectionsLike>(this.ctx, 'sessionProjections'),
    }
  }

  /** 把启动路径拿到的会话 handle 绑定到插件 fiber（卸载自动拆除）。 */
  private bindSessionHandle(handle: EnsureAgentHandle): void {
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      void handle.dispose().catch(() => {})
    }
    try {
      this.ctx.effect(() => dispose, 'rsi-agent startup session')
    } catch (error) {
      this.logger.warn('[rsi-agent/startup] 会话 handle 绑定失败，立即拆除（降级）', error)
      dispose()
    }
  }

  /**
   * 领域安装后的会话 ensure + 开场 notice（异步、绝不抛）。
   *
   * - ensure 三分支由 {@link ensureSession} 负责；
   * - handle 同时绑定 `ctx.effect`（插件 fiber 卸载）与领域 teardown（uninstall）；
   * - 投递文案优先级：`pack.openingNotice` > 通用文案；
   * - 任一服务缺失 / 调用失败只 `warn`，不影响 install 成功。
   */
  private startDomainSession(
    active: ActiveDomain,
    pack: DomainPack,
    logger: DomainLogger,
    registry: TeardownRegistry,
  ): void {
    const agents = serviceOf<EnsureAgentsLike>(this.ctx, 'agents')
    const persistence = serviceOf<SessionPersistenceService>(this.ctx, 'sessionPersistence')

    if (!agents || typeof agents.get !== 'function') {
      logger.warn('agents 服务不可用，跳过领域会话 ensure / 开场 notice（降级）')
      return
    }
    if (!persistence || typeof persistence.stat !== 'function') {
      logger.warn('sessionPersistence 服务不可用，跳过领域会话 ensure / 开场 notice（降级）')
      return
    }

    let cancelled = false
    let handleDispose: (() => void) | undefined
    const disposeHandle = (): void => {
      const run = handleDispose
      handleDispose = undefined
      run?.()
    }

    // 领域卸载 / 插件卸载都尽早拆除会话；两处调用同一个幂等闭包。
    let effectDispose: (() => void) | undefined
    try {
      const effect = this.ctx.effect(
        () => () => {
          cancelled = true
          disposeHandle()
        },
        'rsi-agent domain session',
      )
      effectDispose = () => {
        void effect()
      }
      registry.add('active', 'dispose domain session effect', () => {
        effectDispose?.()
      })
    } catch (error) {
      logger.warn('会话 effect 绑定失败（降级：仅随 ensure 结果拆除）', error)
    }

    const sessionId = active.sessionId
    const workspaceDir = active.runtime.workspaceDir

    void ensureSession({
      agents,
      sessionPersistence: persistence,
      sessionId,
      workspaceDir,
      logger: (message) => logger.info(message),
    })
      .then(async ({ outcome, handle }) => {
        // 卸载（effect 已触发）或领域已切换 → 立即拆除刚建好的会话。
        if (cancelled || this.current !== active) {
          if (handle) await handle.dispose().catch(() => {})
          return
        }

        if (handle) {
          let done = false
          handleDispose = () => {
            if (done) return
            done = true
            void handle.dispose().catch(() => {})
          }
          // handle 已就绪但 effect 绑定失败过：登记到 active 阶段兜底拆除。
          if (!effectDispose) {
            registry.add('active', 'dispose domain session handle', disposeHandle)
          }
        }

        if (outcome.kind === 'skipped') {
          logger.warn(`领域 "${pack.id}" 会话 ensure 跳过：${outcome.detail}`)
          return
        }

        const text = pack.openingNotice ?? CORE_OPENING_NOTICE_TEXT
        const summary = pack.openingNotice === undefined ? CORE_OPENING_NOTICE_SUMMARY : undefined
        const projections = serviceOf<SessionProjectionsLike>(
          this.ctx,
          'sessionProjections',
        )

        await deliverOpeningNotice({
          agents: agents as unknown as OpeningNoticeAgents,
          sessionPersistence: persistence as OpeningNoticeDeps['sessionPersistence'],
          ...(projections === undefined ? {} : { sessionProjections: projections }),
          sessionId,
          text,
          ...(summary === undefined ? {} : { summary }),
          // 领域路径同样探测卸载 / 切换：投递链路内（blank 判读后）再查一次。
          isCancelled: () => cancelled || this.current !== active,
          logger: (message) => logger.info(message),
        })
      })
      .catch((error: unknown) => {
        logger.warn(`领域 "${pack.id}" 会话 ensure / 开场 notice 异常（已隔离）`, error)
      })
  }

  /**
   * 装配调度器（§12）。
   *
   * - 唤醒投递复用 `agents` 服务的固定会话 `followup` + producer-owned notice 消息源；
   *   `agents` 缺失时注入「永远失败」的 sink，让唤醒降级为 `skipped` 而非崩溃；
   * - teardown 压入 `'scheduler'` 阶段（拆卸顺序第一位：先停调度，再拆工具/会话）；
   * - `ctx.effect` 兜底：插件 fiber 卸载时同样 stop，避免残留 timer；
   * - 任何异常只 warn（定时能力降级），绝不阻断领域安装。
   */
  private mountScheduler(
    pack: DomainPack,
    runtime: DomainRuntime,
    logger: DomainLogger,
    registry: TeardownRegistry,
  ): SchedulerService | undefined {
    try {
      const agents = serviceOf<WakeAgentsLike>(this.ctx, 'agents')
      const sink =
        agents === undefined
          ? undefined
          : createAgentWakeSink({
              agents,
              logger: {
                info: (message: string, meta?: unknown) => logger.info(message, meta),
                warn: (message: string, meta?: unknown) => logger.warn(message, meta),
              },
            })

      const service = createSchedulerService({
        runtime: {
          home: runtime.home,
          assetsDir: runtime.assetsDir,
          dataDir: runtime.dataDir,
          sessionId: runtime.sessionId,
          timezone: runtime.timezone,
          logger,
        },
        scheduler: pack.scheduler,
        ...(pack.disclaimer === undefined ? {} : { disclaimer: pack.disclaimer }),
        ...(this.config.config?.timezone === undefined
          ? {}
          : { configTimezone: this.config.config.timezone }),
        ...(sink === undefined ? {} : { sink }),
        logger,
      })

      registry.add('scheduler', 'stop scheduler', () => service.stop())
      try {
        const effect = this.ctx.effect(() => () => service.stop(), 'rsi-agent scheduler')
        registry.add('scheduler', 'dispose scheduler effect', () => {
          void effect()
        })
      } catch (error) {
        logger.warn('调度器 effect 绑定失败（降级：仅随领域 teardown 停止）', error)
      }
      return service
    } catch (error) {
      logger.warn('调度器装配失败（降级：不启用定时任务）', error)
      return undefined
    }
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

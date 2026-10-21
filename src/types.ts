/**
 * `agentHost` 服务与 DomainPack 的公共契约。
 *
 * 本文件只声明类型与常量，不含任何运行时副作用。领域包（DomainPack）由
 * 调用方以普通对象提供，`AgentHost.install` 在装配前完成全部契约校验
 * （见 `./validate.ts`）。
 *
 * 契约版本遵循技术方案 §6：`apiVersion` 必须严格等于
 * {@link DOMAIN_API_VERSION}，任何不兼容变更都必须递增该常量。
 */
import type { Context, Disposable } from '@deepseek-ai/cordis'

/** 当前 DomainPack 契约版本（`apiVersion` 必须严格等于该值）。 */
export const DOMAIN_API_VERSION = 1

/**
 * 资产类型：描述领域资产目录下的一个相对路径分区。
 *
 * `prefix` 必须是相对资产根目录的路径前缀，以 `/` 结尾；具体目录布局、
 * 权限与 home 切换由后续 runtime 任务负责，本任务只校验契约形状。
 */
export interface AssetType {
  /** 资产类型标识（例如 `notes`、`datasets`）。 */
  name: string
  /** 相对资产根目录的路径前缀，必须以 `/` 结尾，且不含 `..` / `.git` / 反斜杠。 */
  prefix: string
  /** 可选的人类可读说明。 */
  description?: string
}

/** 可进化 SKILL：内容由进化循环改写，初始内容作为种子落盘。 */
export interface SeedSkill {
  /** kebab-case 名称，领域内全局唯一。 */
  name: string
  /** 可选说明。 */
  description?: string
  /** SKILL.md 正文（种子内容）。 */
  markdown: string
}

/** 固有 SKILL：随领域包发布，不参与进化。 */
export interface FirmwareSkill {
  /** 名称，必须非空，且不得与可进化 SKILL 重名。 */
  name: string
  /** 可选说明。 */
  description?: string
  /** SKILL.md 正文。 */
  markdown: string
}

/**
 * 进化策略。
 *
 * 校验规则（技术方案 §6）：所有数值字段必须 > 0；`window` 非空字符串；
 * `independentCases` 为正整数。允许扩展字段，但扩展出的数值字段同样受
 * 「> 0」约束。
 */
export interface EvolutionPolicy {
  /** 评估窗口标签（非空字符串，例如 `7d`）。 */
  window: string
  /** 独立样本数（正整数）。 */
  independentCases: number
  /** 单轮进化允许的最大迭代次数（可选，若提供必须 > 0）。 */
  maxIterations?: number
  /** 判定改进所需的最小提升幅度（可选，若提供必须 > 0）。 */
  minImprovement?: number
  /** 其余策略参数由后续任务解释；其中数值字段同样必须 > 0。 */
  [key: string]: unknown
}

/** 人设提供者：延迟渲染，避免安装期做无谓的 IO。 */
export interface PersonaProvider {
  /** 返回人设 Markdown 正文（非空、合法 UTF-8、≤ 64 KB）。 */
  markdown(): string
}

/** 调度器契约（本任务只校验时区，不实现调度）。 */
export interface SchedulerSpec {
  /** 合法 IANA 时区名（例如 `Asia/Shanghai`）。 */
  timezone: string
  /** 其余调度参数由后续任务解释。 */
  [key: string]: unknown
}

/** 领域 SKILL 集合。 */
export interface DomainSkills {
  /** 可进化 SKILL 列表。 */
  evolvable: SeedSkill[]
  /** 固有 SKILL 列表（不进化）；缺省视为空数组。 */
  firmware?: FirmwareSkill[]
}

/**
 * 工具定义的最小结构。
 *
 * 具体的 schema / 执行管线由 `@deepseek-ai/dsh-tools` 提供，本任务只要求
 * `tools(ctx, rt)` 返回的每一项具备非空字符串 `name`，并允许携带任意扩展字段。
 */
export interface ToolDefinition {
  /** 工具名（面向模型，必须与 `pack.toolNames` 声明一致）。 */
  name: string
  /** 可选说明。 */
  description?: string
  /** 可选参数 schema（后续任务补齐）。 */
  parameters?: Record<string, unknown>
  /** 可选执行函数（后续任务补齐）。 */
  execute?: (...args: unknown[]) => unknown
  /** 允许工具携带未在此声明的扩展字段。 */
  [key: string]: unknown
}

/** `git` 提交端口的一次提交请求。 */
export interface CommitOptions {
  /** 提交说明。 */
  message: string
  /** 资产根目录；缺省由端口实现决定。 */
  assetsDir?: string
  /** 限定提交的路径列表（相对资产根目录）。 */
  paths?: readonly string[]
}

/** 提交结果。`degraded: true` 表示底层 VCS 不可用，调用方应降级而非失败。 */
export interface CommitResult {
  /** 是否处于降级状态（`git` 不可用）。 */
  degraded: boolean
  /** 降级原因。 */
  reason?: string
  /** 成功提交的 commit id。 */
  commit?: string
}

/**
 * 可注入的提交端口。
 *
 * 本任务只提供「探测 + 降级」路径；真正的资产仓库提交由后续任务实现。
 */
export interface CommitPort {
  /** 底层 `git` 是否可用（每次调用实时探测，不缓存）。 */
  isAvailable(): boolean
  /** 提交资产变更。`git` 不可用时必须返回 `{ degraded: true, reason }`。 */
  commit(options: CommitOptions): Promise<CommitResult>
}

/** 领域运行时句柄：由宿主创建，领域包只读消费。 */
export interface DomainRuntime {
  /** 运行时遵循的契约版本。 */
  readonly apiVersion: typeof DOMAIN_API_VERSION
  /** 领域 id。 */
  readonly domainId: string
  /** 领域版本。 */
  readonly domainVersion: string
  /** 本领域使用的会话 id。 */
  readonly sessionId: string
  /** 资产根目录（绝对路径；本任务不推导目录布局）。 */
  readonly assetsDir: string
  /** 领域日志门面。 */
  readonly logger: DomainLogger
  /** 资产提交端口。 */
  readonly commit: CommitPort
}

/** 领域包（DomainPack）：一个可安装领域的完整契约。 */
export interface DomainPack {
  /** 契约版本，必须 === {@link DOMAIN_API_VERSION}。 */
  apiVersion: number
  /** 领域 id，`^[a-z][a-z0-9-]{1,31}$`。 */
  id: string
  /** 合法 semver 版本号。 */
  version: string
  /** 可选展示名。 */
  displayName?: string
  /** 人设提供者。 */
  persona: PersonaProvider
  /** 默认会话 id（非空，`^[a-zA-Z0-9._-]+$`，长度 ≤ 128）。 */
  defaultSessionId: string
  /** 领域 SKILL 集合。 */
  skills: DomainSkills
  /** 资产类型列表。 */
  assetTypes: AssetType[]
  /** 调度器契约。 */
  scheduler: SchedulerSpec
  /** 进化策略。 */
  evolutionPolicy: EvolutionPolicy
  /** 工具工厂：返回本领域要注册的工具定义数组。 */
  tools(ctx: Context, rt: DomainRuntime): ToolDefinition[]
  /** 工具名声明，必须与实际返回的工具名集合完全一致。 */
  toolNames: string[]
}

/** 安装选项。 */
export interface InstallOptions {
  /** 资产根目录；缺省为空字符串（目录布局由后续任务决定）。 */
  assetsDir?: string
  /** 覆盖领域默认会话 id。 */
  sessionId?: string
  /** 自定义提交端口。 */
  commit?: CommitPort
  /** 自定义日志门面。 */
  logger?: DomainLogger
  /** 自定义运行时工厂；缺省使用最小实现。 */
  createRuntime?: (pack: DomainPack, ctx: Context) => DomainRuntime
}

/** 当前激活领域的只读快照。 */
export interface ActiveDomain {
  /** 领域 id。 */
  readonly id: string
  /** 领域版本。 */
  readonly version: string
  /** 可选展示名。 */
  readonly displayName?: string
  /** 实际使用的会话 id。 */
  readonly sessionId: string
  /** 实际使用的资产根目录。 */
  readonly assetsDir: string
  /** 安装时间（epoch 毫秒）。 */
  readonly installedAt: number
  /** 已安装的工具名（快照）。 */
  readonly toolNames: readonly string[]
  /** 原始领域包引用。 */
  readonly pack: DomainPack
  /** 运行时句柄。 */
  readonly runtime: DomainRuntime
  /** 幂等拆卸器。 */
  readonly disposable: Disposable<void>
}

/** `agentHost` 服务契约。 */
export interface AgentHostService {
  /** 服务实现的契约版本。 */
  readonly apiVersion: typeof DOMAIN_API_VERSION
  /** 当前激活领域；未安装时为 `undefined`。只读。 */
  readonly active: ActiveDomain | undefined
  /**
   * 同步安装一个领域包。
   *
   * 契约/基础设施校验全部完成后才写入 `active`；返回的 Disposable 幂等，
   * 拆卸顺序按技术方案 §4（stop scheduler → dispose tools → restore persona
   * → unregister firmware skills → unmount skill provider → clear active）。
   */
  install(pack: DomainPack, options?: InstallOptions): Disposable<void>
}

/** 领域日志门面（结构化 meta 可选）。 */
export interface DomainLogger {
  error(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  info(message: string, meta?: unknown): void
  debug(message: string, meta?: unknown): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** RSI Agent 宿主服务（由 `rsi-agent` 插件自身提供）。 */
    agentHost: AgentHostService
  }
}

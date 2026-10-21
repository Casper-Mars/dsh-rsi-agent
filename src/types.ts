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
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ResolvedCoreConfig } from './config.js'

/** 当前 DomainPack 契约版本（`apiVersion` 必须严格等于该值）。 */
export const DOMAIN_API_VERSION = 1

/**
 * 资产类型：描述领域资产目录下的一个相对路径分区，并可选地声明内容校验。
 *
 * `prefix` 必须是相对资产根目录的路径前缀，以 `/` 结尾；不同类型的前缀
 * 不得重叠（按**路径段**判断，`a/` 与 `a/b/` 重叠、`a/` 与 `ab/` 不重叠），
 * 因此任一资产路径最多属于一个类型。
 */
export interface AssetType {
  /** 资产类型标识（kebab-case，领域内唯一，不得使用保留字）。 */
  name: string
  /** 相对资产根目录的路径前缀，必须以 `/` 结尾，且不含 `..` / `.git` / 反斜杠。 */
  prefix: string
  /**
   * 可选的类型级内容校验：落盘前调用；抛错即视为该 spec 非法（原样透传）。
   *
   * @param path 相对资产根目录的 posix 路径（已通过白名单校验）。
   * @param content 待写入的文本内容。
   */
  validate?(path: string, content: string): void
}

/** 一次资产注册请求。 */
export interface AssetSpec {
  /** 资产类型（必须是 `assets.types[].name` 已声明的类型）。 */
  type: string
  /** 相对资产根目录的 posix 路径（必须落在该类型的 prefix 之下）。 */
  path: string
  /** 文件内容（UTF-8 文本）。 */
  content: string
  /**
   * 写入模式；缺省 `seed`。
   *   - `seed`：目标已存在则跳过（不覆盖）；
   *   - `upsert`：内容与磁盘不同才覆盖；完全一致时同样跳过（no-op）。
   */
  mode?: 'seed' | 'upsert'
  /** 可选提交说明（会写入本次 commit message）。 */
  message?: string
}

/**
 * 单个资产注册结果状态。
 *
 *   - `created` —— 新写入，且已产生 commit；
 *   - `updated` —— 内容发生变化，且已产生 commit；
 *   - `skipped` —— 未写盘、未 commit：`seed` 命中已存在文件，或 `upsert`
 *     内容与磁盘完全一致。两者靠 {@link RegisterResult.reason} 区分。
 */
export type RegisterStatus = 'created' | 'skipped' | 'updated'

/** 单个资产注册结果。 */
export interface RegisterResult {
  /** 相对资产根目录的 posix 路径。 */
  path: string
  /** 资产类型名。 */
  type: string
  /** 实际动作：新建 / 跳过 / 覆盖（语义见 {@link RegisterStatus}）。 */
  status: RegisterStatus
  /** 本次提交的 commit id（仅当该批次成功提交且该文件参与提交时存在）。 */
  sha?: string
  /** 是否因 git 不可用降级（资产已落盘，但未进入版本库）。 */
  degraded?: boolean
  /**
   * 原因说明：
   *   - `skipped` 时区分原因：`seed already exists` / `content unchanged`；
   *   - `degraded: true` 时说明 git 降级原因。
   */
  reason?: string
}

/** 资产清单条目。 */
export interface AssetEntry {
  /** 相对资产根目录的 posix 路径。 */
  path: string
  /** 资产类型名。 */
  type: string
  /** 文件字节数。 */
  size: number
}

/**
 * 领域包在 `bootstrap` 中拿到的资产写入器。
 *
 * 三个方法都必须做路径白名单校验（`..`、绝对路径、`.git`、反斜杠一律拒绝）。
 * `register` 是**同步**方法：一次调用内的全部 spec 要么全部落盘、要么一个都不写；
 * 落盘后统一产生**一个** commit。
 */
export interface AssetWriter {
  /** 注册一个或多个资产（同步；批量原子）。 */
  register(spec: AssetSpec | readonly AssetSpec[]): RegisterResult[]
  /** 列出命中已声明 prefix 的资产（按 path 排序）；可按类型过滤。 */
  list(type?: string): AssetEntry[]
  /** 读取资产文件内容；不存在时抛错。 */
  read(path: string): string
}

/** 固有 SKILL：随领域包发布，不参与进化。 */
export interface FirmwareSkill {
  /** kebab-case 名称，不得自相重复，也不得占用 core 内置固件 SKILL 名。 */
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

/** 领域资产注册契约：类型声明 + 同步 bootstrap。 */
export interface DomainAssets {
  /** 资产类型列表（至少 1 项，name 唯一，prefix 两两不重叠）。 */
  types: readonly AssetType[]
  /**
   * 领域包自己的资产注册入口：`install` 在工具注册之后、启用领域之前同步调用。
   *
   * **必须同步**：返回 thenable / Promise 会导致安装失败。
   */
  bootstrap?(assets: AssetWriter): void
}

/**
 * 工具定义 = `@deepseek-ai/dsh-tools` 的公共契约，core **不再**维护影子类型。
 *
 * 该契约要求（dsh-tools `ToolDefinition`）：
 *   - `name` / `description` / `parameters`（`ToolSchema` 必填）；
 *   - `output: { schema, render, presentationMeta? }`（必填，注册时强校验）；
 *   - `execute(args, exec): Promise<unknown>`（**必须异步**，且 `Promise` 结果需
 *     通过 `output.schema` 校验）。
 *
 * 这里是纯类型 re-export：编译产物不含任何 `require('@deepseek-ai/dsh-tools')`，
 * 因此 `@deepseek-ai/dsh-tools` 仍保持 optional peer 语义；但其 `.d.ts` 会引用该
 * 包的类型，消费方若需完整类型检查应自行安装（dsh 宿主环境必然具备）。
 */
export type {
  ToolDefinition,
  ToolOutputDefinition,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'

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

/**
 * 领域运行时句柄：由宿主创建，领域包只读消费。
 *
 * 类型**真源**在本文件（纯契约模块）：`runtime.ts` 只是该契约的构造器，
 * 因此类型定义留在契约层，避免「构造器与契约各说一套」。`runtime.ts` 通过
 * `CreatedDomainRuntime` 补充它实际保证的具体字段语义。
 *
 * 全部路径均为绝对路径（`path.resolve` 归一化），且严格位于 `home` 之下。
 */
export interface DomainRuntime {
  /** 运行时遵循的契约版本。 */
  readonly apiVersion: typeof DOMAIN_API_VERSION
  /** 领域 id（无领域时为 `core`）。 */
  readonly domainId: string
  /** 领域版本（无领域时为 `0.0.0`）。 */
  readonly domainVersion: string
  /** 本领域 home 目录（`<homeRoot>/<domainId>`）。 */
  readonly home: string
  /** 本领域使用的会话 id。 */
  readonly sessionId: string
  /** 运行时区（IANA 名称）。 */
  readonly timezone: string
  /** 资产根目录（`<home>/assets`）。 */
  readonly assetsDir: string
  /** 私有数据目录（`<home>/data`，权限 `0o700`）。 */
  readonly dataDir: string
  /** 日志目录（`<home>/logs`，权限 `0o700`）。 */
  readonly logsDir: string
  /** 工作区目录（`<home>/workspace`）。 */
  readonly workspaceDir: string
  /** 已解析的 core 配置（含最终 `homeRoot`）。 */
  readonly config: ResolvedCoreConfig
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
  /**
   * 可选：领域专属开场 notice 文案（投递给首次启动的 blank 会话）。
   *
   * 非空、合法 UTF-8、≤ 4096 字节；缺省时使用 core 的通用开场文案。
   * 该字段只影响开场白内容，不改变会话 / 人设 / 工具契约。
   */
  openingNotice?: string
  /** 默认会话 id（非空，`^[a-zA-Z0-9._-]+$`，长度 ≤ 128）。 */
  defaultSessionId: string
  /** 资产注册契约（必填）。 */
  assets: DomainAssets
  /** 领域自带的固有 SKILL 列表（不参与进化）；缺省视为空数组。 */
  firmwareSkills?: readonly FirmwareSkill[]
  /** 调度器契约。 */
  scheduler: SchedulerSpec
  /** 进化策略。 */
  evolutionPolicy: EvolutionPolicy
  /**
   * 工具工厂：返回本领域要注册的工具定义数组。
   *
   * 返回的每一项都会由 {@link AgentHostService.install} 逐个交给
   * `ctx.tools.register()`；形状必须与 dsh-tools 的 `ToolDefinition` 完全一致。
   */
  tools(ctx: Context, rt: DomainRuntime): ToolDefinition[]
  /** 工具名声明，必须与实际返回的工具名集合完全一致。 */
  toolNames: string[]
}

/** 安装选项。 */
export interface InstallOptions {
  /** 工作区根目录（与 `CoreConfig.homeRoot` 同义，优先级更高）。 */
  home?: string
  /** 资产根目录覆盖；缺省使用 `<home>/assets`（不创建、不 chmod）。 */
  assetsDir?: string
  /** 覆盖领域默认会话 id（优先级最高）。 */
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
   * 最近一次 `install` 的 SKILL provider 就绪信号（只读）。
   *
   * 领域声明了 `skills/` 前缀时，`await` 后 `ctx.skills.list()` 立即可见
   * provider 贡献的 SKILL；未声明 `skills/`、依赖缺失降级或尚未安装时
   * 为已 resolve 的 Promise。用于替代不确定的 sleep。
   */
  readonly skillProviderReady?: Promise<void>
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

/**
 * 会话确保层：固定会话「检查 → 恢复 → 新建」。
 *
 * 本模块把 ensure 逻辑抽成**可注入依赖的纯函数**，便于三分支单测；与
 * harness `session-controller` 的 `createOrAdopt` 同构，区别在于判据精简：
 *
 *   1. `agents.get(id)` 命中（live）→ 直接复用，不调用 resume/create；
 *   2. 否则 `sessionPersistence.stat(id)` 命中（已持久化）→ `resume` 恢复；
 *   3. 都不存在 → `create` 新建（`meta.cwd = workspaceDir`）。
 *
 * 归属：会话的 ownerCtx / fiber 归属由**宿主 agents 服务**决定（`create` /
 * `resume` 的 API 不接收 owner 参数，`get` 命中的既有会话也由原持有者管理）。
 * 本插件只负责显式 handle 的生命周期：调用方把返回的 handle 绑定到插件 fiber
 * 或领域 teardown，并以**幂等**的 `dispose()` 拆除（重复调用无副作用）。
 *
 * 降级：会话缺失 / 服务不可用 / 任一调用抛错 → 记日志后返回 `skipped`，
 * **不抛异常、不中断 install**。
 */

/** agent 的最小结构替身（仅需可辨别的 id）。 */
export interface EnsureAgent {
  readonly id: string
}

/** `agentOptions` 的精简投影（仅 provider/model；缺省由宿主决定）。 */
export interface EnsureAgentOptions {
  provider?: string
  model?: string
}

/** `AgentHandle` 的最小结构替身（归属契约：dispose 拆除会话）。 */
export interface EnsureAgentHandle {
  agent: EnsureAgent
  dispose(): Promise<void>
}

/** 新建会话的选项（对齐 harness `ctx.agents.create`）。 */
export interface EnsureCreateOptions {
  sessionId: string
  agentOptions?: EnsureAgentOptions
  meta?: { cwd?: string }
}

/** 恢复会话的选项（对齐 harness `ctx.agents.resume`）。 */
export interface EnsureResumeOptions {
  resumeSessionId: string
  agentOptions?: EnsureAgentOptions
}

/** `ctx.agents` 的最小结构替身。 */
export interface EnsureAgentsLike {
  /** 查 live：命中返回 agent，否则 `undefined`。 */
  get(id: string): EnsureAgent | undefined
  /** 新建（live 未命中且无持久化）。 */
  create(options: EnsureCreateOptions): Promise<EnsureAgentHandle>
  /** 恢复（已持久化但未 live）。 */
  resume(options: EnsureResumeOptions): Promise<EnsureAgentHandle>
}

/** `ctx.sessionPersistence` 的最小结构替身（ensure 只需 `stat`）。 */
export interface EnsureSessionPersistenceLike {
  /** 观察持久会话：存在返回快照，否则 `undefined`。 */
  stat(id: string): Promise<unknown>
}

/** ensure 依赖的可注入面。 */
export interface EnsureSessionDeps {
  /** 活跃 agent 注册表（`ctx.agents` 结构替身）。 */
  agents: EnsureAgentsLike
  /** 会话持久化服务（`ctx.sessionPersistence` 结构替身）。 */
  sessionPersistence: EnsureSessionPersistenceLike
  /** 目标会话 id。 */
  sessionId: string
  /** 宿主工作目录（新建会话的 `meta.cwd`）。 */
  workspaceDir: string
  /** 可选的模型投影（缺省不写 `agentOptions`）。 */
  agentOptions?: EnsureAgentOptions
  /** 日志（info 级；缺省静默）。 */
  logger?: (message: string) => void
}

/** ensure 结局：live 复用 / resume 恢复 / create 新建 / skip 降级。 */
export type EnsureOutcome =
  | { kind: 'reuse'; id: string }
  | { kind: 'resumed'; id: string }
  | { kind: 'created'; id: string }
  | { kind: 'skipped'; id: string; detail: string }

/** ensure 结果：结局 + 需要调用方持有生命周期的 handle。 */
export interface EnsureSessionResult {
  /** 本次 ensure 的结局。 */
  readonly outcome: EnsureOutcome
  /**
   * 会话保活 handle。
   *
   * - `reuse` 分支为 `undefined`（会话由既有持有者管理，无需重复拆除）；
   * - `resumed` / `created` 分支返回新 handle，调用方负责 `dispose()`；
   * - `skipped` 分支为 `undefined`。
   */
  readonly handle: EnsureAgentHandle | undefined
}

/**
 * 确保固定会话就绪（纯逻辑，可注入依赖）。
 *
 * 三分支判定顺序见文件头。任一分支失败都返回 `skipped`，**绝不向上抛错**。
 *
 * @param deps 可注入依赖。
 */
export async function ensureSession(deps: EnsureSessionDeps): Promise<EnsureSessionResult> {
  const log = deps.logger ?? (() => {})
  const id = deps.sessionId

  // 1) live 命中 → 直接复用（不调用 resume / create）。
  try {
    const live = deps.agents.get(id)
    if (live !== undefined) {
      log(`[rsi-agent/session] 会话已 live，直接复用：${id}`)
      return { outcome: { kind: 'reuse', id }, handle: undefined }
    }
  } catch (error) {
    log(`[rsi-agent/session] 警告 agents.get 失败（降级 skip）：${String(error)}`)
    return {
      outcome: { kind: 'skipped', id, detail: `agents.get failed: ${String(error)}` },
      handle: undefined,
    }
  }

  // 2) 已持久化 → resume 恢复。
  try {
    const stat = await deps.sessionPersistence.stat(id)
    if (stat !== undefined && stat !== null) {
      log(`[rsi-agent/session] 会话已持久化，resume 恢复：${id}`)
      const handle = await deps.agents.resume(
        withAgentOptions({ resumeSessionId: id }, deps.agentOptions),
      )
      return { outcome: { kind: 'resumed', id }, handle }
    }
  } catch (error) {
    log(`[rsi-agent/session] 警告 恢复会话失败（降级 skip）：${String(error)}`)
    return {
      outcome: { kind: 'skipped', id, detail: `resume failed: ${String(error)}` },
      handle: undefined,
    }
  }

  // 3) 都不存在 → create 新建（cwd 固定为领域 workspace）。
  try {
    log(`[rsi-agent/session] 会话不存在，create 新建：${id}（cwd=${deps.workspaceDir}）`)
    const handle = await deps.agents.create(
      withAgentOptions(
        { sessionId: id, meta: { cwd: deps.workspaceDir } },
        deps.agentOptions,
      ),
    )
    return { outcome: { kind: 'created', id }, handle }
  } catch (error) {
    log(`[rsi-agent/session] 警告 新建会话失败（降级 skip）：${String(error)}`)
    return {
      outcome: { kind: 'skipped', id, detail: `create failed: ${String(error)}` },
      handle: undefined,
    }
  }
}

/** 仅在 `agentOptions` 有实际内容时附加字段，避免传出 `undefined` 键。 */
function withAgentOptions<T extends object>(
  base: T,
  agentOptions: EnsureAgentOptions | undefined,
): T & { agentOptions?: EnsureAgentOptions } {
  if (agentOptions === undefined) return base
  if (agentOptions.provider === undefined && agentOptions.model === undefined) return base
  return { ...base, agentOptions }
}

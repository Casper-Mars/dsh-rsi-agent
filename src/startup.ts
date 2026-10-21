/**
 * 启动序列：startup grace → 通用会话 ensure → 通用开场 notice。
 *
 * 背景（技术方案 §4.1 / §20 第 1、5 条）：
 *   - core 启动时可能「稍后」才安装领域包。为避免领域包抢在通用路径之后
 *     又投递一次开场，启动阶段设置一个宽限期（`startupGraceMs`）：
 *       * 宽限期内领域 install **成功** → **取消计时器**，由领域安装路径用自己的
 *         文案投递开场（绝不出现通用开场）；
 *       * install 失败 → 不消耗宽限，计时器到期照常走通用路径；
 *       * 计时器到期时 install 仍在装配 → 顺延（`STARTUP_INSTALL_DEFER_MS`），
 *         避免在安装结果未知时抢跑。
 *       * 宽限期到期仍无领域 install → 按通用路径 ensure + 投通用开场。
 *   - `startupGraceMs === 0`：立即执行通用路径（同步/微任务内可见）。
 *
 * 计时器必须可清理：`cancel()` 之后即使时间推进也**永不触发**。本模块用
 * `setTimeout` / `clearTimeout` 全局函数，测试可直接使用 fake timers。
 */

import type { DomainLogger } from './types.js'
import { deliverOpeningNotice, CORE_OPENING_NOTICE_SUMMARY, type OpeningNoticeDeps, type SessionProjectionsLike } from './opening-notice.js'
import {
  ensureSession,
  type EnsureAgentHandle,
  type EnsureAgentOptions,
  type EnsureAgentsLike,
  type EnsureSessionPersistenceLike,
  type EnsureOutcome,
} from './session-ensure.js'

/** 会话持久化服务：ensure 需要 `stat`，notice 判读需要 `open`（可选）。 */
export type StartupSessionPersistence = EnsureSessionPersistenceLike &
  Partial<Pick<OpeningNoticeDeps['sessionPersistence'], 'open'>>

/** 启动期可用的会话服务集合。 */
export interface StartupServices {
  agents?: EnsureAgentsLike
  sessionPersistence?: StartupSessionPersistence
  sessionProjections?: SessionProjectionsLike
}

/** 启动序列依赖。 */
export interface StartupDeps {
  /** 宽限期（毫秒）；`<= 0` 表示立即执行通用路径。 */
  graceMs: number
  /** 通用路径使用的会话 id。 */
  sessionId: string
  /** 通用路径新建会话的 cwd。 */
  workspaceDir: string
  /** 延迟解析会话服务（计时器到期时再读，服务可能晚于插件启动上线）。 */
  resolveServices(): StartupServices | undefined
  /** 日志门面。 */
  logger?: Pick<DomainLogger, 'info' | 'warn'>
  /** 开场文案（缺省用通用文案）。 */
  noticeText?: string
  /** 开场摘要（缺省 {@link CORE_OPENING_NOTICE_SUMMARY}）。 */
  noticeSummary?: string
  /** 模型投影（可选）。 */
  agentOptions?: EnsureAgentOptions
  /** ensure 新建/恢复出的 handle 交给调用方绑定生命周期。 */
  onSessionHandle?(handle: EnsureAgentHandle): void
  /**
   * 通用路径执行途中的取消探测。返回 `true` 时不再投递通用开场
   * （覆盖「计时器已触发、ensure 尚未完成时领域 install 到达」的竞态）。
   */
  isCancelled?(): boolean
  /**
   * 是否有领域 install 正在同步装配。
   *
   * 计时器到期时若 install 进行中，**顺延**而非抢跑：install 成功会取消本轮
   * 通用路径；install 失败则解除标记，计时器按（剩余）宽限继续触发。
   */
  isInstalling?(): boolean
}

/**
 * install 期间计时器到期的顺延间隔（毫秒）。
 *
 * 只用于「装配窗口内」的短重试；正常路径下计时器在宽限到期时立即执行。
 */
export const STARTUP_INSTALL_DEFER_MS = 50

/** 启动序列控制器（幂等、可清理）。 */
export interface StartupController {
  /** 是否已取消（领域 install 或插件卸载）。 */
  readonly cancelled: boolean
  /** 通用路径是否尚未执行（计时器仍在等待）。 */
  readonly pending: boolean
  /**
   * 取消计时器。取消后通用路径**永不执行**；已执行后再调用只是标记。
   *
   * @param reason 取消原因（写入 info 日志）。
   */
  cancel(reason?: string): void
}

/** 通用启动路径的执行结果（便于单测断言）。 */
export interface GenericStartupResult {
  readonly kind: 'skipped' | 'delivered' | 'not-blank' | 'ensure-skipped'
  readonly id: string
  readonly outcome?: EnsureOutcome
}

/**
 * 执行通用启动路径：ensure + 开场 notice。
 *
 * 该函数**永不抛异常**：服务缺失、ensure 失败、投递失败都只记日志。
 */
export async function runGenericStartup(deps: StartupDeps): Promise<GenericStartupResult> {
  const log = deps.logger
  const id = deps.sessionId

  let services: StartupServices | undefined
  try {
    services = deps.resolveServices()
  } catch (error) {
    log?.warn(`[rsi-agent/startup] 警告 解析会话服务失败（降级 skip）：${String(error)}`)
    return { kind: 'skipped', id }
  }

  const agents = services?.agents
  const persistence = services?.sessionPersistence
  if (!agents || typeof agents.get !== 'function') {
    log?.warn('[rsi-agent/startup] agents 服务不可用，跳过通用启动（降级）')
    return { kind: 'skipped', id }
  }
  if (!persistence || typeof persistence.stat !== 'function') {
    log?.warn('[rsi-agent/startup] sessionPersistence 服务不可用，跳过通用启动（降级）')
    return { kind: 'skipped', id }
  }

  const { outcome, handle } = await ensureSession({
    agents,
    sessionPersistence: persistence,
    sessionId: id,
    workspaceDir: deps.workspaceDir,
    ...(deps.agentOptions === undefined ? {} : { agentOptions: deps.agentOptions }),
    logger: (message) => log?.info(message),
  })

  let bound = false
  if (handle && deps.onSessionHandle) {
    try {
      deps.onSessionHandle(handle)
      bound = true
    } catch (error) {
      log?.warn(`[rsi-agent/startup] 警告 绑定会话 handle 失败（降级）：${String(error)}`)
    }
  }

  if (outcome.kind === 'skipped') {
    // 没有可投递的会话：ensure 产出的 handle（若有）立即拆除。
    if (handle && !bound) void handle.dispose().catch(() => {})
    log?.warn(`[rsi-agent/startup] 通用会话 ensure 跳过：${outcome.detail}`)
    return { kind: 'ensure-skipped', id, outcome }
  }

  // 竞态保护：ensure 期间领域 install 已取消启动 → 不投通用开场。
  if (deps.isCancelled?.() === true) {
    if (handle && !bound) void handle.dispose().catch(() => {})
    log?.info('[rsi-agent/startup] 启动宽限已取消，跳过通用开场')
    return { kind: 'skipped', id, outcome }
  }

  const notice = await deliverOpeningNotice({
    agents: agents as unknown as OpeningNoticeDeps['agents'],
    sessionPersistence: persistence as OpeningNoticeDeps['sessionPersistence'],
    ...(services?.sessionProjections === undefined
      ? {}
      : { sessionProjections: services.sessionProjections }),
    sessionId: id,
    ...(deps.noticeText === undefined ? {} : { text: deps.noticeText }),
    ...(deps.noticeSummary === undefined ? {} : { summary: deps.noticeSummary }),
    // 取消探测下沉到投递链路：blank 判读后、followup 前再查一次 token。
    isCancelled: () => deps.isCancelled?.() === true,
    logger: (message) => log?.info(message),
  })

  // 无生命周期绑定方：投递完成后拆除，避免会话句柄泄漏。
  if (handle && !bound) void handle.dispose().catch(() => {})

  return { kind: notice.kind, id, outcome }
}

/**
 * 启动通用路径（带 grace）。
 *
 * - `graceMs > 0`：起计时器；到期执行 {@link runGenericStartup}；
 * - `graceMs <= 0`：立即执行（不产生计时器）。
 *
 * 计时器调用 `unref()`（Node 环境）避免拖住进程退出；浏览器/测试环境无
 * `unref` 时静默跳过。
 */
export function startStartupSequence(deps: StartupDeps): StartupController {
  const log = deps.logger
  let cancelled = false
  let fired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const controllerDeps: StartupDeps = {
    ...deps,
    isCancelled: () => cancelled,
  }

  const armTimer = (): void => {
    timer = setTimeout(fire, deps.graceMs)
    const handle = timer as unknown as { unref?: () => void }
    if (typeof handle.unref === 'function') handle.unref()
  }

  const fire = (): void => {
    if (cancelled || fired) return
    // 领域 install 正在装配：顺延，绝不抢在 install 结果之前投通用开场。
    // - install 成功 → `cancel()` 清掉顺延计时器，本轮只有领域开场；
    // - install 失败 → 解除标记，顺延计时器继续走通用路径。
    if (deps.isInstalling?.() === true) {
      timer = setTimeout(fire, STARTUP_INSTALL_DEFER_MS)
      const pendingHandle = timer as unknown as { unref?: () => void }
      if (typeof pendingHandle.unref === 'function') pendingHandle.unref()
      return
    }
    fired = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    void runGenericStartup(controllerDeps).catch((error: unknown) => {
      log?.warn(`[rsi-agent/startup] 通用启动异常（已隔离）：${String(error)}`)
    })
  }

  if (deps.graceMs > 0) {
    armTimer()
    log?.info(`[rsi-agent/startup] 启动宽限期 ${deps.graceMs}ms，等待领域 install`)
  } else {
    fire()
  }

  return {
    get cancelled() {
      return cancelled
    },
    get pending() {
      return timer !== undefined && !fired && !cancelled
    },
    cancel(reason?: string) {
      if (cancelled) return
      cancelled = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      log?.info('[rsi-agent/startup] 启动宽限期已取消', { reason: reason ?? null })
    },
  }
}

export { CORE_OPENING_NOTICE_SUMMARY }

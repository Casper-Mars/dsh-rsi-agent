/**
 * 调度器装配（技术方案 §12.4）：`start` / `stop` + 每任务一条链式 timer。
 *
 * 语义：
 *   - **不阻塞下一轮**：`fire()` 只 `void runTask(...)`，执行结果在后台结算；
 *     `finally` 中立即重算并装上该任务的下一次 timer；
 *   - **代际守卫**：`stop` / `reload` 会让代际自增，旧 fire 不再补 timer，避免
 *     同 id 双份 timer（泄漏 + 双触发）；
 *   - **单飞锁**：同一 `task_id` 同时最多一个 run 在飞（`inFlight` Map）。定时触发
 *     与 `runNow` 共用同一把锁；锁被占用时本次直接 `skipped`（reason 含
 *     `already running`），不排队——排队会在长任务下无限堆积，反而放大唤醒风暴；
 *   - **timer 登记表**：每次 `setTimer` 的句柄都进 `liveTimers`，`stop` / `reload`
 *     逐个 `clearTimer`；同 id 重复装配前也先清旧句柄，避免 map 覆盖丢句柄残留；
 *   - **异常隔离**：单任务 cron 非法 / 清单读取失败只 warn，不影响其它任务；
 *   - 时区优先级：`pack.scheduler.timezone > CoreConfig.timezone > 系统`（§7）。
 */
import { createNoticeMessage } from '../message-source.js'
import { newTraceId, runWithTrace } from '../log/trace.js'
import { resolveTimezone } from '../runtime.js'
import type { DomainLogger, SchedulerSpec } from '../types.js'
import type { Clock, TaskDef, TaskRunOutcome, Timer, TimerHandle, WakeSink } from './types.js'
import { isValidCron, next as cronNext, parseCron, type CronSchedule } from './cron.js'
import { createDependencyCache, createPnpmInstallStrategy, type DependencyCacheOptions } from './deps-cache.js'
import { createNodeExecStrategy } from './runner.js'
import { createTaskStore, TaskStore } from './store.js'
import { runTask } from './task.js'
import { createWaker, Waker } from './wake.js'
import type { GitRunner } from '../assets/git.js'

/** 调度器运行时视图（`DomainRuntime` 的最小子集）。 */
export interface SchedulerRuntimeLike {
  readonly home: string
  readonly assetsDir: string
  readonly dataDir: string
  readonly sessionId: string
  readonly timezone: string
  readonly logger?: DomainLogger
}

/** agent 会话的最小结构。 */
export interface WakeAgentLike {
  readonly id: string
  followup(message: unknown): void
}

/** agent 注册表的最小结构。 */
export interface WakeAgentsLike {
  get(id: string): WakeAgentLike | undefined
}

/** 基于 `ctx.agents` 的唤醒投递端口（复用 producer-owned notice 消息源）。 */
export function createAgentWakeSink(options: {
  readonly agents: WakeAgentsLike
  readonly logger?: Pick<DomainLogger, 'warn' | 'info'>
}): WakeSink {
  return {
    deliver({ text, summary, sessionId }) {
      const agent = options.agents.get(sessionId)
      if (agent === undefined || typeof agent.followup !== 'function') {
        throw new Error(`固定会话 ${sessionId} 不可达（无 followup）`)
      }
      agent.followup(createNoticeMessage(text, summary))
    },
  }
}

/** 永远失败的 sink：未注入投递端口时让唤醒降级为 `skipped`（而不是崩溃）。 */
const NO_SINK: WakeSink = {
  deliver() {
    throw new Error('未配置唤醒投递端口')
  },
}

/** {@link SchedulerService} 选项。 */
export interface SchedulerServiceOptions {
  readonly runtime: SchedulerRuntimeLike
  readonly scheduler: SchedulerSpec
  /** 领域合规声明（追加到唤醒正文末尾）。 */
  readonly disclaimer?: string
  /** `CoreConfig.timezone`（领域未声明时的兜底）。 */
  readonly configTimezone?: string
  /** 覆盖任务目录（缺省 `scheduler.tasksDir` 或 `<assetsDir>/tasks`）。 */
  readonly tasksDir?: string
  /** 注入任务存储（测试）。 */
  readonly store?: Pick<TaskStore, 'list' | 'get' | 'save' | 'remove' | 'tasksDir'>
  /** 注入依赖缓存（测试）。 */
  readonly deps?: { ensure(taskId: string, taskDir: string): Promise<{ installed: boolean; reason: string }> }
  /** 注入执行策略（测试）。 */
  readonly exec?: import('./types.js').ExecStrategy
  /** 注入安装策略（仅在自建依赖缓存时使用）。 */
  readonly install?: import('./types.js').InstallStrategy
  /** 注入唤醒器。 */
  readonly waker?: Waker
  /** 注入投递端口（未注入 `waker` 时生效）。 */
  readonly sink?: WakeSink
  /** 注入时钟。 */
  readonly clock?: Clock
  /** 注入定时器。 */
  readonly timer?: Timer
  /** 注入 git 执行器（任务存储提交用）。 */
  readonly git?: GitRunner
  /** 日志。 */
  readonly logger?: DomainLogger
  /** 依赖缓存参数覆盖。 */
  readonly depsOptions?: Partial<Omit<DependencyCacheOptions, 'dataDir' | 'install'>>
  /** 超时 / 缓冲参数。 */
  readonly timeouts?: {
    readonly installMs?: number
    readonly execMs?: number
    readonly maxStdoutBytes?: number
    readonly maxStderrBytes?: number
  }
}

interface ScheduledEntry {
  readonly schedule: CronSchedule
  readonly taskPath: string
  handle: TimerHandle
}

/** 原生定时器。 */
function nativeTimer(): Timer {
  return {
    setTimer(delayMs, cb) {
      const handle = setTimeout(cb, delayMs)
      if (typeof (handle as { unref?: () => void }).unref === 'function') {
        ;(handle as { unref: () => void }).unref()
      }
      return handle
    },
    clearTimer(handle) {
      clearTimeout(handle)
    },
  }
}

/**
 * 多任务调度器。
 *
 * 任务通过 `store.list()` 读取；每条 `enabled` 且 cron 合法的任务拥有独立 timer，
 * 触发后链式重排下一次。`start` / `stop` / `reload` 幂等。
 */
export class SchedulerService {
  readonly timezone: string
  readonly store: Pick<TaskStore, 'list' | 'get' | 'save' | 'remove' | 'tasksDir'>
  private readonly runtime: SchedulerRuntimeLike
  private readonly deps: { ensure(taskId: string, taskDir: string): Promise<{ installed: boolean; reason: string }> }
  private readonly execStrategy: import('./types.js').ExecStrategy
  private readonly waker: Waker
  private readonly timer: Timer
  private readonly clock: Clock
  private readonly logger: DomainLogger | undefined
  private readonly declaredRuntimes: readonly string[] | undefined
  private readonly knownRuntimes: readonly string[]
  private readonly timeoutMs: number
  private readonly maxStdoutBytes: number
  private readonly maxStderrBytes: number

  private started = false
  private epoch = 0
  private readonly scheduled = new Map<string, ScheduledEntry>()
  /**
   * 已登记、尚未清理的 timer 句柄。
   *
   * `scheduled` 只保留「每个 id 的当前句柄」，同 id 被重复装配会覆盖旧值；单独登记
   * 一份全量句柄集合，保证 `stop` / `reload` 不会漏清。
   */
  private readonly liveTimers = new Set<TimerHandle>()
  /** 同任务单飞锁：`task_id -> 在飞 promise`（定时触发与 runNow 共用）。 */
  private readonly inFlight = new Map<string, Promise<TaskRunOutcome>>()

  constructor(options: SchedulerServiceOptions) {
    this.runtime = options.runtime
    this.logger = options.logger ?? options.runtime.logger
    this.timer = options.timer ?? nativeTimer()
    this.clock = options.clock ?? { now: () => new Date() }
    this.timeoutMs = options.timeouts?.execMs ?? 60_000
    this.maxStdoutBytes = options.timeouts?.maxStdoutBytes ?? 1_048_576
    this.maxStderrBytes = options.timeouts?.maxStderrBytes ?? 65_536

    // 时区：pack > CoreConfig > 系统（技术方案 §7）。
    this.timezone = resolveTimezone(
      { timezone: options.configTimezone },
      { scheduler: { timezone: options.scheduler.timezone } },
      { prefer: 'pack' },
    )

    const tasksDir =
      options.tasksDir ??
      (typeof options.scheduler.tasksDir === 'string' && options.scheduler.tasksDir.trim() !== ''
        ? options.scheduler.tasksDir.trim()
        : `${options.runtime.assetsDir}/tasks`)
    const absoluteTasksDir = tasksDir.startsWith('/')
      ? tasksDir
      : `${options.runtime.home}/${tasksDir}`

    this.store =
      options.store ??
      createTaskStore({
        tasksDir: absoluteTasksDir,
        assetsDir: options.runtime.assetsDir,
        ...(this.logger === undefined
          ? {}
          : { logger: { warn: (message: string) => this.logger?.warn(message) } }),
        ...(options.git === undefined ? {} : { git: options.git }),
      })

    const install = options.install ?? createPnpmInstallStrategy()
    this.deps =
      options.deps ??
      createDependencyCache({
        dataDir: options.runtime.dataDir,
        install,
        ...(this.logger === undefined ? {} : { logger: { warn: (m: string) => this.logger?.warn(m) } }),
        ...(options.depsOptions?.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.depsOptions.timeoutMs }),
        ...(options.depsOptions?.fs === undefined ? {} : { fs: options.depsOptions.fs }),
        ...(options.depsOptions?.clock === undefined ? {} : { clock: options.depsOptions.clock }),
      })

    this.execStrategy = options.exec ?? createNodeExecStrategy()
    this.waker =
      options.waker ??
      createWaker({
        sink: options.sink ?? NO_SINK,
        sessionId: options.runtime.sessionId,
        clock: this.clock,
        ...(options.disclaimer === undefined ? {} : { disclaimer: options.disclaimer }),
        ...(this.logger === undefined
          ? {}
          : {
              logger: {
                info: (m: string, meta?: unknown) => this.logger?.info(m, meta),
                warn: (m: string, meta?: unknown) => this.logger?.warn(m, meta),
              },
            }),
      })

    this.declaredRuntimes = options.scheduler.runtimes
    this.knownRuntimes = ['node', this.execStrategy.name].filter(
      (name, index, list) => list.indexOf(name) === index,
    )
  }

  /** 是否运行中。 */
  get running(): boolean {
    return this.started
  }

  /** 启动调度（幂等）。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.rebuild()
  }

  /** 停止并清空所有 timer（幂等）。 */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.clearAll()
  }

  /** 重新加载清单（全量重建）。 */
  reload(): void {
    if (!this.started) return
    this.clearAll()
    this.rebuild()
  }

  /** 已排定的任务 id（诊断用）。 */
  get scheduledIds(): string[] {
    return [...this.scheduled.keys()].sort()
  }

  /** 立即执行一次（不影响既有 timer）；与定时触发共用同一把单飞锁。 */
  runNow(taskId: string): Promise<TaskRunOutcome> {
    const running = this.inFlight.get(taskId)
    if (running !== undefined) {
      // 单飞：同一任务已有一次运行在飞 → 本次直接跳过（不排队，避免堆积）。
      return Promise.resolve<TaskRunOutcome>({
        kind: 'skipped',
        reason: `任务 ${taskId} 已在执行中（already running），本次触发跳过`,
      })
    }

    const promise = this.executeTask(taskId).finally(() => {
      // 只清除属于本次运行的锁，避免误删后续新锁（防御性处理）。
      if (this.inFlight.get(taskId) === promise) this.inFlight.delete(taskId)
    })
    this.inFlight.set(taskId, promise)
    return promise
  }

  /** 任务是否正在执行（诊断用）。 */
  isTaskRunning(taskId: string): boolean {
    return this.inFlight.has(taskId)
  }

  /** 单飞锁内的真实执行体。 */
  private executeTask(taskId: string): Promise<TaskRunOutcome> {
    // 每次触发分配一个 traceId，并包住整条异步链（依赖安装 / 子进程 / 唤醒）：
    // 同一链路内的所有日志自动带同一个 traceId；子进程由 runner 经 env 继承。
    const trace = { traceId: newTraceId(), taskId, sessionId: this.runtime.sessionId }
    return runWithTrace(trace, () =>
      runTask(taskId, {
        store: this.store,
        deps: this.deps,
        exec: this.execStrategy,
        waker: this.waker,
        home: this.runtime.home,
        ...(this.declaredRuntimes === undefined ? {} : { declaredRuntimes: this.declaredRuntimes }),
        knownRuntimes: this.knownRuntimes,
        timeoutMs: this.timeoutMs,
        maxStdoutBytes: this.maxStdoutBytes,
        maxStderrBytes: this.maxStderrBytes,
        ...(this.logger === undefined
          ? {}
          : {
              logger: {
                info: (m: string, meta?: unknown) => this.logger?.info(m, meta),
                warn: (m: string, meta?: unknown) => this.logger?.warn(m, meta),
              },
            }),
      }),
    )
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private clearAll(): void {
    this.epoch += 1
    // 句柄取并集：登记表（历史全量）+ map 当前值（防御性兜底）。
    const handles = new Set<TimerHandle>(this.liveTimers)
    for (const entry of this.scheduled.values()) handles.add(entry.handle)
    for (const handle of handles) this.timer.clearTimer(handle)
    this.liveTimers.clear()
    this.scheduled.clear()
  }

  private rebuild(): void {
    let listed: { tasks: TaskDef[]; corrupted: string[] }
    try {
      listed = this.store.list()
    } catch (error) {
      this.logger?.error(`读取任务清单失败（本轮跳过）：${String(error)}`)
      return
    }

    if (listed.corrupted.length > 0) {
      this.logger?.warn(`跳过 ${listed.corrupted.length} 个损坏任务文件：${listed.corrupted.join(', ')}`)
    }

    for (const task of listed.tasks) this.scheduleTask(task)
  }

  private scheduleTask(task: TaskDef): void {
    try {
      if (!task.enabled) return
      const taskPath = task.task_path.trim()
      if (taskPath === '') {
        this.logger?.warn(`任务 ${task.id} 缺 task_path，已跳过`)
        return
      }
      if (!isValidCron(task.cron)) {
        this.logger?.warn(`任务 ${task.id} cron 非法（${JSON.stringify(task.cron)}），已跳过`)
        return
      }
      const schedule = parseCron(task.cron)
      this.installTimer(task.id, schedule, taskPath)
    } catch (error) {
      this.logger?.error(`任务 ${task.id} 装配失败（已跳过）：${String(error)}`)
      this.scheduled.delete(task.id)
    }
  }

  private installTimer(id: string, schedule: CronSchedule, taskPath: string): void {
    // 同 id 覆盖前先清掉旧句柄，绝不留下孤儿 timer。
    const existing = this.scheduled.get(id)
    if (existing !== undefined) {
      this.timer.clearTimer(existing.handle)
      this.liveTimers.delete(existing.handle)
      this.scheduled.delete(id)
    }

    const now = this.clock.now()
    const nextAt = cronNext(schedule, now, this.timezone)
    const delay = Math.max(nextAt.getTime() - now.getTime(), 0)
    const handle = this.timer.setTimer(delay, () => {
      this.fire(id)
    })
    this.liveTimers.add(handle)
    this.scheduled.set(id, { schedule, taskPath, handle })
  }

  /**
   * 到点触发：**不阻塞**下一轮。
   *
   * `void runNow` 立即返回；`finally` 中按代际守卫重装下一次 timer。
   */
  private fire(id: string): void {
    const entry = this.scheduled.get(id)
    if (entry === undefined) return
    this.scheduled.delete(id)
    // 该句柄已触发、不再有效：同步出登记表，避免长期运行时无限累积死句柄。
    this.liveTimers.delete(entry.handle)
    const fireEpoch = this.epoch
    this.logger?.info(`任务 ${id} 触发（${entry.taskPath}）`)

    void this.runNow(id)
      .then((outcome) => {
        if (outcome.kind === 'failed') {
          this.logger?.error(
            `任务 ${id} 失败（${outcome.failureKind ?? 'unknown'}）：${outcome.reason}${
              outcome.detail === undefined ? '' : ` — ${outcome.detail}`
            }`,
          )
        } else if (outcome.kind === 'skipped') {
          this.logger?.warn(`任务 ${id} 跳过：${outcome.reason}`)
        } else if (outcome.kind === 'woke') {
          this.logger?.info(`任务 ${id} 已唤醒`)
        } else {
          this.logger?.info(`任务 ${id} 执行完成（未唤醒）`)
        }
      })
      .catch((error: unknown) => {
        this.logger?.error(`任务 ${id} 触发异常（已隔离）：${String(error)}`)
      })
      .finally(() => {
        if (!this.started || fireEpoch !== this.epoch) return
        try {
          this.installTimer(id, entry.schedule, entry.taskPath)
        } catch (error) {
          this.logger?.error(`任务 ${id} 重算下次触发失败，调度链终止：${String(error)}`)
        }
      })
  }
}

/** 创建调度器。 */
export function createSchedulerService(options: SchedulerServiceOptions): SchedulerService {
  return new SchedulerService(options)
}

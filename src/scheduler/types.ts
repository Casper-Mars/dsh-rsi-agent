/**
 * 调度执行链的公共契约（任务模型 / 结局 / 可注入策略 / 时钟）。
 *
 * 本文件只有类型与常量，没有任何运行时副作用。设计目标（技术方案 §12.1–12.4）：
 *   - 调度层对「任务程序内容」一无所知：只负责 定时 → 装依赖 → 起独立进程 →
 *     取 stdout 末行 JSON → 映射结局 → 唤醒；
 *   - 依赖（安装 / 执行 / 唤醒 / 时钟 / 定时器）全部可注入，单测绝不真跑
 *     `pnpm install` 或真实 `node` 子进程。
 */

/** 一条定时任务的定义（`<tasksDir>/<id>.json`）。 */
export interface TaskDef {
  /** 唯一标识（同时是文件名骨架，必须通过安全路径段校验）。 */
  readonly id: string
  /** 人类可读名称。 */
  readonly name: string
  /** 5 段 cron（分 时 日 月 周），最小粒度分钟。 */
  readonly cron: string
  /** 任务程序入口（相对 `<home>` 的路径，或绝对路径）。 */
  readonly task_path: string
  /** 是否启用；`false` 的任务不参与调度。 */
  readonly enabled: boolean
}

/**
 * 任务程序的返回值契约：stdout **最后一个非空行**的一行 JSON。
 *
 *   - `{ "shouldWake": true, "data": "..." }` —— 唤醒，`data` 逐字作为正文；
 *   - `{ "shouldWake": false }` —— 静默完成。
 *
 * `shouldWake` 非 boolean、`data` 非 string、末行不是 JSON ⇒ 解析失败（`parse`）。
 */
export type TaskScriptResult =
  | { readonly shouldWake: true; readonly data: string }
  | { readonly shouldWake: false }

/** 失败分类（与结局 `failed` 搭配）。 */
export type TaskRunFailureKind =
  /** 依赖安装阶段失败 / 超时 / 未知运行时。 */
  | 'install'
  /** 进程 spawn 失败。 */
  | 'spawn'
  /** 子进程执行失败（非零退出 / 崩溃 / 超时强杀 / stdout 超限）。 */
  | 'exec'
  /** stdout 解析失败（无有效结果 JSON）。 */
  | 'parse'
  /** 唤醒投递失败。 */
  | 'wake'

/** 单次任务运行的结局（四态）。 */
export type TaskRunOutcome =
  | {
      /** 正常执行、无需唤醒（无输出或 `shouldWake:false`）。 */
      readonly kind: 'quiet'
      /** 结局说明。 */
      readonly reason: string
    }
  | {
      /** 有唤醒且投递成功。 */
      readonly kind: 'woke'
      /** 结局说明。 */
      readonly reason: string
      /** 唤醒正文（已截断 + 已追加 disclaimer）。 */
      readonly data: string
      /** 投递目标（固定会话 id）。 */
      readonly targets: readonly string[]
    }
  | {
      /** 跳过：冷却中 / 投递失败（降级）。 */
      readonly kind: 'skipped'
      /** 跳过说明。 */
      readonly reason: string
      /** 降级细节。 */
      readonly detail?: string
    }
  | {
      /** 失败：install / spawn / exec / parse。 */
      readonly kind: 'failed'
      /** 失败说明。 */
      readonly reason: string
      /** 失败细节。 */
      readonly detail?: string
      /** 失败分类。 */
      readonly failureKind?: TaskRunFailureKind
    }

/** 时钟源（可注入，便于冷却边界测试）。 */
export interface Clock {
  /** 当前时刻。 */
  now(): Date
}

/** 定时器句柄。 */
export type TimerHandle = ReturnType<typeof setTimeout>

/** 定时器抽象（可注入）。 */
export interface Timer {
  /** 安排一次性定时。 */
  setTimer(delayMs: number, cb: () => void): TimerHandle
  /** 取消已排定的定时。 */
  clearTimer(handle: TimerHandle): void
}

/** 进程执行结果。 */
export interface ExecResult {
  /** 退出码；`null` = 未退出 / 崩溃。 */
  readonly exitCode: number | null
  /** stdout（已按上限截断）。 */
  readonly stdout: string
  /** stderr（有界收集）。 */
  readonly stderr: string
  /** stdout 是否超限被截断。 */
  readonly truncated: boolean
  /** 是否因超时被强杀。 */
  readonly timedOut: boolean
  /** spawn 失败原因（存在时其余字段无意义）。 */
  readonly spawnError?: string
}

/** 执行策略输入。 */
export interface ExecInput {
  /** 任务入口绝对路径。 */
  readonly taskPath: string
  /** 子进程工作目录（任务目录）。 */
  readonly cwd: string
  /** 超时上限（毫秒）。 */
  readonly timeoutMs: number
  /** stdout 上限（**UTF-8 字节**；截断点不切开多字节字符）。 */
  readonly maxStdoutBytes: number
  /** stderr 上限（字节）。 */
  readonly maxStderrBytes: number
}

/**
 * 执行策略（v1：`node`）。
 *
 * 实现方负责「起独立进程 → 有界收集输出 → 超时强杀」，并保证**不抛异常**：
 * 失败通过 {@link ExecResult} 字段表达（唯一例外是组合器层面的编程错误）。
 */
export interface ExecStrategy {
  /** 策略名（诊断用，例如 `node`）。 */
  readonly name: string
  /** 执行任务程序。 */
  exec(input: ExecInput): Promise<ExecResult>
}

/** 安装策略输入。 */
export interface InstallInput {
  /** 任务 id（错误信息用）。 */
  readonly taskId: string
  /** 任务目录（安装命令的 cwd）。 */
  readonly taskDir: string
  /** 超时上限（毫秒）。 */
  readonly timeoutMs: number
}

/** 安装策略（v1：`pnpm`）。失败必须抛错（由调用方映射为 `install`）。 */
export interface InstallStrategy {
  /** 策略名（诊断用，例如 `pnpm`）。 */
  readonly name: string
  /** 确保任务目录依赖就绪。 */
  install(input: InstallInput): Promise<void>
}

/** 唤醒投递输入。 */
export interface WakeInput {
  /** 任务 id（冷却键）。 */
  readonly taskId: string
  /** 已截断、已追加 disclaimer 的正文。 */
  readonly text: string
  /** 一行摘要（notice 形态需要）。 */
  readonly summary: string
  /** 投递目标会话 id。 */
  readonly sessionId: string
}

/** 唤醒投递端口（由宿主注入；抛错即降级为 `skipped`）。 */
export interface WakeSink {
  /** 投递一条唤醒消息。 */
  deliver(input: WakeInput): void | Promise<void>
}

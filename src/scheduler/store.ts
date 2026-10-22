/**
 * 任务定义持久化（`<tasksDir>/<id>.json`）。
 *
 * 存储位置取舍（任务卡要求「二选一，并说明理由」）：**放在 `<assetsDir>/tasks/`**，
 * 而不是 `<dataDir>/tasks/`。理由：
 *   1. 技术方案 §9.2 规定「资产写入即 commit」；任务定义是需要版本化、可分享、
 *      可回溯的资产，`save` / `remove` 必须能进入资产仓库的提交历史；
 *   2. `commitAssets` 只接受**相对 assetsDir 且落在某个类型前缀下**的路径，
 *      放 `<dataDir>` 根本进不了提交（路径越界，只能永久降级）；
 *   3. `<dataDir>` 是 `0o700` 私有目录，适合放缓存（`deps-cache.json`）与运行期
 *      状态，不适合放需要分享的定义。
 *
 * 关键约束：
 *   - **id 防目录穿越**：拼路径前必须过 {@link assertTaskId}（拒绝 `/`、`\`、`..`、
 *     空串、控制字符、超长）；
 *   - **损坏文件跳过**：`list()` 遇到 JSON 解析失败 / 结构非法只记入 `corrupted`，
 *     不抛异常、不中断其它任务；
 *   - **id 必须等于文件名骨架**：`tasks/dup.json` 里写 `id:"other"` 属于损坏
 *     （否则同 id 会装出多份 timer，`stop` 也无法按 id 收敛），跳过并 warn；
 *   - **git 降级不抛**：`save` / `remove` 落盘后走 `commitAssets`；任何提交失败
 *     （git 不可用、路径不在资产目录、动作异常）只 `warn`，磁盘成功即业务成功。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { commitAssets, type CommitAssetsResult } from '../assets/commit.js'
import type { GitRunner } from '../assets/git.js'
import type { TaskDef } from './types.js'

/** 任务 id 白名单：字母/数字开头，允许 `.` `_` `-`。 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** 任务文件扩展名。 */
export const TASK_FILE_EXT = '.json'

/**
 * 任务定义的写入动作（决定 commit message 里的动词）。
 *
 *   - `create` / `update` / `enable` / `disable` —— 工具层的四种写动作；
 *   - `save` —— 缺省值，保持既有调用（`store.save(task)`）的提交语义不变。
 */
export type TaskSaveAction = 'create' | 'update' | 'enable' | 'disable' | 'save'

/** 任务存储契约错误（id 非法 / 写入内容非法）。 */
export class TaskStoreError extends Error {
  constructor(message: string) {
    super(`[scheduler/store] ${message}`)
    this.name = 'TaskStoreError'
  }
}

/** 日志出口：兼容统一门面与简单回调。 */
export type TaskStoreLogger =
  | { warn(message: string, meta?: unknown): void }
  | ((message: string) => void)

function warnOf(logger: TaskStoreLogger | undefined): (message: string) => void {
  if (logger === undefined) return () => {}
  if (typeof logger === 'function') return logger
  return (message: string) => logger.warn(message)
}

/**
 * 校验任务 id 可作为单段文件名。
 *
 * 拒绝 `''` / `.` / `..` / 含路径分隔符 / 反斜杠 / 空字符 / 超长 / 非法字符，
 * 并给出具体原因（调用方与测试可直接断言消息）。
 */
export function assertTaskId(id: unknown): string {
  if (typeof id !== 'string' || id === '') {
    throw new TaskStoreError(`任务 id 必须是非空字符串，实际为 ${String(id)}`)
  }
  if (id === '.' || id === '..') {
    throw new TaskStoreError(`任务 id 不能是特殊路径段 ${JSON.stringify(id)}`)
  }
  if (id.includes('/') || id.includes('\\')) {
    throw new TaskStoreError(`任务 id 不得包含路径分隔符：${JSON.stringify(id)}`)
  }
  if (id.includes('\0')) {
    throw new TaskStoreError(`任务 id 不得包含空字符：${JSON.stringify(id)}`)
  }
  if (!TASK_ID_PATTERN.test(id)) {
    throw new TaskStoreError(
      `任务 id 必须匹配 ${TASK_ID_PATTERN}（字母/数字开头，≤128 字符），实际为 ${JSON.stringify(id)}`,
    )
  }
  return id
}

/** 判断未知值是否符合 {@link TaskDef} 的最小结构。 */
export function isTaskDef(value: unknown): value is TaskDef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !TASK_ID_PATTERN.test(record.id)) return false
  return (
    typeof record.name === 'string' &&
    typeof record.cron === 'string' &&
    typeof record.task_path === 'string' &&
    typeof record.enabled === 'boolean'
  )
}

/** `list()` 结果：有效任务 + 损坏文件名（不含扩展名）。 */
export interface TaskListResult {
  readonly tasks: TaskDef[]
  readonly corrupted: string[]
}

/** {@link TaskStore} 构造选项。 */
export interface TaskStoreOptions {
  /** 任务定义目录（绝对路径）。 */
  readonly tasksDir: string
  /**
   * 资产仓库根目录；缺省取 `tasksDir` 的父目录。tasksDir 不在其下时不产生提交
   * （只落盘 + warn）。
   */
  readonly assetsDir?: string
  /** 日志出口。 */
  readonly logger?: TaskStoreLogger
  /** 自定义 git 执行器（测试注入）。 */
  readonly git?: GitRunner
}

/** 任务清单持久化。 */
export class TaskStore {
  readonly tasksDir: string
  private readonly assetsDir: string
  /** 任务目录相对资产根的 posix 前缀（含结尾 `/`）；不在资产目录内时为 undefined。 */
  private readonly assetPrefix: string | undefined
  private readonly warn: (message: string) => void
  private readonly git: GitRunner | undefined

  constructor(options: TaskStoreOptions) {
    if (typeof options.tasksDir !== 'string' || options.tasksDir === '') {
      throw new TaskStoreError('tasksDir 必须是非空字符串')
    }
    this.tasksDir = options.tasksDir
    this.assetsDir = options.assetsDir ?? dirname(options.tasksDir)
    this.warn = warnOf(options.logger)
    this.git = options.git

    const rel = relative(this.assetsDir, this.tasksDir)
    const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    this.assetPrefix = inside ? `${rel.split(sep).join('/')}/` : undefined
  }

  /** 任务定义文件的绝对路径（id 先过安全校验）。 */
  filePath(id: string): string {
    return join(this.tasksDir, `${assertTaskId(id)}${TASK_FILE_EXT}`)
  }

  /** 相对资产根的任务文件路径；不在资产目录内时 `undefined`。 */
  private assetRelPath(id: string): string | undefined {
    if (this.assetPrefix === undefined) return undefined
    return `${this.assetPrefix}${id}${TASK_FILE_EXT}`
  }

  /**
   * 提交单个任务文件的变更。
   *
   * 只用一个合成资产类型（`tasks` + 本 store 的实际前缀）做白名单，不要求领域包
   * 额外声明 `tasks/`，避免「core 基础设施」反过来污染领域资产契约。
   */
  private commit(id: string, message: string): void {
    const path = this.assetRelPath(id)
    if (path === undefined) {
      this.warn(`任务 ${id} 不在资产目录（${this.assetsDir}）内，跳过提交（文件已落盘）`)
      return
    }
    let result: CommitAssetsResult
    try {
      result = commitAssets({
        runtime: { assetsDir: this.assetsDir },
        assetTypes: [{ name: 'scheduler-tasks', prefix: this.assetPrefix as string }],
        paths: [path],
        message,
        ...(this.git === undefined ? {} : { git: this.git }),
        logger: (text: string) => this.warn(text),
      })
    } catch (error) {
      // 路径非法 / git 执行器抛错：一律降级（磁盘已成功，绝不能反向失败）。
      this.warn(`任务 ${id} 提交异常（已忽略）：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (result.degraded) {
      this.warn(`任务 ${id} 提交降级（文件已落盘）：${result.reason ?? '未知原因'}`)
    }
  }

  /**
   * 列出全部任务（按 id 升序）并归集损坏文件。
   *
   * 「损坏」判定包含两类：JSON 解析失败 / 结构非法，以及**文件内 `id` 与文件名
   * 骨架不一致**（`dup.json` 内 `id` 为 `other`）。后者不校验会导致同一 id 在多份
   * 文件里出现，装出多份 timer 且 `stop` 只能清掉其中一份，故直接跳过并 warn。
   */
  list(): TaskListResult {
    const tasks: TaskDef[] = []
    const corrupted: string[] = []
    if (!existsSync(this.tasksDir)) return { tasks, corrupted }

    let entries: string[]
    try {
      entries = readdirSync(this.tasksDir)
    } catch {
      return { tasks, corrupted }
    }

    for (const entry of entries) {
      if (!entry.endsWith(TASK_FILE_EXT)) continue
      const stem = entry.slice(0, -TASK_FILE_EXT.length)
      let task: TaskDef | undefined
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(this.tasksDir, entry), 'utf8'))
        if (isTaskDef(parsed)) task = parsed
      } catch {
        task = undefined
      }
      if (task === undefined) {
        corrupted.push(stem)
      } else if (task.id !== stem) {
        // 文件名与 id 不一致：视为损坏项（双份 timer / stop 残留的根源）。
        corrupted.push(stem)
        this.warn(
          `任务文件 ${entry} 内的 id（${task.id}）与文件名（${stem}）不一致，已跳过`,
        )
      } else {
        tasks.push(task)
      }
    }

    tasks.sort((left, right) => left.id.localeCompare(right.id))
    return { tasks, corrupted }
  }

  /** 读取单个任务；不存在 / 损坏返回 `undefined`。id 非法仍抛错（编程错误要响亮）。 */
  get(id: string): TaskDef | undefined {
    const path = this.filePath(id)
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      return isTaskDef(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 写入 / 覆盖任务（同步落盘，随后提交；提交失败只 warn）。
   *
   * @param task 已校验的任务定义。
   * @param action 写入动作，决定 commit message 的动词
   *   （`tasks: <action> <id>`）；缺省 `save`，与既有调用完全兼容。
   */
  save(task: TaskDef, action: TaskSaveAction = 'save'): void {
    if (!isTaskDef(task)) {
      throw new TaskStoreError(`save 的任务结构非法：${JSON.stringify(task)}`)
    }
    const path = this.filePath(task.id)
    mkdirSync(this.tasksDir, { recursive: true })
    writeFileSync(path, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
    this.commit(task.id, `tasks: ${action} ${task.id}`)
  }

  /** 删除任务文件；不存在返回 `false`（不抛错）。删除同样提交。 */
  remove(id: string): boolean {
    const path = this.filePath(id)
    if (!existsSync(path)) return false
    rmSync(path, { force: true })
    this.commit(id, `tasks: remove ${id}`)
    return true
  }
}

/** 创建任务存储。 */
export function createTaskStore(options: TaskStoreOptions): TaskStore {
  return new TaskStore(options)
}

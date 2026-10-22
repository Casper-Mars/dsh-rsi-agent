/**
 * 任务定义工具（7 个）：`task_create` / `task_list` / `task_get` /
 * `task_update` / `task_delete` / `task_enable` / `task_disable`。
 *
 * 设计约束（技术方案 §12 / Task-11）：
 *   1. **单一写入入口**：全部写动作都经 {@link TaskStore}（落盘 + `commitAssets`），
 *      工具层**绝不**自己 `writeFileSync`；`save` 的第二个参数决定 commit
 *      message 的动词（`tasks: create|update|enable|disable <id>`）；
 *   2. **路径白名单**：`task_path` 必须相对 `<assetsDir>` 落在 `programs/` 前缀下
 *      （也接受显式写 `assets/programs/...`），逐段拒绝空段 / `.` / `..` /
 *      `.git` / 反斜杠 / 绝对路径，并要求目标文件存在、可读、软链接不逃逸；
 *   2b. **落盘基准 = home（P0 修复）**：校验仍以 `assetsDir` 为基准，落盘前统一
 *      归一化为**相对 `<home>` 的 posix 路径**（如 `assets/programs/demo/task.ts`），
 *      使执行链 `resolveTaskPath(home, task_path)` 解析回同一个真实文件，资产
 *      定义也不含机器绝对路径（可移植）。若 `assetsDir` 被 legacy 安装选项指到
 *      `home` 之外，`relative` 会以 `..` 开头，此时**退化为绝对路径**落盘
 *      （`runTask` 对绝对 `task_path` 显式放行：语义正确但不可移植）；
 *   3. **语义错误一律抛错**（id 不存在 / cron 非法 / 路径非法 / 文件不可读），
 *      带明确中文原因，不返回 `{ ok: false }` 静默吞掉；
 *   4. **变更即时生效**：写成功后调用注入的 `onChange`（生产环境是
 *      `SchedulerService.reload()`，单测可注入纯计数器，不依赖真实调度器）；
 *   5. **任务对象严格 5 字段**：`id` / `name` / `cron` / `task_path` / `enabled`，
 *      不携带任何业务扩展字段（`TaskDef` 之外的字段一律丢弃）。写操作以这 5
 *      字段**重写**定义文件，因此磁盘上既有的扩展字段会在 update / enable /
 *      disable 时被丢弃（预期行为：调度契约只认这 5 个字段）；
 *   6. 零第三方运行时依赖，只依赖 `@deepseek-ai/dsh-tools` 的类型。
 */
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ToolDefinition } from '../types.js'
import { parseCron } from './cron.js'
import { assertTaskId, type TaskListResult, type TaskSaveAction } from './store.js'
import { checkTaskFileReadable, resolveTaskPath } from './task.js'
import type { TaskDef } from './types.js'

/** 工具错误前缀（错误信息统一可辨识）。 */
export const SCHEDULER_TOOLS_TAG = '[scheduler/tools]'

/** 任务程序必须落在资产根的该前缀下。 */
export const TASK_PROGRAM_PREFIX = 'programs'

/** 暴露给 `task_path` 的两种合法写法前缀（相对资产根）。 */
export const TASK_PROGRAM_PREFIXES: readonly string[] = Object.freeze([
  `${TASK_PROGRAM_PREFIX}/`,
  `assets/${TASK_PROGRAM_PREFIX}/`,
])

/** 调度工具语义错误（入参非法 / id 不存在 / 文件不可读）。 */
export class SchedulerToolError extends Error {
  constructor(message: string) {
    super(`${SCHEDULER_TOOLS_TAG} ${message}`)
    this.name = 'SchedulerToolError'
  }
}

/**
 * 工具层需要的任务存储最小面（`TaskStore` 结构上完全满足；单测可注入）。
 *
 * `save` 的第二个参数可选，因此既有只接受一个参数的实现依然兼容。
 */
export interface SchedulerToolStore {
  /** 任务定义目录（绝对路径）。 */
  readonly tasksDir: string
  list(): TaskListResult
  get(id: string): TaskDef | undefined
  save(task: TaskDef, action?: TaskSaveAction): void
  remove(id: string): boolean
}

/** {@link createSchedulerTools} 依赖。 */
export interface SchedulerToolsOptions {
  /** 任务定义存储（`TaskStore`）。 */
  readonly store: SchedulerToolStore
  /** 资产根目录（`<home>/assets`），`task_path` **入参校验**的解析基准。 */
  readonly assetsDir: string
  /**
   * 领域 home，`task_path` **落盘归一化**的基准（执行链 `runTask` / `resolveTaskPath`
   * 用的是同一个基准）。
   *
   * 缺省取 `dirname(assetsDir)`（即 `<home>/assets` 的父目录），保证只注入
   * `assetsDir` 的既有调用仍然可用；生产环境由 `mountScheduler()` 显式传入
   * `runtime.home`。
   */
  readonly home?: string
  /** 写成功后的回调（生产环境注入 `() => service.reload()`）。 */
  onChange?: () => void
  /** 日志出口（`onChange` 抛错时只 warn）。 */
  readonly logger?: { warn(message: string, meta?: unknown): void }
}

/** 对外暴露的任务对象（与 `TaskDef` 逐字段一致，严格 5 字段）。 */
export interface TaskView {
  readonly id: string
  readonly name: string
  readonly cron: string
  readonly task_path: string
  readonly enabled: boolean
}

// ---------------------------------------------------------------------------
// 入参校验
// ---------------------------------------------------------------------------

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new SchedulerToolError(
      `入参必须是对象，实际为 ${args === null ? 'null' : Array.isArray(args) ? 'array' : typeof args}`,
    )
  }
  return args as Record<string, unknown>
}

/** 校验任务 id（单段文件名骨架，防目录穿越）。 */
export function validateTaskId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SchedulerToolError('id 必须是非空字符串')
  }
  const id = value.trim()
  try {
    return assertTaskId(id)
  } catch (error) {
    throw new SchedulerToolError(
      `id 非法：${error instanceof Error ? error.message.replace(/^\[scheduler\/store\]\s*/, '') : String(error)}`,
    )
  }
}

/** 校验任务名称。 */
function validateName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SchedulerToolError('name 必须是非空字符串')
  }
  return value
}

/** 校验 enabled。 */
function validateEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new SchedulerToolError(`enabled 必须是 boolean，实际为 ${value === null ? 'null' : typeof value}`)
  }
  return value
}

/**
 * 校验 cron：**只接受 5 段**（分 时 日 月 周），6 段 / 带秒表达式一律拒绝。
 *
 * 复用 {@link parseCron} 的严格校验，错误信息保留其中文说明（含
 * 「应含 5 段（分 时 日 月 周）」），并补充工具层前缀。
 */
export function validateTaskCron(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SchedulerToolError('cron 必须是非空字符串（应含 5 段（分 时 日 月 周））')
  }
  const expr = value.trim()
  try {
    parseCron(expr)
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/^\[cron\]\s*/, '') : String(error)
    throw new SchedulerToolError(`cron 非法：${detail}`)
  }
  return expr
}

/** 路径段是否非法（空段 / `.` / `..` / `.git`）。 */
function isIllegalSegment(segment: string): boolean {
  return segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git'
}

/** `realpathSync` 容错封装。 */
function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * 校验 `task_path` 并返回**可读性已确认**的绝对路径。
 *
 * 规则（逐条拒绝，错误信息带具体原因）：
 *   - 非空字符串、不含空字符 / 反斜杠；
 *   - 不是绝对路径（也不接受 `C:` 盘符写法）；
 *   - 逐段拒绝空段、`.`、`..`、`.git`；
 *   - 去掉可选的 `assets/` 前缀后，首段必须是 `programs`，且至少
 *     `programs/<file>` 两段；
 *   - 目标必须是存在的普通文件且可读（复用 {@link checkTaskFileReadable}）；
 *   - 软链接解析后的真实路径仍须位于资产根内（拒绝软链接逃逸）。
 *
 * @param assetsDir 资产根目录（绝对路径）。
 * @param value 模型传入的 `task_path`。
 * @returns 绝对路径（供可读性校验与诊断使用）。
 * @throws {SchedulerToolError} 任一规则不满足。
 */
export function resolveTaskProgramPath(assetsDir: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SchedulerToolError(
      `task_path 必须是非空字符串（必须以 ${TASK_PROGRAM_PREFIX}/ 开头，相对 assets 资产根）`,
    )
  }
  const raw = value.trim()
  if (raw.includes('\0')) {
    throw new SchedulerToolError(`task_path 不得包含空字符：${JSON.stringify(raw)}`)
  }
  if (raw.includes('\\')) {
    throw new SchedulerToolError(`task_path 不得使用反斜杠（只接受 posix 路径）：${JSON.stringify(raw)}`)
  }
  if (raw.startsWith('/') || isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new SchedulerToolError(
      `task_path 不得为绝对路径（必须以 ${TASK_PROGRAM_PREFIX}/ 开头，相对 assets 资产根）：${JSON.stringify(raw)}`,
    )
  }

  const segments = raw.split('/')
  const illegal = segments.find((segment) => isIllegalSegment(segment))
  if (illegal !== undefined) {
    throw new SchedulerToolError(
      `task_path 含非法路径段 ${JSON.stringify(illegal)}（不得为空段 / "." / ".." / ".git"）：${JSON.stringify(raw)}`,
    )
  }

  const relativeSegments = segments[0] === 'assets' ? segments.slice(1) : segments
  if (relativeSegments[0] !== TASK_PROGRAM_PREFIX || relativeSegments.length < 2) {
    throw new SchedulerToolError(
      `task_path 必须以 ${TASK_PROGRAM_PREFIX}/ 开头（相对 assets 资产根，形如 ${TASK_PROGRAM_PREFIX}/<dir>/<file>）：${JSON.stringify(raw)}`,
    )
  }

  const absolute = join(assetsDir, ...relativeSegments)
  const unreadable = checkTaskFileReadable(absolute)
  if (unreadable !== undefined) {
    throw new SchedulerToolError(`task_path 指向的任务程序不可用（${unreadable}）：${absolute}`)
  }

  // 软链接逃逸：真实路径必须仍在资产根内。
  const real = tryRealpath(absolute)
  if (real === undefined) {
    throw new SchedulerToolError(`task_path 指向的任务程序不可解析（软链接损坏或权限不足）：${absolute}`)
  }
  const rootReal = tryRealpath(assetsDir)
  if (rootReal !== undefined) {
    const rel = relative(rootReal, real)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new SchedulerToolError(
        `task_path 软链接指向资产根之外：${JSON.stringify(raw)} -> ${real}`,
      )
    }
  }
  return absolute
}

/** 工具层的落盘基准 home（缺省按 `<assetsDir>/..` 推断）。 */
export function resolveHomeBase(options: Pick<SchedulerToolsOptions, 'assetsDir' | 'home'>): string {
  return options.home ?? dirname(options.assetsDir)
}

/**
 * 把校验通过的绝对路径归一化为**相对 `home` 的 posix** `task_path`。
 *
 * - 常规情形（`assetsDir` 位于 `home` 内）：得到 `assets/programs/...`，与执行链
 *   `resolveTaskPath(home, ...)` 的基准一致，且资产定义不含机器绝对路径；
 * - 退化情形（`assetsDir` 被 legacy 选项指到 `home` 之外）：`relative` 以 `..`
 *   开头，相对值既是逃逸路径也不可移植 → 落**绝对路径**（`runTask` 显式放行
 *   绝对 `task_path`，行为正确但不可移植）；
 * - 结果再用 {@link resolveTaskPath} 回验：写盘值必须能被真实执行链解析。不一致
 *   属内部契约破坏，直接抛错而不是静默落一个永远执行失败的路径。
 */
export function toStoredTaskPath(home: string, absolute: string): string {
  const rel = relative(home, absolute)
  const escaped = rel === '' || rel.startsWith('..') || isAbsolute(rel)
  const stored = escaped ? absolute : rel.split(sep).join('/')

  const check = resolveTaskPath(home, stored)
  if (check.path === undefined) {
    throw new SchedulerToolError(
      `task_path 归一化结果无法被执行链解析（${check.error}）：${JSON.stringify(stored)}`,
    )
  }
  return stored
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/** 任务定义文件的绝对路径。 */
function taskFilePath(store: SchedulerToolStore, id: string): string {
  return join(store.tasksDir, `${id}.json`)
}

/** 任务定义文件是否已存在（含损坏文件，避免 create 静默覆盖）。 */
function taskFileExists(store: SchedulerToolStore, id: string): boolean {
  return existsSync(taskFilePath(store, id))
}

/** 读取必须存在的任务；不存在即抛错。 */
function requireTask(store: SchedulerToolStore, id: string): TaskDef {
  const task = store.get(id)
  if (task === undefined) {
    throw new SchedulerToolError(`任务 ${id} 不存在`)
  }
  return task
}

/** 任务定义的可写补丁（`TaskDef` 字段只读，补丁用可变结构表达）。 */
type TaskPatch = {
  name?: string
  cron?: string
  task_path?: string
  enabled?: boolean
}

/** 构造严格 5 字段的任务定义（丢弃外部文件里的额外字段）。 */
function buildTask(task: TaskDef, patch: TaskPatch = {}): TaskDef {
  return {
    id: task.id,
    name: task.name,
    cron: task.cron,
    task_path: task.task_path,
    enabled: task.enabled,
    ...patch,
  }
}

/** 任务定义 → 对外视图（严格 5 字段，无业务扩展）。 */
function toTaskView(task: TaskDef): TaskView {
  return {
    id: task.id,
    name: task.name,
    cron: task.cron,
    task_path: task.task_path,
    enabled: task.enabled,
  }
}

/** 写后通知（`onChange` 抛错不得让「已落盘」的写动作反向失败）。 */
function notifyChange(options: SchedulerToolsOptions): void {
  if (options.onChange === undefined) return
  try {
    options.onChange()
  } catch (error) {
    options.logger?.warn(
      `任务变更后的调度器 reload 失败（文件已落盘）：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// output.schema
// ---------------------------------------------------------------------------

/** 单条任务视图（严格 5 字段）。 */
const TASK_VIEW_SCHEMA = {
  type: 'object',
  description: '任务定义（仅 id/name/cron/task_path/enabled 五个字段）',
  properties: {
    id: { type: 'string', description: '任务唯一标识' },
    name: { type: 'string', description: '人类可读名称' },
    cron: { type: 'string', description: '5 段 cron（分 时 日 月 周）' },
    task_path: {
      type: 'string',
      description: '任务程序入口（相对领域 home 的 posix 路径，programs/ 下，如 assets/programs/...）',
    },
    enabled: { type: 'boolean', description: '是否启用' },
  },
  required: ['id', 'name', 'cron', 'task_path', 'enabled'],
  additionalProperties: false,
} as const

/** 写类工具出参：`{ ok, task }`。 */
const TASK_WRITE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '写库是否成功（成功即 true）' },
    task: TASK_VIEW_SCHEMA,
  },
  required: ['ok', 'task'],
  additionalProperties: false,
} as const

/** `task_get` 出参：`{ task }`。 */
const TASK_GET_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { task: TASK_VIEW_SCHEMA },
  required: ['task'],
  additionalProperties: false,
} as const

/** `task_delete` 出参：`{ ok, id }`。 */
const TASK_DELETE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '是否删除成功' },
    id: { type: 'string', description: '被删除的任务 id' },
  },
  required: ['ok', 'id'],
  additionalProperties: false,
} as const

/** `task_list` 出参：`{ tasks, corrupted? }`（`corrupted` 仅在非空时出现）。 */
const TASK_LIST_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      description: '有效任务清单（按 id 升序）',
      items: TASK_VIEW_SCHEMA,
    },
    corrupted: {
      type: 'array',
      description: '解析失败 / 结构非法 / 文件名与 id 不一致的任务文件名（不含扩展名）',
      items: { type: 'string' },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
} as const

const ID_PARAMETER = {
  type: 'string',
  description: '任务唯一标识（字母/数字开头，允许 . _ -，≤128 字符）',
} as const

const CRON_PARAMETER = {
  type: 'string',
  description: 'cron 表达式，**必须 5 段**（分 时 日 月 周），最小粒度分钟；不接受秒字段',
} as const

const TASK_PATH_PARAMETER = {
  type: 'string',
  description:
    '任务程序入口，必须位于 programs/ 下，两种写法等价：programs/demo/task.ts（相对 assets 资产根）' +
    '或 assets/programs/demo/task.ts（相对领域 home）。服务端统一归一化为相对 home 的 posix 路径落盘' +
    '（默认 assets/programs/demo/task.ts）；文件必须存在且可读',
} as const

// ---------------------------------------------------------------------------
// 7 个工具
// ---------------------------------------------------------------------------

/** `task_create`：新建任务定义（id 必须唯一）。 */
export function createTaskCreateTool(options: SchedulerToolsOptions): ToolDefinition {
  const { store, assetsDir } = options
  const home = resolveHomeBase(options)
  return {
    name: 'task_create',
    description:
      '新建一条定时任务定义并立即生效（写入即 commit）。' +
      'id 必须唯一（已存在会报错）；cron 只接受 5 段（分 时 日 月 周）；' +
      'task_path 必须在 programs/ 前缀下且文件可读；入参可写 programs/... 或 assets/programs/...，' +
      '落盘统一归一化为相对领域 home 的路径（默认 assets/programs/...），执行链可直接解析。',
    parameters: {
      type: 'object',
      properties: {
        id: ID_PARAMETER,
        name: { type: 'string', description: '人类可读名称' },
        cron: CRON_PARAMETER,
        task_path: TASK_PATH_PARAMETER,
        enabled: { type: 'boolean', description: '是否启用，缺省 true' },
      },
      required: ['id', 'name', 'cron', 'task_path'],
      additionalProperties: false,
    } as unknown as Record<string, unknown>,
    output: {
      schema: TASK_WRITE_OUTPUT_SCHEMA as unknown as never,
      render: (_args: unknown, value: unknown) => {
        const view = (value as { task: TaskView }).task
        return [
          { type: 'text' as const, text: `✅ 已创建任务 ${view.id}（enabled=${view.enabled}，cron=${view.cron}）` },
        ]
      },
    },
    execute: async (args: unknown): Promise<unknown> => {
      const record = asRecord(args)
      const id = validateTaskId(record.id)
      if (taskFileExists(store, id)) {
        throw new SchedulerToolError(`任务 ${id} 已存在，create 不允许覆盖（请改用 task_update）`)
      }
      const name = validateName(record.name)
      const cron = validateTaskCron(record.cron)
      const taskPath = record.task_path
      // 先按 assetsDir 校验（抛错即不落盘），再归一化为相对 home 的落盘值。
      if (typeof taskPath !== 'string') {
        throw new SchedulerToolError('task_path 必须是字符串')
      }
      const absolute = resolveTaskProgramPath(assetsDir, taskPath)
      const storedPath = toStoredTaskPath(home, absolute)
      const enabled = record.enabled === undefined ? true : validateEnabled(record.enabled)
      const task: TaskDef = {
        id,
        name,
        cron,
        task_path: storedPath,
        enabled,
      }
      store.save(task, 'create')
      notifyChange(options)
      return { ok: true, task: toTaskView(task) }
    },
  }
}

/** `task_list`：列出全部任务定义（+ 可选损坏诊断）。 */
export function createTaskListTool(options: SchedulerToolsOptions): ToolDefinition {
  const { store } = options
  return {
    name: 'task_list',
    description:
      '列出全部定时任务定义（按 id 升序），每个任务只含 id/name/cron/task_path/enabled。只读操作。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    } as unknown as Record<string, unknown>,
    output: {
      schema: TASK_LIST_OUTPUT_SCHEMA as unknown as never,
      render: (_args: unknown, value: unknown) => {
        const result = value as { tasks: TaskView[]; corrupted?: string[] }
        if (result.tasks.length === 0) {
          const extra =
            result.corrupted === undefined || result.corrupted.length === 0
              ? ''
              : `（另有 ${result.corrupted.length} 个损坏文件：${result.corrupted.join(', ')}）`
          return [{ type: 'text' as const, text: `暂无定时任务${extra}` }]
        }
        const lines = result.tasks.map(
          (task) =>
            `${task.enabled ? '🟢' : '⚪'} ${task.id} — ${task.name} [${task.cron}] → ${task.task_path}`,
        )
        let text = `共 ${result.tasks.length} 个任务：\n${lines.join('\n')}`
        if (result.corrupted !== undefined && result.corrupted.length > 0) {
          text += `\n损坏文件（已跳过）：${result.corrupted.join(', ')}`
        }
        return [{ type: 'text' as const, text }]
      },
    },
    execute: async (): Promise<unknown> => {
      const { tasks, corrupted } = store.list()
      const views = tasks.map(toTaskView)
      return corrupted.length === 0 ? { tasks: views } : { tasks: views, corrupted: [...corrupted] }
    },
  }
}

/** `task_get`：读取单个任务定义。 */
export function createTaskGetTool(options: SchedulerToolsOptions): ToolDefinition {
  const { store } = options
  return {
    name: 'task_get',
    description: '读取单条定时任务定义；id 不存在时报错。只读操作。',
    parameters: {
      type: 'object',
      properties: { id: ID_PARAMETER },
      required: ['id'],
      additionalProperties: false,
    } as unknown as Record<string, unknown>,
    output: {
      schema: TASK_GET_OUTPUT_SCHEMA as unknown as never,
      render: (_args: unknown, value: unknown) => {
        const view = (value as { task: TaskView }).task
        return [
          {
            type: 'text' as const,
            text:
              `${view.enabled ? '🟢' : '⚪'} ${view.id} — ${view.name}\n` +
              `cron: ${view.cron}\n` +
              `task_path: ${view.task_path}`,
          },
        ]
      },
    },
    execute: async (args: unknown): Promise<unknown> => {
      const record = asRecord(args)
      const id = validateTaskId(record.id)
      return { task: toTaskView(requireTask(store, id)) }
    },
  }
}

/** `task_update`：更新已有任务定义（不存在即报错，绝不静默创建）。 */
export function createTaskUpdateTool(options: SchedulerToolsOptions): ToolDefinition {
  const { store, assetsDir } = options
  const home = resolveHomeBase(options)
  return {
    name: 'task_update',
    description:
      '更新一条已存在的定时任务定义并立即生效。id 必须已存在（不存在会报错，不会新建）；' +
      'name/cron/task_path/enabled 缺省保持原值；新 cron 只接受 5 段；新 task_path 必须在 programs/ 下且可读，' +
      '入参可写 programs/... 或 assets/programs/...，落盘统一归一化为相对领域 home 的路径。',
    parameters: {
      type: 'object',
      properties: {
        id: ID_PARAMETER,
        name: { type: 'string', description: '新名称（缺省保持原值）' },
        cron: CRON_PARAMETER,
        task_path: TASK_PATH_PARAMETER,
        enabled: { type: 'boolean', description: '是否启用（缺省保持原值）' },
      },
      required: ['id'],
      additionalProperties: false,
    } as unknown as Record<string, unknown>,
    output: {
      schema: TASK_WRITE_OUTPUT_SCHEMA as unknown as never,
      render: (_args: unknown, value: unknown) => {
        const view = (value as { task: TaskView }).task
        return [
          { type: 'text' as const, text: `✅ 已更新任务 ${view.id}（enabled=${view.enabled}，cron=${view.cron}）` },
        ]
      },
    },
    execute: async (args: unknown): Promise<unknown> => {
      const record = asRecord(args)
      const id = validateTaskId(record.id)
      const existing = requireTask(store, id)

      const next: TaskPatch = {}
      if (record.name !== undefined) next.name = validateName(record.name)
      if (record.cron !== undefined) next.cron = validateTaskCron(record.cron)
      if (record.enabled !== undefined) next.enabled = validateEnabled(record.enabled)
      if (record.task_path !== undefined) {
        if (typeof record.task_path !== 'string') {
          throw new SchedulerToolError('task_path 必须是字符串')
        }
        const absolute = resolveTaskProgramPath(assetsDir, record.task_path)
        next.task_path = toStoredTaskPath(home, absolute)
      }

      const task = buildTask(existing, next)
      store.save(task, 'update')
      notifyChange(options)
      return { ok: true, task: toTaskView(task) }
    },
  }
}

/** `task_delete`：删除任务定义（**不删除** programs/ 下的程序文件）。 */
export function createTaskDeleteTool(options: SchedulerToolsOptions): ToolDefinition {
  const { store } = options
  return {
    name: 'task_delete',
    description:
      '删除一条定时任务定义并立即生效。只移除任务定义（tasks/<id>.json），' +
      '不删除 programs/ 下的任务程序文件。id 不存在时报错。' +
      '（提交动作为 remove，即 commit message 首行 tasks: remove <id>。）',
    parameters: {
      type: 'object',
      properties: { id: ID_PARAMETER },
      required: ['id'],
      additionalProperties: false,
    } as unknown as Record<string, unknown>,
    output: {
      schema: TASK_DELETE_OUTPUT_SCHEMA as unknown as never,
      render: (_args: unknown, value: unknown) => {
        const result = value as { id: string }
        return [{ type: 'text' as const, text: `🗑️ 已删除任务定义 ${result.id}（程序文件保留）` }]
      },
    },
    execute: async (args: unknown): Promise<unknown> => {
      const record = asRecord(args)
      const id = validateTaskId(record.id)
      const removed = store.remove(id)
      if (!removed) {
        throw new SchedulerToolError(`任务 ${id} 不存在，无法删除`)
      }
      notifyChange(options)
      return { ok: true, id }
    },
  }
}

/** 构造 enable / disable 两个只改 `enabled` 的工具。 */
function createToggleTool(
  options: SchedulerToolsOptions,
  enabled: boolean,
): ToolDefinition {
  const { store } = options
  const action: TaskSaveAction = enabled ? 'enable' : 'disable'
  const name = enabled ? 'task_enable' : 'task_disable'
  return {
    name,
    description: enabled
      ? '启用一条定时任务（仅把 enabled 改为 true，不删定义）并立即生效；id 不存在时报错。'
      : '禁用一条定时任务（仅把 enabled 改为 false，保留定义）并立即生效，禁用后不再被触发；id 不存在时报错。',
    parameters: {
      type: 'object',
      properties: { id: ID_PARAMETER },
      required: ['id'],
      additionalProperties: false,
    } as unknown as Record<string, unknown>,
    output: {
      schema: TASK_WRITE_OUTPUT_SCHEMA as unknown as never,
      render: (_args: unknown, value: unknown) => {
        const view = (value as { task: TaskView }).task
        return [
          {
            type: 'text' as const,
            text: `${enabled ? '🟢 已启用' : '⚪ 已禁用'}任务 ${view.id}（enabled=${view.enabled}）`,
          },
        ]
      },
    },
    execute: async (args: unknown): Promise<unknown> => {
      const record = asRecord(args)
      const id = validateTaskId(record.id)
      const existing = requireTask(store, id)
      const task = buildTask(existing, { enabled })
      store.save(task, action)
      notifyChange(options)
      return { ok: true, task: toTaskView(task) }
    },
  }
}

/** `task_enable`：`enabled = true`。 */
export function createTaskEnableTool(options: SchedulerToolsOptions): ToolDefinition {
  return createToggleTool(options, true)
}

/** `task_disable`：`enabled = false`。 */
export function createTaskDisableTool(options: SchedulerToolsOptions): ToolDefinition {
  return createToggleTool(options, false)
}

/**
 * 构造 7 个任务定义工具（顺序即语义顺序）。
 *
 * @param options store / assetsDir / onChange 注入。
 */
export function createSchedulerTools(options: SchedulerToolsOptions): ToolDefinition[] {
  return [
    createTaskCreateTool(options),
    createTaskListTool(options),
    createTaskGetTool(options),
    createTaskUpdateTool(options),
    createTaskDeleteTool(options),
    createTaskEnableTool(options),
    createTaskDisableTool(options),
  ]
}

/** 7 个工具名（注册前预检 / 测试断言用）。 */
export const SCHEDULER_TOOL_NAMES: readonly string[] = Object.freeze([
  'task_create',
  'task_list',
  'task_get',
  'task_update',
  'task_delete',
  'task_enable',
  'task_disable',
])

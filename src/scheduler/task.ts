/**
 * 完整触发链（技术方案 §12.1）：读任务 → 可读性校验 → 依赖缓存 → 独立进程执行
 * → 取 stdout 最后非空行 JSON → 结局映射 → 唤醒。
 *
 * 结局四态：
 *   - `quiet`   无输出 / 正常空结果（`shouldWake:false`）；
 *   - `woke`    有唤醒且投递成功；
 *   - `skipped` 冷却中，或投递失败降级；
 *   - `failed`  install / spawn / exec / parse。
 *
 * 所有外部副作用（存储 / 依赖安装 / 执行 / 唤醒）都经接口注入，便于单测完全脱离
 * 真实 `pnpm install` 与 Node 子进程。
 */
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import type { ExecStrategy, TaskDef, TaskRunOutcome, TaskScriptResult } from './types.js'
import { parseTaskOutput } from './runner.js'
import type { Waker } from './wake.js'

/** 默认执行超时（60 秒）。 */
export const DEFAULT_RUN_TIMEOUT_MS = 60_000

/** 默认 stdout 上限（1 MiB）。 */
export const DEFAULT_RUN_MAX_STDOUT_BYTES = 1_048_576

/** 默认 stderr 上限（64 KiB）。 */
export const DEFAULT_RUN_MAX_STDERR_BYTES = 65_536

/** v1 core 支持的运行时（执行策略覆盖的运行时名集合）。 */
export const DEFAULT_KNOWN_RUNTIMES: readonly string[] = Object.freeze(['node'])

/** 扩展名 → 运行时名（未列出的扩展名退化为「扩展名即运行时名」）。 */
const RUNTIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.ts': 'node',
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
  '.py': 'python',
  '.rb': 'ruby',
  '.sh': 'sh',
  '.go': 'go',
})

/** 按扩展名推断任务运行时（未知扩展名按同名运行时处理，从而走「未知运行时」失败）。 */
export function inferRuntime(taskPath: string): string {
  const ext = extname(taskPath).toLowerCase()
  if (ext === '') return 'node'
  return RUNTIME_BY_EXTENSION[ext] ?? ext.slice(1)
}

/** 任务文件可读性探测：返回 `undefined` 表示可读，否则返回原因。 */
export function checkTaskFileReadable(taskPath: string): string | undefined {
  let stats
  try {
    stats = statSync(taskPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? '任务程序不存在' : `任务程序无法访问（${code ?? '未知错误'}）`
  }
  if (!stats.isFile()) return '任务程序不是普通文件'
  try {
    accessSync(taskPath, constants.R_OK)
  } catch {
    return '任务程序不可读（R_OK 校验失败）'
  }
  return undefined
}

/** {@link runTask} 的最小依赖面。 */
export interface RunTaskDeps {
  /** 任务定义来源。 */
  readonly store: { get(id: string): TaskDef | undefined }
  /** 依赖缓存 / 安装。 */
  readonly deps: { ensure(taskId: string, taskDir: string): Promise<{ installed: boolean; reason: string }> }
  /** 执行策略。 */
  readonly exec: ExecStrategy
  /** 唤醒器。 */
  readonly waker: Waker
  /** 领域 home（解析相对 `task_path`）。 */
  readonly home: string
  /** 领域 `scheduler.runtimes` 声明。 */
  readonly declaredRuntimes?: readonly string[]
  /** core 认识的运行时；缺省 {@link DEFAULT_KNOWN_RUNTIMES}。 */
  readonly knownRuntimes?: readonly string[]
  /** 执行超时。 */
  readonly timeoutMs?: number
  /** stdout 上限。 */
  readonly maxStdoutBytes?: number
  /** stderr 上限。 */
  readonly maxStderrBytes?: number
  /** 可读性探测（测试注入）。 */
  readonly checkReadable?: (taskPath: string) => string | undefined
  /** 日志出口。 */
  readonly logger?: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void }
}

/** `realpathSync` 的容错封装：路径不存在 / 不可解析返回 `undefined`。 */
function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * 相对 `home` 解析任务路径，并拒绝逃逸出 home 的路径（含**软链接逃逸**）。
 *
 * 两道校验：
 *   1. 字符串层：`relative(home, resolve(home, taskPath))` 不得以 `..` 开头；
 *   2. 真实路径层：`realpathSync` 解析软链接后再比一次——否则
 *      `tasks/job/link.js -> /tmp/outside/evil.js` 会绕过第 1 步被直接执行。
 *
 * 目标文件不存在时（`realpathSync` 抛 ENOENT）走原逻辑返回路径，交由后续
 * 可读性校验给出 `failed / exec` 结局，保持既有错误语义。
 * 绝对 `task_path` 属显式授权，不做 home 归属校验（沿用原语义）。
 */
export function resolveTaskPath(home: string, taskPath: string): { path?: string; error?: string } {
  if (typeof taskPath !== 'string' || taskPath.trim() === '') {
    return { error: '任务 task_path 为空' }
  }
  const trimmed = taskPath.trim()
  if (isAbsolute(trimmed)) return { path: resolve(trimmed) }
  const absolute = resolve(home, trimmed)
  const rel = relative(home, absolute)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { error: `任务 task_path 逃逸出领域 home：${taskPath}` }
  }

  // 软链接校验：真实路径仍须落在 home（home 自身的软链接以真实路径为基准）。
  const real = tryRealpath(absolute)
  if (real === undefined) return { path: absolute }
  const homeReal = tryRealpath(home) ?? home
  const realRel = relative(homeReal, real)
  if (realRel.startsWith('..') || isAbsolute(realRel)) {
    return {
      error: `任务 task_path 软链接指向领域 home 之外：${taskPath} -> ${real}`,
    }
  }
  return { path: absolute }
}

/**
 * 执行一次任务并返回结局（**不抛异常**，任何异常都收敛为 `failed`）。
 *
 * @param taskOrId 任务定义或任务 id（id 会从 store 读取）。
 */
export async function runTask(taskOrId: string | TaskDef, deps: RunTaskDeps): Promise<TaskRunOutcome> {
  const taskId = typeof taskOrId === 'string' ? taskOrId : taskOrId.id

  let task: TaskDef | undefined
  try {
    task = typeof taskOrId === 'string' ? deps.store.get(taskOrId) : taskOrId
  } catch (error) {
    return {
      kind: 'failed',
      reason: `读取任务 ${taskId} 失败`,
      detail: error instanceof Error ? error.message : String(error),
      failureKind: 'exec',
    }
  }
  if (task === undefined) {
    return { kind: 'failed', reason: `任务 ${taskId} 不存在（任务定义缺失）`, failureKind: 'exec' }
  }

  try {
    // 1) 程序可读性校验
    const resolved = resolveTaskPath(deps.home, task.task_path)
    if (resolved.path === undefined) {
      return { kind: 'failed', reason: `任务 ${taskId} 路径非法`, detail: resolved.error, failureKind: 'exec' }
    }
    const taskPath = resolved.path
    const unreadable = (deps.checkReadable ?? checkTaskFileReadable)(taskPath)
    if (unreadable !== undefined) {
      return {
        kind: 'failed',
        reason: `任务 ${taskId} 程序不可用：${unreadable}`,
        detail: taskPath,
        failureKind: 'exec',
      }
    }

    // 2) 运行时支持性（未知运行时 → install 失败并点名）
    const runtime = inferRuntime(taskPath)
    const known = new Set(deps.knownRuntimes ?? DEFAULT_KNOWN_RUNTIMES)
    if (!known.has(runtime)) {
      return {
        kind: 'failed',
        reason: `任务 ${taskId} 需要运行时 "${runtime}"，但 core v1 不支持该运行时（已支持：${[...known].join(', ')}）`,
        detail: `不支持的运行时 "${runtime}"`,
        failureKind: 'install',
      }
    }
    const declared = deps.declaredRuntimes
    if (declared !== undefined) {
      const unknownDeclared = declared.filter((name) => !known.has(name))
      if (unknownDeclared.length > 0) {
        return {
          kind: 'failed',
          reason: `领域 scheduler.runtimes 声明了未支持的运行时 "${unknownDeclared[0]}"（core v1 仅支持：${[...known].join(', ')}）`,
          detail: `未支持的运行时：${unknownDeclared.join(', ')}`,
          failureKind: 'install',
        }
      }
    }

    // 3) 依赖缓存 + 安装
    const taskDir = dirname(taskPath)
    try {
      const result = await deps.deps.ensure(task.id, taskDir)
      deps.logger?.info(`任务 ${taskId} 依赖检查：${result.reason}`)
    } catch (error) {
      return {
        kind: 'failed',
        reason: `任务 ${taskId} 依赖安装失败`,
        detail: error instanceof Error ? error.message : String(error),
        failureKind: 'install',
      }
    }

    // 4) 独立进程执行
    const execResult = await deps.exec.exec({
      taskPath,
      cwd: taskDir,
      timeoutMs: deps.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      maxStdoutBytes: deps.maxStdoutBytes ?? DEFAULT_RUN_MAX_STDOUT_BYTES,
      maxStderrBytes: deps.maxStderrBytes ?? DEFAULT_RUN_MAX_STDERR_BYTES,
    })

    if (execResult.spawnError !== undefined) {
      return {
        kind: 'failed',
        reason: `任务 ${taskId} 进程启动失败`,
        detail: execResult.spawnError,
        failureKind: 'spawn',
      }
    }
    if (execResult.timedOut) {
      return {
        kind: 'failed',
        reason: `任务 ${taskId} 执行超时（${deps.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS}ms），已强杀`,
        failureKind: 'exec',
      }
    }
    if (execResult.truncated) {
      return {
        kind: 'failed',
        reason: `任务 ${taskId} stdout 超限（${deps.maxStdoutBytes ?? DEFAULT_RUN_MAX_STDOUT_BYTES} 字节），已截断并强杀`,
        detail: execResult.stderr.trim() === '' ? undefined : execResult.stderr.trim(),
        failureKind: 'exec',
      }
    }
    if (execResult.exitCode !== 0) {
      return {
        kind: 'failed',
        reason: `任务 ${taskId} 进程异常退出（exitCode=${String(execResult.exitCode)}）`,
        detail: execResult.stderr.trim() === '' ? undefined : execResult.stderr.trim(),
        failureKind: 'exec',
      }
    }

    // 5) 末行 JSON 解析 + 结局映射
    const parsed: TaskScriptResult | null = parseTaskOutput(execResult.stdout)
    if (parsed === null) {
      return {
        kind: 'failed',
        reason: `任务 ${taskId} 输出不可解析（stdout 最后非空行无有效结果 JSON）`,
        detail: '期望 {"shouldWake":boolean,"data"?:string}',
        failureKind: 'parse',
      }
    }
    if (!parsed.shouldWake) {
      return { kind: 'quiet', reason: `任务 ${taskId} 执行完成，未唤醒` }
    }

    // 6) 唤醒（含截断 / 冷却 / 降级）
    const wake = await deps.waker.wake(task.id, parsed.data)
    if (wake.kind === 'skipped') {
      return {
        kind: 'skipped',
        reason: wake.reason,
        ...(wake.detail === undefined ? {} : { detail: wake.detail }),
      }
    }
    return {
      kind: 'woke',
      reason: `任务 ${taskId} 已唤醒`,
      data: wake.text,
      targets: wake.targets,
    }
  } catch (error) {
    // 兜底：任何未预期异常都不得穿透调度链。
    return {
      kind: 'failed',
      reason: `任务 ${taskId} 执行异常`,
      detail: error instanceof Error ? error.message : String(error),
      failureKind: 'exec',
    }
  }
}

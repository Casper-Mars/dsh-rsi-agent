/**
 * 任务程序执行器（独立 Node 进程 + 有界 stdout + 末行 JSON 解析）。
 *
 * 硬约束（技术方案 §12.3）：
 *   1. `child_process.spawn` 起**独立进程**，不经宿主主进程事件循环执行任务代码；
 *   2. 默认 60s 超时，到点 `SIGTERM`，宽限后 `SIGKILL`；
 *   3. stdout 上限 1 MiB：按 **UTF-8 字节**累计（不是 UTF-16 码元长度），累积到上限
 *      即截断并**标记**（`truncated: true`），绝不无界增长导致 OOM；截断点经
 *      `StringDecoder` 处理，不切开多字节字符 / 代理对；
 *   4. stderr 有界收集（默认 64 KiB，保留头部 + 截断标记），仅用于诊断；
 *   5. 结果 JSON 取 stdout **最后一个非空行**。
 *
 * 可注入：本文件导出 {@link createNodeExecStrategy}（v1 node 实现）；编排层只依赖
 * {@link ExecStrategy} 接口，测试用 fake 注入即可完全脱离真实子进程。
 */
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { ExecInput, ExecResult, ExecStrategy, TaskScriptResult } from './types.js'

/** 默认任务执行超时（60 秒）。 */
export const DEFAULT_TASK_TIMEOUT_MS = 60_000

/** 默认 stdout 上限（1 MiB）。 */
export const DEFAULT_MAX_STDOUT_BYTES = 1_048_576

/** 默认 stderr 上限（64 KiB）。 */
export const DEFAULT_MAX_STDERR_BYTES = 65_536

/** 截断标记（写入被截断的输出末尾，便于诊断）。 */
export const STDOUT_TRUNCATION_MARKER = '\n[scheduler/runner] stdout truncated\n'

/** 强杀宽限（毫秒）：SIGTERM 之后多久补 SIGKILL。 */
export const KILL_GRACE_MS = 500

/** v1 执行策略选项。 */
export interface NodeExecStrategyOptions {
  /** 可执行文件，缺省 `process.execPath`（当前 Node）。 */
  readonly command?: string
  /** 附加参数（在任务路径之前）。 */
  readonly args?: readonly string[]
  /** 强杀宽限（毫秒）。 */
  readonly killGraceMs?: number
  /** spawn 实现（测试注入）。 */
  readonly spawn?: typeof spawn
}

/**
 * v1 执行策略：`node <taskPath>`。
 *
 * **不抛异常**：spawn 失败、超时、超限都通过 {@link ExecResult} 字段表达。
 */
export function createNodeExecStrategy(options: NodeExecStrategyOptions = {}): ExecStrategy {
  const command = options.command ?? process.execPath
  const extraArgs = options.args ?? []
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS
  const spawnFn = options.spawn ?? spawn

  return {
    name: 'node',
    exec(input: ExecInput): Promise<ExecResult> {
      return new Promise<ExecResult>((resolve) => {
        let settled = false
        let stdout = ''
        /** stdout 已接收的 **UTF-8 字节数**（多字节字符按其编码字节计）。 */
        let stdoutBytes = 0
        // 增量解码：跨 chunk 的不完整多字节序列留在 decoder 内部，不会产出半个字符。
        const stdoutDecoder = new StringDecoder('utf8')
        let stderr = ''
        let truncated = false
        let timedOut = false

        const finish = (exitCode: number | null, spawnError?: string): void => {
          if (settled) return
          settled = true
          resolve({
            exitCode,
            stdout,
            stderr,
            truncated,
            timedOut,
            ...(spawnError === undefined ? {} : { spawnError }),
          })
        }

        let child: ReturnType<typeof spawn>
        try {
          child = spawnFn(command, [...extraArgs, input.taskPath], {
            cwd: input.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (error) {
          finish(null, error instanceof Error ? error.message : String(error))
          return
        }

        let killTimer: ReturnType<typeof setTimeout> | undefined
        const timer = setTimeout(() => {
          timedOut = true
          try {
            child.kill('SIGTERM')
          } catch {
            /* 忽略 */
          }
          killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {
              /* 忽略 */
            }
            // 进程可能不响应 kill（异常实现）：兜底结算，避免永久挂起。
            finish(null)
          }, killGraceMs)
          if (typeof (killTimer as { unref?: () => void }).unref === 'function') {
            (killTimer as { unref: () => void }).unref()
          }
        }, input.timeoutMs)
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
          (timer as { unref: () => void }).unref()
        }

        const clearTimers = (): void => {
          clearTimeout(timer)
          if (killTimer !== undefined) clearTimeout(killTimer)
        }

        child.stdout?.on('data', (chunk: Buffer | string) => {
          if (truncated || settled) return
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
          const room = input.maxStdoutBytes - stdoutBytes
          if (buffer.length > room) {
            // 只收剩余字节；被切断的多字节序列由 decoder 缓存丢弃，不产生半个字符。
            if (room > 0) {
              stdoutBytes += room
              stdout += stdoutDecoder.write(buffer.subarray(0, room))
            }
            truncated = true
            // 超限即止损：强杀进程，避免继续产出。
            try {
              child.kill('SIGKILL')
            } catch {
              /* 忽略 */
            }
            return
          }
          stdoutBytes += buffer.length
          stdout += stdoutDecoder.write(buffer)
        })

        child.stderr?.on('data', (chunk: Buffer | string) => {
          if (stderr.length >= input.maxStderrBytes) return
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          const room = input.maxStderrBytes - stderr.length
          stderr += text.length > room ? text.slice(0, room) : text
        })

        child.on('error', (error) => {
          clearTimers()
          finish(null, error.message)
        })

        // `close` 晚于 `exit` 且保证 stdio 已排空，是读取 exitCode 的可靠信号。
        child.on('close', (code) => {
          clearTimers()
          finish(code)
        })
      })
    },
  }
}

/** stdout 超限时的统一诊断文本（`truncated` 已置位时使用）。 */
export function truncationDetail(maxStdoutBytes: number): string {
  return `stdout 超过上限 ${maxStdoutBytes} 字节，已截断并强杀`
}

/**
 * 解析 stdout 的**最后一个非空行**为 {@link TaskScriptResult}。
 *
 * 返回 `null` 表示「无有效结果」：无任何非空行 / JSON 非法 / 非对象 /
 * `shouldWake` 非 boolean / `shouldWake:true` 但 `data` 非 string。
 */
export function parseTaskOutput(stdout: string): TaskScriptResult | null {
  const lines = stdout.split('\n')
  let lastLine: string | null = null
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = (lines[index] as string).trim()
    if (trimmed.length > 0) {
      lastLine = trimmed
      break
    }
  }
  if (lastLine === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(lastLine)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.shouldWake !== 'boolean') return null
  if (record.shouldWake === true) {
    if (typeof record.data !== 'string') return null
    return { shouldWake: true, data: record.data }
  }
  return { shouldWake: false }
}

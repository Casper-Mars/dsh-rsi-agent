/**
 * assets 层共享 git 执行器 —— 技术方案 §9.1 / §9.3。
 *
 * 资产层只有一个 git 仓库（`<home>/assets`）。本文件是**唯一**调用 git 的
 * 叶子模块，向 `repo.ts` / `commit.ts` 提供：
 *   1. 参数化执行器 {@link runGit}（`execFileSync('git', argv)`，**不经 shell**）；
 *   2. 固定身份（`dsh-rsi-agent <dsh-rsi-agent@localhost>`）、固定
 *      `core.autocrlf=false`，且**不读取宿主机 global/system git config**；
 *   3. 统一超时与错误包装 `{ ok, stdout, stderr, code }` —— 执行器**永不抛错**，
 *      业务层据此降级，不需要 try/catch；
 *   4. 可用性探测 {@link isGitAvailable}（PATH 摘除后返回 false，不抛）。
 *
 * 安全约束：
 *   - 只用 `execFileSync`（`execFile` 家族），argv 逐项传参，**绝不拼 shell
 *     字符串**，也从不启用 shell（不设置 `shell` 选项）；
 *   - 环境变量里剔除 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` 等宿主残留，
 *     避免「在 A 仓库里操作 B 仓库」的串味；
 *   - `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` 指向空设备：宿主机 `~/.gitconfig`
 *     的 `user.*` / `core.autocrlf` 一律不参与，保证提交身份与字节语义可复现。
 */
import { execFileSync } from 'node:child_process'

/** 固定作者 / 提交者姓名（不依赖宿主机 git config）。 */
export const GIT_IDENTITY_NAME = 'dsh-rsi-agent'

/** 固定作者 / 提交者邮箱。 */
export const GIT_IDENTITY_EMAIL = 'dsh-rsi-agent@localhost'

/** 单次 git 命令的统一超时（毫秒）。 */
export const DEFAULT_GIT_TIMEOUT_MS = 10_000

/** 可用性探测的超时（毫秒）；探测必须快速失败，不拖慢插件装载。 */
export const GIT_PROBE_TIMEOUT_MS = 2_000

const MAX_BUFFER_BYTES = 16 * 1024 * 1024

/** 空设备：用于屏蔽宿主机 global / system git config。 */
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'

/** 需要从宿主环境剔除的 git 变量（避免操作到外层仓库）。 */
const SCRUBBED_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
] as const

/** git 命令的统一结果。**所有失败都以值返回**，不抛给业务层。 */
export interface GitResult {
  /** 是否成功（退出码 0）。 */
  ok: boolean
  /** 标准输出（utf8）。 */
  stdout: string
  /** 标准错误（utf8）。 */
  stderr: string
  /** 退出码；进程被信号终止或可执行文件缺失时为 -1。 */
  code: number
}

/** 可注入的 git 执行器（单测替换用）。签名与 {@link runGit} 一致。 */
export type GitRunner = (args: readonly string[], cwd: string) => GitResult

/** 原始字节版 git 结果。**所有失败都以值返回**，不抛给业务层。 */
export interface GitBufferResult {
  /** 是否成功（退出码 0）。 */
  ok: boolean
  /** 标准输出（原始字节，**未经 utf8 解码**）。 */
  stdout: Buffer
  /** 标准错误（utf8）。 */
  stderr: string
  /** 退出码；进程被信号终止 / 可执行文件缺失 / 超出 maxBuffer 时为 -1。 */
  code: number
}

/** 可注入的字节版 git 执行器（单测替换用）。 */
export type GitBufferRunner = (args: readonly string[], cwd: string) => GitBufferResult

/** {@link runGit} 选项。 */
export interface RunGitOptions {
  /** 超时（毫秒），缺省 {@link DEFAULT_GIT_TIMEOUT_MS}。 */
  timeoutMs?: number
  /** 环境变量来源，缺省 `process.env`（测试注入用）。 */
  env?: NodeJS.ProcessEnv
  /** 输出缓冲上限（字节），缺省 16 MiB。 */
  maxBuffer?: number
}

/** 固定身份 + 字节保真的 `-c` 参数（每次调用显式传入，不依赖仓库配置）。 */
export function gitIdentityArgs(): string[] {
  return [
    '-c',
    `user.name=${GIT_IDENTITY_NAME}`,
    '-c',
    `user.email=${GIT_IDENTITY_EMAIL}`,
    // 字节保真（§9.3）：禁止 CRLF→LF 入库规范化，也不在 checkout 时改行尾。
    '-c',
    'core.autocrlf=false',
  ]
}

/** 构造隔离后的环境变量：屏蔽宿主 git config，并双保险注入身份。 */
function isolatedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  for (const key of SCRUBBED_ENV_KEYS) delete next[key]
  next.GIT_CONFIG_NOSYSTEM = '1'
  next.GIT_CONFIG_GLOBAL = NULL_DEVICE
  next.GIT_CONFIG_SYSTEM = NULL_DEVICE
  next.GIT_TERMINAL_PROMPT = '0'
  next.GIT_AUTHOR_NAME = GIT_IDENTITY_NAME
  next.GIT_AUTHOR_EMAIL = GIT_IDENTITY_EMAIL
  next.GIT_COMMITTER_NAME = GIT_IDENTITY_NAME
  next.GIT_COMMITTER_EMAIL = GIT_IDENTITY_EMAIL
  return next
}

/** 把 `Buffer | string | undefined` 归一化为 utf8 字符串。 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

/** 把 `execFileSync` 抛出的异常归一化为 {@link GitResult}。 */
function failure(error: unknown): GitResult {
  const detail = error as {
    status?: number | null
    code?: string | number
    stdout?: unknown
    stderr?: unknown
    message?: string
  }
  const code = typeof detail?.status === 'number' ? detail.status : -1
  const stderr = asText(detail?.stderr)
  return {
    ok: false,
    stdout: asText(detail?.stdout),
    stderr:
      stderr !== ''
        ? stderr
        : typeof detail?.message === 'string'
          ? detail.message
          : String(error),
    code,
  }
}

/**
 * 执行一条 git 命令：`git <identity args> <args...>`，工作目录 `cwd`。
 *
 * - 只走 `execFileSync`，argv 逐项传参，不经 shell；
 * - 超时 / 非零退出 / 可执行文件缺失一律包装为 `{ ok: false, ... }`，**不抛**。
 *
 * @param args git 子命令及其参数（不含可执行文件名）。
 * @param cwd  工作目录（仓库根）。
 * @param options 超时与环境变量注入。
 */
export function runGit(
  args: readonly string[],
  cwd: string,
  options: RunGitOptions = {},
): GitResult {
  try {
    const stdout = execFileSync('git', [...gitIdentityArgs(), ...args], {
      cwd,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: options.maxBuffer ?? MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: isolatedEnv(options.env ?? process.env),
    })
    return { ok: true, stdout: typeof stdout === 'string' ? stdout : '', stderr: '', code: 0 }
  } catch (error) {
    return failure(error)
  }
}

/**
 * 执行一条 git 命令并保留**原始字节**输出。
 *
 * 为什么需要它：`execFileSync(..., { encoding: 'utf8' })` 在解码阶段就会把
 * 非法 / 被截断的多字节序列替换成 U+FFFD，调用方再也无法按 UTF-8 字符边界
 * 回退（§9.4 的 256 KB 截断要求）。本函数只负责取字节，解码由业务层完成。
 *
 * - 只走 `execFileSync`，argv 逐项传参，不经 shell；
 * - 超时 / 非零退出 / 超出 `maxBuffer` 一律包装为 `{ ok: false, ... }`，**不抛**。
 */
export function runGitBuffer(
  args: readonly string[],
  cwd: string,
  options: RunGitOptions = {},
): GitBufferResult {
  try {
    const stdout = execFileSync('git', [...gitIdentityArgs(), ...args], {
      cwd,
      encoding: 'buffer',
      timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: options.maxBuffer ?? MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: isolatedEnv(options.env ?? process.env),
    })
    return {
      ok: true,
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout), 'utf8'),
      stderr: '',
      code: 0,
    }
  } catch (error) {
    const detail = error as {
      status?: number | null
      stdout?: unknown
      stderr?: unknown
      message?: string
    }
    const code = typeof detail?.status === 'number' ? detail.status : -1
    const stderr = asText(detail?.stderr)
    return {
      ok: false,
      stdout: Buffer.isBuffer(detail?.stdout) ? detail.stdout : Buffer.alloc(0),
      stderr:
        stderr !== ''
          ? stderr
          : typeof detail?.message === 'string'
            ? detail.message
            : String(error),
      code,
    }
  }
}

/** {@link isGitAvailable} 选项。 */
export interface IsGitAvailableOptions {
  /** 环境变量来源，缺省 `process.env`（PATH 摘除测试用）。 */
  env?: NodeJS.ProcessEnv
  /** 可执行文件名，缺省 `git`。 */
  executable?: string
  /** 探测超时，缺省 {@link GIT_PROBE_TIMEOUT_MS}。 */
  timeoutMs?: number
}

/**
 * 探测 `git` 是否可用（`git --version` 退出码 0）。
 *
 * 依赖 PATH：PATH 被摘除 / 无 git 时返回 `false`，**不抛错**。
 * 不缓存结果 —— 运行期 PATH 变化可被立即观察到。
 */
export function isGitAvailable(options: IsGitAvailableOptions = {}): boolean {
  try {
    execFileSync(options.executable ?? 'git', ['--version'], {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? GIT_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: options.env ?? process.env,
    })
    return true
  } catch {
    return false
  }
}

/**
 * 初始化仓库（默认分支 `main`）。
 *
 * 老版本 git 不支持 `init -b` 时回落到普通 `git init`；两次都失败则返回
 * 第二次的结果（`ok: false`）。
 */
export function initGitRepo(dir: string, options: RunGitOptions = {}): GitResult {
  const first = runGit(['init', '-b', 'main'], dir, options)
  if (first.ok) return first
  return runGit(['init'], dir, options)
}

/**
 * 幂等写入仓库 **local** 必需配置：`user.name` / `user.email` /
 * `core.autocrlf=false`。
 *
 * 即使每次命令都通过 `-c` 显式传参，也把身份落进 local config：让外部
 * `git log` / `git commit`（不经过本模块）在同一仓库里行为一致。
 *
 * 返回第一个失败的步骤结果；全部成功返回最后一次的结果。
 */
export function ensureRepoConfig(dir: string, options: RunGitOptions = {}): GitResult {
  const steps: string[][] = [
    ['config', '--local', 'user.name', GIT_IDENTITY_NAME],
    ['config', '--local', 'user.email', GIT_IDENTITY_EMAIL],
    ['config', '--local', 'core.autocrlf', 'false'],
  ]
  let last: GitResult = { ok: true, stdout: '', stderr: '', code: 0 }
  for (const step of steps) {
    last = runGit(step, dir, options)
    if (!last.ok) return last
  }
  return last
}

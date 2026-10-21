/**
 * 依赖安装与依赖缓存（技术方案 §12.2）。
 *
 * 语义：
 *   1. 任务依赖按任务目录隔离（每个任务自己的 `package.json` / `pnpm-lock.yaml`）；
 *   2. 依赖指纹 = `sha256(package.json ‖ pnpm-lock.yaml)`，存
 *      `<dataDir>/deps-cache.json`；指纹一致 ⇒ 跳过 `pnpm install`；
 *   3. **安装失败绝不写指纹** —— 否则一次失败会被永久缓存成「已安装」；
 *   4. 任一文件变化（含锁文件出现/消失）⇒ 指纹变化 ⇒ 重新安装；
 *   5. `pnpm install` 默认 120s 超时；超时/非零退出/spawn 失败都归 `install` 失败。
 *
 * 可注入：`install`（{@link InstallStrategy}）、`fs`（测试免落盘）、`clock`、`logger`。
 * 单测**绝不真的执行** `pnpm install`。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock, InstallStrategy } from './types.js'

/** 依赖缓存文件名（位于 `<dataDir>`）。 */
export const DEPS_CACHE_FILE = 'deps-cache.json'

/** 默认安装超时（120 秒）。 */
export const DEFAULT_INSTALL_TIMEOUT_MS = 120_000

/** 依赖安装失败（上层映射为 `failed` + `failureKind='install'`）。 */
export class DepsInstallError extends Error {
  readonly failureKind = 'install' as const
  constructor(message: string) {
    super(`[scheduler/deps] ${message}`)
    this.name = 'DepsInstallError'
  }
}

/** 一条缓存记录。 */
export interface DepsCacheEntry {
  /** `package.json` + `pnpm-lock.yaml` 的内容哈希。 */
  readonly hash: string
  /** 任务目录（目录换了即使哈希相同也要重装）。 */
  readonly taskDir: string
  /** 记录时间（epoch ms）。 */
  readonly updatedAt: number
}

/** 缓存文件结构。 */
export interface DepsCacheFile {
  readonly version: 1
  readonly entries: Record<string, DepsCacheEntry>
}

/** 最小 fs 抽象（测试注入，避免真实落盘）。 */
export interface DepsCacheFs {
  exists(path: string): boolean
  readText(path: string): string
  writeText(path: string, content: string): void
  mkdirp(path: string): void
}

function nodeFs(): DepsCacheFs {
  return {
    exists: (path) => existsSync(path),
    readText: (path) => readFileSync(path, 'utf8'),
    writeText: (path, content) => writeFileSync(path, content, 'utf8'),
    mkdirp: (path) => {
      mkdirSync(path, { recursive: true })
    },
  }
}

/** 依赖指纹：`package.json` 不存在时返回 `undefined`（无依赖，无需安装）。 */
export function computeDepsHash(taskDir: string, fs: DepsCacheFs = nodeFs()): string | undefined {
  const manifest = join(taskDir, 'package.json')
  if (!fs.exists(manifest)) return undefined
  const lockPath = join(taskDir, 'pnpm-lock.yaml')
  const lock = fs.exists(lockPath) ? fs.readText(lockPath) : '<missing>'
  const hash = createHash('sha256')
  hash.update('package.json\0')
  hash.update(fs.readText(manifest))
  hash.update('\0pnpm-lock.yaml\0')
  hash.update(lock)
  return hash.digest('hex')
}

/** 依赖缓存构造选项。 */
export interface DependencyCacheOptions {
  /** 缓存文件目录（`<dataDir>`）。 */
  readonly dataDir: string
  /** 安装策略（v1 pnpm）。 */
  readonly install: InstallStrategy
  /** 安装超时（毫秒），默认 {@link DEFAULT_INSTALL_TIMEOUT_MS}。 */
  readonly timeoutMs?: number
  /** fs 抽象。 */
  readonly fs?: DepsCacheFs
  /** 时钟。 */
  readonly clock?: Clock
  /** 日志出口。 */
  readonly logger?: { warn(message: string, meta?: unknown): void } | ((message: string) => void)
}

/** {@link DependencyCache.ensure} 的结果。 */
export interface EnsureDepsResult {
  /** 本次是否真的执行了安装。 */
  readonly installed: boolean
  /** 依赖指纹（无 package.json 时为 undefined）。 */
  readonly hash?: string
  /** 说明（`cache hit` / `installed` / `no package.json`）。 */
  readonly reason: string
}

/** 依赖缓存 / 安装编排。 */
export class DependencyCache {
  readonly cacheFile: string
  private readonly dataDir: string
  private readonly installStrategy: InstallStrategy
  private readonly timeoutMs: number
  private readonly fs: DepsCacheFs
  private readonly clock: Clock
  private readonly warn: (message: string) => void

  constructor(options: DependencyCacheOptions) {
    if (typeof options.dataDir !== 'string' || options.dataDir === '') {
      throw new TypeError('[scheduler/deps] dataDir 必须是非空字符串')
    }
    this.dataDir = options.dataDir
    this.cacheFile = join(options.dataDir, DEPS_CACHE_FILE)
    this.installStrategy = options.install
    this.timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
    this.fs = options.fs ?? nodeFs()
    this.clock = options.clock ?? { now: () => new Date() }
    const logger = options.logger
    this.warn =
      logger === undefined
        ? () => {}
        : typeof logger === 'function'
          ? logger
          : (message: string) => logger.warn(message)
  }

  /** 读取缓存文件；损坏 / 缺失一律视为空缓存（不抛）。 */
  read(): DepsCacheFile {
    try {
      if (!this.fs.exists(this.cacheFile)) return { version: 1, entries: {} }
      const parsed: unknown = JSON.parse(this.fs.readText(this.cacheFile))
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { version?: unknown }).version !== 1 ||
        typeof (parsed as { entries?: unknown }).entries !== 'object' ||
        (parsed as { entries?: unknown }).entries === null
      ) {
        return { version: 1, entries: {} }
      }
      return parsed as DepsCacheFile
    } catch {
      return { version: 1, entries: {} }
    }
  }

  /** 写缓存（失败只 warn：缓存损坏不应让安装成功变成任务失败）。 */
  private write(cache: DepsCacheFile): void {
    try {
      this.fs.mkdirp(this.dataDir)
      this.fs.writeText(this.cacheFile, JSON.stringify(cache, null, 2))
    } catch (error) {
      this.warn(`依赖缓存写入失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 确保任务依赖就绪。
   *
   * @throws {DepsInstallError} 安装失败 / 超时。
   */
  async ensure(taskId: string, taskDir: string): Promise<EnsureDepsResult> {
    const hash = computeDepsHash(taskDir, this.fs)
    if (hash === undefined) {
      return { installed: false, reason: 'no package.json' }
    }

    const cached = this.read().entries[taskId]
    if (cached !== undefined && cached.hash === hash && cached.taskDir === taskDir) {
      return { installed: false, hash, reason: 'cache hit' }
    }

    try {
      await this.installStrategy.install({ taskId, taskDir, timeoutMs: this.timeoutMs })
    } catch (error) {
      // 关键：失败不写指纹，下一次仍会重试安装。
      throw new DepsInstallError(
        `任务 ${taskId} 依赖安装失败（${this.installStrategy.name}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    const cache = this.read()
    this.write({
      version: 1,
      entries: {
        ...cache.entries,
        [taskId]: { hash, taskDir, updatedAt: this.clock.now().getTime() },
      },
    })
    return { installed: true, hash, reason: 'installed' }
  }
}

/** 创建依赖缓存。 */
export function createDependencyCache(options: DependencyCacheOptions): DependencyCache {
  return new DependencyCache(options)
}

// ---------------------------------------------------------------------------
// v1 安装策略：pnpm install
// ---------------------------------------------------------------------------

/** 安装策略构造选项。 */
export interface PnpmInstallStrategyOptions {
  /** 可执行文件，缺省 `pnpm`。 */
  readonly command?: string
  /** 附加参数，缺省 `['install']`。 */
  readonly args?: readonly string[]
  /** 强杀宽限（毫秒），缺省 1000。 */
  readonly killGraceMs?: number
  /** spawn 实现（测试注入）。 */
  readonly spawn?: typeof import('node:child_process').spawn
}

/** 安装子进程（真实 `child_process.spawn` 的返回类型）。 */
type InstallChild = ReturnType<typeof nodeSpawn>

/**
 * v1 安装策略：在任务目录内执行 `pnpm install`。
 *
 * 超时先 `SIGTERM`，宽限后 `SIGKILL` 兜底；`settled` 守卫保证单一结算。
 */
export function createPnpmInstallStrategy(
  options: PnpmInstallStrategyOptions = {},
): InstallStrategy {
  const command = options.command ?? 'pnpm'
  const args = options.args ?? ['install']
  const killGraceMs = options.killGraceMs ?? 1000
  const spawnFn = options.spawn ?? nodeSpawn

  return {
    name: 'pnpm',
    install({ taskId, taskDir, timeoutMs }): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          if (error === undefined) resolve()
          else reject(error)
        }

        let child: InstallChild
        try {
          child = spawnFn(command, [...args], {
            cwd: taskDir,
            stdio: 'ignore',
          })
        } catch (error) {
          finish(new Error(`无法启动 ${command} install：${error instanceof Error ? error.message : String(error)}`))
          return
        }

        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          try {
            child.kill('SIGTERM')
          } catch {
            /* 忽略 */
          }
          setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {
              /* 忽略 */
            }
            finish(new Error(`${command} install 超过 ${timeoutMs}ms 未完成（已强杀）`))
          }, killGraceMs)
        }, timeoutMs)
        // 安装超时不得把宿主进程钉住（unref 让定时器不阻止退出）。
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
          (timer as { unref: () => void }).unref()
        }

        child.on('error', (error) => {
          clearTimeout(timer)
          finish(new Error(`无法启动 ${command} install：${error.message}`))
        })
        child.on('exit', (code) => {
          clearTimeout(timer)
          if (timedOut) {
            finish(new Error(`${command} install 超过 ${timeoutMs}ms 未完成（已强杀）`))
            return
          }
          if (code === 0) finish()
          else finish(new Error(`${command} install 退出码 ${String(code)}（任务 ${taskId}）`))
        })
      })
    },
  }
}

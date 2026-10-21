/**
 * 依赖缓存：指纹命中跳过安装 / 变化重装 / 安装失败不写指纹 / pnpm 超时强杀。
 *
 * 所有安装策略均为 fake，**绝不真的执行 `pnpm install`**。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEPS_CACHE_FILE,
  DependencyCache,
  DepsInstallError,
  computeDepsHash,
  createPnpmInstallStrategy,
  type InstallStrategy,
} from '../src/scheduler/deps-cache'

const roots: string[] = []

function tempTask(files: Record<string, string> = {}): { root: string; taskDir: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rsi-deps-'))
  roots.push(root)
  const taskDir = join(root, 'programs', 'demo')
  const dataDir = join(root, 'data')
  mkdirSync(taskDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(taskDir, name), content, 'utf8')
  return { root, taskDir, dataDir }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

function fakeInstall(): InstallStrategy & { calls: number } {
  const strategy = {
    name: 'fake-pnpm',
    calls: 0,
    async install() {
      strategy.calls += 1
    },
  }
  return strategy
}

const PKG = JSON.stringify({ name: 'demo', dependencies: { left: '1.0.0' } })

describe('依赖指纹', () => {
  it('缺少 package.json → undefined（无依赖）', () => {
    const { taskDir } = tempTask()
    expect(computeDepsHash(taskDir)).toBeUndefined()
  })

  it('同样内容 → 稳定哈希', () => {
    const { taskDir } = tempTask({ 'package.json': PKG, 'pnpm-lock.yaml': 'lock: 1' })
    expect(computeDepsHash(taskDir)).toBe(computeDepsHash(taskDir))
    expect(computeDepsHash(taskDir)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('package.json 变化 → 哈希变化', () => {
    const { taskDir } = tempTask({ 'package.json': PKG })
    const before = computeDepsHash(taskDir)
    writeFileSync(join(taskDir, 'package.json'), `${PKG} `, 'utf8')
    expect(computeDepsHash(taskDir)).not.toBe(before)
  })

  it('锁文件出现 / 变化 → 哈希变化', () => {
    const { taskDir } = tempTask({ 'package.json': PKG })
    const withoutLock = computeDepsHash(taskDir)
    writeFileSync(join(taskDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9', 'utf8')
    const withLock = computeDepsHash(taskDir)
    expect(withLock).not.toBe(withoutLock)
    writeFileSync(join(taskDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.1', 'utf8')
    expect(computeDepsHash(taskDir)).not.toBe(withLock)
  })
})

describe('缓存命中 / 失效', () => {
  it('首次安装并写入指纹', async () => {
    const { taskDir, dataDir } = tempTask({ 'package.json': PKG })
    const install = fakeInstall()
    const cache = new DependencyCache({ dataDir, install })
    const result = await cache.ensure('demo', taskDir)
    expect(result).toMatchObject({ installed: true, reason: 'installed' })
    expect(install.calls).toBe(1)
    expect(cache.read().entries.demo?.hash).toBe(computeDepsHash(taskDir))
  })

  it('第二次命中缓存 → 不安装', async () => {
    const { taskDir, dataDir } = tempTask({ 'package.json': PKG })
    const install = fakeInstall()
    const cache = new DependencyCache({ dataDir, install })
    await cache.ensure('demo', taskDir)
    const result = await cache.ensure('demo', taskDir)
    expect(result).toMatchObject({ installed: false, reason: 'cache hit' })
    expect(install.calls).toBe(1)
  })

  it('跨实例（重新 new）仍命中磁盘缓存', async () => {
    const { taskDir, dataDir } = tempTask({ 'package.json': PKG })
    const install = fakeInstall()
    await new DependencyCache({ dataDir, install }).ensure('demo', taskDir)
    const result = await new DependencyCache({ dataDir, install }).ensure('demo', taskDir)
    expect(result.reason).toBe('cache hit')
    expect(install.calls).toBe(1)
  })

  it('package.json 变化 → 重新安装', async () => {
    const { taskDir, dataDir } = tempTask({ 'package.json': PKG })
    const install = fakeInstall()
    const cache = new DependencyCache({ dataDir, install })
    await cache.ensure('demo', taskDir)
    writeFileSync(join(taskDir, 'package.json'), JSON.stringify({ name: 'demo2' }), 'utf8')
    const result = await cache.ensure('demo', taskDir)
    expect(result.installed).toBe(true)
    expect(install.calls).toBe(2)
  })

  it('锁文件变化 → 重新安装', async () => {
    const { taskDir, dataDir } = tempTask({ 'package.json': PKG, 'pnpm-lock.yaml': 'v1' })
    const install = fakeInstall()
    const cache = new DependencyCache({ dataDir, install })
    await cache.ensure('demo', taskDir)
    writeFileSync(join(taskDir, 'pnpm-lock.yaml'), 'v2', 'utf8')
    expect((await cache.ensure('demo', taskDir)).installed).toBe(true)
    expect(install.calls).toBe(2)
  })

  it('任务目录变化（哈希相同）→ 重新安装', async () => {
    const { root, taskDir, dataDir } = tempTask({ 'package.json': PKG })
    const install = fakeInstall()
    const cache = new DependencyCache({ dataDir, install })
    await cache.ensure('demo', taskDir)
    const otherDir = join(root, 'programs', 'other')
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(join(otherDir, 'package.json'), PKG, 'utf8')
    await cache.ensure('demo', otherDir)
    expect(install.calls).toBe(2)
  })

  it('没有 package.json → 不安装、返回原因', async () => {
    const { taskDir, dataDir } = tempTask()
    const install = fakeInstall()
    const result = await new DependencyCache({ dataDir, install }).ensure('demo', taskDir)
    expect(result).toMatchObject({ installed: false, reason: 'no package.json' })
    expect(install.calls).toBe(0)
  })

  it('缓存文件损坏 → 视为空缓存并重新安装', async () => {
    const { taskDir, dataDir } = tempTask({ 'package.json': PKG })
    writeFileSync(join(dataDir, DEPS_CACHE_FILE), '{oops', 'utf8')
    const install = fakeInstall()
    const cache = new DependencyCache({ dataDir, install })
    expect((await cache.ensure('demo', taskDir)).installed).toBe(true)
    expect(install.calls).toBe(1)
  })

  it('缓存版本不符 → 视为空缓存', async () => {
    const { taskDir, dataDir } = tempTask({ 'package.json': PKG })
    writeFileSync(join(dataDir, DEPS_CACHE_FILE), JSON.stringify({ version: 99, entries: {} }), 'utf8')
    const install = fakeInstall()
    await new DependencyCache({ dataDir, install }).ensure('demo', taskDir)
    expect(install.calls).toBe(1)
  })
})

describe('安装失败不写指纹', () => {
  it('安装抛错 → 抛 DepsInstallError（failureKind=install）且缓存为空', async () => {
    const { taskDir, dataDir } = tempTask({ 'package.json': PKG })
    const install: InstallStrategy = {
      name: 'fake-pnpm',
      async install() {
        throw new Error('registry down')
      },
    }
    const cache = new DependencyCache({ dataDir, install })
    await expect(cache.ensure('demo', taskDir)).rejects.toBeInstanceOf(DepsInstallError)
    expect(cache.read().entries.demo).toBeUndefined()
  })

  it('失败后再次调用仍会尝试安装（不会被失败缓存锁死）', async () => {
    const { taskDir, dataDir } = tempTask({ 'package.json': PKG })
    let attempts = 0
    const install: InstallStrategy = {
      name: 'fake-pnpm',
      async install() {
        attempts += 1
        if (attempts === 1) throw new Error('first fails')
      },
    }
    const cache = new DependencyCache({ dataDir, install })
    await expect(cache.ensure('demo', taskDir)).rejects.toThrow()
    expect((await cache.ensure('demo', taskDir)).installed).toBe(true)
    expect(attempts).toBe(2)
  })

  it('错误信息含策略名与任务 id', async () => {
    const { taskDir, dataDir } = tempTask({ 'package.json': PKG })
    const install: InstallStrategy = {
      name: 'fake-pnpm',
      async install() {
        throw new Error('nope')
      },
    }
    await expect(new DependencyCache({ dataDir, install }).ensure('demo', taskDir)).rejects.toThrow(
      /demo.*fake-pnpm|fake-pnpm.*demo/,
    )
  })
})

describe('pnpm 安装策略（注入 fake spawn）', () => {
  function fakeChild(): EventEmitter & { kill: ReturnType<typeof vi.fn> } {
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }
    child.kill = vi.fn()
    return child
  }

  it('exit 0 → resolve；命令 / cwd / 参数正确', async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => child as never)
    const strategy = createPnpmInstallStrategy({ spawn: spawn as never })
    const promise = strategy.install({ taskId: 'demo', taskDir: '/tmp/demo', timeoutMs: 1000 })
    child.emit('exit', 0)
    await expect(promise).resolves.toBeUndefined()
    expect(spawn).toHaveBeenCalledWith('pnpm', ['install'], { cwd: '/tmp/demo', stdio: 'ignore' })
  })

  it('exit 非 0 → reject 并点名退出码', async () => {
    const child = fakeChild()
    const strategy = createPnpmInstallStrategy({ spawn: (() => child) as never })
    const promise = strategy.install({ taskId: 'demo', taskDir: '/tmp/demo', timeoutMs: 1000 })
    child.emit('exit', 2)
    await expect(promise).rejects.toThrow(/退出码 2/)
  })

  it('超时 → SIGTERM 强杀并 reject', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      const strategy = createPnpmInstallStrategy({
        spawn: (() => child) as never,
        killGraceMs: 10,
      })
      const promise = strategy.install({ taskId: 'demo', taskDir: '/tmp/demo', timeoutMs: 100 })
      const rejection = expect(promise).rejects.toThrow(/超过 100ms/)
      await vi.advanceTimersByTimeAsync(150)
      await rejection
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('spawn 抛错 → reject（无法启动）', async () => {
    const strategy = createPnpmInstallStrategy({
      spawn: (() => {
        throw new Error('ENOENT')
      }) as never,
    })
    await expect(
      strategy.install({ taskId: 'demo', taskDir: '/tmp/demo', timeoutMs: 1000 }),
    ).rejects.toThrow(/无法启动/)
  })

  it('子进程 error 事件 → reject', async () => {
    const child = fakeChild()
    const strategy = createPnpmInstallStrategy({ spawn: (() => child) as never })
    const promise = strategy.install({ taskId: 'demo', taskDir: '/tmp/demo', timeoutMs: 1000 })
    child.emit('error', new Error('spawn failed'))
    await expect(promise).rejects.toThrow(/无法启动/)
  })
})

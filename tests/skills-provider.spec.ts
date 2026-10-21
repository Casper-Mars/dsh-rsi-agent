/**
 * SKILL provider 装配 + 资产 bootstrap 验收（任务-08，验收 1–7）。
 *
 * 真实装配：真实 `Context` + 真实 `ToolRuntime` + 真实 `SkillRegistry` + 真实
 * chokidar（watch 用例等待 ≥900ms 稳定阈值）。所有目录均在 `mkdtemp` 沙箱内，
 * 不触碰 `~/.dsh-rsi-agent`。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { AgentHost } from '../src/service.js'
import {
  SKILL_PROVIDER_NAME,
  hasSkillAssetType,
  mountSkillFilesystemProvider,
  resolveSkillDir,
} from '../src/skills/provider.js'
import { FIRMWARE_SKILL_NAMES } from '../src/evolution/names.js'
import type { AssetType, DomainLogger, DomainPack, RegisterResult, ToolDefinition } from '../src/types.js'

const STABILITY_WAIT_MS = 900
const SKILL_TYPES: readonly AssetType[] = [{ name: 'skill', prefix: 'skills/' }]
const NOTE_TYPES: readonly AssetType[] = [{ name: 'note', prefix: 'notes/' }]

const sandboxes: string[] = []
const contexts: Context[] = []

function sandboxHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rsi-provider-'))
  sandboxes.push(dir)
  return dir
}

function skillMd(name: string, description: string, body = `# ${name}`): string {
  return `---\nname: ${name}\ndescription: ${description}\nwhenToUse: ${description}-when\n---\n\n${body}\n`
}

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} 测试工具`,
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text' as const, text: 'ok' }],
    },
    execute: async () => ({ ok: true }),
  } as unknown as ToolDefinition
}

function makePack(overrides: Partial<DomainPack> = {}): DomainPack {
  return {
    apiVersion: 1,
    id: 'rsi-demo',
    version: '1.0.0',
    displayName: 'RSI Demo',
    persona: { markdown: () => '# demo' },
    defaultSessionId: 'demo-session',
    assets: { types: SKILL_TYPES },
    scheduler: { timezone: 'Asia/Shanghai' },
    evolutionPolicy: { window: '7d', independentCases: 10 },
    tools: () => [makeTool('demo-echo')],
    toolNames: ['demo-echo'],
    ...overrides,
  }
}

interface LogRecord {
  level: 'error' | 'warn' | 'info' | 'debug'
  message: string
  meta?: unknown
}

function makeLogger(): { records: LogRecord[]; logger: DomainLogger } {
  const records: LogRecord[] = []
  const push =
    (level: LogRecord['level']) =>
    (message: string, meta?: unknown): void => {
      records.push({ level, message, meta })
    }
  return {
    records,
    logger: { error: push('error'), warn: push('warn'), info: push('info'), debug: push('debug') },
  }
}

async function waitFor<T>(
  fn: () => Promise<T> | T,
  opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<T> {
  const { timeout = 12_000, interval = 100, label = '' } = opts
  const start = Date.now()
  let lastError: unknown
  while (Date.now() - start < timeout) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw lastError ?? new Error(`waitFor 超时：${label}`)
}

const SYSTEM_PROMPT_STUB = new Proxy(
  {},
  { get: (_target, property) => (property === 'then' ? undefined : () => () => {}) },
)

/** 真实 tools + skills 服务；watch 用例依赖真实 SkillRegistry。 */
async function createRuntimeCtx(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('systemPrompt', SYSTEM_PROMPT_STUB as never)
  ctx.plugin(ToolRuntime)
  await waitFor(() => ctx.tools !== undefined, { timeout: 2000, label: 'ToolRuntime 上线' })
  await (ctx.plugin(SkillRegistry as never) as unknown as Promise<unknown>)
  return ctx
}

interface SkillSummary {
  name: string
  description?: string
  whenToUse?: string
  provider?: string
  source?: string
}

async function listSkills(ctx: Context): Promise<SkillSummary[]> {
  const registry = ctx.skills as unknown as { list(options: unknown): Promise<SkillSummary[]> }
  return registry.list({})
}

/** 轮询直到指定 skill 出现（`waitFor` 只负责重试，成功判定由这里负责）。 */
async function ensureSkill(
  ctx: Context,
  name: string,
  label = `skill ${name} 可见`,
): Promise<SkillSummary> {
  return waitFor(
    async () => {
      const found = (await listSkills(ctx)).find((skill) => skill.name === name)
      if (found === undefined) throw new Error(`${label}：尚未出现`)
      return found
    },
    { label },
  )
}

/**
 * 统计当前进程中活跃的 `fs.FSWatcher` 实例。
 *
 * 注意：不能用 `process.getActiveResourcesInfo()` —— 在 macOS 上它把活跃
 * watcher 报成 `FSEventWrap`，对 `FSWatcher` 过滤恒为 0，会让断言变成 0<=0。
 * `_getActiveHandles()` 返回的是真实句柄对象，constructor 名为 `FSWatcher`。
 *
 * 返回 -1 表示该运行时没有暴露 `_getActiveHandles`（调用方跳过断言）。
 */
function countFsWatchers(): number {
  const getHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })
    ._getActiveHandles
  if (typeof getHandles !== 'function') return -1
  try {
    return getHandles.call(process).filter((handle) => {
      const ctor = (handle as { constructor?: { name?: string } } | undefined)?.constructor
      return ctor?.name === 'FSWatcher'
    }).length
  } catch {
    return -1
  }
}

function gitLog(assetsDir: string): string {
  return execFileSync('git', ['-C', assetsDir, 'log', '--pretty=%B'], { encoding: 'utf8' })
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose()
    } catch {
      /* ignore */
    }
  }
  for (const dir of sandboxes.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  vi.doUnmock('@deepseek-ai/dsh-skill-filesystem')
})

// ---------------------------------------------------------------------------
// 条件化判断（纯函数）
// ---------------------------------------------------------------------------
describe('条件化判断 hasSkillAssetType（按路径段、大小写折叠）', () => {
  it.each([
    ['skills/', true],
    ['skills/sub/', true],
    ['Skills/', true],
    ['notes/', false],
    ['skillz/', false],
  ])('prefix %s → %s', (prefix, expected) => {
    expect(hasSkillAssetType([{ name: 'x', prefix }])).toBe(expected)
  })

  it('多类型中任意一个命中即可；空列表为 false', () => {
    expect(hasSkillAssetType([...NOTE_TYPES, ...SKILL_TYPES])).toBe(true)
    expect(hasSkillAssetType([])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 验收 3：未声明 skills/ → 不挂 provider、不加载依赖；声明后生效
// ---------------------------------------------------------------------------
describe('验收 3 · 条件化挂载', () => {
  it('未声明 skills/ 前缀：install 成功、不加载 provider 依赖、技能列表无 provider 贡献', async () => {
    const probe = { calls: 0 }
    vi.doMock('@deepseek-ai/dsh-skill-filesystem', () => {
      probe.calls += 1
      throw new Error('不应被加载')
    })

    const ctx = await createRuntimeCtx()
    const host = new AgentHost(ctx)
    const { records, logger } = makeLogger()
    const home = sandboxHome()

    const dispose = host.install(
      makePack({
        assets: {
          types: NOTE_TYPES,
          bootstrap(writer) {
            writer.register({ type: 'note', path: 'notes/a.md', content: 'a' })
          },
        },
      }),
      { home, logger },
    )

    try {
      expect(typeof dispose).toBe('function')
      expect(host.active).toBeDefined()
      // 给予异步挂载（若发生）充足时间，确保「没有发生」不是时序巧合。
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(probe.calls, '未声明 skills/ 时不得 import provider 依赖').toBe(0)
      expect(resolveSkillDir(host.active!.assetsDir)).toBe(join(host.active!.assetsDir, 'skills'))
      const skills = await listSkills(ctx)
      expect(skills.every((skill) => skill.provider !== SKILL_PROVIDER_NAME)).toBe(true)
      expect(records.some((record) => record.message.includes('skill-filesystem'))).toBe(false)
    } finally {
      dispose()
      vi.doUnmock('@deepseek-ai/dsh-skill-filesystem')
    }
  })

  it('声明 skills/ 前缀：provider 生效，bootstrap 落盘的 SKILL 被列表感知', async () => {
    const ctx = await createRuntimeCtx()
    const host = new AgentHost(ctx)
    const { logger } = makeLogger()
    const home = sandboxHome()

    const dispose = host.install(
      makePack({
        assets: {
          types: SKILL_TYPES,
          bootstrap(writer) {
            writer.register({
              type: 'skill',
              path: 'skills/demo/SKILL.md',
              content: skillMd('demo-skill', 'DEMO-DESC'),
            })
          },
        },
      }),
      { home, logger },
    )

    try {
      const listed = await ensureSkill(ctx, 'demo-skill', 'provider 发现 demo-skill')
      expect(listed.provider).toBe(SKILL_PROVIDER_NAME)
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 验收 1：bootstrap 注册资产 → 落盘 + commit，install 成功
// ---------------------------------------------------------------------------
describe('验收 1 · bootstrap 资产落盘 + commit', () => {
  it('注册 1 个资产：文件落盘、产生 commit、install 成功且资产被 provider 发现', async () => {
    const ctx = await createRuntimeCtx()
    const host = new AgentHost(ctx)
    const { records, logger } = makeLogger()
    const home = sandboxHome()
    let results: RegisterResult[] = []

    const pack = makePack({
      assets: {
        types: SKILL_TYPES,
        bootstrap(writer) {
          results = writer.register({
            type: 'skill',
            path: 'skills/demo/SKILL.md',
            content: skillMd('demo-skill', 'DEMO-DESC', '# demo body'),
            message: 'seed demo skill',
          })
        },
      },
    })

    const dispose = host.install(pack, { home, logger })
    try {
      expect(host.active?.id).toBe('rsi-demo')
      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('created')
      expect(typeof results[0].sha).toBe('string')

      const assetsDir = host.active!.assetsDir
      const file = join(assetsDir, 'skills', 'demo', 'SKILL.md')
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, 'utf8')).toContain('# demo body')

      const log = gitLog(assetsDir)
      expect(log).toContain('seed demo skill')
      expect(log).toContain('create skills/demo/SKILL.md')

      const listed = await ensureSkill(ctx, 'demo-skill', 'demo-skill 出现在技能列表')
      expect(listed.provider).toBe(SKILL_PROVIDER_NAME)
      expect(records.filter((record) => record.level === 'error')).toEqual([])
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 验收 2：bootstrap 声明为 async → install 失败，错误点明必须同步
// ---------------------------------------------------------------------------
describe('验收 2 · async bootstrap 拒绝', () => {
  it('async 声明在契约校验阶段被拒绝，错误明确指出必须同步', async () => {
    const ctx = await createRuntimeCtx()
    const host = new AgentHost(ctx)
    const home = sandboxHome()

    let caught: unknown
    try {
      host.install(
        makePack({
          assets: {
            types: SKILL_TYPES,
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            async bootstrap() {},
          },
        }),
        { home },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toContain('assets.bootstrap')
    expect(message).toContain('同步')
    expect(host.active).toBeUndefined()
  })

  it('普通函数返回 Promise（thenable）同样失败', async () => {
    const ctx = await createRuntimeCtx()
    const host = new AgentHost(ctx)
    const home = sandboxHome()

    expect(() =>
      host.install(
        makePack({
          assets: {
            types: SKILL_TYPES,
            bootstrap: () => Promise.resolve() as never,
          },
        }),
        { home },
      ),
    ).toThrow(/bootstrap/)
    expect(host.active).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 验收 4：改写 SKILL.md 无需重启即被感知（watch）
// ---------------------------------------------------------------------------
describe('验收 4 · watch 热更新', () => {
  it('改写 SKILL.md → 技能列表在无重启情况下反映新内容', async () => {
    const ctx = await createRuntimeCtx()
    const host = new AgentHost(ctx)
    const { logger } = makeLogger()
    const home = sandboxHome()

    const dispose = host.install(
      makePack({
        assets: {
          types: SKILL_TYPES,
          bootstrap(writer) {
            writer.register({
              type: 'skill',
              path: 'skills/hot/SKILL.md',
              content: skillMd('hot-skill', 'BEFORE-DESC', '# BEFORE-BODY'),
            })
          },
        },
      }),
      { home, logger },
    )

    try {
      const assetsDir = host.active!.assetsDir
      const skillsDir = resolveSkillDir(assetsDir)
      const file = join(skillsDir, 'hot', 'SKILL.md')

      await ensureSkill(ctx, 'hot-skill', 'hot-skill 初次可见')
      expect((await listSkills(ctx)).find((s) => s.name === 'hot-skill')?.description).toBe(
        'BEFORE-DESC',
      )

      // 等待 chokidar 稳定阈值（默认 200ms）+ 余量后再改写。
      await new Promise((resolve) => setTimeout(resolve, STABILITY_WAIT_MS))
      writeFileSync(
        file,
        skillMd('hot-skill', 'AFTER-DESC', '# AFTER-BODY'),
        'utf8',
      )

      await waitFor(
        async () => {
          const found = (await listSkills(ctx)).find((skill) => skill.name === 'hot-skill')
          expect(found?.description).toBe('AFTER-DESC')
        },
        { label: 'description 热更新' },
      )

      const registry = ctx.skills as unknown as { get(name: string): Promise<{ content: string }> }
      const definition = await registry.get('hot-skill')
      expect(definition.content).toContain('AFTER-BODY')
    } finally {
      dispose()
    }
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 固件隔离：3 个固件 skill 只来自静态注册，不被 provider 重复发现
// ---------------------------------------------------------------------------
describe('固件 SKILL 隔离', () => {
  it('provider 开启后固件名各出现一次，且 provider 均为静态注册（非 rsi-skills）', async () => {
    const ctx = await createRuntimeCtx()
    const host = new AgentHost(ctx)
    const { logger } = makeLogger()
    const home = sandboxHome()

    const dispose = host.install(
      makePack({
        assets: {
          types: SKILL_TYPES,
          bootstrap(writer) {
            writer.register({
              type: 'skill',
              path: 'skills/demo/SKILL.md',
              content: skillMd('demo-skill', 'DEMO-DESC'),
            })
          },
        },
      }),
      { home, logger },
    )

    try {
      await ensureSkill(ctx, 'demo-skill', 'provider 就绪')

      const skills = await listSkills(ctx)
      for (const firmwareName of FIRMWARE_SKILL_NAMES) {
        const matches = skills.filter((skill) => skill.name === firmwareName)
        expect(matches, `固件 SKILL ${firmwareName} 必须恰好 1 条`).toHaveLength(1)
        expect(matches[0].provider).not.toBe(SKILL_PROVIDER_NAME)
      }
      expect(skills.filter((skill) => skill.name === 'demo-skill')).toHaveLength(1)
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 验收 6：卸载后 provider 与 watch 拆除、资产文件保留
// ---------------------------------------------------------------------------
describe('验收 6 · 卸载语义', () => {
  it('dispose → provider 归零、watcher 关闭、assets/ 文件仍在', async () => {
    const ctx = await createRuntimeCtx()
    const host = new AgentHost(ctx)
    const { logger } = makeLogger()
    const home = sandboxHome()

    // 前序用例的 watcher 在 dispose 后异步收敛（见 provider.ts 的注销时序说明）；
    // 先等进程基线归零，避免把「上一轮残留」误当成「本轮挂载」。
    if (countFsWatchers() >= 0) {
      await waitFor(
        () => {
          expect(countFsWatchers(), '测试起点应无残留 FSWatcher').toBe(0)
        },
        { timeout: 1500, interval: 25, label: '历史 watcher 收敛到 0' },
      )
    }
    const watchersBefore = countFsWatchers()
    const disposable = host.install(
      makePack({
        assets: {
          types: SKILL_TYPES,
          bootstrap(writer) {
            writer.register({
              type: 'skill',
              path: 'skills/demo/SKILL.md',
              content: skillMd('demo-skill', 'DEMO-DESC'),
            })
          },
        },
      }),
      { home, logger },
    )

    const assetsDir = host.active!.assetsDir
    const file = join(assetsDir, 'skills', 'demo', 'SKILL.md')
    await ensureSkill(ctx, 'demo-skill', 'dispose 前 provider 就绪')

    // 真实断言的前置条件：provider 确实开了一个 FSWatcher（否则计数无意义）。
    // `ensureSkill` 内部调用过 `list()`，watcher 已 open 并 ready。
    const watchersMounted = countFsWatchers()
    if (watchersBefore >= 0 && watchersMounted >= 0) {
      expect(watchersMounted, 'provider 挂载后必须存在真实 FSWatcher').toBeGreaterThan(
        watchersBefore,
      )
    }

    disposable()
    expect(host.active).toBeUndefined()

    await waitFor(
      async () => {
        const skills = await listSkills(ctx)
        expect(skills.filter((skill) => skill.provider === SKILL_PROVIDER_NAME)).toHaveLength(0)
        expect(skills).toHaveLength(0)
      },
      { timeout: 8000, label: 'provider 与固件 skill 全部拆除' },
    )

    // watch 关闭：dispose 同步返回，但 chokidar 的 close 异步收敛（实测 ~8ms），
    // 故轮询等待（≤1.5s）活跃 FSWatcher 回落到挂载前基线，而不是瞬时判定。
    if (watchersBefore >= 0) {
      await waitFor(
        () => {
          const watchersAfter = countFsWatchers()
          expect(
            watchersAfter,
            `活跃 FSWatcher 未收敛（before=${watchersBefore}）`,
          ).toBeLessThanOrEqual(watchersBefore)
        },
        { timeout: 1500, interval: 25, label: 'FSWatcher 异步收敛到基线' },
      )
      // 收敛后基线本身应为 0（本用例独立进程内无其它 watcher）时，必须精确为 0。
      if (watchersBefore === 0) expect(countFsWatchers()).toBe(0)
    }

    // 再改写文件不得复活任何 skill；磁盘资产保留（§4.3）。
    writeFileSync(file, skillMd('demo-skill', 'AFTER-DISPOSE'), 'utf8')
    await new Promise((resolve) => setTimeout(resolve, STABILITY_WAIT_MS))
    expect(await listSkills(ctx)).toHaveLength(0)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('AFTER-DISPOSE')
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 验收 5：bootstrap 中途失败（第 2 批）→ install 失败 + error 日志
// ---------------------------------------------------------------------------
describe('验收 5 · bootstrap 中途失败', () => {
  it('第 2 批抛错：第 1 批 commit 保留、install 失败、error 日志、无表面成功', async () => {
    const ctx = await createRuntimeCtx()
    const host = new AgentHost(ctx)
    const { records, logger } = makeLogger()
    const home = sandboxHome()

    const pack = makePack({
      assets: {
        types: SKILL_TYPES,
        bootstrap(writer) {
          writer.register({
            type: 'skill',
            path: 'skills/first/SKILL.md',
            content: skillMd('first-skill', 'FIRST-DESC'),
          })
          throw new Error('第 2 批资产注册失败（测试注入）')
        },
      },
    })

    let caught: unknown
    try {
      host.install(pack, { home, logger })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('第 2 批资产注册失败')
    expect(host.active, '不得出现表面成功').toBeUndefined()

    const assetsDir = join(home, 'rsi-demo', 'assets')
    const firstFile = join(assetsDir, 'skills', 'first', 'SKILL.md')
    expect(existsSync(firstFile), '第 1 批已落盘并保留').toBe(true)
    const log = gitLog(assetsDir)
    expect(log).toContain('create skills/first/SKILL.md')
    expect(log).not.toContain('skills/second')

    const errors = records.filter((record) => record.level === 'error')
    expect(errors, '必须留下 error 级日志').toHaveLength(1)
    expect(errors[0].message).toContain('安装失败')
    expect((errors[0].meta as Error).message).toContain('第 2 批资产注册失败')

    // 工具与固件 skill 已回滚，provider 未挂载。
    expect(ctx.tools.get('demo-echo')).toBeUndefined()
    expect(ctx.tools.get('asset_commit')).toBeUndefined()
    expect((await listSkills(ctx)).filter((s) => s.name === 'first-skill')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 验收 7：依赖缺失 → core 仍可启动、warn 降级、工具可用
// ---------------------------------------------------------------------------
describe('验收 7 · optional peer 缺失降级', () => {
  it('依赖不可解析：install 成功、warn 日志、core 工具可用、provider 不生效', async () => {
    vi.doMock('@deepseek-ai/dsh-skill-filesystem', () => {
      throw new Error('MODULE_UNRESOLVABLE')
    })

    const ctx = await createRuntimeCtx()
    const host = new AgentHost(ctx)
    const { records, logger } = makeLogger()
    const home = sandboxHome()

    const dispose = host.install(
      makePack({
        assets: {
          types: SKILL_TYPES,
          bootstrap(writer) {
            writer.register({
              type: 'skill',
              path: 'skills/demo/SKILL.md',
              content: skillMd('demo-skill', 'DEMO-DESC'),
            })
          },
        },
      }),
      { home, logger },
    )

    try {
      expect(typeof dispose).toBe('function')
      expect(host.active).toBeDefined()
      expect(ctx.tools.get('asset_commit'), 'core 工具必须可用').toBeDefined()
      expect(ctx.tools.get('demo-echo'), '领域工具必须可用').toBeDefined()

      // 依赖缺失属于降级：ready 必须 resolve（而不是 reject / 永久 pending）。
      await expect(host.skillProviderReady).resolves.toBeUndefined()

      await waitFor(
        () => {
          expect(
            records.some(
              (record) => record.level === 'warn' && record.message.includes('降级'),
            ),
          ).toBe(true)
        },
        { timeout: 5000, label: '降级 warn 日志' },
      )

      const skills = await listSkills(ctx)
      expect(skills.filter((skill) => skill.provider === SKILL_PROVIDER_NAME)).toHaveLength(0)
      // 固件 skill 仍是静态注册，照常可用。
      expect(skills.filter((skill) => FIRMWARE_SKILL_NAMES.includes(skill.name as never))).toHaveLength(3)
    } finally {
      dispose()
      vi.doUnmock('@deepseek-ai/dsh-skill-filesystem')
    }
  }, 20_000)
})

// ---------------------------------------------------------------------------
// 就绪信号：install 返回后 await ready → 立即 list() 可见（替代 sleep）
// ---------------------------------------------------------------------------
describe('provider 就绪信号（最终一致 → 确定性等待）', () => {
  it('install 返回后 await host.skillProviderReady：无需重试即可见', async () => {
    const ctx = await createRuntimeCtx()
    const host = new AgentHost(ctx)
    const { logger } = makeLogger()
    const home = sandboxHome()

    const dispose = host.install(
      makePack({
        assets: {
          types: SKILL_TYPES,
          bootstrap(writer) {
            writer.register({
              type: 'skill',
              path: 'skills/ready/SKILL.md',
              content: skillMd('ready-skill', 'READY-DESC'),
            })
          },
        },
      }),
      { home, logger },
    )

    try {
      expect(host.skillProviderReady).toBeDefined()
      await host.skillProviderReady
      // 关键：不是 waitFor，只 list 一次；就绪后必须立即可见。
      const skills = await listSkills(ctx)
      expect(skills.map((skill) => skill.name)).toContain('ready-skill')
      expect(skills.find((skill) => skill.name === 'ready-skill')?.provider).toBe(
        SKILL_PROVIDER_NAME,
      )
    } finally {
      dispose()
    }
  })

  it('未声明 skills/ 前缀时 skillProviderReady 已 resolve（await 不等待）', async () => {
    const ctx = await createRuntimeCtx()
    const host = new AgentHost(ctx)
    const home = sandboxHome()

    const dispose = host.install(makePack({ assets: { types: NOTE_TYPES } }), { home })
    try {
      const ready = host.skillProviderReady
      expect(ready).toBeInstanceOf(Promise)
      await expect(ready).resolves.toBeUndefined()
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 文档化行为：缺 YAML frontmatter 的 SKILL 文件不被 provider 收录
// ---------------------------------------------------------------------------
describe('frontmatter 契约（上游 provider 行为）', () => {
  it('缺 frontmatter 的文件不会进入技能列表；合法文件正常收录', async () => {
    const ctx = await createRuntimeCtx()
    const host = new AgentHost(ctx)
    const { logger } = makeLogger()
    const home = sandboxHome()

    const dispose = host.install(
      makePack({
        assets: {
          types: SKILL_TYPES,
          bootstrap(writer) {
            writer.register({
              type: 'skill',
              path: 'skills/no-fm/SKILL.md',
              content: '# no-fm\n\n没有 frontmatter 的正文。\n',
            })
            writer.register({
              type: 'skill',
              path: 'skills/with-fm/SKILL.md',
              content: skillMd('with-fm', 'WITH-DESC'),
            })
          },
        },
      }),
      { home, logger },
    )

    try {
      await host.skillProviderReady
      const skills = await listSkills(ctx)
      // provider 已就绪 + 同目录合法文件可见 ⇒ 缺 frontmatter 的确实是被忽略而非未扫到。
      expect(skills.map((skill) => skill.name)).toContain('with-fm')
      expect(skills.map((skill) => skill.name)).not.toContain('no-fm')
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 组装位置 / 导出契约
// ---------------------------------------------------------------------------
describe('装配契约', () => {
  it('同步入口立即可用：返回 ready / dispose，且 dispose 可重复调用', async () => {
    const ctx = await createRuntimeCtx()
    const home = sandboxHome()
    const assetsDir = join(home, 'assets')
    mkdirSync(join(assetsDir, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(assetsDir, 'skills', 'demo', 'SKILL.md'), skillMd('demo-skill', 'D'), 'utf8')

    const handle = mountSkillFilesystemProvider(ctx, { assetsDir })
    expect(handle.providerName).toBe(SKILL_PROVIDER_NAME)
    expect(handle.dir).toBe(resolveSkillDir(assetsDir))

    await handle.ready
    await ensureSkill(ctx, 'demo-skill', '同步入口挂载完成')

    await handle.dispose()
    await handle.dispose()
    expect((await listSkills(ctx)).filter((s) => s.provider === SKILL_PROVIDER_NAME)).toHaveLength(0)
  }, 20_000)
})

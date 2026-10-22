/**
 * 生命周期：install → dispose → 再 install（HMR 重入）的残留检查（Task-14）。
 *
 * 审计结论：既有用例覆盖了「单次 install 的装配 / 回滚 / 幂等 dispose」，
 * 但没有把「同一个 host 上反复装卸」作为一条完整链路验证。本文件补：
 *   1. HMR 重入：timer 数归零再装回、工具表无残留、active 干净切换；
 *   2. install 中途失败后 host 未被污染（可立即重新安装成功）；
 *   3. 双领域冲突后 dispose 首个领域 → 第二个领域可以正常安装。
 *
 * 用 `vi.getTimerCount()` 观察调度器 timer：调度器 `start()` 为每个启用任务装
 * 一条 timer，`stop()` 必须全部清空；残留 timer 会在 HMR 场景下成倍累积。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { AgentHost } from '../src/service'
import type { DomainPack, ToolDefinition } from '../src/types'

const created: string[] = []
function tempDir(prefix = 'dsh-rsi-hmr-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

afterEach(() => {
  vi.useRealTimers()
  while (created.length > 0) {
    const dir = created.pop() as string
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} 测试工具`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: {} },
      render: () => [{ type: 'text' as const, text: 'ok' }],
    },
    execute: async () => ({}),
  } as unknown as ToolDefinition
}

function makePack(id: string, overrides: Partial<DomainPack> = {}): DomainPack {
  return {
    apiVersion: 1,
    id,
    version: '1.0.0',
    displayName: id,
    persona: { markdown: () => `# ${id}` },
    defaultSessionId: `${id}-session`,
    assets: { types: [{ name: 'notes', prefix: 'notes/' }] },
    scheduler: { timezone: 'UTC' },
    evolutionPolicy: { window: '7d', independentCases: 3 },
    tools: () => [makeTool(`${id}-lookup`)],
    toolNames: [`${id}-lookup`],
    ...overrides,
  }
}

/** 在领域 home 下预置一个「每分钟触发」的任务，让 scheduler.start() 装 timer。 */
function seedTask(homeRoot: string, domainId: string): void {
  const home = join(homeRoot, domainId)
  mkdirSync(join(home, 'assets', 'tasks'), { recursive: true })
  mkdirSync(join(home, 'programs'), { recursive: true })
  writeFileSync(
    join(home, 'programs', 'job.js'),
    'process.stdout.write(JSON.stringify({ shouldWake: false }) + "\\n")\n',
  )
  writeFileSync(
    join(home, 'assets', 'tasks', 'main.json'),
    JSON.stringify(
      { id: 'main', name: 'main', cron: '* * * * *', task_path: 'programs/job.js', enabled: true },
      null,
      2,
    ),
  )
}

/** 等待（最多 `timeoutMs`）直到 `check()` 为真。 */
async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function hostWithRealTools(): Promise<{ ctx: Context; host: AgentHost }> {
  const ctx = new Context()
  ctx.provide(
    'systemPrompt',
    new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : () => () => {}) }) as never,
  )
  ctx.plugin(ToolRuntime)
  await waitFor(() => ctx.tools !== undefined)
  return { ctx, host: new AgentHost(ctx) }
}

describe('HMR 重入：install → dispose → install', () => {
  it('调度器 timer 在 dispose 后归零，重装后重新装回（无泄漏、无叠加）', () => {
    vi.useFakeTimers()
    const homeRoot = process.env.DSH_RSI_HOME as string
    const domainId = 'hmr-timer'
    seedTask(homeRoot, domainId)

    const host = new AgentHost(new Context())
    const pack = makePack(domainId)

    const first = host.install(pack)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    expect(host.active?.id).toBe(domainId)

    first()
    expect(vi.getTimerCount()).toBe(0)
    expect(host.active).toBeUndefined()

    const second = host.install(pack)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    expect(host.active?.id).toBe(domainId)

    second()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('重装后工具表恰好恢复一份：dispose 消失、再 install 可执行、再 dispose 再消失', async () => {
    const { ctx, host } = await hostWithRealTools()
    const pack = makePack('hmr-tools')

    const first = host.install(pack)
    expect(ctx.tools.get('hmr-tools-lookup')).toBeDefined()
    first()
    expect(ctx.tools.get('hmr-tools-lookup')).toBeUndefined()

    const second = host.install(pack)
    const tool = ctx.tools.get('hmr-tools-lookup') as { execute?: unknown } | undefined
    expect(tool).toBeDefined()
    expect(typeof tool?.execute).toBe('function')
    second()
    expect(ctx.tools.get('hmr-tools-lookup')).toBeUndefined()
    expect(host.active).toBeUndefined()
  })
})

describe('安装中途失败后的可重试性', () => {
  it('bootstrap 抛错 → 无 active；改为合法 pack 后可立即安装成功', () => {
    const host = new AgentHost(new Context())
    const broken = makePack('hmr-retry', {
      assets: {
        types: [{ name: 'notes', prefix: 'notes/' }],
        bootstrap: () => {
          throw new Error('bootstrap boom')
        },
      },
    })

    expect(() => host.install(broken)).toThrow('bootstrap boom')
    expect(host.active).toBeUndefined()

    const fixed = makePack('hmr-retry')
    const dispose = host.install(fixed)
    expect(host.active?.id).toBe('hmr-retry')
    dispose()
    expect(host.active).toBeUndefined()
  })

  it('与 core 工具重名 → 拒绝且工具表干净；随后合法 pack 可安装（可重试）', async () => {
    const { ctx, host } = await hostWithRealTools()

    // `asset_commit` 由 core 在领域工具之前注册；领域工具与它重名必须整单失败。
    const broken = makePack('hmr-rollback', {
      tools: () => [makeTool('hmr-rollback-lookup'), makeTool('asset_commit')],
      toolNames: ['hmr-rollback-lookup', 'asset_commit'],
    })
    expect(() => host.install(broken)).toThrow()
    expect(host.active).toBeUndefined()
    // 领域自己的工具一个都不许留下（冲突在注册前就被拦下）。
    expect(ctx.tools.get('hmr-rollback-lookup')).toBeUndefined()

    const dispose = host.install(makePack('hmr-rollback'))
    expect(ctx.tools.get('hmr-rollback-lookup')).toBeDefined()
    dispose()
    expect(ctx.tools.get('hmr-rollback-lookup')).toBeUndefined()
  })
})

describe('双领域冲突后的恢复', () => {
  it('第二个领域被拒后 dispose 第一个 → 第二个可正常安装', () => {
    const host = new AgentHost(new Context())
    const first = host.install(makePack('hmr-first'))
    expect(() => host.install(makePack('hmr-second'))).toThrow(/单领域约束/)

    first()
    expect(host.active).toBeUndefined()

    const second = host.install(makePack('hmr-second'))
    expect(host.active?.id).toBe('hmr-second')
    second()
  })
})

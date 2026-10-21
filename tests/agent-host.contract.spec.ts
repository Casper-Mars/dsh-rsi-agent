/**
 * `agentHost` 契约验证（Task-02）。
 *
 * 覆盖：真实 cordis 装配、单领域约束、DomainPack 契约反例、工具名一致性、
 * 幂等拆卸、LIFO 拆卸顺序、git 降级、无 logger 降级。
 *
 * 说明：反例用例通过 `as any` 故意构造非法 pack —— 这是**类型绕过**（非法值
 * 本就不在 `DomainPack` 类型域内），而非接口设计缺陷。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/plugin'
import {
  AgentHost,
  NotImplementedError,
  TEARDOWN_ORDER,
  TeardownRegistry,
  createDefaultCommitPort,
} from '../src/service'
import { DomainPackValidationError, PERSONA_MAX_BYTES } from '../src/validate'
import type { DomainPack, ToolDefinition } from '../src/types'

/**
 * 构造一个 **符合 dsh-tools 契约** 的工具定义（真实注册表会强校验 output）。
 *
 * `overrides` 用于表单点破坏（例如删掉 output、改成非法的 output.schema）。
 */
function makeTool(name: string, overrides: Record<string, unknown> = {}): ToolDefinition {
  return {
    name,
    description: `${name} 测试工具`,
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { echoed: { type: 'string' } },
        required: ['echoed'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown) => [
        { type: 'text' as const, text: JSON.stringify(value) },
      ],
    },
    execute: async (args: unknown) => ({
      echoed: String((args as { text?: unknown } | undefined)?.text ?? ''),
    }),
    ...overrides,
  } as unknown as ToolDefinition
}

/** 合法的基准 pack；反例在此基础上做单点破坏。 */
function makePack(overrides: Partial<DomainPack> = {}): DomainPack {
  return {
    apiVersion: 1,
    id: 'alpha-domain',
    version: '1.2.3',
    displayName: 'Alpha Domain',
    persona: { markdown: () => '# Alpha\n\nYou are alpha.' },
    defaultSessionId: 'session-1',
    assets: {
      types: [
        { name: 'notes', prefix: 'notes/' },
        { name: 'skill', prefix: 'skills/' },
      ],
    },
    firmwareSkills: [{ name: 'firmware-skill', markdown: '# firmware' }],
    scheduler: { timezone: 'Asia/Shanghai' },
    evolutionPolicy: { window: '7d', independentCases: 10, maxIterations: 3 },
    tools: () => [makeTool('alpha-lookup')],
    toolNames: ['alpha-lookup'],
    ...overrides,
  }
}

/** 每个用例独立的宿主（独立 Context，避免服务注册冲突）。 */
function createHost(config?: { toolNames?: readonly string[] }): {
  ctx: Context
  host: AgentHost
} {
  const ctx = new Context()
  return { ctx, host: new AgentHost(ctx, config) }
}

/** `systemPrompt` 的 no-op 桩：真实 `ToolRuntime` 声明了 `inject: ['systemPrompt']`。 */
function systemPromptStub(): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get: (_target, property) => (property === 'then' ? undefined : () => () => {}),
    },
  ) as Record<string, unknown>
}

/** 等待（最多 `timeoutMs`）直到 `check()` 为真；cordis 服务在微任务中上线。 */
async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 带**真实 dsh-tools 注册表**的宿主（验证工具真正落到 ctx.tools）。 */
async function createHostWithRealTools(): Promise<{ ctx: Context; host: AgentHost }> {
  const ctx = new Context()
  ctx.provide('systemPrompt', systemPromptStub() as never)
  ctx.plugin(ToolRuntime)
  await waitFor(() => ctx.tools !== undefined)
  return { ctx, host: new AgentHost(ctx) }
}

/** 安装并断言抛 DomainPackValidationError，且 field / message 均点名该字段。 */
function expectContractError(pack: unknown, field: string): void {
  const { host } = createHost()
  let caught: unknown
  try {
    host.install(pack as DomainPack)
  } catch (error) {
    caught = error
  }
  expect(caught, '应当抛出契约错误').toBeInstanceOf(DomainPackValidationError)
  const error = caught as DomainPackValidationError
  expect(error.field).toBe(field)
  expect(error.message).toContain(field)
  expect(host.active, '校验失败不得留下 active').toBeUndefined()
}

// ---------------------------------------------------------------------------
// 1. 真实 cordis 装配
// ---------------------------------------------------------------------------
describe('真实 cordis 装配', () => {
  it('apply(ctx) 按微任务完成 fiber 启动后暴露 ctx.agentHost 且 apiVersion === 1', async () => {
    const ctx = new Context()
    apply(ctx)
    // cordis 的 plugin fiber 在微任务中启动，同步读取会拿到 undefined。
    await Promise.resolve()
    expect(ctx.agentHost).toBeDefined()
    expect(ctx.agentHost.apiVersion).toBe(1)
    expect(ctx.agentHost).toBeInstanceOf(AgentHost)

    // 通过真实 cordis 服务代理完成一次安装/拆卸，验证方法绑定与状态可见性。
    const dispose = ctx.agentHost.install(makePack())
    expect(ctx.agentHost.active?.id).toBe('alpha-domain')
    dispose()
    expect(ctx.agentHost.active).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. 单领域约束
// ---------------------------------------------------------------------------
describe('单领域约束', () => {
  it('第二次 install 抛错，信息含已激活 id 与 version', () => {
    const { host } = createHost()
    host.install(makePack())

    let caught: unknown
    try {
      host.install(makePack({ id: 'beta-domain', version: '9.9.9' }))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toContain('alpha-domain')
    expect(message).toContain('1.2.3')
    // 首个领域仍保持激活，未被第二次调用破坏。
    expect(host.active?.id).toBe('alpha-domain')
  })
})

// ---------------------------------------------------------------------------
// 3. 契约反例
// ---------------------------------------------------------------------------
describe('DomainPack 契约反例', () => {
  const cases: Array<[string, string, (pack: any) => void]> = [
    ['apiVersion=2', 'apiVersion', (p) => { p.apiVersion = 2 }],
    ["id='Bad_Id'", 'id', (p) => { p.id = 'Bad_Id' }],
    ['id 超长（33 字符）', 'id', (p) => { p.id = 'a' + 'b'.repeat(32) }],
    ["version='1.0'", 'version', (p) => { p.version = '1.0' }],
    ["defaultSessionId='bad/id'", 'defaultSessionId', (p) => { p.defaultSessionId = 'bad/id' }],
    ["defaultSessionId 超长（129）", 'defaultSessionId', (p) => { p.defaultSessionId = 'a'.repeat(129) }],
    ["persona=''", 'persona.markdown', (p) => { p.persona = { markdown: () => '' } }],
    ['persona 65537 字节（中文）', 'persona.markdown', (p) => {
      // 2 个 ASCII + 21845 个「中」= 2 + 65535 = 65537 字节
      p.persona = { markdown: () => 'ab' + '中'.repeat(21845) }
    }],
    ["类型名 'BadName'", 'assets.types[0].name', (p) => {
      p.assets = { types: [{ name: 'BadName', prefix: 'notes/' }] }
    }],
    ['两个同名资产类型', 'assets.types[1].name', (p) => {
      p.assets = {
        types: [
          { name: 'dup-type', prefix: 'notes/' },
          { name: 'dup-type', prefix: 'records/' },
        ],
      }
    }],
    ["类型名为保留字 'core'", 'assets.types[0].name', (p) => {
      p.assets = { types: [{ name: 'core', prefix: 'core/' }] }
    }],
    ['assets 缺失', 'assets', (p) => { delete p.assets }],
    ['assets.types 为空数组', 'assets.types', (p) => { p.assets = { types: [] } }],
    ['assets.types 非数组', 'assets.types', (p) => { p.assets = { types: {} } }],
    ['prefix 重叠（a/ 与 a/b/）', 'assets.types[1].prefix', (p) => {
      p.assets = {
        types: [
          { name: 'alpha', prefix: 'a/' },
          { name: 'beta', prefix: 'a/b/' },
        ],
      }
    }],
    ['firmwareSkills 重名', 'firmwareSkills[1].name', (p) => {
      p.firmwareSkills = [
        { name: 'firmware-skill', markdown: '# a' },
        { name: 'firmware-skill', markdown: '# b' },
      ]
    }],
    ['firmwareSkills 占用 core 内置名', 'firmwareSkills[0].name', (p) => {
      p.firmwareSkills = [{ name: 'rsi-evolution', markdown: '# 冲突' }]
    }],
    ['bootstrap 非函数', 'assets.bootstrap', (p) => {
      p.assets = { types: [{ name: 'notes', prefix: 'notes/' }], bootstrap: 'nope' }
    }],
    ['bootstrap 声明为 async', 'assets.bootstrap', (p) => {
      p.assets = { types: [{ name: 'notes', prefix: 'notes/' }], bootstrap: async () => {} }
    }],
    ["prefix '../x/'", 'assets.types[0].prefix', (p) => { p.assets = { types: [{ name: 'x', prefix: '../x/' }] } }],
    ["prefix '.git/x/'", 'assets.types[0].prefix', (p) => { p.assets = { types: [{ name: 'x', prefix: '.git/x/' }] } }],
    ["prefix 'x'（缺尾斜杠）", 'assets.types[0].prefix', (p) => { p.assets = { types: [{ name: 'x', prefix: 'x' }] } }],
    ["prefix '/abs/'", 'assets.types[0].prefix', (p) => { p.assets = { types: [{ name: 'x', prefix: '/abs/' }] } }],
    ['prefix 含反斜杠', 'assets.types[0].prefix', (p) => { p.assets = { types: [{ name: 'x', prefix: 'a\\b/' }] } }],
    ["timezone='Not/AZone'", 'scheduler.timezone', (p) => { p.scheduler = { timezone: 'Not/AZone' } }],
    ['evolutionPolicy.independentCases=0', 'evolutionPolicy.independentCases', (p) => {
      p.evolutionPolicy = { window: '7d', independentCases: 0 }
    }],
    ['evolutionPolicy.window 为空', 'evolutionPolicy.window', (p) => {
      p.evolutionPolicy = { window: '  ', independentCases: 3 }
    }],
    ['tool 缺 output（dsh-tools 必填字段）', 'tools()[0].output', (p) => {
      p.tools = () => [
        {
          name: 'alpha-lookup',
          description: 'x',
          parameters: { type: 'object' },
          execute: async () => ({}),
        },
      ]
    }],
    ['tool.execute 为同步函数（类型不再允许）', 'tools()[0].execute', (p) => {
      p.tools = () => [
        {
          name: 'alpha-lookup',
          description: 'x',
          parameters: { type: 'object' },
          output: { schema: { type: 'object' }, render: () => [] },
        },
      ]
    }],
  ]

  it.each(cases)('%s → 抛错且点名字段', (_label, field, mutate) => {
    const pack = makePack()
    mutate(pack)
    expectContractError(pack, field)
  })

  it('persona 恰好 65536 字节时通过（字节口径边界）', () => {
    const { host } = createHost()
    const boundary = '中'.repeat(21845) + 'a' // 65535 + 1 = 65536 字节
    expect(Buffer.byteLength(boundary, 'utf8')).toBe(PERSONA_MAX_BYTES)

    const dispose = host.install(makePack({ persona: { markdown: () => boundary } }))
    expect(host.active?.id).toBe('alpha-domain')
    dispose()
  })
})

// ---------------------------------------------------------------------------
// 4. 工具契约
// ---------------------------------------------------------------------------
describe('工具名一致性', () => {
  it('返回未声明的工具 → 报错并点名未声明工具', () => {
    const { host } = createHost()
    const pack = makePack({
      tools: () => [makeTool('alpha-lookup'), makeTool('extra-tool')],
      toolNames: ['alpha-lookup'],
    })
    let caught: unknown
    try {
      host.install(pack)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DomainPackValidationError)
    expect((caught as DomainPackValidationError).field).toBe('toolNames')
    expect((caught as Error).message).toContain('extra-tool')
  })

  it('声明了但未返回 → 报错并点名缺失工具', () => {
    const { host } = createHost()
    const pack = makePack({
      tools: () => [makeTool('alpha-lookup')],
      toolNames: ['alpha-lookup', 'missing-tool'],
    })
    let caught: unknown
    try {
      host.install(pack)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DomainPackValidationError)
    expect((caught as DomainPackValidationError).field).toBe('toolNames')
    expect((caught as Error).message).toContain('missing-tool')
  })

  it('与 core 重名 → 报错并列出冲突名', () => {
    const { host } = createHost({ toolNames: ['alpha-lookup', 'shared-tool'] })
    const pack = makePack({
      tools: () => [makeTool('alpha-lookup')],
      toolNames: ['alpha-lookup'],
    })
    let caught: unknown
    try {
      host.install(pack)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DomainPackValidationError)
    expect((caught as DomainPackValidationError).field).toBe('toolNames')
    expect((caught as Error).message).toContain('与 core 已注册工具重名')
    expect((caught as Error).message).toContain('alpha-lookup')
    expect((caught as Error).message).not.toContain('shared-tool')
  })
})

// ---------------------------------------------------------------------------
// 5. 工具真实注册（真实 dsh-tools 注册表）
// ---------------------------------------------------------------------------
describe('工具真实注册', () => {
  it('install 后 ctx.tools.get(name) 可执行，dispose 后消失', async () => {
    const { ctx, host } = await createHostWithRealTools()
    expect(ctx.tools.get('alpha-lookup')).toBeUndefined()

    const dispose = host.install(makePack())
    const registered = ctx.tools.get('alpha-lookup')
    expect(registered, 'install 后 ctx.tools 必须真有该工具（不能只是 active 快照）').toBeDefined()
    await expect(registered!.execute({ text: 'ping' }, {} as never)).resolves.toEqual({
      echoed: 'ping',
    })

    dispose()
    expect(ctx.tools.get('alpha-lookup')).toBeUndefined()
    expect(host.active).toBeUndefined()

    // 重复 dispose 不报错，且不影响重新安装。
    expect(() => dispose()).not.toThrow()
    const again = host.install(makePack({ version: '2.0.0' }))
    expect(ctx.tools.get('alpha-lookup')).toBeDefined()
    again()
    expect(ctx.tools.get('alpha-lookup')).toBeUndefined()
  })

  it('与 ctx.tools 已注册工具重名 → 抛契约错误并点名冲突工具', async () => {
    const { ctx, host } = await createHostWithRealTools()
    ctx.tools.register(makeTool('core-tool'))

    let caught: unknown
    try {
      host.install(makePack({ tools: () => [makeTool('core-tool')], toolNames: ['core-tool'] }))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DomainPackValidationError)
    expect((caught as Error).message).toContain('core-tool')
    expect(host.active).toBeUndefined()
    // 原有 core 工具未被破坏。
    expect(ctx.tools.get('core-tool')).toBeDefined()
  })

  it('注册中途失败 → 回滚已注册工具、不留 active', async () => {
    const { ctx, host } = await createHostWithRealTools()
    // 第二个工具的 output.schema 超出 dsh-tools 支持子集：core 形状校验放行，真注册时被拒。
    const broken = makeTool('broken-tool', {
      output: { schema: { type: 'bogus' }, render: () => [] },
    })
    const pack = makePack({
      tools: () => [makeTool('alpha-lookup'), broken],
      toolNames: ['alpha-lookup', 'broken-tool'],
    })

    let caught: unknown
    try {
      host.install(pack)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DomainPackValidationError)
    expect((caught as Error).field).toBe('tools')
    expect((caught as Error).message).toContain('broken-tool')
    expect((caught as Error).message).toContain('已回滚')
    expect((caught as Error).message).toContain('alpha-lookup')
    expect(ctx.tools.get('alpha-lookup'), '已注册的工具必须回滚').toBeUndefined()
    expect(host.active).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 6. 幂等 dispose
// ---------------------------------------------------------------------------
describe('幂等 dispose', () => {
  it('两次 dispose 不抛错、第二次无副作用、active 清空、可重装', () => {
    const { host } = createHost()
    const dispose = host.install(makePack())
    expect(host.active?.id).toBe('alpha-domain')

    expect(() => dispose()).not.toThrow()
    expect(host.active).toBeUndefined()

    // 第二次调用：不抛错，且不会影响后续安装。
    expect(() => dispose()).not.toThrow()
    expect(host.active).toBeUndefined()

    const disposeAgain = host.install(makePack({ version: '2.0.0' }))
    expect(host.active?.id).toBe('alpha-domain')
    expect(host.active?.version).toBe('2.0.0')
    disposeAgain()
    expect(host.active).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 6. 逆序拆卸（LIFO）
// ---------------------------------------------------------------------------
describe('逆序拆卸', () => {
  it('当前 install 登记 active + tools 两步，dispose 后均失效', () => {
    const { host } = createHost()
    const dispose = host.install(makePack())
    dispose()
    expect(host.active).toBeUndefined()
  })

  it('TeardownRegistry 按 TEARDOWN_ORDER 正序、同阶段逆序（LIFO）执行', () => {
    const order: string[] = []
    const registry = new TeardownRegistry()
    const add = (stage: Parameters<TeardownRegistry['add']>[0], label: string) =>
      registry.add(stage, label, () => order.push(label))

    // 故意打乱登记顺序，验证执行顺序由阶段表 + LIFO 决定。
    add('active', 'active-1')
    add('tools', 'tools-1')
    add('scheduler', 'scheduler-1')
    add('persona', 'persona-1')
    add('tools', 'tools-2')
    add('firmwareSkills', 'firmware-1')
    add('skillProvider', 'skillProvider-1')
    add('active', 'active-2')

    registry.dispose()

    expect(TEARDOWN_ORDER).toEqual([
      'scheduler',
      'tools',
      'persona',
      'firmwareSkills',
      'skillProvider',
      'active',
    ])
    expect(order).toEqual([
      'scheduler-1',
      'tools-2',
      'tools-1',
      'persona-1',
      'firmware-1',
      'skillProvider-1',
      'active-2',
      'active-1',
    ])
  })

  it('TeardownRegistry.dispose 幂等且单步失败不阻断后续', () => {
    const order: string[] = []
    const errors: string[] = []
    const registry = new TeardownRegistry({ onError: (_e, label) => errors.push(label) })
    registry.add('active', 'a', () => order.push('a'))
    registry.add('tools', 'boom', () => { throw new Error('boom') })
    registry.add('scheduler', 's', () => order.push('s'))

    expect(() => registry.dispose()).not.toThrow()
    expect(order).toEqual(['s', 'a'])
    expect(errors).toEqual(['tools:boom'])

    expect(() => registry.dispose()).not.toThrow()
    expect(order).toEqual(['s', 'a'])
    expect(errors).toEqual(['tools:boom'])
  })
})

// ---------------------------------------------------------------------------
// 7. git 降级
// ---------------------------------------------------------------------------
describe('git 降级', () => {
  it('PATH 置空后 install 成功，commit() 返回 degraded:true 且 reason 非空', async () => {
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      const { host } = createHost()
      expect(() => host.install(makePack())).not.toThrow()
      expect(host.active?.id).toBe('alpha-domain')

      const result = await host.active!.runtime.commit.commit({ message: 'test' })
      expect(result.degraded).toBe(true)
      expect(typeof result.reason).toBe('string')
      expect(result.reason!.length).toBeGreaterThan(0)
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('git 可用时 commit() 抛 NotImplementedError（Task-05 占位）', async () => {
    const available = createDefaultCommitPort().isAvailable()
    if (!available) {
      // 宿主机无 git 时该分支无法验证，直接跳过以免误判。
      return
    }
    const { host } = createHost()
    host.install(makePack())
    await expect(
      host.active!.runtime.commit.commit({ message: 'test' }),
    ).rejects.toBeInstanceOf(NotImplementedError)
  })
})

// ---------------------------------------------------------------------------
// 8. 基础设施降级：无 logger
// ---------------------------------------------------------------------------
describe('基础设施降级', () => {
  it('ctx 无 logger / tools 时 install 不抛错（warn 后继续）', () => {
    // 最小 mock ctx：只提供 Service 注册所需的 reflect.provide。
    const mockCtx: any = {
      reflect: { provide: () => () => {} },
      get: () => undefined,
    }
    const host = new AgentHost(mockCtx)
    expect(() => host.install(makePack())).not.toThrow()
    expect(host.active?.id).toBe('alpha-domain')
    expect(typeof host.active!.runtime.logger.warn).toBe('function')
    host.active!.disposable()
    expect(host.active).toBeUndefined()
  })
})

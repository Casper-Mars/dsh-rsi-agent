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
import { apply } from '../src/plugin'
import {
  AgentHost,
  NotImplementedError,
  TEARDOWN_ORDER,
  TeardownRegistry,
  createDefaultCommitPort,
} from '../src/service'
import { DomainPackValidationError, PERSONA_MAX_BYTES } from '../src/validate'
import type { DomainPack } from '../src/types'

/** 合法的基准 pack；反例在此基础上做单点破坏。 */
function makePack(overrides: Partial<DomainPack> = {}): DomainPack {
  return {
    apiVersion: 1,
    id: 'alpha-domain',
    version: '1.2.3',
    displayName: 'Alpha Domain',
    persona: { markdown: () => '# Alpha\n\nYou are alpha.' },
    defaultSessionId: 'session-1',
    skills: {
      evolvable: [{ name: 'seed-skill', markdown: '# seed' }],
      firmware: [{ name: 'firmware-skill', markdown: '# firmware' }],
    },
    assetTypes: [{ name: 'notes', prefix: 'notes/' }],
    scheduler: { timezone: 'Asia/Shanghai' },
    evolutionPolicy: { window: '7d', independentCases: 10, maxIterations: 3 },
    tools: () => [{ name: 'alpha-lookup' }],
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
    ["skill 名 'BadName'", 'skills.evolvable[0].name', (p) => {
      p.skills = { evolvable: [{ name: 'BadName', markdown: '# x' }] }
    }],
    ['两个同名 evolvable', 'skills.evolvable[1].name', (p) => {
      p.skills = {
        evolvable: [
          { name: 'dup-skill', markdown: '# a' },
          { name: 'dup-skill', markdown: '# b' },
        ],
      }
    }],
    ['evolvable 与 firmware 重名', 'skills.firmware[0].name', (p) => {
      p.skills = {
        evolvable: [{ name: 'same-skill', markdown: '# a' }],
        firmware: [{ name: 'same-skill', markdown: '# b' }],
      }
    }],
    ["prefix '../x/'", 'assetTypes[0].prefix', (p) => { p.assetTypes = [{ name: 'x', prefix: '../x/' }] }],
    ["prefix '.git/x/'", 'assetTypes[0].prefix', (p) => { p.assetTypes = [{ name: 'x', prefix: '.git/x/' }] }],
    ["prefix 'x'（缺尾斜杠）", 'assetTypes[0].prefix', (p) => { p.assetTypes = [{ name: 'x', prefix: 'x' }] }],
    ["prefix '/abs/'", 'assetTypes[0].prefix', (p) => { p.assetTypes = [{ name: 'x', prefix: '/abs/' }] }],
    ['prefix 含反斜杠', 'assetTypes[0].prefix', (p) => { p.assetTypes = [{ name: 'x', prefix: 'a\\b/' }] }],
    ["timezone='Not/AZone'", 'scheduler.timezone', (p) => { p.scheduler = { timezone: 'Not/AZone' } }],
    ['evolutionPolicy.independentCases=0', 'evolutionPolicy.independentCases', (p) => {
      p.evolutionPolicy = { window: '7d', independentCases: 0 }
    }],
    ['evolutionPolicy.window 为空', 'evolutionPolicy.window', (p) => {
      p.evolutionPolicy = { window: '  ', independentCases: 3 }
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
      tools: () => [{ name: 'alpha-lookup' }, { name: 'extra-tool' }],
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
      tools: () => [{ name: 'alpha-lookup' }],
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
      tools: () => [{ name: 'alpha-lookup' }],
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
// 5. 幂等 dispose
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
  it('当前 install 只登记 active 一步，dispose 仅清空 active', () => {
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

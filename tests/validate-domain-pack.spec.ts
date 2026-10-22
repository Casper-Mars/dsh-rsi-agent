/**
 * `validateDomainPack` / `runAssetsBootstrap` 的补充用例（Task-14 覆盖审计补齐）。
 *
 * 审计结论：`tests/agent-host.contract.spec.ts` 与 `tests/assets-writer.spec.ts`
 * 已覆盖绝大多数契约反例；本文件只补四个此前未覆盖或未显式断言的点：
 *   1. 全字段 happy path（确认「全字段合法」这条基线本身没有回归）；
 *   2. `apiVersion` 的类型严格性（1.5 / '1' / 0 都必须拒绝，不能只测 2）；
 *   3. 工具名与 core 重名的**谓词**形态（`hasTool`，而不只是 `toolNames` 集合）；
 *   4. `assets.bootstrap` 异步错误信息必须含 `bootstrap`（含「普通函数返回
 *      thenable」这条漏网写法），以及字段前缀重叠的边界（`a/` vs `ab/` 不重叠）。
 */
import { describe, expect, it } from 'vitest'
import {
  DomainPackValidationError,
  runAssetsBootstrap,
  validateDomainPack,
} from '../src/validate'
import type { AssetWriter, DomainPack, ToolDefinition } from '../src/types'

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} 测试工具`,
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    output: {
      schema: { type: 'object', properties: { echoed: { type: 'string' } } },
      render: () => [{ type: 'text' as const, text: 'ok' }],
    },
    execute: async () => ({ echoed: 'ok' }),
  } as unknown as ToolDefinition
}

function makePack(overrides: Partial<DomainPack> = {}): DomainPack {
  return {
    apiVersion: 1,
    id: 'alpha-domain',
    version: '1.2.3',
    displayName: 'Alpha Domain',
    persona: { markdown: () => '# Alpha' },
    defaultSessionId: 'session-1',
    assets: { types: [{ name: 'notes', prefix: 'notes/' }] },
    firmwareSkills: [{ name: 'firmware-skill', markdown: '# firmware' }],
    scheduler: { timezone: 'Asia/Shanghai' },
    evolutionPolicy: { window: '7d', independentCases: 10, maxIterations: 3 },
    tools: () => [makeTool('alpha-lookup')],
    toolNames: ['alpha-lookup'],
    ...overrides,
  }
}

function capture(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

function expectField(pack: unknown, field: string, core?: Parameters<typeof validateDomainPack>[1]): DomainPackValidationError {
  const error = capture(() => validateDomainPack(pack, core))
  expect(error, `字段 ${field} 应触发契约错误`).toBeInstanceOf(DomainPackValidationError)
  const typed = error as DomainPackValidationError
  expect(typed.field).toBe(field)
  expect(typed.message).toContain(field)
  return typed
}

/** `runAssetsBootstrap` 只需要 register；其余方法不会被调用。 */
const writerStub = {
  register: () => [],
  list: () => [],
  read: () => '',
} as unknown as AssetWriter

describe('全字段合法基线', () => {
  it('所有字段齐备时校验通过，返回工具快照与人设 Markdown', () => {
    const pack = makePack()
    const validated = validateDomainPack(pack)
    expect(validated.pack).toBe(pack)
    expect(validated.personaMarkdown).toBe('# Alpha')
    expect(validated.toolNames).toEqual(['alpha-lookup'])
    expect(validated.tools.map((tool) => tool.name)).toEqual(['alpha-lookup'])
  })
})

describe('apiVersion 类型严格性（必须严格等于 1）', () => {
  it.each([
    ['2', 2],
    ['0', 0],
    ['1.5', 1.5],
    ['字符串 "1"', '1'],
    ['null', null],
    ['undefined', undefined],
  ])('%s → 拒绝且字段为 apiVersion', (_label, value) => {
    expectField(makePack({ apiVersion: value as unknown as number }), 'apiVersion')
  })
})

describe('工具名与 core 重名（谓词形态）', () => {
  it('core.hasTool 命中即拒绝，即使 toolNames 集合为空', () => {
    const pack = makePack()
    const error = expectField(pack, 'toolNames', {
      toolNames: [],
      hasTool: (name: string) => name === 'alpha-lookup',
    })
    expect(error.message).toContain('alpha-lookup')
  })

  it('toolNames 重复声明 → 拒绝且点名重复名', () => {
    const pack = makePack({ toolNames: ['alpha-lookup', 'alpha-lookup'] })
    const error = expectField(pack, 'toolNames[1]')
    expect(error.message).toContain('alpha-lookup')
  })
})

describe('资产前缀重叠的边界', () => {
  it('a/ 与 ab/ 按路径段不重叠 → 通过', () => {
    const pack = makePack({
      assets: {
        types: [
          { name: 'alpha', prefix: 'a/' },
          { name: 'ab', prefix: 'ab/' },
        ],
      },
    })
    expect(() => validateDomainPack(pack)).not.toThrow()
  })

  it('a/ 与 a/b/ 重叠（包含关系）→ 拒绝且点名两个类型', () => {
    const pack = makePack({
      assets: {
        types: [
          { name: 'alpha', prefix: 'a/' },
          { name: 'beta', prefix: 'a/b/' },
        ],
      },
    })
    const error = expectField(pack, 'assets.types[1].prefix')
    expect(error.message).toContain('"alpha"')
    expect(error.message).toContain('"beta"')
  })
})

describe('bootstrap 必须同步（错误信息含 bootstrap）', () => {
  it('async 声明 → 契约校验阶段拒绝，field 与 message 均含 bootstrap', () => {
    const pack = makePack({
      assets: {
        types: [{ name: 'notes', prefix: 'notes/' }],
        bootstrap: (async () => {}) as unknown as () => void,
      },
    })
    const error = expectField(pack, 'assets.bootstrap')
    expect(error.message).toContain('bootstrap')
  })

  it('普通函数返回 Promise（thenable 漏网写法）→ runAssetsBootstrap 拒绝，信息含 bootstrap', () => {
    const pack = makePack({
      assets: {
        types: [{ name: 'notes', prefix: 'notes/' }],
        bootstrap: (() => Promise.resolve()) as unknown as () => void,
      },
    })
    const error = capture(() => runAssetsBootstrap(pack, writerStub))
    expect(error).toBeInstanceOf(DomainPackValidationError)
    expect((error as DomainPackValidationError).message).toContain('bootstrap')
    expect((error as DomainPackValidationError).field).toBe('assets.bootstrap')
  })

  it('bootstrap 内部抛错原样透传（不包裹成契约错误）', () => {
    const boom = new Error('domain 自己的原因')
    const pack = makePack({
      assets: {
        types: [{ name: 'notes', prefix: 'notes/' }],
        bootstrap: () => {
          throw boom
        },
      },
    })
    expect(capture(() => runAssetsBootstrap(pack, writerStub))).toBe(boom)
  })
})

describe('logging 字段路径', () => {
  it('非法 level → 字段为 logging.level', () => {
    const pack = makePack({
      logging: { level: 'verbose' as unknown as 'info' },
    })
    expectField(pack, 'logging.level')
  })
})

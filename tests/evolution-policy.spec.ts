/**
 * 进化策略（§10.2）：默认值固定断言、深合并、非法值点名。
 *
 * 第一条用例刻意用「字面量深比较」锁死默认值：默认策略是产品行为的一部分，
 * 变动必须显式改测试，不能被悄悄改掉。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EVOLUTION_POLICY,
  EvolutionPolicyValidationError,
  evolutionPolicyOverridesFromPack,
  mergeEvolutionPolicy,
} from '../src/evolution/policy'

/** 文档中的默认值（独立字面量，不复用实现常量）。 */
const DOCUMENTED_DEFAULTS = {
  evidence: {
    parameterChange: { window: '20 observations', outOfSample: true },
    methodologyChange: { independentCases: 3 },
  },
  discipline: {
    singleVariable: true,
    preregistration: true,
    throttle: 'one change per review cycle',
    keepNegativeResults: true,
    historyImmutable: true,
  },
}

/** 断言抛 EvolutionPolicyValidationError 且 field / message 均点名。 */
function expectPolicyError(run: () => unknown, field: string): void {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught, '应当抛出 EvolutionPolicyValidationError').toBeInstanceOf(
    EvolutionPolicyValidationError,
  )
  const error = caught as EvolutionPolicyValidationError
  expect(error.field).toBe(field)
  expect(error.message).toContain(field)
}

describe('默认策略', () => {
  it('深比较等于文档默认值（固定断言，防止被悄悄改动）', () => {
    expect(DEFAULT_EVOLUTION_POLICY).toStrictEqual(DOCUMENTED_DEFAULTS)
  })

  it('逐层冻结（默认值不可被调用方改写）', () => {
    expect(Object.isFrozen(DEFAULT_EVOLUTION_POLICY)).toBe(true)
    expect(Object.isFrozen(DEFAULT_EVOLUTION_POLICY.evidence)).toBe(true)
    expect(Object.isFrozen(DEFAULT_EVOLUTION_POLICY.evidence?.parameterChange)).toBe(true)
    expect(Object.isFrozen(DEFAULT_EVOLUTION_POLICY.evidence?.methodologyChange)).toBe(true)
    expect(Object.isFrozen(DEFAULT_EVOLUTION_POLICY.discipline)).toBe(true)
  })

  it('未提供领域覆盖时返回默认值', () => {
    expect(mergeEvolutionPolicy()).toStrictEqual(DOCUMENTED_DEFAULTS)
    expect(mergeEvolutionPolicy({})).toStrictEqual(DOCUMENTED_DEFAULTS)
  })
})

describe('领域覆盖（深合并）', () => {
  it('只覆盖 parameterChange.window 时其余字段保持默认值', () => {
    const merged = mergeEvolutionPolicy({
      evidence: { parameterChange: { window: '20 个交易日' } },
    })

    expect(merged.evidence?.parameterChange?.window).toBe('20 个交易日')
    // 同层未覆盖字段
    expect(merged.evidence?.parameterChange?.outOfSample).toBe(true)
    // 兄弟分支未覆盖
    expect(merged.evidence?.methodologyChange).toEqual({ independentCases: 3 })
    // 另一顶层分支未覆盖
    expect(merged.discipline).toEqual(DOCUMENTED_DEFAULTS.discipline)
    // 默认值本身未被改写
    expect(DEFAULT_EVOLUTION_POLICY.evidence?.parameterChange?.window).toBe('20 observations')
  })

  it('只覆盖 discipline 的单字段时其余纪律保持默认值', () => {
    const merged = mergeEvolutionPolicy({ discipline: { throttle: '两轮一次' } })
    expect(merged.discipline).toEqual({
      ...DOCUMENTED_DEFAULTS.discipline,
      throttle: '两轮一次',
    })
  })

  it('notes 在提供时进入结果，未提供时不出现在结果里', () => {
    expect(mergeEvolutionPolicy({ notes: '仅在工作日变更' }).notes).toBe('仅在工作日变更')
    expect('notes' in mergeEvolutionPolicy()).toBe(false)
  })

  it('扁平领域包策略可适配为嵌套覆盖（install 链路）', () => {
    const merged = mergeEvolutionPolicy(
      evolutionPolicyOverridesFromPack({ window: '7d', independentCases: 10 }),
    )
    expect(merged.evidence).toEqual({
      parameterChange: { window: '7d', outOfSample: true },
      methodologyChange: { independentCases: 10 },
    })
    expect(merged.discipline).toEqual(DOCUMENTED_DEFAULTS.discipline)
  })
})

describe('非法策略点名', () => {
  it('independentCases = 0 → 点名 evidence.methodologyChange.independentCases', () => {
    expectPolicyError(
      () => mergeEvolutionPolicy({ evidence: { methodologyChange: { independentCases: 0 } } }),
      'evidence.methodologyChange.independentCases',
    )
  })

  it('window = "" → 点名 evidence.parameterChange.window', () => {
    expectPolicyError(
      () => mergeEvolutionPolicy({ evidence: { parameterChange: { window: '' } } }),
      'evidence.parameterChange.window',
    )
  })

  it('notes = 123 → 点名 notes', () => {
    expectPolicyError(
      () => mergeEvolutionPolicy({ notes: 123 as unknown as string }),
      'notes',
    )
  })

  it('outOfSample 非布尔 → 点名 evidence.parameterChange.outOfSample', () => {
    expectPolicyError(
      () =>
        mergeEvolutionPolicy({
          evidence: { parameterChange: { window: '7d', outOfSample: 'yes' as unknown as boolean } },
        }),
      'evidence.parameterChange.outOfSample',
    )
  })

  it('discipline 非对象 → 点名 discipline', () => {
    expectPolicyError(
      () => mergeEvolutionPolicy({ discipline: [] as unknown as never }),
      'discipline',
    )
  })
})

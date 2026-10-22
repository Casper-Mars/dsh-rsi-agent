/**
 * Task-12 · 日志级别（§13.1）与 `DomainPack.logging` 可选契约。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOG_LEVEL,
  LEVEL_RANK,
  LOG_LEVELS,
  isLogLevel,
  resolveLevel,
  shouldEmit,
} from '../src/log/level'
import { DomainPackValidationError, validateDomainPack } from '../src/validate'
import type { DomainPack } from '../src/types'

const EMPTY_ENV: NodeJS.ProcessEnv = {}

describe('log/level · 严重度与阈值', () => {
  it('LEVEL_RANK：error < warn < info < debug', () => {
    expect(LEVEL_RANK.error).toBeLessThan(LEVEL_RANK.warn)
    expect(LEVEL_RANK.warn).toBeLessThan(LEVEL_RANK.info)
    expect(LEVEL_RANK.info).toBeLessThan(LEVEL_RANK.debug)
  })

  it('LOG_LEVELS 覆盖四个级别且顺序稳定', () => {
    expect(LOG_LEVELS).toEqual(['error', 'warn', 'info', 'debug'])
  })

  it('shouldEmit：阈值是「最啰嗦的允许级别」', () => {
    expect(shouldEmit('error', 'error')).toBe(true)
    expect(shouldEmit('warn', 'error')).toBe(false)
    expect(shouldEmit('info', 'info')).toBe(true)
    expect(shouldEmit('debug', 'info')).toBe(false)
    expect(shouldEmit('debug', 'debug')).toBe(true)
  })

  it('isLogLevel 拒绝非枚举值', () => {
    expect(isLogLevel('info')).toBe(true)
    expect(isLogLevel('INFO')).toBe(false)
    expect(isLogLevel('trace')).toBe(false)
    expect(isLogLevel(undefined)).toBe(false)
    expect(isLogLevel(1)).toBe(false)
  })
})

describe('log/level · resolveLevel', () => {
  it('缺省 → info', () => {
    expect(resolveLevel(undefined, EMPTY_ENV)).toBe(DEFAULT_LOG_LEVEL)
  })

  it('显式参数优先于环境变量', () => {
    expect(resolveLevel('warn', { DSH_RSI_LOG_LEVEL: 'debug' })).toBe('warn')
  })

  it('无显式参数时读 DSH_RSI_LOG_LEVEL', () => {
    expect(resolveLevel(undefined, { DSH_RSI_LOG_LEVEL: 'debug' })).toBe('debug')
  })

  it('非法值回落默认（不抛错）', () => {
    expect(resolveLevel('verbose', { DSH_RSI_LOG_LEVEL: 'nope' })).toBe('info')
  })
})

function makePack(overrides: Partial<DomainPack> = {}): DomainPack {
  return {
    apiVersion: 1,
    id: 'alpha-domain',
    version: '1.0.0',
    persona: { markdown: () => '# Alpha' },
    defaultSessionId: 'alpha-session',
    assets: { types: [{ name: 'notes', prefix: 'notes/' }] },
    scheduler: { timezone: 'Asia/Shanghai' },
    evolutionPolicy: { window: '7d', independentCases: 3 },
    tools: () => [],
    toolNames: [],
    ...overrides,
  }
}

function expectField(pack: unknown, field: string): void {
  let caught: unknown
  try {
    validateDomainPack(pack)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(DomainPackValidationError)
  expect((caught as DomainPackValidationError).field).toBe(field)
}

describe('DomainPack.logging · 可选字段校验', () => {
  it('缺省合法（不递增 apiVersion）', () => {
    expect(() => validateDomainPack(makePack())).not.toThrow()
  })

  it('完整合法配置通过', () => {
    expect(() =>
      validateDomainPack(
        makePack({
          logging: {
            level: 'debug',
            retentionDays: 7,
            secretKeys: ['nickname'],
            amountKeys: ['nav'],
          },
        }),
      ),
    ).not.toThrow()
  })

  it('未知键忽略（宽松口径）', () => {
    expect(() =>
      validateDomainPack(makePack({ logging: { level: 'warn', unknown: 1 } as never })),
    ).not.toThrow()
  })

  it('非对象 → 错误点名 logging', () => {
    expectField(makePack({ logging: 'debug' as never }), 'logging')
    expectField(makePack({ logging: [] as never }), 'logging')
  })

  it('非法 level → 错误点名 logging.level', () => {
    expectField(makePack({ logging: { level: 'trace' as never } }), 'logging.level')
    expectField(makePack({ logging: { level: 3 as never } }), 'logging.level')
  })

  it('retentionDays 非正整数 → 错误点名 logging.retentionDays', () => {
    expectField(makePack({ logging: { retentionDays: 0 } }), 'logging.retentionDays')
    expectField(makePack({ logging: { retentionDays: 1.5 } }), 'logging.retentionDays')
    expectField(makePack({ logging: { retentionDays: Number.NaN } }), 'logging.retentionDays')
    expectField(
      makePack({ logging: { retentionDays: '30' as never } }),
      'logging.retentionDays',
    )
  })

  it('secretKeys / amountKeys 必须是字符串数组', () => {
    expectField(makePack({ logging: { secretKeys: 'token' as never } }), 'logging.secretKeys')
    expectField(makePack({ logging: { secretKeys: [1] as never } }), 'logging.secretKeys[0]')
    expectField(makePack({ logging: { amountKeys: [''] as never } }), 'logging.amountKeys[0]')
  })
})

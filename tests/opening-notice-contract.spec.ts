/**
 * Task-09 · 契约：`DomainPack.openingNotice` 可选字段。
 *
 * 规则：非空字符串、合法 UTF-8、≤ 4096 字节；缺省合法。
 */
import { describe, expect, it } from 'vitest'
import { DomainPackValidationError, OPENING_NOTICE_MAX_BYTES, validateDomainPack } from '../src/validate'
import type { DomainPack } from '../src/types'

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

describe('openingNotice 契约', () => {
  it('缺省合法（可选字段）', () => {
    expect(() => validateDomainPack(makePack())).not.toThrow()
  })

  it('非空字符串合法', () => {
    expect(() =>
      validateDomainPack(makePack({ openingNotice: '欢迎使用本领域，请先说明你的目标。' })),
    ).not.toThrow()
  })

  it('空字符串 → 错误点名字段 openingNotice', () => {
    expectField(makePack({ openingNotice: '' }), 'openingNotice')
  })

  it('纯空白字符串 → 错误点名字段 openingNotice', () => {
    expectField(makePack({ openingNotice: '   \n\t ' }), 'openingNotice')
  })

  it('非字符串（number / null / object）→ 错误点名字段 openingNotice', () => {
    expectField(makePack({ openingNotice: 42 as never }), 'openingNotice')
    expectField(makePack({ openingNotice: null as never }), 'openingNotice')
    expectField(makePack({ openingNotice: { text: 'x' } as never }), 'openingNotice')
  })

  it('恰好 4096 字节时通过（字节口径边界）', () => {
    const boundary = 'a'.repeat(OPENING_NOTICE_MAX_BYTES)
    expect(Buffer.byteLength(boundary, 'utf8')).toBe(4096)
    expect(() => validateDomainPack(makePack({ openingNotice: boundary }))).not.toThrow()
  })

  it('4097 字节 → 错误点名 openingNotice', () => {
    const tooLong = 'a'.repeat(OPENING_NOTICE_MAX_BYTES + 1)
    expectField(makePack({ openingNotice: tooLong }), 'openingNotice')
  })

  it('中文按 UTF-8 字节数计算（1366 个汉字 = 4098 字节 → 拒绝）', () => {
    const tooLong = '中'.repeat(1366)
    expect(Buffer.byteLength(tooLong, 'utf8')).toBe(4098)
    expectField(makePack({ openingNotice: tooLong }), 'openingNotice')
  })

  it('孤立代理项（非法 UTF-8）→ 错误点名 openingNotice', () => {
    expectField(makePack({ openingNotice: '\uD800' }), 'openingNotice')
  })
})

/**
 * 模板渲染的边界用例（Task-14 覆盖审计补齐）。
 *
 * 现有 `tests/evolution-template.spec.ts` 已覆盖：白名单 6 项、未知变量、
 * undefined、不二次渲染。本文件只补审计表里的「未闭合 `{{`」与值类型边界：
 *   1. 未闭合 `{{` 不是占位符 → 原样保留（不抛错、不吞文本）；
 *   2. 未闭合片段之后仍有合法占位符 → 后者正常渲染，前者保持字面量；
 *   3. 孤立 `}}`、嵌套 `{{` 的花括号识别边界；
 *   4. 白名单变量传 null / 对象 / 布尔 → 明确抛错（不静默 String() 化）。
 */
import { describe, expect, it } from 'vitest'
import { TemplateRenderError, renderTemplate } from '../src/evolution/template'

describe('未闭合 {{ 保持字面量', () => {
  it('`{{ domain.id` 不构成占位符 → 原样返回，不抛错', () => {
    expect(renderTemplate('前缀 {{ domain.id 后缀', { 'domain.id': 'alpha' })).toBe(
      '前缀 {{ domain.id 后缀',
    )
  })

  it('未闭合片段之后的合法占位符仍正常渲染', () => {
    expect(renderTemplate('{{ broken {{ domain.id }}', { 'domain.id': 'alpha' })).toBe(
      '{{ broken alpha',
    )
  })

  it('孤立 `}}` 不构成占位符 → 原样保留', () => {
    expect(renderTemplate('a }} b', {})).toBe('a }} b')
  })

  it('连续三花括号 `{{{ domain.id }}}` → 中间占位符被渲染，外层括号保留', () => {
    // 正则从左扫描：`{{{` 处的匹配失败（`[^{}]*?` 不能跨 `{`），
    // 引擎前进一位后命中 `{{ domain.id }}`，结果外层各留一个花括号。
    expect(renderTemplate('{{{ domain.id }}}', { 'domain.id': 'alpha' })).toBe('{alpha}')
  })

  it('多字节文本与未闭合片段混排不产生替换字符', () => {
    const output = renderTemplate('中文 {{未闭合', {})
    expect(output).toBe('中文 {{未闭合')
    expect(output).not.toContain('\uFFFD')
  })
})

describe('值类型边界', () => {
  it('null → 视为未提供值（与 undefined 同口径）', () => {
    expect(() =>
      renderTemplate('{{ policy.notes }}', { 'policy.notes': null as unknown as string }),
    ).toThrow(TemplateRenderError)
  })

  it('对象值 → 抛错并说明只接受字符串 / 数字', () => {
    let caught: unknown
    try {
      renderTemplate('{{ assets }}', { assets: { a: 1 } as unknown as string })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TemplateRenderError)
    expect((caught as TemplateRenderError).message).toContain('字符串或数字')
  })

  it('布尔值 → 抛错（不隐式 String(true)）', () => {
    expect(() => renderTemplate('{{ assets }}', { assets: true as unknown as string })).toThrow(
      TemplateRenderError,
    )
  })

  it('数字 0 是合法值（不被当作 falsy 丢弃）', () => {
    expect(renderTemplate('{{ assets }}', { assets: 0 })).toBe('0')
  })

  it('空字符串是合法值（显式值，不触发未提供错误）', () => {
    expect(renderTemplate('[{{ assets }}]', { assets: '' })).toBe('[]')
  })
})

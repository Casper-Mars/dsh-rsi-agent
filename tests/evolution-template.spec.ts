/**
 * 模板渲染（§10.3）：白名单、未知变量点名、不二次渲染、undefined 视为未知。
 */
import { describe, expect, it } from 'vitest'
import {
  TEMPLATE_VARIABLES,
  TemplateRenderError,
  renderTemplate,
  type TemplateVars,
} from '../src/evolution/template'

const FULL_VARS: TemplateVars = {
  'domain.id': 'alpha',
  'domain.displayName': 'Alpha 领域',
  assets: '- `notes`：`notes/`',
  'policy.evidence.parameterChange.window': '20 个交易日',
  'policy.evidence.methodologyChange.independentCases': 3,
  'policy.notes': '仅在工作日变更',
}

function expectTemplateError(template: string, vars: TemplateVars, variable: string): void {
  let caught: unknown
  try {
    renderTemplate(template, vars)
  } catch (error) {
    caught = error
  }
  expect(caught, '应当抛出 TemplateRenderError').toBeInstanceOf(TemplateRenderError)
  const error = caught as TemplateRenderError
  expect(error.variable).toBe(variable)
  // 错误信息必须原样包含变量名，便于定位模板里的错字。
  expect(error.message).toContain(variable)
}

describe('白名单渲染', () => {
  it('6 个白名单变量全部渲染成功（含两侧空格的写法）', () => {
    const output = renderTemplate(
      [
        '{{domain.id}}',
        '{{ domain.displayName }}',
        '{{  assets  }}',
        '{{ policy.evidence.parameterChange.window }}',
        '{{policy.evidence.methodologyChange.independentCases}}',
        '{{ policy.notes }}',
      ].join('|'),
      FULL_VARS,
    )

    expect(output).toBe(
      'alpha|Alpha 领域|- `notes`：`notes/`|20 个交易日|3|仅在工作日变更',
    )
  })

  it('白名单恰好是固定 6 项', () => {
    expect([...TEMPLATE_VARIABLES]).toEqual([
      'domain.id',
      'domain.displayName',
      'assets',
      'policy.evidence.parameterChange.window',
      'policy.evidence.methodologyChange.independentCases',
      'policy.notes',
    ])
  })

  it('无占位符时原样返回', () => {
    expect(renderTemplate('# 标题\n\n正文 {{ not-a-brace', FULL_VARS)).toBe(
      '# 标题\n\n正文 {{ not-a-brace',
    )
  })
})

describe('未知变量', () => {
  it('{{policy.evidence.foo}} → 抛错且信息含变量名', () => {
    expectTemplateError('前缀 {{policy.evidence.foo}} 后缀', FULL_VARS, 'policy.evidence.foo')
  })

  it('{{ process.env.HOME }} → 抛错且信息含变量名', () => {
    expectTemplateError('{{ process.env.HOME }}', FULL_VARS, 'process.env.HOME')
  })

  it('{{domain}} → 抛错且信息含变量名', () => {
    expectTemplateError('{{domain}}', FULL_VARS, 'domain')
  })

  it('空占位符 {{}} → 抛错（变量名为空串）', () => {
    expectTemplateError('{{}}', FULL_VARS, '')
  })
})

describe('不二次渲染', () => {
  it('变量值里含 {{domain.id}} 时输出保持原样', () => {
    const output = renderTemplate('A={{ domain.id }}', {
      'domain.id': '{{domain.displayName}}',
    })
    expect(output).toBe('A={{domain.displayName}}')
  })

  it('变量值里的未知变量也不会触发校验', () => {
    const output = renderTemplate('{{ policy.notes }}', {
      'policy.notes': '{{ policy.evidence.foo }}',
    })
    expect(output).toBe('{{ policy.evidence.foo }}')
  })
})

describe('undefined 值', () => {
  it('显式 undefined → 视为未知变量抛错（不渲染成空串）', () => {
    expectTemplateError('{{ policy.notes }}', { 'policy.notes': undefined }, 'policy.notes')
  })

  it('未提供的白名单变量同样抛错', () => {
    expectTemplateError('{{ assets }}', {}, 'assets')
  })

  it('数字值按字符串渲染', () => {
    expect(
      renderTemplate('{{ policy.evidence.methodologyChange.independentCases }}', {
        'policy.evidence.methodologyChange.independentCases': 5,
      }),
    ).toBe('5')
  })
})

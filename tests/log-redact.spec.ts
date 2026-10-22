/**
 * Task-12 · 脱敏（§13.3，风险项「日志脱敏不完整」）。
 *
 * 验收口径：敏感键（含 meta 深层）/ 文本级 `key=value` / 裸令牌 / 长文本截断 /
 * Error 折叠 / 深度与循环护栏 / fail-closed（自身抛错也只落 `[REDACTED]`）。
 */
import { describe, expect, it } from 'vitest'
import {
  CIRCULAR_MARKER,
  DEFAULT_MAX_TEXT_LENGTH,
  MAX_DEPTH_MARKER,
  REDACTED,
  TRUNCATED_SUFFIX,
  isAmountKey,
  isSensitiveKey,
  redactRecord,
  redactText,
} from '../src/log/redact'

function json(value: unknown): string {
  return JSON.stringify(value)
}

describe('redact · 敏感键（结构级）', () => {
  it('基础敏感键全部遮蔽且保留键名', () => {
    const redacted = redactRecord({
      token: 'abc',
      secret: 's',
      password: 'p',
      passwd: 'p',
      Authorization: 'Bearer x',
      cookie: 'c',
      apiKey: 'k1',
      api_key: 'k2',
      accessKey: 'k3',
      privateKey: 'k4',
      credential: 'c2',
      session_key: 'k5',
      bearer: 'b',
    })
    for (const value of Object.values(redacted)) expect(value).toBe(REDACTED)
    expect(Object.keys(redacted)).toContain('api_key')
  })

  it('大小写 / 分隔符无关（子串匹配）', () => {
    expect(redactRecord({ API_TOKEN: 'abc' }).API_TOKEN).toBe(REDACTED)
    expect(redactRecord({ userSecretValue: 'abc' }).userSecretValue).toBe(REDACTED)
  })

  it('领域扩展 secretKeys 与内置词表并集', () => {
    expect(redactRecord({ nickname: 'reach' }, { secretKeys: ['nickname'] }).nickname).toBe(REDACTED)
    expect(redactRecord({ nickname: 'reach' }).nickname).toBe('reach')
  })

  it('金额 / 成本键遮蔽（领域 amountKeys 可扩展）', () => {
    const redacted = redactRecord({
      cost: 1,
      amount: 2,
      price: 3,
      pnl: 4,
      profit: 5,
      balance: 6,
      position: 7,
      equity: 8,
      nav: 9,
    }, { amountKeys: ['nav'] })
    for (const value of Object.values(redacted)) expect(value).toBe(REDACTED)
    expect(isAmountKey('costPrice')).toBe(true)
    expect(isSensitiveKey('myApiKey')).toBe(true)
  })

  it('meta 深层同样生效（含数组内对象）', () => {
    const redacted = redactRecord({
      msg: 'hello',
      meta: {
        user: 'u1',
        token: 'abc',
        nested: { apiKey: 'k9', list: [{ password: 'p' }] },
      },
    })
    const text = json(redacted)
    expect(text).not.toContain('abc')
    expect(text).not.toContain('k9')
    expect(text).not.toContain('"p"')
    expect(text).toContain(REDACTED)
  })
})

describe('redact · 文本级', () => {
  it('key=value / key: value，一行多键', () => {
    const text = redactText('login token=abc password: def cost=1,pnl=2')
    expect(text).not.toContain('abc')
    expect(text).not.toContain('def')
    expect(text).toContain(`${REDACTED}`)
  })

  it('URL 查询串中的敏感键被遮蔽且不吞掉后续参数', () => {
    const text = redactText('GET /cb?token=abc&x=1')
    expect(text).not.toContain('abc')
    expect(text).toContain('x=1')
  })

  it('句子前缀不阻碍其后赋值被遮蔽（Error: token=abc）', () => {
    const text = redactText('Error: token=abc')
    expect(text).not.toContain('abc')
  })

  it('Bearer <token> 整体遮蔽', () => {
    const text = redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz')
  })

  it('前缀型裸令牌（sk- / ghp_ / xoxb- / AKIA）', () => {
    const samples = [
      'sk-abcdefghijklmnop',
      'ghp_abcdefghijklmnopqrstuvwxyz012345',
      'xoxb-1234567890-abcdef',
      'AKIAIOSFODNN7EXAMPLE',
    ]
    for (const sample of samples) {
      const text = redactText(`key material ${sample} end`)
      expect(text, sample).not.toContain(sample)
      expect(text).toContain(REDACTED)
    }
  })

  it('普通文本不误伤（无敏感键 / 无令牌形态）', () => {
    const text = 'task-based risk-driven workflow finished'
    expect(redactText(text)).toBe(text)
  })
})

describe('redact · 长文本 / Error / 护栏 / fail-closed', () => {
  it(`超过 ${DEFAULT_MAX_TEXT_LENGTH} 字符 → 截断 + 后缀`, () => {
    const long = 'a'.repeat(DEFAULT_MAX_TEXT_LENGTH + 10)
    const text = redactText(long)
    expect(text.endsWith(TRUNCATED_SUFFIX)).toBe(true)
    expect(text.length).toBe(DEFAULT_MAX_TEXT_LENGTH + TRUNCATED_SUFFIX.length)
  })

  it('任意键的字符串值都受长文本预算约束', () => {
    const long = 'b'.repeat(DEFAULT_MAX_TEXT_LENGTH + 1)
    const redacted = redactRecord({ whateverKey: long })
    expect(typeof redacted.whateverKey).toBe('string')
    expect((redacted.whateverKey as string).endsWith(TRUNCATED_SUFFIX)).toBe(true)
  })

  it('Error → { name, message, stack: 前 10 行 } 且文本级脱敏', () => {
    const stack = ['Error: token=abc', ...Array.from({ length: 20 }, (_, i) => `    at fn${i}`)]
    const error = new Error('token=abc')
    error.stack = stack.join('\n')
    const redacted = redactRecord({ error })
    const value = redacted.error as Record<string, unknown>
    expect(value.name).toBe('Error')
    expect(String(value.message)).not.toContain('abc')
    expect(String(value.stack).split('\n').length).toBe(10)
    expect(String(value.stack)).not.toContain('abc')
  })

  it('深度上限 6 → 更深层落为标记', () => {
    let node: Record<string, unknown> = { token: 'deep' }
    for (let i = 0; i < 10; i += 1) node = { child: node }
    const redacted = json(redactRecord({ root: node }))
    // 敏感键在任意可达深度都必须被遮蔽；超深部分必须落标记而非明文。
    expect(redacted).not.toContain('deep')
    expect(redacted).toContain(MAX_DEPTH_MARKER)
  })

  it('数组上限 100 → 多余元素折叠', () => {
    const values = Array.from({ length: 150 }, (_, i) => i)
    const redacted = redactRecord({ items: values }).items as unknown[]
    expect(redacted.length).toBe(101)
    expect(redacted[100]).toBe('[+50 more]')
  })

  it('循环引用 → 标记，不抛错', () => {
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop
    const redacted = redactRecord({ loop })
    expect(json(redacted)).toContain(CIRCULAR_MARKER)
  })

  it('fail-closed：取值抛错的字段替换为 [REDACTED]（不外抛、不放行）', () => {
    const evil = {
      ok: 'fine',
      get secret() {
        throw new Error('boom')
      },
    }
    const redacted = redactRecord({ evil })
    expect((redacted.evil as Record<string, unknown>).secret).toBe(REDACTED)
    expect((redacted.evil as Record<string, unknown>).ok).toBe('fine')
  })
})

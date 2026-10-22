/**
 * Task-12 复验（第二轮）—— Tester 独立用例，仅覆盖本轮三个修复点 + 误伤检查。
 * 不引用 zz-task12-independent.spec.ts 的任何断言。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlSink } from '../src/log/exporter.js'
import { REDACTED, TRUNCATED_SUFFIX, redactRecord, redactText } from '../src/log/redact.js'

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function logsDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'task12-rv3-')), 'logs')
}

function fixedNow(iso: string): () => number {
  const ms = Date.parse(iso)
  return () => ms
}

/** 落盘 → 读回 → JSON 反序列化，返回每行 msg（真实 IO 链路）。 */
function roundTrip(iso: string, msg: string): { raw: string; parsed: Record<string, unknown> } {
  const dir = logsDir()
  const sink = createJsonlSink({ logsDir: dir, maxBytes: 0, now: fixedNow(iso), env: {} })
  expect(sink.write({ level: 'info', name: 'rsi-agent', msg })).toBe(true)
  const raw = readFileSync(join(dir, `${iso.slice(0, 10)}.jsonl`), 'utf8')
  const row = JSON.parse(raw.trim()) as Record<string, unknown>
  return { raw, parsed: row }
}

describe('复验A：长文本截断按码点（1999/2000/2001）', () => {
  it('A1 ASCII 边界：1999/2000 原样，2001 截断为 2000 码点 + 后缀', () => {
    const a1999 = redactText('a'.repeat(1999))
    const a2000 = redactText('a'.repeat(2000))
    const a2001 = redactText('a'.repeat(2001))
    expect(a1999).toHaveLength(1999)
    expect(a2000).toHaveLength(2000)
    expect(a2001.endsWith(TRUNCATED_SUFFIX)).toBe(true)
    expect(Array.from(a2001).length).toBe(2000 + Array.from(TRUNCATED_SUFFIX).length)
    console.log('[evidence] A1 lengths =', a1999.length, a2000.length, Array.from(a2001).length)
  })

  it('A2 emoji 正好落在第 2000 个码点（保留完整）', () => {
    const text = 'a'.repeat(1999) + '😀' + 'tail' // 2001 码点
    const out = redactText(text)
    expect(out.endsWith(TRUNCATED_SUFFIX)).toBe(true)
    expect(out.includes('😀')).toBe(true) // 第 2000 个码点被完整保留
    expect(LONE_SURROGATE.test(out)).toBe(false)
    console.log('[evidence] A2 tail =', JSON.stringify(out.slice(-24)))
  })

  it('A3 emoji 落在截断点之后（整颗丢弃，不留半颗）', () => {
    const text = 'a'.repeat(2000) + '😀' + 'tail' // emoji 是第 2001 个码点
    const out = redactText(text)
    expect(out.endsWith(TRUNCATED_SUFFIX)).toBe(true)
    expect(out.includes('😀')).toBe(false)
    expect(LONE_SURROGATE.test(out)).toBe(false)
    const body = out.slice(0, out.length - TRUNCATED_SUFFIX.length)
    expect(body).toHaveLength(2000)
    console.log('[evidence] A3 tail =', JSON.stringify(out.slice(-24)))
  })

  it('A4 落盘 JSON 反序列化后无孤立代理（两种边界各一次）', () => {
    for (const [iso, text] of [
      ['2026-10-10T00:00:00Z', 'a'.repeat(1999) + '😀' + 'tail'],
      ['2026-10-11T00:00:00Z', 'a'.repeat(2000) + '😀' + 'tail'],
      ['2026-10-12T00:00:00Z', '中😀'.repeat(1500)],
    ] as const) {
      const { raw, parsed } = roundTrip(iso, text)
      const msg = String(parsed.msg)
      expect(JSON.parse(raw.trim())).toBeTruthy()
      expect(LONE_SURROGATE.test(msg)).toBe(false)
      expect(LONE_SURROGATE.test(raw)).toBe(false)
      console.log('[evidence] A4', iso.slice(0, 10), 'cps =', Array.from(msg).length, 'truncated =', msg.endsWith(TRUNCATED_SUFFIX))
    }
  })
})

describe('复验B：Symbol 值走文本级脱敏', () => {
  it('B1 Symbol 值本身带 token=abc → 不出现明文', () => {
    const out = redactRecord({ meta: { s: Symbol('token=abc') } })
    const text = JSON.stringify(out)
    expect(text).not.toContain('abc')
    expect(text).toContain(REDACTED)
    console.log('[evidence] B1 =', text)
  })

  it('B2 符号键的敏感值不外泄（键被丢弃或值被遮蔽，均无明文）', () => {
    const input = { meta: { [Symbol('x')]: 'token=abc', keep: 'v' } }
    const out = redactRecord(input)
    const text = JSON.stringify(out)
    expect(text).not.toContain('abc')
    console.log('[evidence] B2 =', text)
  })
})

describe('复验C：全角分隔符 + 中文键', () => {
  it('C1 token：abc / token＝abc 均遮蔽', () => {
    const fullColon = redactText('token：abc')
    const fullEqual = redactText('token＝abc')
    expect(fullColon).not.toContain('abc')
    expect(fullEqual).not.toContain('abc')
    expect(fullColon).toContain(REDACTED)
    expect(fullEqual).toContain(REDACTED)
    console.log('[evidence] C1 =', JSON.stringify([fullColon, fullEqual]))
  })

  it('C2 密码：p@ss 遮蔽', () => {
    const out = redactText('密码：p@ss')
    expect(out).not.toContain('p@ss')
    expect(out).toContain(REDACTED)
    console.log('[evidence] C2 =', JSON.stringify(out))
  })

  it('C3 中文敏感键（密钥/口令/私钥/令牌/凭证）作为对象键均遮蔽', () => {
    const out = redactRecord({
      meta: { 密钥: 'k', 口令: 'p', 私钥: 'sk', 令牌: 'tk', 凭证: 'cred', 普通: 'visible' },
    })
    const meta = out.meta as Record<string, unknown>
    for (const key of ['密钥', '口令', '私钥', '令牌', '凭证']) {
      expect(meta[key], key).toBe(REDACTED)
    }
    expect(meta['普通']).toBe('visible')
    const text = JSON.stringify(out)
    for (const secret of ['"k"', '"p"', '"sk"', '"tk"', '"cred"']) expect(text).not.toContain(secret)
    console.log('[evidence] C3 =', text)
  })
})

describe('复验D：误伤检查（正常中文文本不应被遮蔽）', () => {
  it('D1 句子中的「密码」无分隔符 → 原样保留', () => {
    const sentence = '任务已完成，密码字段说明见文档'
    expect(redactText(sentence)).toBe(sentence)
    expect(redactRecord({ msg: sentence }).msg).toBe(sentence)
  })

  it('D2 普通全角冒号中文句子不被当成赋值', () => {
    const sentence = '注意：任务已完成，稍后复核'
    expect(redactText(sentence)).toBe(sentence)
    console.log('[evidence] D2 =', JSON.stringify(redactText(sentence)))
  })

  it('D3 记录已知过度遮蔽（values/position），仅记录不判失败', () => {
    const out = redactRecord({ meta: { values: [1, 2], position: 3, count: 9 } })
    const meta = out.meta as Record<string, unknown>
    console.log('[known-limitation] values =', JSON.stringify(meta.values), '| position =', JSON.stringify(meta.position), '| count =', meta.count)
    expect(meta.count).toBe(9)
  })
})

/**
 * Task-09 · A：Persona 槽位。
 *
 * 核心语义：**领域人设是补充，不是替代** —— core 常驻在前，领域追加在后。
 *
 * 覆盖：
 *   1. 通用 section 名 / order 固定；
 *   2. 单 section + 动态 text：领域切换不产生重复 section；
 *   3. 未装领域时严格等于 core 原文；装领域后 core + 分隔符 + domain；
 *   4. uninstall 恢复纯 core，且 core 只读一次；错配 packId 的延迟拆卸不会误恢复；
 *   5. 空领域正文不留下孤立分隔符；
 *   6. 每次切换都有含 `packId` 的 info 日志；
 *   7. AgentHost 集成：install 叠加、dispose 恢复，且切换不重建会话。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentHost } from '../src/service'
import {
  CORE_PERSONA_FALLBACK,
  PERSONA_DOMAIN_SEPARATOR,
  PERSONA_SECTION_NAME,
  PERSONA_SECTION_ORDER,
  createPersonaSlot,
  loadCorePersonaMarkdown,
  registerPersonaSection,
  type PromptSectionLike,
  type SystemPromptLike,
} from '../src/prompts/persona'
import type { DomainPack } from '../src/types'

/** 记录 section 的 `systemPrompt` 替身（`section()` 返回幂等注销器）。 */
function fakeSystemPrompt(): { service: SystemPromptLike; sections: PromptSectionLike[] } {
  const sections: PromptSectionLike[] = []
  const service: SystemPromptLike = {
    section(section) {
      sections.push(section)
      let active = true
      return () => {
        if (!active) return
        active = false
        const index = sections.indexOf(section)
        if (index >= 0) sections.splice(index, 1)
      }
    },
  }
  return { service, sections }
}

function makePack(overrides: Partial<DomainPack> = {}): DomainPack {
  return {
    apiVersion: 1,
    id: 'alpha-domain',
    version: '1.0.0',
    displayName: 'Alpha',
    persona: { markdown: () => '# Alpha Persona\n\nAlpha 专属人设。' },
    defaultSessionId: 'alpha-session',
    assets: { types: [{ name: 'notes', prefix: 'notes/' }] },
    scheduler: { timezone: 'Asia/Shanghai' },
    evolutionPolicy: { window: '7d', independentCases: 3 },
    tools: () => [],
    toolNames: [],
    ...overrides,
  }
}

/** 轮询等待（cordis 服务在微任务中上线）。 */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 统计子串出现次数（用于断言分隔符只出现一次）。 */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('A · Persona 槽位', () => {
  it('section 名固定为 rsi-agent:persona，order 固定为 100', () => {
    expect(PERSONA_SECTION_NAME).toBe('rsi-agent:persona')
    expect(PERSONA_SECTION_ORDER).toBe(100)
  })

  it('通用人设文件非空，且包含「不冒充领域专家」的边界声明', () => {
    const markdown = loadCorePersonaMarkdown()
    expect(markdown.length).toBeGreaterThan(0)
    expect(markdown).not.toBe(CORE_PERSONA_FALLBACK)
    expect(markdown).toContain('不冒充任何领域专家')
    expect(markdown).toContain('不承诺具体结果')
    expect(markdown).toContain('不编造专业结论')
  })

  it('D5 · 通用人设不含具体领域词枚举（金融/投资/收益/医疗/法律）', () => {
    const path = fileURLToPath(new URL('../src/prompts/persona.md', import.meta.url))
    const markdown = readFileSync(path, 'utf8')
    expect(markdown).not.toMatch(/金融|投资|收益|医疗|法律/)
    // 口径保留：不冒充领域专家 / 不承诺结果 / 高风险决策建议咨询持证专业人士。
    expect(markdown).toContain('不冒充任何领域专家')
    expect(markdown).toContain('不承诺具体结果')
    expect(markdown).toContain('持证专业人士')
  })

  it('未装领域：text() 严格等于 core 原文（不允许多余分隔符）', () => {
    const slot = createPersonaSlot({ coreMarkdown: () => '# CORE' })
    expect(slot.text()).toBe('# CORE')
    expect(slot.source).toBe('core')
    expect(slot.domainId).toBeUndefined()

    const provider = slot.section().text as () => string
    expect(provider()).toBe('# CORE')
  })

  it('装领域后：core 在前、领域在后，分隔符恰出现一次', () => {
    const slot = createPersonaSlot({ coreMarkdown: () => '# CORE\n\n通用正文。' })
    slot.useDomain('# DOMAIN\n\n领域正文。', 'alpha-domain')

    const text = slot.text()
    expect(text).toContain('# CORE')
    expect(text).toContain('# DOMAIN')
    expect(text.indexOf('# CORE')).toBeLessThan(text.indexOf('# DOMAIN'))
    expect(countOccurrences(text, PERSONA_DOMAIN_SEPARATOR)).toBe(1)
    expect(text).toBe('# CORE\n\n通用正文。' + PERSONA_DOMAIN_SEPARATOR + '# DOMAIN\n\n领域正文。')
    expect(slot.source).toBe('domain')
    expect(slot.domainId).toBe('alpha-domain')
  })

  it('section 使用动态 text provider：同一个 section 对象在切换后返回组合文案', () => {
    const slot = createPersonaSlot({ coreMarkdown: () => '# CORE' })
    const section = slot.section()
    expect(section.name).toBe(PERSONA_SECTION_NAME)
    expect(section.order).toBe(PERSONA_SECTION_ORDER)
    expect(typeof section.text).toBe('function')

    const provider = section.text as () => string
    expect(provider()).toBe('# CORE')

    slot.useDomain('# DOMAIN', 'alpha-domain')
    expect(provider()).toBe('# CORE' + PERSONA_DOMAIN_SEPARATOR + '# DOMAIN')
    expect(slot.source).toBe('domain')
    expect(slot.domainId).toBe('alpha-domain')

    slot.restore('alpha-domain')
    expect(provider()).toBe('# CORE')
    expect(slot.source).toBe('core')
    expect(slot.domainId).toBeUndefined()
  })

  it('restore 后回到纯 core，且 core 文件只读取一次', () => {
    let reads = 0
    const slot = createPersonaSlot({
      coreMarkdown: () => {
        reads += 1
        return '# CORE'
      },
    })

    expect(slot.text()).toBe('# CORE')
    expect(reads).toBe(1)

    slot.useDomain('# DOMAIN', 'alpha-domain')
    expect(slot.text()).toBe('# CORE' + PERSONA_DOMAIN_SEPARATOR + '# DOMAIN')
    expect(reads).toBe(1)

    expect(slot.restore('alpha-domain')).toBe(true)
    expect(slot.text()).toBe('# CORE')
    expect(reads).toBe(1)
  })

  it('空领域正文不留下孤立分隔符', () => {
    const slot = createPersonaSlot({ coreMarkdown: () => '# CORE' })
    slot.useDomain('', 'empty-pack')
    expect(slot.text()).toBe('# CORE')
    expect(slot.text()).not.toContain(PERSONA_DOMAIN_SEPARATOR)

    slot.useDomain('   \n\n  ', 'blank-pack')
    expect(slot.text()).toBe('# CORE')
    expect(slot.text()).not.toContain(PERSONA_DOMAIN_SEPARATOR)
  })

  it('只注册一个 section：多次领域切换后 section 数量仍为 1', () => {
    const slot = createPersonaSlot({ coreMarkdown: () => '# CORE' })
    const { service, sections } = fakeSystemPrompt()
    const dispose = registerPersonaSection(service, slot)

    expect(sections).toHaveLength(1)
    slot.useDomain('# A', 'pack-a')
    slot.useDomain('# B', 'pack-b')
    slot.restore('pack-b')
    slot.useDomain('# C', 'pack-c')
    expect(sections).toHaveLength(1)
    expect((sections[0].text as () => string)()).toBe(
      '# CORE' + PERSONA_DOMAIN_SEPARATOR + '# C',
    )

    dispose()
    expect(sections).toHaveLength(0)
  })

  it('uninstall 恢复通用人设', () => {
    const slot = createPersonaSlot({ coreMarkdown: () => '# CORE' })
    slot.useDomain('# DOMAIN', 'alpha-domain')
    expect(slot.text()).toBe('# CORE' + PERSONA_DOMAIN_SEPARATOR + '# DOMAIN')

    expect(slot.restore('alpha-domain')).toBe(true)
    expect(slot.text()).toBe('# CORE')
    expect(slot.source).toBe('core')
  })

  it('错配 packId 的延迟拆卸不会误恢复新人设', () => {
    const slot = createPersonaSlot({ coreMarkdown: () => '# CORE' })
    slot.useDomain('# NEW', 'new-pack')

    expect(slot.restore('old-pack')).toBe(false)
    expect(slot.text()).toBe('# CORE' + PERSONA_DOMAIN_SEPARATOR + '# NEW')
    expect(slot.domainId).toBe('new-pack')
    expect(slot.source).toBe('domain')
  })

  it('切换与恢复都记 info，且 meta 携带 packId', () => {
    const logs: Array<{ message: string; meta?: unknown }> = []
    const slot = createPersonaSlot({
      coreMarkdown: () => '# CORE',
      logger: {
        info: (message, meta) => logs.push({ message, meta }),
      },
    })

    slot.useDomain('# DOMAIN', 'alpha-domain')
    slot.restore('alpha-domain')

    expect(logs).toHaveLength(2)
    expect(logs[0].message).toContain('叠加领域人设')
    expect(logs[0].message).toContain('core + domain')
    expect(logs[0].meta).toEqual({ packId: 'alpha-domain' })
    expect(logs[1].message).toContain('已恢复为通用人设')
    expect(logs[1].meta).toEqual({ packId: 'alpha-domain' })
  })

  it('AgentHost 构造即注册唯一通用 section', async () => {
    const ctx = new Context()
    const { service, sections } = fakeSystemPrompt()
    ctx.provide('systemPrompt', service as never)

    new AgentHost(ctx)
    await waitFor(() => sections.length === 1)

    expect(sections).toHaveLength(1)
    expect(sections[0].name).toBe(PERSONA_SECTION_NAME)
    expect(sections[0].order).toBe(PERSONA_SECTION_ORDER)
    expect((sections[0].text as () => string)()).toContain('递归自我改进')
  })

  it('AgentHost install 后内容为 core + 领域，dispose 后恢复纯 core，且无重复 section', async () => {
    const ctx = new Context()
    const { service, sections } = fakeSystemPrompt()
    ctx.provide('systemPrompt', service as never)

    const host = new AgentHost(ctx)
    await waitFor(() => sections.length === 1)

    const core = loadCorePersonaMarkdown()
    const pack = makePack()
    const dispose = host.install(pack)
    expect(sections).toHaveLength(1)
    expect((sections[0].text as () => string)()).toBe(
      core + PERSONA_DOMAIN_SEPARATOR + pack.persona.markdown().trim(),
    )

    dispose()
    expect(sections).toHaveLength(1)
    expect((sections[0].text as () => string)()).toBe(core)
  })

  it('persona 切换不重建会话：install 只触发一次 create', async () => {
    const ctx = new Context()
    const { service, sections } = fakeSystemPrompt()
    ctx.provide('systemPrompt', service as never)

    let createCalls = 0
    const sessions = new Map<string, unknown>()
    ctx.provide(
      'agents',
      {
        get: (id: string) => sessions.get(id),
        create: async (options: { sessionId: string }) => {
          createCalls += 1
          const agent = { id: options.sessionId, followup: () => {} }
          sessions.set(options.sessionId, agent)
          return { agent, dispose: async () => {} }
        },
        resume: async () => {
          throw new Error('不应走 resume')
        },
      } as never,
    )
    ctx.provide(
      'sessionPersistence',
      {
        stat: async () => undefined,
        open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }),
      } as never,
    )

    const host = new AgentHost(ctx)
    await waitFor(() => sections.length === 1)

    const dispose = host.install(makePack())
    await waitFor(() => createCalls === 1)

    expect(sections).toHaveLength(1)
    const text = (sections[0].text as () => string)()
    expect(text).toContain('# RSI Agent 通用人设')
    expect(text).toContain('# Alpha Persona')

    // 再等一个事件循环：persona 切换本身不产生任何额外 create。
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(createCalls).toBe(1)

    dispose()
  })
})

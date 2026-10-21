/**
 * 固件 SKILL（§10.1 / §11.3）：文件契约、渲染注册、冲突点名、dispose 逆序注销。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { AgentHost } from '../src/service'
import {
  EVOLUTION_SKILL_NAME,
  FIRMWARE_SKILL_NAMES,
  formatAssetTypes,
  loadFirmwareSkills,
  parseSkillMarkdown,
} from '../src/evolution/skills'
import { DomainPackValidationError } from '../src/validate'
import type { DomainPack, ToolDefinition } from '../src/types'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 最小合法工具（真实注册链路会校验 output 契约）。 */
function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} 测试工具`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render: (_args: unknown, value: unknown) => [
        { type: 'text' as const, text: JSON.stringify(value) },
      ],
    },
    execute: async () => ({ ok: true }),
  } as unknown as ToolDefinition
}

function makePack(overrides: Partial<DomainPack> = {}): DomainPack {
  return {
    apiVersion: 1,
    id: 'alpha-domain',
    version: '1.0.0',
    displayName: 'Alpha 领域',
    persona: { markdown: () => '# Alpha' },
    defaultSessionId: 'session-1',
    skills: { evolvable: [{ name: 'seed-skill', markdown: '# seed' }] },
    assetTypes: [{ name: 'notes', prefix: 'notes/', description: '笔记' }],
    scheduler: { timezone: 'Asia/Shanghai' },
    evolutionPolicy: { window: '7d', independentCases: 10 },
    tools: () => [makeTool('alpha-lookup')],
    toolNames: ['alpha-lookup'],
    ...overrides,
  }
}

/** 最小 skills 服务桩：只实现 `register()` 与返回的 unregister。 */
function createSkillsStub(): {
  table: Map<string, SkillRegistration>
  service: { register(skill: SkillRegistration): () => void }
} {
  const table = new Map<string, SkillRegistration>()
  return {
    table,
    service: {
      register(skill: SkillRegistration): () => void {
        table.set(skill.name, skill)
        return () => {
          table.delete(skill.name)
        }
      },
    },
  }
}

describe('固件 SKILL 文件契约', () => {
  it('三个 SKILL.md 存在，frontmatter 三字段齐全且 name 与目录一致', () => {
    const loaded = loadFirmwareSkills()
    expect(loaded.map((skill) => skill.name)).toEqual([...FIRMWARE_SKILL_NAMES])

    for (const skill of loaded) {
      expect(existsSync(skill.path), `${skill.path} 应存在`).toBe(true)
      expect(path.basename(path.dirname(skill.path))).toBe(skill.name)

      const parsed = parseSkillMarkdown(skill.content, skill.path)
      expect(parsed.frontmatter.name).toBe(skill.name)
      expect(parsed.frontmatter.description.length).toBeGreaterThan(0)
      expect(parsed.frontmatter.whenToUse.length).toBeGreaterThan(0)
      expect(parsed.content.trimStart().startsWith('---')).toBe(false)
    }
  })

  it('rsi-evolution 正文使用模板变量（至少 4 个）', () => {
    const evolution = loadFirmwareSkills().find((skill) => skill.name === EVOLUTION_SKILL_NAME)
    expect(evolution).toBeDefined()
    const body = evolution?.content ?? ''
    for (const variable of [
      '{{policy.evidence.parameterChange.window}}',
      '{{policy.evidence.methodologyChange.independentCases}}',
      '{{domain.displayName}}',
      '{{assets}}',
    ]) {
      expect(body).toContain(variable)
    }
  })

  it('assets/skills/ 下没有这三个固件 SKILL 的副本（本任务不落盘）', () => {
    for (const name of FIRMWARE_SKILL_NAMES) {
      expect(existsSync(path.join(REPO_ROOT, 'assets', 'skills', name))).toBe(false)
    }
  })

  it('formatAssetTypes 输出可读清单', () => {
    expect(formatAssetTypes([])).toContain('未声明')
    expect(formatAssetTypes([{ name: 'notes', prefix: 'notes/', description: '笔记' }])).toBe(
      '- `notes`：`notes/` — 笔记',
    )
  })
})

describe('install / dispose 接线', () => {
  it('install 后注册 3 个固件 skill，dispose 后全部消失', () => {
    const ctx = new Context()
    const { table, service } = createSkillsStub()
    ctx.provide('skills', service as never)

    const host = new AgentHost(ctx)
    const dispose = host.install(makePack())

    expect([...table.keys()].sort()).toEqual([...FIRMWARE_SKILL_NAMES].sort())

    const evolution = table.get(EVOLUTION_SKILL_NAME)
    expect(evolution).toBeDefined()
    // 策略与领域信息已渲染进正文
    expect(evolution?.content).toContain('Alpha 领域')
    expect(evolution?.content).toContain('7d')
    expect(evolution?.content).toContain('至少 10 个相互独立的案例')
    expect(evolution?.content).toContain('- `notes`：`notes/` — 笔记')
    // 注册对象不再含 frontmatter
    expect(evolution?.content.trimStart().startsWith('---')).toBe(false)
    expect(evolution?.source).toBe('runtime')
    expect(evolution?.invocation).toEqual({ modelInvocable: true, userInvocable: true })

    // 另两个固件 SKILL 原样注册（无模板变量残留）
    for (const name of ['skill-authorship', 'task-authorship']) {
      expect(table.has(name)).toBe(true)
      expect(table.get(name)?.content).not.toContain('{{')
    }

    dispose()
    expect(table.size).toBe(0)
    expect(host.active).toBeUndefined()
  })

  it('与领域包已声明 SKILL 重名 → 契约错误并点名，且不留 active', () => {
    const ctx = new Context()
    const { table, service } = createSkillsStub()
    ctx.provide('skills', service as never)

    const host = new AgentHost(ctx)
    let caught: unknown
    try {
      host.install(
        makePack({
          skills: {
            evolvable: [{ name: 'seed-skill', markdown: '# seed' }],
            firmware: [{ name: 'rsi-evolution', markdown: '# 冲突' }],
          },
        }),
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DomainPackValidationError)
    expect((caught as Error).message).toContain('rsi-evolution')
    expect((caught as DomainPackValidationError).field).toBe('skills.firmware')
    expect(table.size).toBe(0)
    expect(host.active).toBeUndefined()
  })

  it('ctx.skills 缺失 → warn 降级，install 仍成功', () => {
    const ctx = new Context()
    const host = new AgentHost(ctx)
    const dispose = host.install(makePack())

    expect(host.active?.id).toBe('alpha-domain')
    dispose()
    expect(host.active).toBeUndefined()
  })
})

/**
 * 固件 SKILL 保留名防线（§10.1 / §11.3 / §6 职责边界）：
 *
 *   1. **primary —— 写盘边界**：领域 bootstrap 注册 `skills/<固件名>/...` 时在
 *      写盘前整批拒绝，错误点名冲突名；文件不落盘、commit 数不变、工作区干净、
 *      install 失败后不留 active / 已注册固件 SKILL。
 *   2. **secondary —— 既有资产比对**：资产目录里**已经**存在固件同名条目时，
 *      固件注册阶段直接抛契约错误（历史数据；没有目录时静默跳过）。
 *   3. **行为不回退**：3 个固件 SKILL 仍静态注册、`assets/skills/` 下无副本；
 *      `rsi-evolution` 渲染结果与改造前逐字符一致（golden 文件）。
 *
 * 全部文件操作在 `mkdtemp` 沙箱内。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { AgentHost } from '../src/service'
import {
  AssetRegisterError,
  createAssetWriter,
  ensureAssetsRepo,
  runGit,
} from '../src/index'
import {
  createFirmwareSkillGuard,
  findFirmwareSkillAssetConflicts,
} from '../src/evolution/firmware-guard'
import {
  EVOLUTION_SKILL_NAME,
  FIRMWARE_SKILL_NAMES,
  formatAssetTypes,
  loadFirmwareSkills,
  parseSkillMarkdown,
} from '../src/evolution/skills'
import { renderTemplate } from '../src/evolution/template'
import { DomainPackValidationError } from '../src/validate'
import type { AssetType, DomainPack, ToolDefinition } from '../src/types'

const FIXTURE = fileURLToPath(new URL('./fixtures/rsi-evolution.rendered.md', import.meta.url))
const DOMAIN_ID = 'alpha-domain'
const TYPES: AssetType[] = [
  { name: 'notes', prefix: 'notes/' },
  { name: 'skill', prefix: 'skills/' },
]

const sandboxes: string[] = []

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rsi-firmware-guard-'))
  sandboxes.push(root)
  return root
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

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
    id: DOMAIN_ID,
    version: '1.0.0',
    displayName: 'Alpha 领域',
    persona: { markdown: () => '# Alpha' },
    defaultSessionId: 'session-1',
    assets: { types: TYPES },
    firmwareSkills: [],
    scheduler: { timezone: 'Asia/Shanghai' },
    evolutionPolicy: { window: '7d', independentCases: 10 },
    tools: () => [makeTool('alpha-lookup')],
    toolNames: ['alpha-lookup'],
    ...overrides,
  }
}

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

/** assets 目录的 commit 数（无 HEAD 时为 0）。 */
function commitCount(assetsDir: string): number {
  const result = runGit(['rev-list', '--count', 'HEAD'], assetsDir)
  return result.ok ? Number(result.stdout.trim()) : 0
}

/** assets 目录下的文件清单（排除 `.git`，按路径排序）。 */
function snapshotFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  const walk = (base: string, prefix: string): void => {
    for (const item of readdirSync(base, { withFileTypes: true })) {
      if (item.name === '.git') continue
      const rel = prefix === '' ? item.name : `${prefix}/${item.name}`
      if (item.isDirectory()) {
        walk(join(base, item.name), rel)
        continue
      }
      files.push(rel)
    }
  }
  walk(dir, '')
  return files.sort()
}

/**
 * 预先初始化资产仓库（与 install 用同一个 home），返回 assetsDir 与基线 commit 数。
 *
 * 提前建仓让「拒绝写入 ⇒ commit 数不变」可以对比同一目录的前后状态，
 * 而不是依赖「首次建仓恰好只产生 1 个提交」这种实现细节。
 */
function prepareAssets(home: string): {
  assetsDir: string
  commitsBefore: number
  filesBefore: string[]
} {
  const assetsDir = ensureAssetsRepo(join(home, DOMAIN_ID)).dir
  return { assetsDir, commitsBefore: commitCount(assetsDir), filesBefore: snapshotFiles(assetsDir) }
}

function skillsDir(home: string): string {
  return join(home, DOMAIN_ID, 'assets', 'skills')
}

/** 执行 install 并返回捕获的错误。 */
function installCatching(host: AgentHost, pack: DomainPack, home: string): unknown {
  try {
    host.install(pack, { home })
    return undefined
  } catch (error) {
    return error
  }
}

describe('primary：写盘边界拦截（首次安装也能抓到）', () => {
  it.each([...FIRMWARE_SKILL_NAMES])(
    'bootstrap 注册 skills/%s/SKILL.md → 失败并点名，文件不落盘、commit 不变',
    (name) => {
      const home = join(sandbox(), `guard-${name}`)
      const { assetsDir, commitsBefore, filesBefore } = prepareAssets(home)
      const { table, service } = createSkillsStub()
      const ctx = new Context()
      ctx.provide('skills', service as never)
      const host = new AgentHost(ctx)

      const caught = installCatching(
        host,
        makePack({
          assets: {
            types: TYPES,
            bootstrap(writer) {
              writer.register({
                type: 'skill',
                path: `skills/${name}/SKILL.md`,
                content: '# 冲突',
              })
            },
          },
        }),
        home,
      )

      expect(caught).toBeInstanceOf(AssetRegisterError)
      expect((caught as Error).message).toContain(name)
      expect((caught as Error).message).toContain('固件 SKILL')

      // 零副作用：无文件、无新 commit、无 active、固件 SKILL 已回滚。
      expect(existsSync(join(assetsDir, 'skills', name, 'SKILL.md'))).toBe(false)
      expect(commitCount(assetsDir)).toBe(commitsBefore)
      expect(snapshotFiles(assetsDir)).toEqual(filesBefore)
      expect(host.active).toBeUndefined()
      expect(table.size).toBe(0)
    },
  )

  it('同一批中一条冲突 → 合法条目也不落盘（整批原子）', () => {
    const home = join(sandbox(), 'guard-batch')
    const { assetsDir, commitsBefore, filesBefore } = prepareAssets(home)
    const host = new AgentHost(new Context())

    const caught = installCatching(
      host,
      makePack({
        assets: {
          types: TYPES,
          bootstrap(writer) {
            writer.register([
              { type: 'skill', path: 'skills/demo-skill/SKILL.md', content: '# demo' },
              {
                type: 'skill',
                path: `skills/${EVOLUTION_SKILL_NAME}/SKILL.md`,
                content: '# 冲突',
              },
            ])
          },
        },
      }),
      home,
    )

    expect(caught).toBeInstanceOf(AssetRegisterError)
    expect((caught as Error).message).toContain(EVOLUTION_SKILL_NAME)
    expect(snapshotFiles(assetsDir)).toEqual(filesBefore)
    expect(commitCount(assetsDir)).toBe(commitsBefore)
  })

  it('非冲突名 skills/demo-skill 正常落盘，3 个固件 SKILL 照常注册', () => {
    const home = join(sandbox(), 'guard-ok')
    const { table, service } = createSkillsStub()
    const ctx = new Context()
    ctx.provide('skills', service as never)
    const host = new AgentHost(ctx)

    const dispose = host.install(
      makePack({
        assets: {
          types: TYPES,
          bootstrap(writer) {
            writer.register({ type: 'skill', path: 'skills/demo-skill/SKILL.md', content: '# demo' })
          },
        },
      }),
      { home },
    )

    expect(readFileSync(join(skillsDir(home), 'demo-skill', 'SKILL.md'), 'utf8')).toBe('# demo')
    expect(readdirSync(skillsDir(home))).toEqual(['demo-skill'])
    expect([...table.keys()].sort()).toEqual([...FIRMWARE_SKILL_NAMES].sort())

    dispose()
    expect(table.size).toBe(0)
  })

  it('大小写变体同样拒绝（APFS 折叠后是同一个目录项）', () => {
    const home = join(sandbox(), 'guard-case')
    const { assetsDir, filesBefore } = prepareAssets(home)
    const host = new AgentHost(new Context())

    const caught = installCatching(
      host,
      makePack({
        assets: {
          types: TYPES,
          bootstrap(writer) {
            writer.register({
              type: 'skill',
              // 根目录保持小写（否则会先被 prefix 白名单拒绝），名称大小写翻转。
              path: 'skills/Rsi-Evolution/SKILL.md',
              content: '# 冲突',
            })
          },
        },
      }),
      home,
    )

    expect(caught).toBeInstanceOf(AssetRegisterError)
    expect((caught as Error).message).toContain(EVOLUTION_SKILL_NAME)
    expect(snapshotFiles(assetsDir)).toEqual(filesBefore)
  })

  it('守卫只作用于 skills/ 根：notes/rsi-evolution.md 正常写入', () => {
    const home = join(sandbox(), 'guard-notes')
    const host = new AgentHost(new Context())
    const dispose = host.install(
      makePack({
        assets: {
          types: TYPES,
          bootstrap(writer) {
            writer.register({
              type: 'notes',
              path: `notes/${EVOLUTION_SKILL_NAME}.md`,
              content: '# note',
            })
          },
        },
      }),
      { home },
    )

    expect(
      readFileSync(join(home, DOMAIN_ID, 'assets', 'notes', `${EVOLUTION_SKILL_NAME}.md`), 'utf8'),
    ).toBe('# note')
    dispose()
  })

  it('createAssetWriter 未注入 guard 时行为不变（hook 是可选的）', () => {
    const assetsDir = ensureAssetsRepo(join(sandbox(), 'no-guard')).dir
    const writer = createAssetWriter({ runtime: { assetsDir }, assetTypes: TYPES })
    const [result] = writer.register({
      type: 'skill',
      path: `skills/${EVOLUTION_SKILL_NAME}/SKILL.md`,
      content: '# 冲突',
    })
    expect(result?.status).toBe('created')
    expect(existsSync(join(assetsDir, 'skills', EVOLUTION_SKILL_NAME, 'SKILL.md'))).toBe(true)
  })
})

describe('primary：守卫单元契约', () => {
  const guard = createFirmwareSkillGuard()

  it.each([...FIRMWARE_SKILL_NAMES])('命中 %s 时返回点名原因', (name) => {
    for (const path of [`skills/${name}/SKILL.md`, `skills/${name}/nested/x.md`, `skills/${name}`]) {
      const reason = guard(path)
      expect(reason, path).toBeTypeOf('string')
      expect(reason).toContain(name)
    }
  })

  it('名称大小写折叠后仍命中（APFS 不区分大小写）', () => {
    expect(guard('skills/Rsi-Evolution/SKILL.md')).toContain(EVOLUTION_SKILL_NAME)
    expect(guard('Skills/rsi-evolution/SKILL.md')).toContain(EVOLUTION_SKILL_NAME)
  })

  it('非 skills 根 / 非固件名 / 层级不足 → 放行', () => {
    expect(guard('notes/rsi-evolution/SKILL.md')).toBeUndefined()
    expect(guard('skills/demo-skill/SKILL.md')).toBeUndefined()
    expect(guard('skills')).toBeUndefined()
    expect(guard('rsi-evolution/SKILL.md')).toBeUndefined()
  })
})

describe('secondary：既有资产比对（历史数据）', () => {
  it.each([...FIRMWARE_SKILL_NAMES])(
    '资产目录已有 skills/%s → 固件注册阶段失败并点名，bootstrap 不执行',
    (name) => {
      const home = join(sandbox(), `existing-${name}`)
      const preexisting = join(skillsDir(home), name)
      mkdirSync(preexisting, { recursive: true })
      writeFileSync(join(preexisting, 'SKILL.md'), '# stale')

      const { table, service } = createSkillsStub()
      const ctx = new Context()
      ctx.provide('skills', service as never)
      const host = new AgentHost(ctx)
      let bootstrapRan = false

      const caught = installCatching(
        host,
        makePack({
          assets: {
            types: TYPES,
            bootstrap() {
              bootstrapRan = true
            },
          },
        }),
        home,
      )

      expect(caught).toBeInstanceOf(DomainPackValidationError)
      expect((caught as DomainPackValidationError).field).toBe('firmwareSkills')
      expect((caught as Error).message).toContain(name)
      expect(bootstrapRan).toBe(false)
      expect(table.size).toBe(0)
      expect(host.active).toBeUndefined()
      // 历史资产不被删除：错误只要求领域作者自行清理。
      expect(existsSync(join(preexisting, 'SKILL.md'))).toBe(true)
    },
  )

  it('资产目录不存在 / 为空 → 静默跳过', () => {
    expect(findFirmwareSkillAssetConflicts(undefined)).toEqual([])
    expect(findFirmwareSkillAssetConflicts(join(sandbox(), 'missing'))).toEqual([])
    const empty = join(sandbox(), 'empty')
    mkdirSync(empty, { recursive: true })
    expect(findFirmwareSkillAssetConflicts(empty)).toEqual([])
  })
})

describe('行为不回退', () => {
  it('3 个固件 SKILL 注册成功，且 assets/skills 下没有它们的副本', () => {
    const home = join(sandbox(), 'firmware-layout')
    const { table, service } = createSkillsStub()
    const ctx = new Context()
    ctx.provide('skills', service as never)
    const host = new AgentHost(ctx)

    const dispose = host.install(makePack(), { home })

    expect(table.size).toBe(FIRMWARE_SKILL_NAMES.length)
    for (const name of FIRMWARE_SKILL_NAMES) {
      expect(table.has(name)).toBe(true)
      expect(existsSync(join(skillsDir(home), name))).toBe(false)
    }
    dispose()
  })

  it('rsi-evolution 渲染结果与改造前 golden 文件逐字符一致', () => {
    const skill = loadFirmwareSkills().find((item) => item.name === EVOLUTION_SKILL_NAME)
    expect(skill).toBeDefined()
    const parsed = parseSkillMarkdown(skill?.content ?? '', skill?.path)
    const rendered = renderTemplate(parsed.content, {
      'domain.id': DOMAIN_ID,
      'domain.displayName': 'Alpha 领域',
      assets: formatAssetTypes(TYPES),
      'policy.evidence.parameterChange.window': '7d',
      'policy.evidence.methodologyChange.independentCases': 10,
      'policy.notes': '（无额外约定）',
    })
    expect(rendered).toBe(readFileSync(FIXTURE, 'utf8'))
    expect(rendered).not.toContain('{{')
  })
})

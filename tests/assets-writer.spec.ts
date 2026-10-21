/**
 * 注册式 DomainPack（方案 v1.2 §6 / §11.1 / §11.2）契约测试。
 *
 * 覆盖：
 *   1. 前缀重叠按**路径段**判定：`a/` 与 `a/b/` install 失败并点名两类型；
 *      `a/` 与 `ab/` 合法；
 *   2. `bootstrap` 返回 thenable → install 失败（错误点名 `bootstrap`）；
 *   3. 领域 `validate` 抛错 → install 失败，**原始错误信息透传**；
 *   4. 批量原子性：一条 spec 非法 ⇒ 同批次合法 spec 也不落盘；写盘阶段失败
 *      ⇒ 本批已写入文件回滚（新建删除 / 覆盖恢复），无 commit、工作区干净；
 *   4.1 大小写折叠唯一：批内仅大小写不同、或与磁盘已有条目仅大小写不同 ⇒
 *      写盘前拒绝并点名两条路径（APFS 大小写不敏感）；
 *   5. seed 幂等 / upsert（内容变化才覆盖）/ 一次 register 一个 commit；
 *   6. 废弃的顶层 `skills` 字段 → 响亮失败（不得静默丢弃种子资产）；
 *   7. `list` / `read` 的路径白名单（`..`、绝对路径）与越界读取拒绝。
 *
 * 全部文件操作都在 `mkdtemp` 沙箱内，不触碰真实 `~/.dsh-rsi-agent`。
 */
import { execFileSync } from 'node:child_process'
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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { AgentHost } from '../src/service'
import {
  AssetPathError,
  AssetRegisterError,
  createAssetWriter,
  ensureAssetsRepo,
  runGit,
} from '../src/index'
import { DomainPackValidationError } from '../src/validate'
import type { AssetSpec, AssetType, DomainPack, ToolDefinition } from '../src/types'

const TYPES: AssetType[] = [
  { name: 'record', prefix: 'records/' },
  { name: 'skill', prefix: 'skills/' },
]

const sandboxes: string[] = []

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rsi-writer-'))
  sandboxes.push(root)
  return root
}

afterEach(() => {
  vi.unstubAllEnvs()
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
    id: 'alpha-domain',
    version: '1.0.0',
    displayName: 'Alpha Domain',
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

/** 已初始化的资产仓库 + writer（跳过 AgentHost，聚焦写入器语义）。 */
function setup(): {
  assetsDir: string
  writer: ReturnType<typeof createAssetWriter>
} {
  const home = join(sandbox(), 'domain')
  const repo = ensureAssetsRepo(home)
  expect(repo.degraded).toBe(false)
  return {
    assetsDir: repo.dir,
    writer: createAssetWriter({ runtime: { assetsDir: repo.dir }, assetTypes: TYPES }),
  }
}

/** `git rev-list --count HEAD`（无 commit 时返回 0）。 */
function commitCount(assetsDir: string): number {
  const result = runGit(['rev-list', '--count', 'HEAD'], assetsDir)
  if (!result.ok) return 0
  return Number(result.stdout.trim())
}

/** 在 assetsDir 内执行 git 并返回去尾空白的 stdout（断言用）。 */
function gitText(args: readonly string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** assets 目录下的文件快照（排除 `.git`，按路径排序）——断言「一个字节都没写」。 */
function snapshotFiles(dir: string): string[] {
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

describe('前缀重叠（按路径段判定）', () => {
  it('a/ 与 a/b/ → install 失败，错误点名两个类型', () => {
    const host = new AgentHost(new Context())
    let caught: unknown
    try {
      host.install(
        makePack({
          assets: {
            types: [
              { name: 'alpha', prefix: 'a/' },
              { name: 'beta', prefix: 'a/b/' },
            ],
          },
        }),
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DomainPackValidationError)
    const error = caught as DomainPackValidationError
    expect(error.field).toBe('assets.types[1].prefix')
    expect(error.message).toContain('alpha')
    expect(error.message).toContain('beta')
    expect(host.active).toBeUndefined()

    // 反向声明同样被拒（包含关系双向）。
    const host2 = new AgentHost(new Context())
    expect(() =>
      host2.install(
        makePack({
          assets: {
            types: [
              { name: 'beta', prefix: 'a/b/' },
              { name: 'alpha', prefix: 'a/' },
            ],
          },
        }),
      ),
    ).toThrow(DomainPackValidationError)
  })

  it('a/ 与 ab/ 不重叠 → install 成功，两个分区都能写入', () => {
    const home = join(sandbox(), 'cases')
    const ctx = new Context()
    const host = new AgentHost(ctx)
    const dispose = host.install(
      makePack({
        assets: {
          types: [
            { name: 'alpha', prefix: 'a/' },
            { name: 'beta', prefix: 'ab/' },
          ],
          bootstrap(writer) {
            writer.register([
              { type: 'alpha', path: 'a/one.md', content: '1' },
              { type: 'beta', path: 'ab/two.md', content: '2' },
            ])
          },
        },
      }),
      { home },
    )

    const assetsDir = host.active!.runtime.assetsDir
    expect(readFileSync(join(assetsDir, 'a', 'one.md'), 'utf8')).toBe('1')
    expect(readFileSync(join(assetsDir, 'ab', 'two.md'), 'utf8')).toBe('2')
    dispose()
  })
})

describe('bootstrap 同步性', () => {
  it('普通函数返回 Promise → install 失败，错误信息含 bootstrap', () => {
    const ctx = new Context()
    const host = new AgentHost(ctx)
    let caught: unknown
    try {
      host.install(
        makePack({
          assets: {
            types: TYPES,
            // 注意：不是 async 函数，validate 无法提前识别，必须在执行后拦截 thenable。
            bootstrap: () => Promise.resolve(),
          } as DomainPack['assets'],
        }),
        { home: join(sandbox(), 'async-bootstrap') },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DomainPackValidationError)
    const error = caught as DomainPackValidationError
    expect(error.field).toBe('assets.bootstrap')
    expect(error.message).toContain('bootstrap')
    expect(host.active).toBeUndefined()
  })

  it('async 声明在契约校验阶段即被拒（不产生任何副作用）', () => {
    const home = join(sandbox(), 'async-decl')
    const host = new AgentHost(new Context())
    expect(() =>
      host.install(
        makePack({
          assets: { types: TYPES, bootstrap: async () => {} },
        }),
        { home },
      ),
    ).toThrow(/bootstrap/)
    expect(host.active).toBeUndefined()
    // 校验早于资产仓库初始化：不应产生 .git（也不会有任何资产写入）。
    expect(existsSync(join(home, 'alpha-domain', 'assets', '.git'))).toBe(false)
  })
})

describe('领域自定义 validate', () => {
  it('抛 new Error("demo 自定义原因") → install 失败且原始信息透传', () => {
    const host = new AgentHost(new Context())
    let caught: unknown
    try {
      host.install(
        makePack({
          assets: {
            types: [
              {
                name: 'record',
                prefix: 'records/',
                validate() {
                  throw new Error('demo 自定义原因')
                },
              },
            ],
            bootstrap(writer) {
              writer.register({ type: 'record', path: 'records/x.md', content: 'x' })
            },
          },
        }),
        { home: join(sandbox(), 'validate-throw') },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    // 原样透传：错误类型与 message 都不被包裹改写。
    expect((caught as Error).message).toBe('demo 自定义原因')
    expect(host.active).toBeUndefined()
  })
})

describe('批量原子性', () => {
  it('一条合法 + 一条非法 → 合法的那条也不落盘', () => {
    const { assetsDir, writer } = setup()

    expect(() =>
      writer.register([
        { type: 'record', path: 'records/ok.md', content: 'ok' },
        { type: 'record', path: 'elsewhere/bad.md', content: 'bad' },
      ]),
    ).toThrow(AssetPathError)

    expect(existsSync(join(assetsDir, 'records', 'ok.md'))).toBe(false)
    expect(existsSync(join(assetsDir, 'elsewhere', 'bad.md'))).toBe(false)
  })

  it('整批拒绝 → assets 下无新增文件、无新增 commit、工作区保持干净', () => {
    const { assetsDir, writer } = setup()
    const before = commitCount(assetsDir)
    const filesBefore = snapshotFiles(assetsDir)

    expect(() =>
      writer.register([
        { type: 'record', path: 'records/legal.md', content: 'legal' },
        { type: 'record', path: 'records/../escape.md', content: 'escape' },
      ]),
    ).toThrow(AssetPathError)

    // 验收 4：非法项让整批短路——合法项同样不落盘、不产生 commit。
    expect(commitCount(assetsDir)).toBe(before)
    expect(snapshotFiles(assetsDir)).toEqual(filesBefore)
    expect(existsSync(join(assetsDir, 'records', 'legal.md'))).toBe(false)
    expect(existsSync(join(assetsDir, 'escape.md'))).toBe(false)
    expect(gitText(['status', '--porcelain'], assetsDir)).toBe('')
  })

  it('写盘阶段失败（父路径是文件）→ 已写入文件回滚、无 commit、工作区干净', () => {
    const { assetsDir, writer } = setup()
    // 预置一个与目录同名的普通文件：`records/blocker/x.md` 会在 mkdir 阶段 EEXIST。
    mkdirSync(join(assetsDir, 'records'), { recursive: true })
    writeFileSync(join(assetsDir, 'records', 'blocker'), 'x')
    execFileSync('git', ['add', '--', 'records/blocker'], { cwd: assetsDir })
    execFileSync('git', ['commit', '-m', 'test: blocker'], { cwd: assetsDir })

    const before = commitCount(assetsDir)
    const filesBefore = snapshotFiles(assetsDir)

    expect(() =>
      writer.register([
        { type: 'record', path: 'records/ok.md', content: 'ok' },
        { type: 'record', path: 'records/blocker/x.md', content: 'x' },
      ]),
    ).toThrow()

    // M1：前一条已落盘的 ok.md 必须被回滚，且不留暂存 / 未跟踪文件。
    expect(commitCount(assetsDir)).toBe(before)
    expect(snapshotFiles(assetsDir)).toEqual(filesBefore)
    expect(existsSync(join(assetsDir, 'records', 'ok.md'))).toBe(false)
    expect(gitText(['status', '--porcelain'], assetsDir)).toBe('')
  })

  it('覆盖已有文件后失败 → 原内容逐字节恢复、无新 commit、工作区干净', () => {
    const { assetsDir, writer } = setup()
    writer.register({ type: 'record', path: 'records/keep.md', content: 'v1' })
    writeFileSync(join(assetsDir, 'records', 'blocker'), 'x')
    execFileSync('git', ['add', '--', 'records/blocker'], { cwd: assetsDir })
    execFileSync('git', ['commit', '-m', 'test: blocker'], { cwd: assetsDir })

    const before = commitCount(assetsDir)

    expect(() =>
      writer.register([
        { type: 'record', path: 'records/keep.md', content: 'v2', mode: 'upsert' },
        { type: 'record', path: 'records/blocker/x.md', content: 'x' },
      ]),
    ).toThrow()

    // 覆盖写已发生，回滚必须恢复原字节（不是删除，也不是留 v2）。
    expect(readFileSync(join(assetsDir, 'records', 'keep.md'), 'utf8')).toBe('v1')
    expect(commitCount(assetsDir)).toBe(before)
    expect(gitText(['status', '--porcelain'], assetsDir)).toBe('')
  })

  it('领域 validate 在写盘前执行：同批次后续 spec 失败不影响前面的判定，但整批不写', () => {
    const { assetsDir } = setup()
    const writer = createAssetWriter({
      runtime: { assetsDir },
      assetTypes: [
        ...TYPES,
        {
          name: 'memo',
          prefix: 'memo/',
          validate(_path, content) {
            if (content.includes('FORBIDDEN')) throw new Error('内容被拒绝')
          },
        },
      ],
    })

    expect(() =>
      writer.register([
        { type: 'record', path: 'records/a.md', content: 'fine' },
        { type: 'memo', path: 'memo/b.md', content: 'FORBIDDEN' },
      ]),
    ).toThrow('内容被拒绝')
    expect(existsSync(join(assetsDir, 'records', 'a.md'))).toBe(false)
  })
})

describe('大小写折叠唯一（APFS 大小写不敏感）', () => {
  it('批内仅大小写不同 → 写盘前拒绝，点名两条路径且零副作用', () => {
    const { assetsDir, writer } = setup()
    const before = commitCount(assetsDir)
    const filesBefore = snapshotFiles(assetsDir)

    let caught: unknown
    try {
      writer.register([
        { type: 'record', path: 'records/A.md', content: 'ONE' },
        { type: 'record', path: 'records/a.md', content: 'TWO' },
      ])
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AssetRegisterError)
    expect((caught as Error).message).toContain('records/A.md')
    expect((caught as Error).message).toContain('records/a.md')
    // M2：拒绝发生在写盘前——任何一个大小写都不该落盘。
    expect(snapshotFiles(assetsDir)).toEqual(filesBefore)
    expect(commitCount(assetsDir)).toBe(before)
    expect(gitText(['status', '--porcelain'], assetsDir)).toBe('')
  })

  it('磁盘已有 records/A.md → 注册 records/a.md 被拒绝且原内容不变', () => {
    const { assetsDir, writer } = setup()
    writer.register({ type: 'record', path: 'records/A.md', content: 'ONE' })
    const before = commitCount(assetsDir)
    const filesBefore = snapshotFiles(assetsDir)

    let caught: unknown
    try {
      writer.register({ type: 'record', path: 'records/a.md', content: 'TWO' })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AssetRegisterError)
    expect((caught as Error).message).toContain('records/A.md')
    expect((caught as Error).message).toContain('records/a.md')
    expect(readFileSync(join(assetsDir, 'records', 'A.md'), 'utf8')).toBe('ONE')
    expect(snapshotFiles(assetsDir)).toEqual(filesBefore)
    expect(commitCount(assetsDir)).toBe(before)
    expect(gitText(['status', '--porcelain'], assetsDir)).toBe('')
  })

  it('磁盘已有 skills/Demo/ → 注册 skills/demo/x.md 被拒绝（父目录大小写不同）', () => {
    const { assetsDir, writer } = setup()
    writer.register({ type: 'skill', path: 'skills/Demo/SKILL.md', content: '# demo' })
    const before = commitCount(assetsDir)
    const filesBefore = snapshotFiles(assetsDir)

    let caught: unknown
    try {
      writer.register({ type: 'skill', path: 'skills/demo/x.md', content: 'x' })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AssetRegisterError)
    expect((caught as Error).message).toContain('skills/Demo/x.md')
    expect((caught as Error).message).toContain('skills/demo/x.md')
    expect(snapshotFiles(assetsDir)).toEqual(filesBefore)
    expect(commitCount(assetsDir)).toBe(before)
    expect(gitText(['status', '--porcelain'], assetsDir)).toBe('')
  })
})

describe('seed 幂等 / upsert / 单次 commit', () => {
  it('首次 seed → 恰好 1 个 commit，作者固定，message 含 create 与 spec.message', () => {
    const { assetsDir, writer } = setup()
    const before = commitCount(assetsDir)

    const [result] = writer.register({
      type: 'record',
      path: 'records/first.md',
      content: '# first',
      message: '初始化第一条记录',
    })

    expect(result.status).toBe('created')
    expect(typeof result.sha).toBe('string')
    // 验收 1：一次注册只产生一个 commit，HEAD 就是返回的 sha。
    expect(commitCount(assetsDir)).toBe(before + 1)
    expect(gitText(['rev-parse', 'HEAD'], assetsDir)).toBe(result.sha)

    // 作者 / 提交者均来自固定身份，不读宿主机 git config。
    expect(gitText(['log', '-1', '--format=%an <%ae>'], assetsDir)).toBe(
      'dsh-rsi-agent <dsh-rsi-agent@localhost>',
    )
    expect(gitText(['log', '-1', '--format=%cn <%ce>'], assetsDir)).toBe(
      'dsh-rsi-agent <dsh-rsi-agent@localhost>',
    )

    const message = gitText(['log', '-1', '--format=%B'], assetsDir)
    expect(message).toContain('初始化第一条记录')
    expect(message).toContain('create records/first.md')
    expect(message).toMatch(/assets: create records\/first\.md/)
  })

  it('同内容两次 seed → 第二次全部 skipped，commit 数不变', () => {
    const { assetsDir, writer } = setup()
    const before = commitCount(assetsDir)

    const first = writer.register([
      { type: 'record', path: 'records/a.md', content: 'same' },
      { type: 'skill', path: 'skills/demo/SKILL.md', content: '# demo' },
    ])
    expect(first.map((item) => item.status)).toEqual(['created', 'created'])
    expect(first.every((item) => typeof item.sha === 'string' && item.sha.length > 0)).toBe(true)
    expect(commitCount(assetsDir)).toBe(before + 1)

    const second = writer.register([
      { type: 'record', path: 'records/a.md', content: 'same' },
      { type: 'skill', path: 'skills/demo/SKILL.md', content: '# demo' },
    ])
    expect(second.map((item) => item.status)).toEqual(['skipped', 'skipped'])
    expect(second.every((item) => item.sha === undefined)).toBe(true)
    expect(second.every((item) => item.reason === 'seed already exists')).toBe(true)
    expect(commitCount(assetsDir)).toBe(before + 1)
  })

  it('upsert 内容与磁盘完全一致 → skipped + reason:content unchanged，不产生 commit', () => {
    const { assetsDir, writer } = setup()
    // 首次 upsert 即 created（目标不存在）。
    const [first] = writer.register({
      type: 'record',
      path: 'records/a.md',
      content: 'v1',
      mode: 'upsert',
    })
    expect(first.status).toBe('created')
    expect(typeof first.sha).toBe('string')
    const before = commitCount(assetsDir)

    const [again] = writer.register({
      type: 'record',
      path: 'records/a.md',
      content: 'v1',
      mode: 'upsert',
    })

    expect(again.status).toBe('skipped')
    expect(again.reason).toBe('content unchanged')
    expect(again.sha).toBeUndefined()
    expect(again.degraded).toBeUndefined()
    expect(commitCount(assetsDir)).toBe(before)
    expect(readFileSync(join(assetsDir, 'records', 'a.md'), 'utf8')).toBe('v1')
  })

  it('upsert 改内容 → updated 且产生新 commit', () => {
    const { assetsDir, writer } = setup()
    writer.register({ type: 'record', path: 'records/a.md', content: 'v1' })
    const before = commitCount(assetsDir)

    const [result] = writer.register({
      type: 'record',
      path: 'records/a.md',
      content: 'v2',
      mode: 'upsert',
      message: '更新记录',
    })

    expect(result.status).toBe('updated')
    expect(typeof result.sha).toBe('string')
    expect(commitCount(assetsDir)).toBe(before + 1)
    expect(readFileSync(join(assetsDir, 'records', 'a.md'), 'utf8')).toBe('v2')

    const subject = execFileSync('git', ['log', '-1', '--format=%B'], {
      cwd: assetsDir,
      encoding: 'utf8',
    })
    expect(subject).toContain('更新记录')
    expect(subject).toContain('update records/a.md')
  })

  it('一次 register 多文件 → 只产生 1 个 commit', () => {
    const { assetsDir, writer } = setup()
    const before = commitCount(assetsDir)

    const results = writer.register([
      { type: 'record', path: 'records/a.md', content: 'a' },
      { type: 'record', path: 'records/b.md', content: 'b' },
      { type: 'skill', path: 'skills/s/SKILL.md', content: 's' },
    ])

    expect(results).toHaveLength(3)
    expect(commitCount(assetsDir)).toBe(before + 1)
    const shas = new Set(results.map((item) => item.sha))
    expect(shas.size).toBe(1)
  })
})

describe('废弃的顶层 skills 字段', () => {
  it('传入 skills → install 抛错，field === "skills"', () => {
    const ctx = new Context()
    const host = new AgentHost(ctx)
    // 故意构造旧契约写法：skills.evolvable 是种子资产，新契约里必须走 writer.register。
    const pack = makePack() as unknown as Record<string, unknown>
    delete pack.firmwareSkills
    pack.skills = {
      evolvable: [{ name: 'seed-skill', markdown: '# seed' }],
      firmware: [],
    }

    let caught: unknown
    try {
      host.install(pack as unknown as DomainPack, { home: join(sandbox(), 'legacy-skills') })
    } catch (error) {
      caught = error
    }

    expect(caught, '废弃字段必须响亮失败，不得静默忽略').toBeInstanceOf(
      DomainPackValidationError,
    )
    const error = caught as DomainPackValidationError
    expect(error.field).toBe('skills')
    expect(error.message).toContain('已废弃')
    expect(error.message).toContain('assets.types')
    expect(error.message).toContain('assets.bootstrap')
    expect(error.message).toContain('writer.register')
    // 未提供 firmwareSkills 时不应出现「已生效」提示。
    expect(error.message).not.toContain('已检测到顶层 firmwareSkills')
    expect(host.active).toBeUndefined()
  })

  it('skills 与 firmwareSkills 同时存在 → 错误信息提示 firmwareSkills 已生效', () => {
    const ctx = new Context()
    const host = new AgentHost(ctx)
    const pack = makePack({
      firmwareSkills: [{ name: 'alpha-firmware', markdown: '# firmware' }],
    }) as unknown as Record<string, unknown>
    pack.skills = { evolvable: [], firmware: [{ name: 'alpha-firmware' }] }

    let caught: unknown
    try {
      host.install(pack as unknown as DomainPack, { home: join(sandbox(), 'legacy-both') })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DomainPackValidationError)
    const error = caught as DomainPackValidationError
    expect(error.field).toBe('skills')
    expect(error.message).toContain('firmwareSkills')
    expect(error.message).toContain('已检测到顶层 firmwareSkills')
    expect(error.message).toContain('已生效')
    expect(host.active).toBeUndefined()
  })
})

describe('git 降级与拆卸语义', () => {
  it('git 不可用：资产仍落盘，返回 degraded:true + reason，不抛错', () => {
    const home = join(sandbox(), 'nogi')
    const assetsDir = join(home, 'assets')
    const repo = ensureAssetsRepo(home)
    expect(repo.degraded).toBe(false)

    vi.stubEnv('PATH', '')
    const writer = createAssetWriter({ runtime: { assetsDir }, assetTypes: TYPES })
    const [result] = writer.register({ type: 'record', path: 'records/a.md', content: 'a' })

    expect(result.status).toBe('created')
    expect(result.degraded).toBe(true)
    expect(typeof result.reason).toBe('string')
    expect(result.sha).toBeUndefined()
    expect(readFileSync(join(assetsDir, 'records', 'a.md'), 'utf8')).toBe('a')
  })

  it('bootstrap 抛错 → 已注册的工具 / 固件 skill 全部回滚，active 保持 undefined', async () => {
    const ctx = new Context()
    ctx.provide(
      'systemPrompt',
      new Proxy(
        {},
        { get: (_t, property) => (property === 'then' ? undefined : () => () => {}) },
      ) as never,
    )
    ctx.plugin(ToolRuntime)
    const deadline = Date.now() + 1000
    while (ctx.tools === undefined) {
      if (Date.now() > deadline) throw new Error('ToolRuntime 未上线')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const skills = new Map<string, SkillRegistration>()
    ctx.provide(
      'skills',
      {
        register(skill: SkillRegistration): () => void {
          skills.set(skill.name, skill)
          return () => skills.delete(skill.name)
        },
      } as never,
    )

    const host = new AgentHost(ctx)
    expect(() =>
      host.install(
        makePack({
          assets: {
            types: TYPES,
            bootstrap() {
              throw new Error('bootstrap 故意失败')
            },
          },
        }),
        { home: join(sandbox(), 'rollback') },
      ),
    ).toThrow('bootstrap 故意失败')

    expect(host.active).toBeUndefined()
    expect(ctx.tools.get('alpha-lookup'), '领域工具必须回滚').toBeUndefined()
    expect(ctx.tools.get('asset_commit'), 'core 工具也必须回滚').toBeUndefined()
    expect(skills.size, '固件 skill 必须回滚').toBe(0)
  })

  it('bootstrap 写入的资产不进 teardown：dispose 后磁盘资产保留', () => {
    const home = join(sandbox(), 'retain')
    const host = new AgentHost(new Context())
    const dispose = host.install(
      makePack({
        assets: {
          types: TYPES,
          bootstrap(writer) {
            writer.register({ type: 'skill', path: 'skills/demo/SKILL.md', content: '# demo' })
          },
        },
      }),
      { home },
    )

    const file = join(host.active!.runtime.assetsDir, 'skills', 'demo', 'SKILL.md')
    expect(existsSync(file)).toBe(true)
    dispose()
    expect(host.active).toBeUndefined()
    expect(existsSync(file), '磁盘资产不属于拆卸范围（§4.3）').toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('# demo')
  })
})

describe('list / read 白名单', () => {
  it('list 按 path 排序、可按类型过滤，并带 size', () => {
    const { assetsDir, writer } = setup()
    writer.register([
      { type: 'record', path: 'records/b.md', content: 'bb' },
      { type: 'record', path: 'records/a.md', content: 'a' },
      { type: 'skill', path: 'skills/s/SKILL.md', content: '# s' },
    ])

    const all = writer.list()
    expect(all.map((item) => item.path)).toEqual([
      'records/a.md',
      'records/b.md',
      'skills/s/SKILL.md',
    ])
    expect(all.map((item) => item.type)).toEqual(['record', 'record', 'skill'])
    expect(all[0].size).toBe(1)
    expect(all[1].size).toBe(2)

    expect(writer.list('skill').map((item) => item.path)).toEqual(['skills/s/SKILL.md'])
    expect(() => writer.list('nope')).toThrow(/nope/)
    expect(() => writer.list('../records')).toThrow(/\.\./)
  })

  it('read 正常读取；越界（../、绝对路径、未声明前缀）被拒', () => {
    const { writer } = setup()
    writer.register({ type: 'record', path: 'records/a.md', content: 'hello' })
    expect(writer.read('records/a.md')).toBe('hello')

    expect(() => writer.read('../secret.txt')).toThrow(AssetPathError)
    expect(() => writer.read('/etc/passwd')).toThrow(AssetPathError)
    expect(() => writer.read('elsewhere/x.md')).toThrow(AssetPathError)
    expect(() => writer.read('records/missing.md')).toThrow(/不存在/)
  })

  it('register 同样拒绝越界路径与跨类型路径', () => {
    const { writer } = setup()
    expect(() => writer.register({ type: 'record', path: '../x.md', content: 'x' })).toThrow(
      AssetPathError,
    )
    expect(() => writer.register({ type: 'record', path: '/abs/x.md', content: 'x' })).toThrow(
      AssetPathError,
    )
    // type=record 但路径落在 skill 的 prefix：类型归属不符。
    expect(() =>
      writer.register({ type: 'record', path: 'skills/x/SKILL.md', content: 'x' }),
    ).toThrow(/不在类型 "record"/)
    expect(() => writer.register({ type: 'unknown', path: 'records/x.md', content: 'x' })).toThrow(
      /未在 assets.types 中声明/,
    )
  })

  it('register 拒绝矩阵：未声明 type / 越出前缀 / 命中其它 type / ../escape.md / 绝对路径', () => {
    const { assetsDir, writer } = setup()
    const before = commitCount(assetsDir)
    const filesBefore = snapshotFiles(assetsDir)

    const cases: ReadonlyArray<{ label: string; spec: AssetSpec; pattern: RegExp }> = [
      {
        label: 'type 未声明',
        spec: { type: 'unknown', path: 'records/x.md', content: 'x' },
        pattern: /未在 assets.types 中声明/,
      },
      {
        label: 'path 越出前缀',
        spec: { type: 'record', path: 'elsewhere/x.md', content: 'x' },
        pattern: /不在任何资产前缀之下/,
      },
      {
        label: 'path 命中其它 type 前缀',
        spec: { type: 'record', path: 'skills/x/SKILL.md', content: 'x' },
        pattern: /不在类型 "record"/,
      },
      {
        label: '../escape.md',
        spec: { type: 'record', path: '../escape.md', content: 'x' },
        pattern: /\.\./,
      },
      {
        label: '绝对路径',
        spec: { type: 'record', path: '/tmp/abs.md', content: 'x' },
        pattern: /绝对路径/,
      },
    ]

    for (const { label, spec, pattern } of cases) {
      expect(() => writer.register(spec), label).toThrow(pattern)
    }

    // 五次拒绝都发生在写盘 / 提交之前。
    expect(snapshotFiles(assetsDir)).toEqual(filesBefore)
    expect(commitCount(assetsDir)).toBe(before)
  })

  it('路径同时命中其它类型 prefix（前缀重叠）→ writer 兜底拒绝', () => {
    const { assetsDir } = setup()
    const writer = createAssetWriter({
      runtime: { assetsDir },
      assetTypes: [
        { name: 'alpha', prefix: 'a/' },
        { name: 'beta', prefix: 'a/b/' },
      ],
    })

    expect(() => writer.register({ type: 'alpha', path: 'a/b/x.md', content: 'x' })).toThrow(
      /同时命中类型 "beta"/,
    )
    expect(existsSync(join(assetsDir, 'a', 'b', 'x.md'))).toBe(false)
  })

})

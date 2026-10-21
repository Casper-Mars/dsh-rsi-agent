/**
 * 资产单仓契约测试（技术方案 §9.1 / §9.2 / §9.3）。
 *
 * 覆盖：
 *   1. git 执行器：参数化调用、不抛错、PATH 摘除后可用性探测为 false；
 *   2. `ensureAssetsRepo`：首次初始化 / 幂等 / 降级不抛；
 *   3. `commitAssets`：固定作者、无空 commit、路径逐条拒绝、前缀段边界、
 *      只提交本次 paths、中文 + CRLF 逐字节保真、git 故障降级；
 *   4. `asset_commit` 工具：dsh-tools 契约（parameters / output.schema / 异步 execute）；
 *   5. `AgentHost.install` 接线：工具真实注册、重名检查、dispose 反注册。
 *
 * 全部 git 操作都在 `mkdtemp` 沙箱内，不触碰真实仓库与 `~/.dsh-rsi-agent`。
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
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  ToolRuntime,
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools'
import { AgentHost } from '../src/service'
import { DomainPackValidationError } from '../src/validate'
import {
  ASSETS_GITIGNORE,
  ASSETS_GITIGNORE_BLOCK_END,
  ASSETS_GITIGNORE_BLOCK_START,
  ASSET_COMMIT_OUTPUT_SCHEMA,
  ASSET_COMMIT_TOOL_NAME,
  AssetPathError,
  commitAssets,
  createAssetCommitTool,
  ensureAssetsRepo,
  isGitAvailable,
  runGit,
  validateAssetPaths,
} from '../src/index'
import type { AssetType, DomainPack, ToolDefinition } from '../src/types'

const ASSET_TYPES: AssetType[] = [
  { name: 'records', prefix: 'records/' },
  { name: 'skills', prefix: 'skills/' },
]

/** 新建独立沙箱：`<root>/domain` 作为领域 home。 */
function sandbox(): { root: string; home: string; assetsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rsi-assets-'))
  const home = join(root, 'domain')
  return { root, home, assetsDir: join(home, 'assets') }
}

/** 直接在沙箱内执行 git（断言用，不经过被测执行器）。 */
function gitText(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function gitBuffer(args: string[], cwd: string): Buffer {
  return execFileSync('git', args, { cwd, encoding: 'buffer' }) as unknown as Buffer
}

/** 写资产文件（自动创建父目录）。 */
function writeAsset(assetsDir: string, rel: string, data: string): void {
  const file = join(assetsDir, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data, 'utf8')
}

/** 真实可用的依赖（沙箱内 git 一定可用）。 */
function realDeps(): { git: typeof runGit } {
  return { git: runGit }
}

describe('assets/git：参数化执行器', () => {
  it('isGitAvailable 在真实 PATH 下为 true；PATH 摘除后为 false 且不抛', () => {
    expect(isGitAvailable()).toBe(true)
    expect(() => isGitAvailable({ env: { PATH: '' } })).not.toThrow()
    expect(isGitAvailable({ env: { PATH: '' } })).toBe(false)
    expect(isGitAvailable({ env: { PATH: '/nonexistent-bin' } })).toBe(false)
  })

  it('runGit 对非法子命令返回 { ok: false, code != 0 }，不抛错', () => {
    const { assetsDir } = sandbox()
    mkdirSync(assetsDir, { recursive: true })
    const result = runGit(['definitely-not-a-git-subcommand'], assetsDir)
    expect(result.ok).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})

describe('assets/repo：单仓就绪', () => {
  it('首次调用创建 <home>/assets、git init、写默认 .gitignore 并纳入首次 commit', () => {
    const { home, assetsDir } = sandbox()
    const result = ensureAssetsRepo(home)

    expect(result.dir).toBe(assetsDir)
    expect(result.initialized).toBe(true)
    expect(result.degraded).toBe(false)
    expect(result.gitignore).toBe('created')
    expect(existsSync(join(assetsDir, '.git'))).toBe(true)
    expect(readFileSync(join(assetsDir, '.gitignore'), 'utf8')).toBe(ASSETS_GITIGNORE)
    expect(ASSETS_GITIGNORE).toContain('.DS_Store')
    expect(ASSETS_GITIGNORE).toContain('*.tmp')
    expect(ASSETS_GITIGNORE).toContain('*.log')

    // `.gitignore` 已入库：恰好 1 个 commit，工作区干净。
    expect(gitText(['rev-list', '--count', 'HEAD'], assetsDir).trim()).toBe('1')
    expect(gitText(['log', '-1', '--format=%s'], assetsDir).trim()).toBe(
      'chore: init assets repository',
    )
    expect(gitText(['ls-tree', '--name-only', 'HEAD'], assetsDir).trim()).toBe('.gitignore')
    expect(gitText(['status', '--porcelain'], assetsDir).trim()).toBe('')
  })

  it('已有自定义 .gitignore：绝不覆盖，只追加缺失忽略项区块（幂等）', () => {
    const { home, assetsDir } = sandbox()
    expect(ensureAssetsRepo(home).initialized).toBe(true)

    writeFileSync(join(assetsDir, '.gitignore'), '# custom\nnode_modules/\n', 'utf8')
    const again = ensureAssetsRepo(home)

    expect(again.initialized).toBe(false)
    expect(again.degraded).toBe(false)
    expect(again.gitignore).toBe('appended')
    const text = readFileSync(join(assetsDir, '.gitignore'), 'utf8')
    // 用户原文一字不改，保留在最前面。
    expect(text.startsWith('# custom\nnode_modules/\n')).toBe(true)
    expect(text).toContain(ASSETS_GITIGNORE_BLOCK_START)
    expect(text).toContain(ASSETS_GITIGNORE_BLOCK_END)
    expect(text).toContain('.DS_Store')
    expect(text).toContain('*.tmp')
    expect(text).toContain('*.log')
    // 已有条目（none）不重复追加。
    expect(text.match(/\*\.log/g)?.length).toBe(1)

    // 改动已入库（init commit + 同步 commit）。
    expect(gitText(['rev-list', '--count', 'HEAD'], assetsDir).trim()).toBe('2')
    expect(gitText(['status', '--porcelain'], assetsDir).trim()).toBe('')

    // 再次调用：幂等，不重复追加、不再产生提交。
    const third = ensureAssetsRepo(home)
    expect(third.gitignore).toBe('unchanged')
    expect(readFileSync(join(assetsDir, '.gitignore'), 'utf8')).toBe(text)
    expect(gitText(['rev-list', '--count', 'HEAD'], assetsDir).trim()).toBe('2')
  })

  it('预置 .gitignore（init 之前已存在）：不覆盖，且纳入首次 commit（不再恒 dirty）', () => {
    const { home, assetsDir } = sandbox()
    mkdirSync(assetsDir, { recursive: true })
    const preset = '# preset\ndist/\n'
    writeFileSync(join(assetsDir, '.gitignore'), preset, 'utf8')

    const result = ensureAssetsRepo(home)

    expect(result.initialized).toBe(true)
    expect(result.gitignore).toBe('appended')
    const text = readFileSync(join(assetsDir, '.gitignore'), 'utf8')
    expect(text.startsWith(preset)).toBe(true)
    expect(text).toContain(ASSETS_GITIGNORE_BLOCK_START)
    expect(gitText(['rev-list', '--count', 'HEAD'], assetsDir).trim()).toBe('1')
    expect(gitText(['log', '-1', '--format=%s'], assetsDir).trim()).toBe(
      'chore: init assets repository',
    )
    expect(gitText(['status', '--porcelain'], assetsDir).trim()).toBe('')
  })

  it('预置 .gitignore 已含本工具区块：不重复追加，但未追踪时仍纳入首次 commit', () => {
    const { home, assetsDir } = sandbox()
    mkdirSync(assetsDir, { recursive: true })
    const preset = `# preset\n${ASSETS_GITIGNORE_BLOCK_START}\n*.log\n${ASSETS_GITIGNORE_BLOCK_END}\n`
    writeFileSync(join(assetsDir, '.gitignore'), preset, 'utf8')

    const result = ensureAssetsRepo(home)
    expect(result.gitignore).toBe('unchanged')
    expect(readFileSync(join(assetsDir, '.gitignore'), 'utf8')).toBe(preset)
    expect(gitText(['rev-list', '--count', 'HEAD'], assetsDir).trim()).toBe('1')
    expect(gitText(['status', '--porcelain'], assetsDir).trim()).toBe('')
  })

  it('已有 .gitignore 含本工具区块：不重复追加（即便条目被手工删掉）', () => {
    const { home, assetsDir } = sandbox()
    expect(ensureAssetsRepo(home).initialized).toBe(true)

    const custom = `# custom\n${ASSETS_GITIGNORE_BLOCK_START}\n*.log\n${ASSETS_GITIGNORE_BLOCK_END}\n`
    writeFileSync(join(assetsDir, '.gitignore'), custom, 'utf8')

    const again = ensureAssetsRepo(home)
    expect(again.gitignore).toBe('unchanged')
    expect(readFileSync(join(assetsDir, '.gitignore'), 'utf8')).toBe(custom)
    expect(gitText(['rev-list', '--count', 'HEAD'], assetsDir).trim()).toBe('1')
  })

  it('git 不可用时 degraded:true + reason，不抛错且不创建 .git', () => {
    const { home, assetsDir } = sandbox()
    const warnings: string[] = []
    const result = ensureAssetsRepo(home, {
      isGitAvailable: () => false,
      logger: (message) => warnings.push(message),
    })

    expect(result.degraded).toBe(true)
    expect(result.initialized).toBe(false)
    expect(result.reason ?? '').toContain('git 不可用')
    expect(existsSync(join(assetsDir, '.git'))).toBe(false)
    expect(warnings.length).toBe(1)
  })
})

describe('assets/commit：写入即 commit', () => {
  it('首次写入 records/a.md → 1 次提交，作者为固定身份', () => {
    const { home, assetsDir } = sandbox()
    ensureAssetsRepo(home)
    writeAsset(assetsDir, 'records/a.md', 'hello\n')

    const result = commitAssets({
      runtime: { assetsDir },
      assetTypes: ASSET_TYPES,
      paths: ['records/a.md'],
      ...realDeps(),
    })

    expect(result.committed).toBe(true)
    expect(result.degraded).toBe(false)
    expect(result.actions).toEqual([{ path: 'records/a.md', action: 'create' }])
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/)
    // 1 个 .gitignore 初始化提交 + 1 个资产提交。
    expect(gitText(['rev-list', '--count', 'HEAD'], assetsDir).trim()).toBe('2')
    expect(gitText(['log', '-1', '--format=%an <%ae>'], assetsDir).trim()).toBe(
      'dsh-rsi-agent <dsh-rsi-agent@localhost>',
    )
    expect(gitText(['log', '-1', '--format=%cn <%ce>'], assetsDir).trim()).toBe(
      'dsh-rsi-agent <dsh-rsi-agent@localhost>',
    )
  })

  it('相同内容再次提交 → committed:false，历史条数不变（无空 commit）', () => {
    const { home, assetsDir } = sandbox()
    ensureAssetsRepo(home)
    writeAsset(assetsDir, 'records/a.md', 'hello\n')

    expect(
      commitAssets({ runtime: { assetsDir }, assetTypes: ASSET_TYPES, paths: ['records/a.md'] })
        .committed,
    ).toBe(true)
    const before = gitText(['rev-list', '--count', 'HEAD'], assetsDir).trim()

    const again = commitAssets({
      runtime: { assetsDir },
      assetTypes: ASSET_TYPES,
      paths: ['records/a.md'],
    })

    expect(again.committed).toBe(false)
    expect(again.degraded).toBe(false)
    expect(again.reason ?? '').toContain('no-op')
    expect(again.actions).toEqual([])
    expect(gitText(['rev-list', '--count', 'HEAD'], assetsDir).trim()).toBe(before)
  })

  it('非法路径逐条拒绝，且文件系统没有产生任何逃逸文件', () => {
    const { root, home, assetsDir } = sandbox()
    ensureAssetsRepo(home)

    const cases: Array<{ path: string; hint: string }> = [
      { path: '../escape.md', hint: '..' },
      { path: '/abs/path', hint: '绝对路径' },
      { path: '.git/config', hint: '.git' },
      { path: 'a\\b.md', hint: '反斜杠' },
      { path: 'records2/x.md', hint: '资产前缀' },
      { path: 'records/../../x.md', hint: '..' },
    ]

    for (const item of cases) {
      let caught: unknown
      try {
        commitAssets({ runtime: { assetsDir }, assetTypes: ASSET_TYPES, paths: [item.path] })
      } catch (error) {
        caught = error
      }
      expect(caught, `${item.path} 必须被拒绝`).toBeInstanceOf(AssetPathError)
      const error = caught as AssetPathError
      expect(error.message).toContain(item.path.replaceAll('\\', '\\\\'))
      expect(error.message).toContain(item.hint)
    }

    // 没有逃逸文件被创建；资产目录里只有 .git / .gitignore / records。
    expect(existsSync(join(home, 'escape.md'))).toBe(false)
    expect(existsSync(join(root, 'escape.md'))).toBe(false)
    expect(existsSync(join(assetsDir, 'records2'))).toBe(false)
    expect(readdirSync(assetsDir).sort()).toEqual(['.git', '.gitignore'].sort())
  })

  it('一次提交多条非法路径时，错误信息列出全部原因', () => {
    const { home, assetsDir } = sandbox()
    ensureAssetsRepo(home)

    let caught: unknown
    try {
      commitAssets({
        runtime: { assetsDir },
        assetTypes: ASSET_TYPES,
        paths: ['../a.md', '/b.md', 'records2/c.md', 42 as unknown as string],
      })
    } catch (error) {
      caught = error
    }
    const error = caught as AssetPathError
    expect(error).toBeInstanceOf(AssetPathError)
    expect(error.reasons.length).toBe(4)
    expect(error.message).toContain('../a.md')
    expect(error.message).toContain('/b.md')
    expect(error.message).toContain('records2/c.md')
    expect(error.message).toContain('paths[3]')
  })

  it('空数组 / 非数组 / 空字符串一律拒绝', () => {
    const { home, assetsDir } = sandbox()
    ensureAssetsRepo(home)
    const runtime = { assetsDir }

    expect(() => commitAssets({ runtime, assetTypes: ASSET_TYPES, paths: [] })).toThrow(
      AssetPathError,
    )
    expect(() =>
      commitAssets({
        runtime,
        assetTypes: ASSET_TYPES,
        paths: 'records/a.md' as unknown as string[],
      }),
    ).toThrow(AssetPathError)
    expect(() =>
      commitAssets({ runtime, assetTypes: ASSET_TYPES, paths: ['  '] }),
    ).toThrow(AssetPathError)
  })

  it('前缀按路径段比较：records2/ 不会命中 records/', () => {
    expect(() => validateAssetPaths(['records2/x.md'], ASSET_TYPES)).toThrow(AssetPathError)
    expect(() => validateAssetPaths(['records'], ASSET_TYPES)).toThrow(AssetPathError)
    expect(validateAssetPaths(['records/x.md', 'records/x.md'], ASSET_TYPES)).toEqual([
      'records/x.md',
    ])
  })

  it('只提交本次 paths：其它已 staged 文件不进本次 commit，仍留在暂存区', () => {
    const { home, assetsDir } = sandbox()
    ensureAssetsRepo(home)

    // 先放一个不在白名单内、但已被 staged 的文件。
    writeFileSync(join(assetsDir, 'other.txt'), 'other\n', 'utf8')
    gitText(['add', 'other.txt'], assetsDir)

    writeAsset(assetsDir, 'records/b.md', 'b\n')
    const result = commitAssets({
      runtime: { assetsDir },
      assetTypes: ASSET_TYPES,
      paths: ['records/b.md'],
    })
    expect(result.committed).toBe(true)

    const committedFiles = gitText(
      ['show', '--name-only', '--format=', 'HEAD'],
      assetsDir,
    )
      .split('\n')
      .filter((line) => line !== '')
    expect(committedFiles).toEqual(['records/b.md'])

    // other.txt 仍然是 staged（`A ` 前缀），没有被顺手提交。
    expect(gitText(['status', '--porcelain'], assetsDir)).toContain('A  other.txt')
  })

  it('中文 + CRLF 正文逐字节保真（core.autocrlf=false）', () => {
    const { home, assetsDir } = sandbox()
    ensureAssetsRepo(home)

    const body = '中文内容\r\n第二行\n末行没有换行'
    const file = join(assetsDir, 'records', '中文.md')
    writeAsset(assetsDir, 'records/中文.md', body)
    const original = readFileSync(file)

    const result = commitAssets({
      runtime: { assetsDir },
      assetTypes: ASSET_TYPES,
      paths: ['records/中文.md'],
    })
    expect(result.committed).toBe(true)

    const shown = gitBuffer(['show', 'HEAD:records/中文.md'], assetsDir)
    expect(Buffer.compare(shown, original)).toBe(0)
    expect(shown.includes(Buffer.from('\r\n', 'utf8'))).toBe(true)
  })

  it('删除文件 → action: delete', () => {
    const { home, assetsDir } = sandbox()
    ensureAssetsRepo(home)
    writeAsset(assetsDir, 'records/gone.md', 'x\n')
    commitAssets({ runtime: { assetsDir }, assetTypes: ASSET_TYPES, paths: ['records/gone.md'] })

    rmSync(join(assetsDir, 'records', 'gone.md'))
    const result = commitAssets({
      runtime: { assetsDir },
      assetTypes: ASSET_TYPES,
      paths: ['records/gone.md'],
    })

    expect(result.committed).toBe(true)
    expect(result.actions).toEqual([{ path: 'records/gone.md', action: 'delete' }])
  })

  it('自定义 message 作为首段，动作行追加在空行之后', () => {
    const { home, assetsDir } = sandbox()
    ensureAssetsRepo(home)
    writeAsset(assetsDir, 'records/m.md', 'x\n')
    commitAssets({
      runtime: { assetsDir },
      assetTypes: ASSET_TYPES,
      paths: ['records/m.md'],
      message: 'feat: 记录',
    })

    const message = gitText(['log', '-1', '--format=%B'], assetsDir)
    expect(message).toContain('feat: 记录\n\nassets: create records/m.md')
  })

  it('git 故障 → degraded:true + reason + logger.warn，不抛错', () => {
    const { home, assetsDir } = sandbox()
    ensureAssetsRepo(home)
    const warnings: string[] = []
    const brokenGit = () => ({ ok: false, stdout: '', stderr: 'boom', code: 128 })

    const result = commitAssets({
      runtime: { assetsDir },
      assetTypes: ASSET_TYPES,
      paths: ['records/a.md'],
      git: brokenGit,
      logger: (message) => warnings.push(message),
    })

    expect(result.committed).toBe(false)
    expect(result.degraded).toBe(true)
    expect(result.reason ?? '').toContain('boom')
    expect(warnings.length).toBe(1)
  })

  it('仓库未就绪 → degraded:true，不向父仓库提交', () => {
    const { root } = sandbox()
    const warnings: string[] = []
    const result = commitAssets({
      runtime: { assetsDir: join(root, 'no-such-assets') },
      assetTypes: ASSET_TYPES,
      paths: ['records/a.md'],
      logger: (message) => warnings.push(message),
    })

    expect(result.committed).toBe(false)
    expect(result.degraded).toBe(true)
    expect(result.reason ?? '').toContain('未就绪')
    expect(warnings.length).toBe(1)
  })
})

describe('asset_commit：dsh-tools 契约', () => {
  it('parameters / output.schema 均落在 dsh-tools 支持的 JSON Schema 子集内', () => {
    const { home, assetsDir } = sandbox()
    ensureAssetsRepo(home)
    const tool = createAssetCommitTool({ runtime: { assetsDir }, assetTypes: ASSET_TYPES })

    expect(tool.name).toBe(ASSET_COMMIT_TOOL_NAME)
    expect(tool.description.length).toBeGreaterThan(0)
    expect(() => assertSupportedJsonSchema(tool.parameters)).not.toThrow()
    expect(() => assertSupportedJsonSchema(ASSET_COMMIT_OUTPUT_SCHEMA)).not.toThrow()
    expect(tool.parameters.required).toEqual(['paths'])
  })

  it('execute 成功提交，返回值通过 output.schema 校验', async () => {
    const { home, assetsDir } = sandbox()
    ensureAssetsRepo(home)
    writeAsset(assetsDir, 'records/t.md', 'tool\n')
    const tool = createAssetCommitTool({ runtime: { assetsDir }, assetTypes: ASSET_TYPES })

    const value = await tool.execute({ paths: ['records/t.md'] }, {} as never)
    expect(value).toMatchObject({
      committed: true,
      degraded: false,
      actions: [{ path: 'records/t.md', action: 'create' }],
    })
    expect(
      validateJsonSchemaValue(ASSET_COMMIT_OUTPUT_SCHEMA as never, value as never),
    ).toEqual([])

    const rendered = tool.output.render({}, value as never)
    expect(rendered.some((block) => block.type === 'text')).toBe(true)
  })

  it('execute 对空数组 / 非法路径返回 reason，不抛错', async () => {
    const { home, assetsDir } = sandbox()
    ensureAssetsRepo(home)
    const tool = createAssetCommitTool({ runtime: { assetsDir }, assetTypes: ASSET_TYPES })

    const empty = await tool.execute({ paths: [] }, {} as never)
    expect(empty).toMatchObject({ committed: false, degraded: false })
    expect((empty as { reason: string }).reason).toContain('至少 1 项')

    const bad = await tool.execute({ paths: ['../escape.md'] }, {} as never)
    expect(bad).toMatchObject({ committed: false, degraded: false })
    expect((bad as { reason: string }).reason).toContain('../escape.md')

    const wrongType = await tool.execute({ paths: [42] }, {} as never)
    expect((wrongType as { reason: string }).reason).toContain('paths[0]')
  })
})

// ---------------------------------------------------------------------------
// 5. AgentHost 接线
// ---------------------------------------------------------------------------
function systemPromptStub(): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get: (_target, property) => (property === 'then' ? undefined : () => () => {}),
    },
  ) as Record<string, unknown>
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function createHostWithRealTools(): Promise<{ ctx: Context; host: AgentHost }> {
  const ctx = new Context()
  ctx.provide('systemPrompt', systemPromptStub() as never)
  ctx.plugin(ToolRuntime)
  await waitFor(() => ctx.tools !== undefined)
  return { ctx, host: new AgentHost(ctx) }
}

function makePack(overrides: Partial<DomainPack> = {}): DomainPack {
  const demo: ToolDefinition = {
    name: 'demo-echo',
    description: 'demo',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      render: () => [{ type: 'text' as const, text: 'ok' }],
    },
    execute: async () => ({ ok: true }),
  } as unknown as ToolDefinition

  return {
    apiVersion: 1,
    id: 'demo',
    version: '1.0.0',
    persona: { markdown: () => '# demo' },
    defaultSessionId: 'demo-session',
    skills: { evolvable: [{ name: 'seed', markdown: '# seed' }] },
    assetTypes: ASSET_TYPES,
    scheduler: { timezone: 'Asia/Shanghai' },
    evolutionPolicy: { window: '7d', independentCases: 10 },
    tools: () => [demo],
    toolNames: ['demo-echo'],
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('AgentHost 接线：core 工具 asset_commit', () => {
  it('git 不可用时只 warn，install 继续且工具仍注册（调用时降级）', async () => {
    const { ctx, host } = await createHostWithRealTools()
    const { home } = sandbox()
    vi.stubEnv('PATH', '')

    const dispose = host.install(makePack(), { home })
    expect(host.active).toBeDefined()
    expect(ctx.tools.get(ASSET_COMMIT_TOOL_NAME)).toBeDefined()
    expect(existsSync(join(host.active!.runtime.assetsDir, '.git'))).toBe(false)

    const tool = ctx.tools.get(ASSET_COMMIT_TOOL_NAME)!
    const value = (await tool.execute({ paths: ['records/x.md'] }, {} as never)) as {
      degraded: boolean
      reason?: string
    }
    expect(value.degraded).toBe(true)
    expect(value.reason ?? '').toContain('git')

    dispose()
  })

  it('install 后 ctx.tools 有 asset_commit，dispose 后消失', async () => {
    const { ctx, host } = await createHostWithRealTools()
    const { home } = sandbox()
    expect(ctx.tools.get(ASSET_COMMIT_TOOL_NAME)).toBeUndefined()

    const dispose = host.install(makePack(), { home })
    expect(ctx.tools.get(ASSET_COMMIT_TOOL_NAME)).toBeDefined()
    expect(ctx.tools.get('demo-echo')).toBeDefined()
    expect(existsSync(join(host.active!.runtime.assetsDir, '.git'))).toBe(true)

    dispose()
    expect(ctx.tools.get(ASSET_COMMIT_TOOL_NAME)).toBeUndefined()
    expect(ctx.tools.get('demo-echo')).toBeUndefined()
  })

  it('领域工具与 asset_commit 重名 → 抛契约错误（core 工具名受保护）', async () => {
    const { ctx, host } = await createHostWithRealTools()
    const { home } = sandbox()
    const clash: ToolDefinition = {
      name: ASSET_COMMIT_TOOL_NAME,
      description: 'clash',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', properties: {} },
        render: () => [],
      },
      execute: async () => ({}),
    } as unknown as ToolDefinition

    let caught: unknown
    try {
      host.install(
        makePack({ tools: () => [clash], toolNames: [ASSET_COMMIT_TOOL_NAME] }),
        { home },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DomainPackValidationError)
    expect((caught as DomainPackValidationError).field).toBe('tools')
    expect(host.active).toBeUndefined()
    expect(ctx.tools.get(ASSET_COMMIT_TOOL_NAME)).toBeUndefined()
  })
})

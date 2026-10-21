/**
 * 资产历史工具契约测试 —— 技术方案 §9.4 / §18 验收第 5 条 / §19 命令注入。
 *
 * 覆盖：
 *   1. `assetHistory`：四字段齐全、固定作者、limit 上限与非法值拒绝、git 故障降级；
 *   2. `assetShow`：首版内容逐字节一致（中文 + emoji + CRLF）、256 KB 按 UTF-8
 *      码点边界截断且**零 U+FFFD**；
 *   3. 注入：`sha` 白名单命中即拒，**不产生任何 git 调用**（可注入执行器计数 +
 *      PATH 假 git 标记文件双重验证）；
 *   4. 路径白名单：不在 `assetTypes[].prefix` 之下的一律拒绝；
 *   5. dsh-tools 契约：schema / render / 异步 execute；
 *   6. `install` 注册 `asset_history` / `asset_show`，`dispose` 反注册。
 *
 * 全部 git 操作都在 `mkdtemp` 沙箱内，不触碰真实仓库与 `~/.dsh-rsi-agent`。
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  ToolRuntime,
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools'
import { AgentHost } from '../src/service'
import {
  ASSET_HISTORY_DEFAULT_LIMIT,
  ASSET_HISTORY_MAX_LIMIT,
  ASSET_HISTORY_OUTPUT_SCHEMA,
  ASSET_HISTORY_PARAMETERS,
  ASSET_HISTORY_TOOL_NAME,
  ASSET_SHOW_MAX_BYTES,
  ASSET_SHOW_OUTPUT_SCHEMA,
  ASSET_SHOW_PARAMETERS,
  ASSET_SHOW_TOOL_NAME,
  AssetHistoryLimitError,
  AssetPathError,
  AssetShaError,
  AssetShowError,
  assetHistory,
  assetShow,
  commitAssets,
  createAssetHistoryTool,
  createAssetShowTool,
  createAssetTools,
  ensureAssetsRepo,
  validUtf8PrefixLength,
} from '../src/index'
import type { GitBufferResult, GitRunner } from '../src/index'
import type { AssetType, DomainPack, ToolDefinition } from '../src/types'

const ASSET_TYPES: AssetType[] = [
  { name: 'records', prefix: 'records/' },
  { name: 'skills', prefix: 'skills/' },
]

const ORIGINAL_PATH = process.env.PATH

interface Fixture {
  root: string
  home: string
  assetsDir: string
}

function sandbox(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rsi-history-'))
  const home = join(root, 'domain')
  return { root, home, assetsDir: join(home, 'assets') }
}

function gitText(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function writeAsset(assetsDir: string, rel: string, data: string | Buffer): void {
  const file = join(assetsDir, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
}

/** 建仓 + 提交一个文件，返回该提交的 SHA。 */
function seed(rel = 'records/a.md', body: string | Buffer = 'v1\n'): Fixture & { sha: string } {
  const fixture = sandbox()
  ensureAssetsRepo(fixture.home)
  writeAsset(fixture.assetsDir, rel, body)
  const result = commitAssets({
    runtime: { assetsDir: fixture.assetsDir },
    assetTypes: ASSET_TYPES,
    paths: [rel],
  })
  expect(result.committed).toBe(true)
  return { ...fixture, sha: result.sha as string }
}

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH
})

describe('assetHistory：历史查询', () => {
  it('至少 1 条，sha/author/date/subject 四字段齐全，author 含 dsh-rsi-agent', () => {
    const { assetsDir, sha } = seed('records/a.md', 'hello\n')

    const result = assetHistory({
      runtime: { assetsDir },
      assetTypes: ASSET_TYPES,
      path: 'records/a.md',
    })

    expect(result.degraded).toBe(false)
    expect(result.entries.length).toBeGreaterThanOrEqual(1)
    const first = result.entries[0]!
    expect(first.sha).toBe(sha)
    expect(first.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(first.author).toContain('dsh-rsi-agent')
    expect(first.author).toBe('dsh-rsi-agent <dsh-rsi-agent@localhost>')
    // ISO 8601（`%aI`）：2026-10-21T14:00:00+00:00
    expect(first.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    expect(first.subject).toBe('assets: create records/a.md')
    expect(Object.keys(first).sort()).toEqual(['author', 'date', 'sha', 'subject'])
  })

  it('缺省 limit 为 20；limit=1 只返回 1 条（新 → 旧）', () => {
    const { assetsDir } = seed('records/a.md', 'v1\n')
    writeAsset(assetsDir, 'records/a.md', 'v2\n')
    commitAssets({
      runtime: { assetsDir },
      assetTypes: ASSET_TYPES,
      paths: ['records/a.md'],
    })

    expect(ASSET_HISTORY_DEFAULT_LIMIT).toBe(20)
    expect(ASSET_HISTORY_MAX_LIMIT).toBe(100)

    const all = assetHistory({ runtime: { assetsDir }, assetTypes: ASSET_TYPES, path: 'records/a.md' })
    expect(all.entries.length).toBe(2)
    expect(all.entries[0]!.subject).toBe('assets: update records/a.md')

    const one = assetHistory({
      runtime: { assetsDir },
      assetTypes: ASSET_TYPES,
      path: 'records/a.md',
      limit: 1,
    })
    expect(one.entries.length).toBe(1)
    expect(one.entries[0]!.subject).toBe('assets: update records/a.md')
  })

  it('limit 为 0 / -1 / 101 / 1.5 / "abc" 全部拒绝（AssetHistoryLimitError）', () => {
    const { assetsDir } = seed()
    for (const limit of [0, -1, 101, 1.5, Number.NaN, 'abc', null]) {
      let caught: unknown
      try {
        assetHistory({
          runtime: { assetsDir },
          assetTypes: ASSET_TYPES,
          path: 'records/a.md',
          limit: limit as unknown as number,
        })
      } catch (error) {
        caught = error
      }
      expect(caught, `limit=${String(limit)} 必须被拒绝`).toBeInstanceOf(AssetHistoryLimitError)
      expect((caught as AssetHistoryLimitError).message).toContain('1..100')
    }
  })

  it('git 故障 → { entries: [], degraded: true, reason }，不抛错', () => {
    const { assetsDir } = seed()
    const broken: GitRunner = () => ({ ok: false, stdout: '', stderr: 'boom', code: 128 })
    const warnings: string[] = []

    const result = assetHistory({
      runtime: { assetsDir },
      assetTypes: ASSET_TYPES,
      path: 'records/a.md',
      git: broken,
      logger: (message) => warnings.push(message),
    })

    expect(result.entries).toEqual([])
    expect(result.degraded).toBe(true)
    expect(result.reason ?? '').toContain('boom')
    expect(warnings.length).toBe(1)
  })

  it('路径不在资产前缀下 → 抛 AssetPathError（契约错误，不降级）', () => {
    const { assetsDir } = seed()
    for (const path of ['src/x.ts', '../x', 'records2/x.md', '.git/config']) {
      expect(() =>
        assetHistory({ runtime: { assetsDir }, assetTypes: ASSET_TYPES, path }),
      ).toThrow(AssetPathError)
    }
  })
})

describe('assetShow：历史版本内容', () => {
  it('首版内容与写入原文逐字节一致（中文 + emoji + CRLF）', () => {
    const body = '第一行中文\r\n🎉 emoji: 🧪🚀\r\nlast line no newline'
    const { assetsDir, sha } = seed('records/中文.md', body)
    const original = readFileSync(join(assetsDir, 'records/中文.md'))

    const shown = assetShow({
      runtime: { assetsDir },
      assetTypes: ASSET_TYPES,
      path: 'records/中文.md',
      sha,
    })

    expect(shown.path).toBe('records/中文.md')
    expect(shown.sha).toBe(sha)
    expect(shown.truncated).toBe(false)
    expect(shown.bytes).toBe(original.length)
    expect(Buffer.compare(Buffer.from(shown.content, 'utf8'), original)).toBe(0)
    expect(shown.content).toContain('\r\n')
    expect(shown.content).toContain('🎉')
    expect(shown.content.includes('\uFFFD')).toBe(false)
  })

  it('短 SHA（7 位）可读；同一版本内容与完整 SHA 一致', () => {
    const { assetsDir, sha } = seed('records/a.md', 'short\n')
    const short = assetShow({
      runtime: { assetsDir },
      assetTypes: ASSET_TYPES,
      path: 'records/a.md',
      sha: sha.slice(0, 7),
    })
    expect(short.content).toBe('short\n')
  })

  it('300 KB 中文文件 → truncated:true，content 中 U+FFFD 出现 0 次', () => {
    const body = '中'.repeat(100_000) // 300_000 字节
    const { assetsDir, sha } = seed('records/big.md', body)

    const shown = assetShow({
      runtime: { assetsDir },
      assetTypes: ASSET_TYPES,
      path: 'records/big.md',
      sha,
    })

    expect(shown.truncated).toBe(true)
    expect(shown.bytes).toBe(300_000)
    expect(Buffer.byteLength(shown.content, 'utf8')).toBeLessThanOrEqual(ASSET_SHOW_MAX_BYTES)
    expect(shown.content.length).toBeGreaterThan(80_000)
    // 核心断言：绝不输出替换字符。
    expect(shown.content.split('\uFFFD').length - 1).toBe(0)
    // 内容必须是原文的合法前缀（按码点回退，不吞字符、不补字符）。
    expect(body.startsWith(shown.content)).toBe(true)
    // 256 KB / 3 = 87381.33 → 87381 个完整汉字（3 的整数倍）。
    expect(shown.content.length).toBe(87_381)
  })

  it('validUtf8PrefixLength：截断落在码点中间时回退到完整码点', () => {
    const buf = Buffer.from('a中', 'utf8') // 61 e4 b8 ad
    expect(validUtf8PrefixLength(buf, 4)).toBe(4) // 完整
    expect(validUtf8PrefixLength(buf, 3)).toBe(1) // 只剩 e4 b8 → 回退掉
    expect(validUtf8PrefixLength(buf, 1)).toBe(1)

    const emoji = Buffer.from('🎉', 'utf8') // 4 字节
    expect(validUtf8PrefixLength(emoji, 3)).toBe(0)
    expect(validUtf8PrefixLength(Buffer.concat([Buffer.from('a'), emoji]), 4)).toBe(1)
    // 非法字节：在第一个非法位置停下，绝不产生 U+FFFD。
    expect(validUtf8PrefixLength(Buffer.from([0x61, 0xff, 0x62]), 3)).toBe(1)
  })

  it('版本不存在 / 路径不在该版本 → AssetShowError', () => {
    const { assetsDir } = seed()
    expect(() =>
      assetShow({
        runtime: { assetsDir },
        assetTypes: ASSET_TYPES,
        path: 'records/a.md',
        sha: 'abcdef1',
      }),
    ).toThrow(AssetShowError)
  })
})

describe('注入防护：sha 白名单在任何 git 调用之前生效', () => {
  const BAD_SHAS = ['HEAD; rm -rf /', 'HEAD --output=/tmp/x', '$(whoami)', '`id`', 'HEAD', 'abc', ''] // prettier-ignore

  it('可注入执行器：非法 sha 全部拒绝，且执行器调用次数为 0', () => {
    const { assetsDir } = seed()
    let calls = 0
    const spy: GitBufferRunner = (): GitBufferResult => {
      calls += 1
      return { ok: true, stdout: Buffer.alloc(0), stderr: '', code: 0 }
    }

    for (const sha of BAD_SHAS) {
      expect(() =>
        assetShow({ runtime: { assetsDir }, assetTypes: ASSET_TYPES, path: 'records/a.md', sha, git: spy }),
      ).toThrow(AssetShaError)
    }
    expect(calls).toBe(0)
  })

  it('PATH 假 git：非法 sha 不产生子进程（标记文件不存在），合法 sha 才触发', () => {
    const { assetsDir, root } = seed()
    const bin = join(root, 'fake-bin')
    const marker = join(root, 'git-called.txt')
    mkdirSync(bin, { recursive: true })
    const script = join(bin, 'git')
    writeFileSync(script, `#!/bin/sh\necho called >> "${marker}"\nexit 1\n`, 'utf8')
    chmodSync(script, 0o755)
    process.env.PATH = `${bin}:${ORIGINAL_PATH ?? ''}`

    for (const sha of BAD_SHAS) {
      expect(() =>
        assetShow({ runtime: { assetsDir }, assetTypes: ASSET_TYPES, path: 'records/a.md', sha }),
      ).toThrow(AssetShaError)
    }
    // 关键断言：假 git 一次都没被调用。
    expect(existsSync(marker)).toBe(false)

    // 对照组：合法 sha 会真的 spawn 假 git（证明标记机制有效，上一条断言不是假阴性）。
    expect(() =>
      assetShow({
        runtime: { assetsDir },
        assetTypes: ASSET_TYPES,
        path: 'records/a.md',
        sha: 'abcdef1',
      }),
    ).toThrow(AssetShowError)
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('called\n')
  })
})

describe('asset_history / asset_show：dsh-tools 契约', () => {
  it('parameters / output.schema 均落在支持子集内，required 严格', () => {
    const { assetsDir } = seed()
    const history = createAssetHistoryTool({ runtime: { assetsDir }, assetTypes: ASSET_TYPES })
    const show = createAssetShowTool({ runtime: { assetsDir }, assetTypes: ASSET_TYPES })

    expect(history.name).toBe(ASSET_HISTORY_TOOL_NAME)
    expect(show.name).toBe(ASSET_SHOW_TOOL_NAME)
    expect(() => assertSupportedJsonSchema(ASSET_HISTORY_PARAMETERS)).not.toThrow()
    expect(() => assertSupportedJsonSchema(ASSET_HISTORY_OUTPUT_SCHEMA)).not.toThrow()
    expect(() => assertSupportedJsonSchema(ASSET_SHOW_PARAMETERS)).not.toThrow()
    expect(() => assertSupportedJsonSchema(ASSET_SHOW_OUTPUT_SCHEMA)).not.toThrow()

    expect(ASSET_HISTORY_PARAMETERS.required).toEqual(['path'])
    expect(ASSET_SHOW_PARAMETERS.required).toEqual(['path', 'sha'])
    expect(ASSET_HISTORY_PARAMETERS.additionalProperties).toBe(false)
    expect(ASSET_SHOW_PARAMETERS.additionalProperties).toBe(false)
  })

  it('execute 返回值通过 output.schema 校验，render 产出 text block', async () => {
    const body = 'tool 🎉\r\n'
    const { assetsDir, sha } = seed('records/t.md', body)
    const history = createAssetHistoryTool({ runtime: { assetsDir }, assetTypes: ASSET_TYPES })
    const show = createAssetShowTool({ runtime: { assetsDir }, assetTypes: ASSET_TYPES })

    const historyValue = await history.execute({ path: 'records/t.md' }, {} as never)
    expect(validateJsonSchemaValue(ASSET_HISTORY_OUTPUT_SCHEMA as never, historyValue as never)).toEqual([])
    const historyBlocks = history.output.render({}, historyValue as never)
    expect(historyBlocks[0]?.type).toBe('text')

    const showValue = await show.execute({ path: 'records/t.md', sha }, {} as never)
    expect(validateJsonSchemaValue(ASSET_SHOW_OUTPUT_SCHEMA as never, showValue as never)).toEqual([])
    expect((showValue as { content: string }).content).toBe(body)
    const showBlocks = show.output.render({}, showValue as never)
    expect(showBlocks[0]?.type).toBe('text')
  })

  it('asset_history 非法 limit / path 返回 reason（不抛错）', async () => {
    const { assetsDir } = seed()
    const history = createAssetHistoryTool({ runtime: { assetsDir }, assetTypes: ASSET_TYPES })

    const badLimit = await history.execute({ path: 'records/a.md', limit: 0 }, {} as never)
    expect(badLimit).toMatchObject({ entries: [], degraded: false })
    expect((badLimit as { reason: string }).reason).toContain('limit')

    const badPath = await history.execute({ path: '../x' }, {} as never)
    expect((badPath as { reason: string }).reason).toContain('../x')
  })

  it('asset_show 非法 sha 抛错（读取类工具不返回空内容）', async () => {
    const { assetsDir } = seed()
    const show = createAssetShowTool({ runtime: { assetsDir }, assetTypes: ASSET_TYPES })
    await expect(show.execute({ path: 'records/a.md', sha: 'HEAD' }, {} as never)).rejects.toThrow(
      AssetShaError,
    )
  })
})

// ---------------------------------------------------------------------------
// AgentHost 接线：install 注册三个 core 工具，dispose 全部反注册
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

async function createHost(): Promise<{ ctx: Context; host: AgentHost }> {
  const ctx = new Context()
  ctx.provide('systemPrompt', systemPromptStub() as never)
  ctx.plugin(ToolRuntime)
  await waitFor(() => ctx.tools !== undefined)
  return { ctx, host: new AgentHost(ctx) }
}

function makePack(): DomainPack {
  const echo: ToolDefinition = {
    name: 'demo-echo',
    description: 'echo',
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
    tools: () => [echo],
    toolNames: ['demo-echo'],
  } as unknown as DomainPack
}

describe('AgentHost 接线：asset_history / asset_show', () => {
  it('install 后三个 core 工具均可用；dispose 后全部消失', async () => {
    const { ctx, host } = await createHost()
    const { home } = sandbox()

    const dispose = host.install(makePack(), { home })
    expect(ctx.tools.get(ASSET_HISTORY_TOOL_NAME)).toBeDefined()
    expect(ctx.tools.get(ASSET_SHOW_TOOL_NAME)).toBeDefined()

    const history = ctx.tools.get(ASSET_HISTORY_TOOL_NAME)!
    const value = (await history.execute({ path: 'records/none.md' }, {} as never)) as {
      entries: unknown[]
      degraded: boolean
    }
    expect(value.entries).toEqual([])
    expect(value.degraded).toBe(false)

    dispose()
    expect(ctx.tools.get(ASSET_HISTORY_TOOL_NAME)).toBeUndefined()
    expect(ctx.tools.get(ASSET_SHOW_TOOL_NAME)).toBeUndefined()
  })

  it('createAssetTools 返回 3 个 core 工具', () => {
    const { assetsDir } = seed()
    const tools = createAssetTools({ runtime: { assetsDir }, assetTypes: ASSET_TYPES })
    expect(tools.map((tool) => tool.name)).toEqual([
      'asset_commit',
      'asset_history',
      'asset_show',
    ])
  })
})

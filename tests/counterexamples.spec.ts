/**
 * 六条必须的反例（Task-14 §二）—— 每条用例名直接写明「它守的是什么」，
 * 便于回归时一眼看出红线是否被越过。
 *
 * 为什么集中在一个文件：这些红线散落在各模块的 happy-path 测试里时，很容易在
 * 重构中被合并 / 删除而无人察觉；集中成一组「以守卫命名」的用例后，删除任何
 * 一条都会在 diff 里非常显眼。
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentHost } from '../src/service'
import { createAssetWriter, AssetRegisterError } from '../src/assets/writer'
import { AssetPathError, type AssetPathReasonCode } from '../src/assets/commit'
import { ensureAssetsRepo } from '../src/assets/repo'
import { runGit } from '../src/assets/git'
import { resolveTaskPath } from '../src/scheduler/task'
import { renderTemplate, TemplateRenderError } from '../src/evolution/template'
import { DomainPackValidationError } from '../src/validate'
import type { DomainPack, ToolDefinition } from '../src/types'

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} 测试工具`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: {} },
      render: () => [{ type: 'text' as const, text: 'ok' }],
    },
    execute: async () => ({}),
  } as unknown as ToolDefinition
}

function makePack(id: string, overrides: Partial<DomainPack> = {}): DomainPack {
  return {
    apiVersion: 1,
    id,
    version: '1.0.0',
    displayName: id,
    persona: { markdown: () => `# ${id}` },
    defaultSessionId: `${id}-session`,
    assets: { types: [{ name: 'notes', prefix: 'notes/' }] },
    scheduler: { timezone: 'UTC' },
    evolutionPolicy: { window: '7d', independentCases: 3 },
    tools: () => [makeTool(`${id}-lookup`)],
    toolNames: [`${id}-lookup`],
    ...overrides,
  }
}

const tempDirs: string[] = []
function tempDir(prefix = 'dsh-rsi-ce-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 递归列出普通文件（相对路径，跳过 .git）。 */
function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.name === '.git') continue
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        walk(full)
        continue
      }
      out.push(relative(root, full))
    }
  }
  walk(root)
  return out.sort()
}

function commitCount(dir: string): number {
  const result = runGit(['rev-list', '--count', 'HEAD'], dir)
  return result.ok ? Number(result.stdout.trim()) : 0
}

describe('反例 1 · 第二个领域 install 必败（单领域约束）', () => {
  it('已激活领域存在时再次 install → 抛错点名两者，且不破坏已激活领域', () => {
    const host = new AgentHost(new Context())
    const first = host.install(makePack('ce-single-a'))
    try {
      let caught: unknown
      try {
        host.install(makePack('ce-single-b'))
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      const message = (caught as Error).message
      expect(message).toContain('ce-single-a')
      expect(message).toContain('ce-single-b')
      // 第一次安装仍然是激活态（失败不得把已有领域一起清掉）。
      expect(host.active?.id).toBe('ce-single-a')
    } finally {
      first()
    }
  })
})

describe('反例 2 · `../` 路径必拒（写入与执行两个入口）', () => {
  const ASSET_TYPES = [{ name: 'notes', prefix: 'notes/' }] as const

  /** 断言拒绝原因**只**来自 `..` 守卫（不靠归一化 / 前缀守卫兜底）。 */
  function expectDotDotRejection(run: () => void, expectedReason: string): void {
    let caught: unknown
    try {
      run()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AssetPathError)
    const error = caught as AssetPathError
    // 1) 原因码精确相等：`..` 守卫是唯一产出 `path_dotdot_segment` 的地方。
    //    删掉该守卫后，同样的输入会落到 `path_not_normalized` → 本断言必红。
    expect(error.reasonCodes).toEqual(['path_dotdot_segment'])
    expect(error.hasReason('path_dotdot_segment')).toBe(true)
    // 2) 明确排除另外两条守卫的兜底原因（它们会把「删守卫」掩盖成绿灯）。
    expect(error.reasonCodes).not.toContain('path_not_normalized')
    expect(error.reasonCodes).not.toContain('path_outside_prefix')
    // 3) 文案精确匹配独有原因，而不是 `toContain('..')` ——
    //    错误信息会回显输入路径，`toContain('..')` 恒真，不能作为判据。
    expect(error.reasons[0]).toBe(expectedReason)
  }

  it('AssetWriter.register 收到 `notes/../escape.md` → 独有原因拒绝，且不产生任何文件', () => {
    const assetsDir = tempDir('dsh-rsi-ce-escape-')
    const writer = createAssetWriter({ runtime: { assetsDir }, assetTypes: [...ASSET_TYPES] })

    expectDotDotRejection(
      () => writer.register({ type: 'notes', path: 'notes/../escape.md', content: 'x' }),
      'spec[0].path：paths[0] "notes/../escape.md"：不得包含 ".." 路径段（不允许上溯父目录）',
    )
    expect(readdirSync(assetsDir)).toEqual([])
  })

  it('判别用例：`notes/../notes/ok.md` 归一化后仍在 prefix 内，仍必须由 `..` 守卫拒绝', () => {
    // 这条路径归一化得到 `notes/ok.md`（合法、位于 notes/ 之下）→ **前缀守卫会放行**，
    // 所以「被拒」不可能是前缀造成的。
    //
    // 说明一个结构性事实：任何含 `..` 的路径 `posix.normalize` 后都不等于自身，
    // 因此「只看是否被拒」永远无法证明 `..` 守卫在起作用（删掉它，归一化守卫仍
    // 会拒绝）。真正的判据只能是**原因**：本用例断言原因码恰为
    // `path_dotdot_segment`；删掉 `..` 守卫后原因会退化成 `path_not_normalized`，
    // 断言立刻变红（已实测，见交付报告）。
    const assetsDir = tempDir('dsh-rsi-ce-dotdot-')
    const writer = createAssetWriter({ runtime: { assetsDir }, assetTypes: [...ASSET_TYPES] })

    expectDotDotRejection(
      () => writer.register({ type: 'notes', path: 'notes/../notes/ok.md', content: 'x' }),
      'spec[0].path：paths[0] "notes/../notes/ok.md"：不得包含 ".." 路径段（不允许上溯父目录）',
    )
    expect(listFiles(assetsDir)).toEqual([])
  })

  it('`notes/./ok.md` 与 `notes//ok.md` 也各自命中独立原因码（不与 `..` 混用）', () => {
    const assetsDir = tempDir('dsh-rsi-ce-dot-')
    const writer = createAssetWriter({ runtime: { assetsDir }, assetTypes: [...ASSET_TYPES] })

    const cases: Array<{ path: string; code: AssetPathReasonCode }> = [
      { path: 'notes/./ok.md', code: 'path_dot_segment' },
      { path: 'notes//ok.md', code: 'path_empty_segment' },
    ]
    for (const item of cases) {
      let caught: unknown
      try {
        writer.register({ type: 'notes', path: item.path, content: 'x' })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(AssetPathError)
      const error = caught as AssetPathError
      expect(error.reasonCodes).toEqual([item.code])
      expect(error.hasReason('path_dotdot_segment')).toBe(false)
    }
    expect(listFiles(assetsDir)).toEqual([])
  })

  it('scheduler task_path 为 `../evil.js` → 拒绝并给出逃逸原因', () => {
    const home = tempDir('dsh-rsi-ce-home-')
    const resolved = resolveTaskPath(home, '../evil.js')
    expect(resolved.path).toBeUndefined()
    // 断言词法守卫的独有措辞（软链接守卫的文案是「软链接指向领域 home 之外」，
    // 不含「逃逸出领域 home」），避免用宽泛的 `逃逸` 掩盖守卫被删。
    expect(resolved.error).toContain('逃逸出领域 home')
    expect(resolved.error).toBe(`任务 task_path 逃逸出领域 home：../evil.js`)
  })
})

describe('反例 3 · 未知模板变量必败', () => {
  it('`{{ policy.evidence.unknown }}` → TemplateRenderError 且信息含变量名', () => {
    let caught: unknown
    try {
      renderTemplate('{{ policy.evidence.unknown }}', {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TemplateRenderError)
    expect((caught as Error).message).toContain('policy.evidence.unknown')
    expect((caught as TemplateRenderError).variable).toBe('policy.evidence.unknown')
  })
})

describe('反例 4 · type 未声明的注册必拒', () => {
  it('register 使用未在 assets.types 声明的 type → AssetRegisterError 且零落盘', () => {
    const assetsDir = tempDir('dsh-rsi-ce-type-')
    const writer = createAssetWriter({
      runtime: { assetsDir },
      assetTypes: [{ name: 'notes', prefix: 'notes/' }],
    })

    let caught: unknown
    try {
      writer.register({ type: 'unknown-type', path: 'notes/a.md', content: 'x' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AssetRegisterError)
    expect((caught as Error).message).toContain('未在 assets.types 中声明')
    expect(listFiles(assetsDir)).toEqual([])
  })
})

describe('反例 5 · 批量中一条非法则整批不落盘（文件清单 + commit 数双断言）', () => {
  it('1 条合法 + 1 条越界 → 文件清单不变、commit 数不变', () => {
    const home = tempDir('dsh-rsi-ce-atomic-')
    const repo = ensureAssetsRepo(home)
    expect(repo.degraded, '本用例需要真实 git 仓库').toBe(false)

    const before = listFiles(repo.dir)
    const beforeCommits = commitCount(repo.dir)

    const writer = createAssetWriter({
      runtime: { assetsDir: repo.dir },
      assetTypes: [{ name: 'notes', prefix: 'notes/' }],
    })

    let caught: unknown
    try {
      writer.register([
        { type: 'notes', path: 'notes/legal.md', content: '合法内容' },
        { type: 'notes', path: '../illegal.md', content: '越界内容' },
      ])
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AssetPathError)

    // 双断言：磁盘文件清单与 git 历史都不得发生任何变化。
    expect(listFiles(repo.dir)).toEqual(before)
    expect(commitCount(repo.dir)).toBe(beforeCommits)
    // 合法项确实不存在（不是「写了但没提交」）。
    expect(() => statSync(join(repo.dir, 'notes/legal.md'))).toThrow()
  })
})

describe('反例 6 · 异步 bootstrap 必败，错误信息含 `bootstrap`', () => {
  it('assets.bootstrap 声明为 async → install 抛 DomainPackValidationError，message 含 bootstrap', () => {
    const host = new AgentHost(new Context())
    const pack = makePack('ce-async-bootstrap', {
      assets: {
        types: [{ name: 'notes', prefix: 'notes/' }],
        bootstrap: (async () => {}) as unknown as () => void,
      },
    })

    let caught: unknown
    try {
      host.install(pack)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DomainPackValidationError)
    const error = caught as DomainPackValidationError
    expect(error.field).toBe('assets.bootstrap')
    expect(error.message).toContain('bootstrap')
    // 安装失败不得留下半个激活领域。
    expect(host.active).toBeUndefined()
  })
})

// 清理：本文件自建的目录（setup-env 的 HOME 由 vitest 进程退出时留待系统清理）。
process.on('exit', () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

/**
 * 契约变更：`DomainPack.disclaimer`、`SchedulerSpec.runtimes` / `tasksDir`，
 * 以及 AgentHost 的调度器装配与 `'scheduler'` 拆卸阶段。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentHost, TEARDOWN_ORDER } from '../src/service'
import {
  DISCLAIMER_MAX_BYTES,
  DomainPackValidationError,
  validateDomainPack,
} from '../src/validate'
import type { DomainPack } from '../src/types'

const roots: string[] = []

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rsi-contract-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

function makePack(overrides: Partial<DomainPack> = {}): DomainPack {
  return {
    apiVersion: 1,
    id: 'alpha-domain',
    version: '1.2.3',
    persona: { markdown: () => '# Alpha' },
    defaultSessionId: 'session-1',
    assets: { types: [{ name: 'notes', prefix: 'notes/' }] },
    scheduler: { timezone: 'Asia/Shanghai' },
    evolutionPolicy: { window: '7d', independentCases: 10 },
    tools: () => [],
    toolNames: [],
    ...overrides,
  }
}

describe('契约 · disclaimer', () => {
  it('缺省合法（undefined）', () => {
    expect(() => validateDomainPack(makePack())).not.toThrow()
  })

  it('非空字符串被接受', () => {
    const pack = makePack({ disclaimer: '本内容不构成投资建议' })
    expect(validateDomainPack(pack).pack.disclaimer).toBe('本内容不构成投资建议')
  })

  it('空串 / 纯空白 → 字段 disclaimer 报错', () => {
    for (const value of ['', '   ']) {
      try {
        validateDomainPack(makePack({ disclaimer: value }))
        throw new Error('should throw')
      } catch (error) {
        expect(error).toBeInstanceOf(DomainPackValidationError)
        expect((error as DomainPackValidationError).field).toBe('disclaimer')
      }
    }
  })

  it('非字符串 → 报错', () => {
    expect(() => validateDomainPack(makePack({ disclaimer: 1 as never }))).toThrow(/disclaimer/)
  })

  it('含孤立代理项 → 报错（非法 UTF-8）', () => {
    expect(() => validateDomainPack(makePack({ disclaimer: '\ud800' }))).toThrow(/UTF-8/)
  })

  it('超过 1024 字节 → 报错并给出实际字节数', () => {
    expect(DISCLAIMER_MAX_BYTES).toBe(1024)
    expect(() => validateDomainPack(makePack({ disclaimer: 'a'.repeat(1025) }))).toThrow(/1025/)
  })

  it('恰好 1024 字节 → 通过（边界闭区间）', () => {
    expect(() => validateDomainPack(makePack({ disclaimer: 'a'.repeat(1024) }))).not.toThrow()
  })
})

describe('契约 · scheduler.runtimes', () => {
  it('缺省合法', () => {
    expect(() => validateDomainPack(makePack())).not.toThrow()
  })

  it('字符串数组被接受', () => {
    expect(() =>
      validateDomainPack(makePack({ scheduler: { timezone: 'UTC', runtimes: ['node'] } })),
    ).not.toThrow()
  })

  it('非数组 → 报错', () => {
    expect(() =>
      validateDomainPack(makePack({ scheduler: { timezone: 'UTC', runtimes: 'node' as never } })),
    ).toThrow(/scheduler.runtimes/)
  })

  it('空字符串项 → 报错', () => {
    expect(() =>
      validateDomainPack(makePack({ scheduler: { timezone: 'UTC', runtimes: [''] } })),
    ).toThrow(/非空字符串/)
  })

  it('重复项 → 报错', () => {
    expect(() =>
      validateDomainPack(makePack({ scheduler: { timezone: 'UTC', runtimes: ['node', 'node'] } })),
    ).toThrow(/重复/)
  })

  it('首尾空白 → 报错', () => {
    expect(() =>
      validateDomainPack(makePack({ scheduler: { timezone: 'UTC', runtimes: [' node'] } })),
    ).toThrow(/首尾空白/)
  })
})

describe('契约 · scheduler.tasksDir', () => {
  it('相对路径被接受', () => {
    expect(() =>
      validateDomainPack(makePack({ scheduler: { timezone: 'UTC', tasksDir: 'data/tasks' } })),
    ).not.toThrow()
  })

  it('空串 / 非字符串 → 报错', () => {
    expect(() =>
      validateDomainPack(makePack({ scheduler: { timezone: 'UTC', tasksDir: '  ' } })),
    ).toThrow(/scheduler.tasksDir/)
    expect(() =>
      validateDomainPack(makePack({ scheduler: { timezone: 'UTC', tasksDir: 1 as never } })),
    ).toThrow(/scheduler.tasksDir/)
  })

  it('含空字符 → 报错', () => {
    expect(() =>
      validateDomainPack(makePack({ scheduler: { timezone: 'UTC', tasksDir: 'a\0b' } })),
    ).toThrow(/空字符/)
  })
})

describe('AgentHost · 调度器装配', () => {
  it("TEARDOWN_ORDER 首位是 'scheduler'", () => {
    expect(TEARDOWN_ORDER[0]).toBe('scheduler')
  })

  it('带 tasksDir 的领域可安装，dispose 幂等且不抛', () => {
    const home = tempHome()
    const tasksDir = join(home, 'alpha-domain', 'assets', 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    writeFileSync(
      join(tasksDir, 'demo.json'),
      JSON.stringify({
        id: 'demo',
        name: 'demo',
        cron: '0 9 * * *',
        task_path: 'programs/demo/task.mjs',
        enabled: true,
      }),
      'utf8',
    )

    const ctx = new Context()
    const host = new AgentHost(ctx)
    const disposable = host.install(makePack(), { home })
    expect(host.active?.id).toBe('alpha-domain')
    expect(() => disposable()).not.toThrow()
    expect(() => disposable()).not.toThrow()
    expect(host.active).toBeUndefined()
  })

  it('领域声明 disclaimer 后可安装（字段随 pack 保留）', () => {
    const home = tempHome()
    const ctx = new Context()
    const host = new AgentHost(ctx)
    const disposable = host.install(makePack({ disclaimer: '声明' }), { home })
    expect(host.active?.pack.disclaimer).toBe('声明')
    disposable()
  })

  it('scheduler.runtimes 声明未知运行时不影响安装（运行期按任务失败）', () => {
    const home = tempHome()
    const ctx = new Context()
    const host = new AgentHost(ctx)
    const pack = makePack({ scheduler: { timezone: 'Asia/Shanghai', runtimes: ['deno'] } })
    const disposable = host.install(pack, { home })
    expect(host.active).toBeDefined()
    disposable()
    expect(host.active).toBeUndefined()
  })
})

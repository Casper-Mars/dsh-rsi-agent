/**
 * Runtime 与路径体系（技术方案 §7 / §14.1）契约测试。
 *
 * 覆盖：
 *   1. 不同 home 的运行时路径两两不相交（用 `path.relative` 判定包含关系）；
 *   2. `data` / `logs` 目录权限严格为 `0o700`；
 *   3. 非法 sessionId 被拒绝且原因具体（空 / 特殊路径段 / 非法字符 / 超长）；
 *   4. `DSH_RSI_HOME` 覆盖 `config.homeRoot`（`vi.stubEnv`，用后恢复）；
 *   5. 目录真实落地（assets / data / logs / workspace）；
 *   6. 完整 boot 冒烟：`DSH_HOME` 隔离下 `runtime.home` 落在临时目录。
 *
 * 环境隔离由 `tests/setup-env.ts` 提供（默认 `DSH_RSI_HOME` 指向临时目录）。
 */
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentHost } from '../src/service'
import {
  CORE_DOMAIN_ID,
  DEFAULT_SESSION_ID,
  InvalidSessionIdError,
  PRIVATE_DIR_MODE,
  RSI_AGENT_HOME_NAME,
  SHARED_DIR_MODE,
  createDomainRuntime,
  describeSessionIdError,
  resolveHomeRoot,
  resolveSessionId,
  resolveTimezone,
  type RuntimePack,
} from '../src/runtime'
import { resolveCoreConfig } from '../src/config'
import type { DomainPack, ToolDefinition } from '../src/types'

const HOME_A = mkdtempSync(join(tmpdir(), 'dsh-rsi-rt-a-'))
const HOME_B = mkdtempSync(join(tmpdir(), 'dsh-rsi-rt-b-'))

const PACK: RuntimePack = {
  id: 'demo',
  version: '1.2.3',
  defaultSessionId: 'demo-session',
  scheduler: { timezone: 'Asia/Shanghai' },
}

/** `parent` 是否包含 `child`（相等也算包含）。 */
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  if (rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

function expectDisjoint(a: string, b: string): void {
  expect(contains(a, b), `${a} 不应包含 ${b}`).toBe(false)
  expect(contains(b, a), `${b} 不应包含 ${a}`).toBe(false)
}

function modeOf(dir: string): number {
  return statSync(dir).mode & 0o777
}

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// 1. 路径不相交
// ---------------------------------------------------------------------------
describe('路径体系：不同 home 完全不相交', () => {
  it('两个运行时的 home/assets/data/logs/workspace 两两无前缀包含关系', () => {
    const a = createDomainRuntime(PACK, { config: { homeRoot: HOME_A }, env: {} })
    const b = createDomainRuntime(PACK, { config: { homeRoot: HOME_B }, env: {} })

    expect(a.home).toBe(join(HOME_A, 'demo'))
    expect(b.home).toBe(join(HOME_B, 'demo'))

    // 两个 runtime 的四个子目录放在一起两两比较：既有跨 home 的不相交，
    // 也有同一 runtime 内部「兄弟目录互不包含」。
    const dirs = [
      a.assetsDir,
      a.dataDir,
      a.logsDir,
      a.workspaceDir,
      b.assetsDir,
      b.dataDir,
      b.logsDir,
      b.workspaceDir,
    ]
    for (let i = 0; i < dirs.length; i += 1) {
      for (let j = i + 1; j < dirs.length; j += 1) {
        expectDisjoint(dirs[i], dirs[j])
      }
    }

    // home 之间同样不相交；子目录必须严格位于各自 home 之下。
    expectDisjoint(a.home, b.home)
    for (const dir of dirs.slice(0, 4)) expect(contains(a.home, dir)).toBe(true)
    for (const dir of dirs.slice(4)) expect(contains(b.home, dir)).toBe(true)
    expect(dirs.every((p) => isAbsolute(p))).toBe(true)
  })

  it('路径布局固定为 <home>/{assets,data,logs,workspace}，且 home 已归一化', () => {
    const rt = createDomainRuntime(PACK, {
      // 带 `..` 与重复分隔符的 homeRoot 也必须归一化。
      config: { homeRoot: `${HOME_A}/x/../y/./` },
      env: {},
    })

    expect(rt.config.homeRoot).toBe(join(HOME_A, 'y'))
    expect(rt.home).toBe(join(HOME_A, 'y', 'demo'))
    expect(rt.assetsDir).toBe(join(rt.home, 'assets'))
    expect(rt.dataDir).toBe(join(rt.home, 'data'))
    expect(rt.logsDir).toBe(join(rt.home, 'logs'))
    expect(rt.workspaceDir).toBe(join(rt.home, 'workspace'))
  })

  it('无领域时落到 <homeRoot>/core', () => {
    const rt = createDomainRuntime(undefined, { config: { homeRoot: HOME_A }, env: {} })
    expect(rt.domainId).toBe(CORE_DOMAIN_ID)
    expect(rt.home).toBe(join(HOME_A, CORE_DOMAIN_ID))
    expect(existsDir(rt.logsDir)).toBe(true)
  })

  it('pack.id 试图逃逸 homeRoot 时被拒绝', () => {
    expect(() =>
      createDomainRuntime({ ...PACK, id: '../evil' }, { config: { homeRoot: HOME_A }, env: {} }),
    ).toThrow(/pack\.id/)
  })
})

function existsDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 2. 目录权限
// ---------------------------------------------------------------------------
describe('目录权限与创建', () => {
  it('data / logs 为 0o700，assets / workspace 为 0o755，且四个目录真实存在', () => {
    const rt = createDomainRuntime(PACK, { config: { homeRoot: HOME_A }, env: {} })

    expect(modeOf(rt.dataDir)).toBe(PRIVATE_DIR_MODE)
    expect(modeOf(rt.logsDir)).toBe(PRIVATE_DIR_MODE)
    expect(modeOf(rt.assetsDir)).toBe(SHARED_DIR_MODE)
    expect(modeOf(rt.workspaceDir)).toBe(SHARED_DIR_MODE)

    for (const dir of [rt.assetsDir, rt.dataDir, rt.logsDir, rt.workspaceDir]) {
      expect(existsDir(dir), `${dir} 应存在`).toBe(true)
    }
    expect(PRIVATE_DIR_MODE).toBe(0o700)
    expect(SHARED_DIR_MODE).toBe(0o755)
  })

  it('已存在的 homeRoot（0o700）不被放宽', () => {
    const privateRoot = mkdtempSync(join(tmpdir(), 'dsh-rsi-rt-private-'))
    chmodSync(privateRoot, 0o700)
    createDomainRuntime(PACK, { config: { homeRoot: privateRoot }, env: {} })
    expect(modeOf(privateRoot)).toBe(0o700)
  })

  it('重复创建幂等（已存在目录不报错，权限保持不变）', () => {
    const first = createDomainRuntime(PACK, { config: { homeRoot: HOME_A }, env: {} })
    const second = createDomainRuntime(PACK, { config: { homeRoot: HOME_A }, env: {} })
    expect(second.dataDir).toBe(first.dataDir)
    expect(modeOf(second.dataDir)).toBe(0o700)
  })
})

// ---------------------------------------------------------------------------
// 3. sessionId 校验
// ---------------------------------------------------------------------------
describe('sessionId 白名单与原因', () => {
  it.each([
    ['a/b', /非法字符/],
    ['..', /特殊路径段/],
    ['.', /特殊路径段/],
    ['a'.repeat(129), /超长/],
    ['', /不能为空/],
  ])('非法值 %j 被拒绝，原因匹配 %s', (value, pattern) => {
    let caught: unknown
    try {
      resolveSessionId({ options: { sessionId: value } })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InvalidSessionIdError)
    const error = caught as InvalidSessionIdError
    expect(error.reason).toMatch(pattern)
    expect(error.message).toContain('sessionId')
    expect(error.value).toBe(value)
  })

  it('超长原因包含实际长度与上限', () => {
    expect(describeSessionIdError('a'.repeat(129))).toContain('129')
    expect(describeSessionIdError('a'.repeat(129))).toContain('128')
  })

  it('合法值（含边界长度 128）通过', () => {
    expect(describeSessionIdError('a'.repeat(128))).toBeUndefined()
    expect(resolveSessionId({ options: { sessionId: 'a'.repeat(128) } })).toHaveLength(128)
    expect(resolveSessionId({ options: { sessionId: 'abc_1.2-3' } })).toBe('abc_1.2-3')
  })

  it('优先级：options > config > pack > 默认值', () => {
    expect(
      resolveSessionId({
        options: { sessionId: 'from-options' },
        config: { sessionId: 'from-config' },
        pack: { defaultSessionId: 'from-pack' },
      }),
    ).toBe('from-options')
    expect(
      resolveSessionId({
        config: { sessionId: 'from-config' },
        pack: { defaultSessionId: 'from-pack' },
      }),
    ).toBe('from-config')
    expect(resolveSessionId({ pack: { defaultSessionId: 'from-pack' } })).toBe('from-pack')
    expect(resolveSessionId({})).toBe(DEFAULT_SESSION_ID)
  })

  it('config 或 pack 提供非法值时同样拒绝（不静默跳过）', () => {
    expect(() => resolveSessionId({ config: { sessionId: 'a b' } })).toThrow(/非法字符/)
    expect(() => resolveSessionId({ pack: { defaultSessionId: '../x' } })).toThrow(/非法字符/)
  })

  it('运行时的 sessionId 采纳 install 选项，且优先级高于 config', () => {
    const rt = createDomainRuntime(PACK, {
      config: { homeRoot: HOME_A, sessionId: 'from-config' },
      installOptions: { sessionId: 'from-install' },
      env: {},
    })
    expect(rt.sessionId).toBe('from-install')
  })
})

// ---------------------------------------------------------------------------
// 4. 环境变量
// ---------------------------------------------------------------------------
describe('环境变量解析', () => {
  it('DSH_RSI_HOME 覆盖 config.homeRoot（stubEnv 并在用例后恢复）', () => {
    vi.stubEnv('DSH_RSI_HOME', '/tmp/x')
    expect(resolveHomeRoot({ homeRoot: '/tmp/configured' })).toBe('/tmp/x')

    const rt = createDomainRuntime(PACK, { config: { homeRoot: '/tmp/configured' } })
    expect(rt.config.homeRoot).toBe('/tmp/x')
    expect(rt.home).toBe(join('/tmp/x', 'demo'))

    vi.unstubAllEnvs()
    // 恢复后回到 setup 注入的临时 home，而不是 /tmp/x。
    expect(process.env.DSH_RSI_HOME).not.toBe('/tmp/x')
    expect(resolveHomeRoot({}, process.env)).toBe(process.env.DSH_RSI_HOME)
  })

  it('未设置 DSH_RSI_HOME 时回落到 config.homeRoot，再回落到 ~/.dsh-rsi-agent', () => {
    expect(resolveHomeRoot({ homeRoot: HOME_A }, {})).toBe(HOME_A)
    expect(resolveHomeRoot({}, {})).toBe(join(process.env.HOME ?? '', '.dsh-rsi-agent'))
  })

  it('DSH_HOME 重定向默认 home（dsh 宿主隔离语义）', () => {
    expect(resolveHomeRoot({}, { DSH_HOME: '/tmp/dsh-home' })).toBe(
      join('/tmp/dsh-home', RSI_AGENT_HOME_NAME),
    )
  })

  it('DSH_RSI_SESSION_ID / LOG_LEVEL / LOG_RETENTION_DAYS / LOG_MAX_SIZE 只由 config 解析', () => {
    const config = resolveCoreConfig(
      {},
      {
        DSH_RSI_SESSION_ID: 'env-session',
        DSH_RSI_LOG_LEVEL: 'debug',
        DSH_RSI_LOG_RETENTION_DAYS: '7',
        DSH_RSI_LOG_MAX_SIZE: '1MB',
      },
    )
    expect(config.sessionId).toBe('env-session')
    expect(config.logLevel).toBe('debug')
    expect(config.logRetentionDays).toBe(7)
    expect(config.logMaxSizeBytes).toBe(1024 * 1024)
  })

  it('非法环境变量给出具体原因', () => {
    expect(() => resolveCoreConfig({}, { DSH_RSI_LOG_LEVEL: 'verbose' })).toThrow(
      /DSH_RSI_LOG_LEVEL.*verbose/s,
    )
    expect(() => resolveCoreConfig({}, { DSH_RSI_LOG_RETENTION_DAYS: '7d' })).toThrow(
      /DSH_RSI_LOG_RETENTION_DAYS/,
    )
    expect(() => resolveCoreConfig({}, { DSH_RSI_LOG_MAX_SIZE: 'huge' })).toThrow(
      /DSH_RSI_LOG_MAX_SIZE/,
    )
  })

  it('DSH_RSI_HOME 为空字符串时视为未设置', () => {
    expect(resolveHomeRoot({ homeRoot: HOME_A }, { DSH_RSI_HOME: '   ' })).toBe(HOME_A)
  })
})

// ---------------------------------------------------------------------------
// 5. 时区与配置
// ---------------------------------------------------------------------------
describe('时区与 §14.1 默认值', () => {
  it('优先 config.timezone，其次 pack.scheduler.timezone，最后系统时区', () => {
    expect(resolveTimezone({ timezone: 'UTC' }, PACK)).toBe('UTC')
    expect(resolveTimezone({}, PACK)).toBe('Asia/Shanghai')
    expect(resolveTimezone({}, undefined)).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    )
  })

  it('非法 config.timezone 抛 RangeError 且点名字段', () => {
    expect(() => resolveTimezone({ timezone: 'Not/AZone' }, PACK)).toThrow(/时区/)
  })

  it('默认值：logLevel=info / startupGraceMs=500 / 30 天 / 500 MB', () => {
    const config = resolveCoreConfig({}, {})
    expect(config.logLevel).toBe('info')
    expect(config.startupGraceMs).toBe(500)
    expect(config.logRetentionDays).toBe(30)
    expect(config.logMaxSizeBytes).toBe(500 * 1024 * 1024)
  })

  it('startupGraceMs 超出 0–5000 抛 RangeError', () => {
    expect(() => resolveCoreConfig({ startupGraceMs: -1 }, {})).toThrow(/startupGraceMs/)
    expect(() => resolveCoreConfig({ startupGraceMs: 5001 }, {})).toThrow(/startupGraceMs/)
    expect(resolveCoreConfig({ startupGraceMs: 0 }, {}).startupGraceMs).toBe(0)
    expect(resolveCoreConfig({ startupGraceMs: 5000 }, {}).startupGraceMs).toBe(5000)
  })

  it('运行时把最终 homeRoot 写入 config（绝对路径）', () => {
    const rt = createDomainRuntime(PACK, { config: { homeRoot: HOME_B }, env: {} })
    expect(rt.config.homeRoot).toBe(HOME_B)
    expect(isAbsolute(rt.config.homeRoot)).toBe(true)
    expect(rt.timezone).toBe('Asia/Shanghai')
    expect(rt.config.sessionId).toBe('demo-session')
    expect(rt.config.timezone).toBe('Asia/Shanghai')
    expect(rt.domainVersion).toBe('1.2.3')
    expect(Object.isFrozen(rt)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. 真实 boot 冒烟：DSH_HOME 隔离
// ---------------------------------------------------------------------------
function makeBootPack(): DomainPack {
  const tool: ToolDefinition = {
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
    assets: {
      types: [
        { name: 'notes', prefix: 'notes/' },
        { name: 'skill', prefix: 'skills/' },
      ],
    },
    scheduler: { timezone: 'Asia/Shanghai' },
    evolutionPolicy: { window: '7d', independentCases: 10 },
    tools: () => [tool],
    toolNames: ['demo-echo'],
  }
}

describe('boot 冒烟（DSH_HOME 隔离，不触碰 ~/.dsh）', () => {
  it('domain 装配后 runtime.home 落到 $DSH_HOME/.dsh-rsi-agent/demo，四个目录真实存在', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'dsh-t04-'))
    vi.stubEnv('DSH_HOME', sandbox)
    vi.stubEnv('DSH_RSI_HOME', '')

    const ctx = new Context()
    const host = new AgentHost(ctx)
    const dispose = host.install(makeBootPack())

    const runtime = host.active!.runtime
    expect(runtime.home).toBe(join(sandbox, '.dsh-rsi-agent', 'demo'))
    for (const dir of [
      runtime.assetsDir,
      runtime.dataDir,
      runtime.logsDir,
      runtime.workspaceDir,
    ]) {
      expect(existsDir(dir), `${dir} 应真实存在`).toBe(true)
      expect(contains(runtime.home, dir)).toBe(true)
    }
    expect(modeOf(runtime.dataDir)).toBe(0o700)
    expect(modeOf(runtime.logsDir)).toBe(0o700)

    dispose()
    expect(host.active).toBeUndefined()
    // 清理沙箱，避免 /tmp 堆积。
    rmSync(sandbox, { recursive: true, force: true })
  })
})

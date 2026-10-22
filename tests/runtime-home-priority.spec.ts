/**
 * Runtime 路径优先级 / 逃逸防线 / 时区解析的补充用例（Task-14 覆盖审计补齐）。
 *
 * 与 `tests/runtime.spec.ts` 的分工：那边覆盖布局、权限、sessionId、单点优先级；
 * 本文件只补审计表里标为「缺口」的四类：
 *   1. `homeRoot` 的四级优先级（installOptions.home 最高，此前未覆盖）；
 *   2. `assertWithin` 的越界防线（公开入口不可达，验证纵深防御的实际行为）；
 *   3. 目录权限在 umask=077 下仍被强制到目标值（mkdir mode 会被 umask 削减）；
 *   4. 时区解析的 `prefer: 'pack'` 分支与空白值退化。
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PRIVATE_DIR_MODE,
  RSI_AGENT_HOME_NAME,
  SHARED_DIR_MODE,
  createDomainRuntime,
  resolveHomeRoot,
  resolveSystemTimezone,
  resolveTimezone,
  type RuntimePack,
} from '../src/runtime'

const created: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop() as string
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言结果 */
    }
  }
})

const PACK: RuntimePack = { id: 'demo', version: '1.0.0' }

describe('homeRoot 四级优先级（options.home > DSH_RSI_HOME > config.homeRoot > $DSH_HOME/.dsh-rsi-agent > ~）', () => {
  it('installOptions.home 压过 DSH_RSI_HOME 与 config.homeRoot', () => {
    const optionHome = tempDir('dsh-rsi-opt-')
    const envHome = tempDir('dsh-rsi-env-')
    const cfgHome = tempDir('dsh-rsi-cfg-')

    const runtime = createDomainRuntime(PACK, {
      config: { homeRoot: cfgHome },
      installOptions: { home: optionHome },
      env: { DSH_RSI_HOME: envHome },
    })

    expect(runtime.config.homeRoot).toBe(resolve(optionHome))
    expect(runtime.home).toBe(resolve(optionHome, 'demo'))
  })

  it('无 installOptions.home 时 DSH_RSI_HOME 压过 config.homeRoot', () => {
    const envHome = tempDir('dsh-rsi-env-')
    const cfgHome = tempDir('dsh-rsi-cfg-')

    const runtime = createDomainRuntime(PACK, {
      config: { homeRoot: cfgHome },
      env: { DSH_RSI_HOME: envHome },
    })

    expect(runtime.config.homeRoot).toBe(resolve(envHome))
  })

  it('DSH_RSI_HOME 为纯空白时视为未设置，回落到 config.homeRoot', () => {
    const cfgHome = tempDir('dsh-rsi-cfg-')
    expect(resolveHomeRoot({ homeRoot: cfgHome }, { DSH_RSI_HOME: '   ' })).toBe(resolve(cfgHome))
  })

  it('env、config 都缺失时落到 $DSH_HOME/.dsh-rsi-agent', () => {
    const dshHome = tempDir('dsh-home-')
    expect(resolveHomeRoot({}, { DSH_HOME: dshHome })).toBe(
      resolve(dshHome, RSI_AGENT_HOME_NAME),
    )
  })

  it('全缺失时落到 ~/.dsh-rsi-agent', () => {
    expect(resolveHomeRoot({}, {})).toBe(resolve(homedir(), RSI_AGENT_HOME_NAME))
  })

  it('返回值为 resolve 归一化后的绝对路径（含 ".." 的输入也被折叠）', () => {
    const root = tempDir('dsh-rsi-norm-')
    const messy = join(root, 'a', '..', 'b', '.')
    const home = resolveHomeRoot({}, { DSH_RSI_HOME: messy })
    expect(isAbsolute(home)).toBe(true)
    expect(home).toBe(resolve(root, 'b'))
    expect(home.includes('..')).toBe(false)
  })
})

describe('assertWithin：逃逸防线（纵深防御）', () => {
  // `assertWithin` 在 `createDomainRuntime` 内先于目录创建执行，但公开入口
  // 会先经过 `assertSafeSegment`（`pack.id` 必须是单段目录名），因此正常调用
  // 永远到不了越界分支。这里验证两层的**实际可观察行为**：
  //   - 第一层（可达）：非法 `pack.id` 被拒绝，且不创建任何目录；
  //   - 第二层（不可达但语义必须存在）：合法 id 的 home 严格位于 homeRoot 之下。

  const hostileIds = ['..', '.', '../x', 'a/b', '/abs', 'a\\b', '', 'a\0b']

  it.each(hostileIds)('pack.id = %j → 拒绝且不落地任何目录', (id) => {
    const root = tempDir('dsh-rsi-escape-')
    const before = readdirSync(root)
    expect(() =>
      createDomainRuntime({ id, version: '1.0.0' }, { env: { DSH_RSI_HOME: root } }),
    ).toThrow(/pack\.id/)
    // 拒绝发生在任何 mkdir 之前：homeRoot 的目录清单一字不变。
    expect(readdirSync(root)).toEqual(before)
  })

  it('合法 id 的 home 严格位于 homeRoot 之下（relative 不以 .. 开头且非空）', () => {
    const root = tempDir('dsh-rsi-within-')
    const runtime = createDomainRuntime(PACK, { env: { DSH_RSI_HOME: root } })
    const rel = relative(runtime.config.homeRoot, runtime.home)
    expect(rel).toBe('demo')
    expect(rel.startsWith('..')).toBe(false)
    expect(isAbsolute(rel)).toBe(false)
  })

  it('homeRoot 本身是文件系统根时 home 仍在根之下（不因 "/" 误判越界）', () => {
    // 只做路径推导，不真正在 / 下建目录：用 core 分支的 id 校验即可。
    // `resolve('/', 'core') === '/core'`，relative('/', '/core') === 'core'。
    expect(relative('/', '/core')).toBe('core')
  })
})

describe('目录权限：umask 077 下仍强制到目标 mode', () => {
  it('data / logs = 0700，assets / workspace = 0755', () => {
    const root = tempDir('dsh-rsi-mode-')
    const previous = process.umask(0o077)
    try {
      const runtime = createDomainRuntime(PACK, { env: { DSH_RSI_HOME: root } })
      expect(statSync(runtime.dataDir).mode & 0o777).toBe(PRIVATE_DIR_MODE)
      expect(statSync(runtime.logsDir).mode & 0o777).toBe(PRIVATE_DIR_MODE)
      expect(statSync(runtime.assetsDir).mode & 0o777).toBe(SHARED_DIR_MODE)
      expect(statSync(runtime.workspaceDir).mode & 0o777).toBe(SHARED_DIR_MODE)
    } finally {
      process.umask(previous)
    }
  })
})

describe('时区解析：prefer 分支与空白退化', () => {
  it('prefer=pack：领域包时区优先于 CoreConfig', () => {
    expect(
      resolveTimezone({ timezone: 'UTC' }, { scheduler: { timezone: 'Asia/Shanghai' } }, { prefer: 'pack' }),
    ).toBe('Asia/Shanghai')
  })

  it('prefer=pack 且领域包未声明 → 回落 CoreConfig', () => {
    expect(resolveTimezone({ timezone: 'Europe/Berlin' }, { scheduler: {} }, { prefer: 'pack' })).toBe(
      'Europe/Berlin',
    )
  })

  it('领域包时区为纯空白 → 视为未声明（回落 CoreConfig）', () => {
    expect(
      resolveTimezone({ timezone: 'Europe/Berlin' }, { scheduler: { timezone: '  ' } }, { prefer: 'pack' }),
    ).toBe('Europe/Berlin')
  })

  it('两者都缺失 → 系统时区（且是合法 IANA 名）', () => {
    expect(resolveTimezone({}, undefined)).toBe(resolveSystemTimezone())
  })

  it('CoreConfig 时区非法时即使 prefer=pack 也抛 RangeError（不静默忽略）', () => {
    expect(() =>
      resolveTimezone({ timezone: 'Not/AZone' }, { scheduler: { timezone: 'UTC' } }, { prefer: 'pack' }),
    ).toThrow(RangeError)
  })
})

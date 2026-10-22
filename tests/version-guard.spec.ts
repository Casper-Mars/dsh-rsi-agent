/**
 * 版本门槛守护（Task-14）。
 *
 * **为什么不是 `engines.dsh`**：2026-10-21 已拍板删除 `engines.dsh` —— 官方
 * manifest 不校验该字段，留着只会让「版本门槛」出现两个真源（engines 与实际
 * 解析到的 peer 区间）并静默漂移。版本门槛的**唯一真源是 `peerDependencies`**。
 * 本文件因此断言「`engines` 里没有 `dsh` 字段」作为回归保护：防止有人把已删除
 * 的字段加回来。
 *
 * 断言的写法约束（避免把版本号抄成第二份真源）：
 *   - 四个 `@deepseek-ai/dsh-*` peer 区间**互相相等**，且形如 `^0.2.x-rc.x`；
 *   - 具体字面量 `^0.2.0-rc.2` 在本文件只出现一次（{@link EXPECTED_PEER_RANGE}）；
 *   - devDependencies 的四个 dsh 包必须**钉死具体版本**（无 `^` / `~`），且
 *     `semver.satisfies(devVersion, peerRange, { includePrerelease: true })` 为真。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import semver from 'semver'
import { DOMAIN_API_VERSION } from '../src/types'

/** peer 区间的唯一字面量（本文件仅此一处）。 */
const EXPECTED_PEER_RANGE = '^0.2.0-rc.2'

/** 四个必须同版本的 dsh peer 包。 */
const DSH_PACKAGES = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tools',
] as const

interface PackageJson {
  engines?: Record<string, unknown>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson

describe('版本守护：engines 不再承载 dsh 门槛', () => {
  it('package.json.engines 不存在 dsh 字段（防止已删除字段被加回）', () => {
    expect(pkg.engines).toBeDefined()
    expect(pkg.engines).not.toHaveProperty('dsh')
    // node / pnpm 门槛仍在，避免「删字段」被写成「删整个 engines」。
    expect(pkg.engines).toHaveProperty('node')
    expect(pkg.engines).toHaveProperty('pnpm')
  })
})

describe('版本守护：四个 dsh peer 区间唯一', () => {
  it('四个 @deepseek-ai/dsh-* peer 全部存在', () => {
    for (const name of DSH_PACKAGES) {
      expect(pkg.peerDependencies?.[name], `缺少 peerDependency ${name}`).toBeTypeOf('string')
    }
  })

  it('四个 peer 区间完全一致', () => {
    const ranges = DSH_PACKAGES.map((name) => pkg.peerDependencies?.[name])
    expect(new Set(ranges).size, `区间不一致：${JSON.stringify(ranges)}`).toBe(1)
  })

  it('peer 区间形如 ^0.2.x-rc.x（具体值只在本文件出现一次）', () => {
    const range = pkg.peerDependencies?.[DSH_PACKAGES[0]]
    expect(range).toBe(EXPECTED_PEER_RANGE)
    // 结构断言与字面量断言并存：字面量改了这条会立刻暴露「四处没同步改」。
    expect(range).toMatch(/^\^0\.2\.\d+-rc\.\d+$/)
  })

  it('@deepseek-ai/cordis peer 存在且为 ^4.x', () => {
    const range = pkg.peerDependencies?.['@deepseek-ai/cordis']
    expect(range).toBeTypeOf('string')
    expect(range).toMatch(/^\^4\.\d+\.\d+$/)
  })
})

describe('版本守护：devDependencies 钉死且满足 peer 区间', () => {
  it('四个 dsh 包在 devDependencies 中钉死具体版本（无 ^ / ~）', () => {
    for (const name of DSH_PACKAGES) {
      const version = pkg.devDependencies?.[name]
      expect(version, `缺少 devDependency ${name}`).toBeTypeOf('string')
      expect(version, `${name} 必须钉死具体版本`).not.toMatch(/^[\^~]/)
      expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    }
  })

  it('dev 版本满足对应 peer 区间（includePrerelease）', () => {
    for (const name of DSH_PACKAGES) {
      const version = pkg.devDependencies?.[name] as string
      const range = pkg.peerDependencies?.[name] as string
      expect(
        semver.satisfies(version, range, { includePrerelease: true }),
        `${name}@${version} 不满足 peer ${range}`,
      ).toBe(true)
    }
  })
})

describe('版本守护：契约版本常量', () => {
  it('DOMAIN_API_VERSION === 1', () => {
    expect(DOMAIN_API_VERSION).toBe(1)
  })
})

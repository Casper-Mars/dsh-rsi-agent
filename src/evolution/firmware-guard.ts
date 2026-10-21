/**
 * 固件 SKILL 与领域资产的冲突防线（§10.1 / §11.3 / §6 职责边界）。
 *
 * 三个固件 SKILL 由 core 静态注册，**不落** `assets/skills/`，也不参与热更新。
 * 领域资产里的 SKILL 布局是 `skills/<skill-name>/SKILL.md`，因此只要领域包在
 * 同一路径下注册了与固件同名的目录，就会出现「同一份 SKILL 有两个真源」。
 *
 * 两层防线，缺一不可：
 *   1. **写盘边界**（primary，{@link createFirmwareSkillGuard}）：作为
 *      `createAssetWriter({ guard })` 的守卫注入。领域 bootstrap 注册冲突路径
 *      时在**写盘前**整批拒绝，因此**首次安装**也能当场拦住——装配顺序是
 *      「固件注册 → bootstrap」，只在固件注册时读磁盘抓不到首次安装的冲突。
 *   2. **既有资产比对**（secondary，{@link findFirmwareSkillAssetConflicts}）：
 *      固件注册阶段扫描资产目录 `skills/` 下已有条目，命中即抛契约错误。
 *      用于拦截本次升级前就已落盘的冲突资产（历史数据），不依赖磁盘可写。
 *
 * 领域语义（`skills/` 前缀、固件保留名）只存在于本模块；`assets/writer.ts`
 * 只提供与领域无关的 `guard` 钩子。
 */
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { FIRMWARE_SKILL_NAMES, type FirmwareSkillName } from './names.js'

/**
 * 领域 SKILL 资产的固定根目录名（`skills/<name>/SKILL.md`）。
 *
 * core 只认这一个布局：领域包若用别的前缀放 SKILL，就不是「可进化 SKILL」，
 * 不在本防线的保护范围内。
 */
export const SKILL_ASSET_ROOT = 'skills'

/** 大小写折叠后匹配固件保留名；未命中返回 `undefined`。 */
function asFirmwareName(segment: string): FirmwareSkillName | undefined {
  const folded = segment.toLowerCase()
  return FIRMWARE_SKILL_NAMES.find((name) => name === folded)
}

/**
 * 创建「固件保留名」写盘守卫。
 *
 * 返回值直接交给 `createAssetWriter({ guard })`：
 *   - 路径形如 `skills/<name>` 或 `skills/<name>/...` 且 `<name>` 命中
 *     {@link FIRMWARE_SKILL_NAMES} ⇒ 返回拒绝原因（点名冲突名）；
 *   - 其余路径一律 `undefined` 放行。
 *
 * 大小写按折叠比较：macOS（APFS 默认大小写不敏感）上 `Skills/Rsi-Evolution/`
 * 与保留目录是同一个目录项，不能因为大小写不同就放行。
 *
 * 签名定为「路径 → 字符串 | undefined」而不是抛异常：守卫是**声明式**的，
 * 调用方（writer）统一决定错误类型与包装方式；返回原因也让守卫保持纯函数、
 * 易单测，且不会把 assets 层和领域错误类型耦合在一起。
 */
export function createFirmwareSkillGuard(): (path: string) => string | undefined {
  return (path: string): string | undefined => {
    const segments = path.split('/')
    if (segments.length < 2) return undefined
    if (segments[0]?.toLowerCase() !== SKILL_ASSET_ROOT) return undefined
    const name = asFirmwareName(segments[1] as string)
    if (name === undefined) return undefined
    return (
      `路径 "${path}" 占用了 core 内置固件 SKILL 保留目录 "${SKILL_ASSET_ROOT}/${name}/"；` +
      `固件 SKILL "${name}" 由 core 静态注册，不落 assets、不参与热更新`
    )
  }
}

/**
 * 扫描资产目录，找出已落盘的固件同名条目（secondary 防线）。
 *
 * @param assetsDir 资产根目录；缺省 / 不存在 / 不可读时返回空数组（静默跳过，
 *   首次安装本来就没有资产目录，不应因此失败）。
 * @returns 命中的固件名（按 {@link FIRMWARE_SKILL_NAMES} 顺序，便于稳定断言）。
 */
export function findFirmwareSkillAssetConflicts(assetsDir?: string): FirmwareSkillName[] {
  if (typeof assetsDir !== 'string' || assetsDir === '') return []
  let entries: string[]
  try {
    entries = readdirSync(path.join(assetsDir, SKILL_ASSET_ROOT))
  } catch {
    // 目录不存在 / 无权限：没有可比对的既有资产。
    return []
  }
  const present = new Set(entries.map((entry) => entry.toLowerCase()))
  return FIRMWARE_SKILL_NAMES.filter((name) => present.has(name))
}

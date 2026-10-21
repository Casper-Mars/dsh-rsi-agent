/**
 * 资产历史版本内容读取 —— 技术方案 §9.4（历史工具）、§18 验收第 5 条、
 * §19（命令注入风险）。
 *
 * 三条硬约束：
 *   1. **注入**：`sha` 只接受 `/^[0-9a-f]{7,40}$/`，任何 `;`、空格、`$()`、
 *      反引号、`--output=` 都在调用 git **之前**被拒；git 本身也只走
 *      `execFile` 家族（argv 逐项传参、从不经 shell）。
 *   2. **字节保真**：`git cat-file -p` 的 stdout 以 `{ encoding: 'buffer' }`
 *      取原始字节（{@link runGitBuffer}）。若先用默认 utf8 解码，被截断的多字节
 *      序列会在解码阶段变成 U+FFFD，之后再怎么切都无法还原。
 *   3. **UTF-8 边界截断**：上限 {@link ASSET_SHOW_MAX_BYTES}；超出时按**码点**
 *      回退，`content` 永远是合法 UTF-8，**绝不出现 U+FFFD**（见
 *      {@link validUtf8PrefixLength}）。
 */
import type { AssetType } from '../types.js'
import { validateAssetPaths } from './commit.js'
import { runGitBuffer, type GitBufferRunner } from './git.js'

/** `sha` 允许的形状：7..40 位小写十六进制（缩写或完整 SHA）。 */
export const ASSET_SHOW_SHA_PATTERN = /^[0-9a-f]{7,40}$/

/** 单次返回内容的字节上限（256 KB）。 */
export const ASSET_SHOW_MAX_BYTES = 256 * 1024

/** `cat-file` 的输出缓冲下限（需求要求 ≥ 4 MB；这里给 16 MB）。 */
export const ASSET_SHOW_MAX_BUFFER = 16 * 1024 * 1024

/** `sha` 非法（调用方编程错误 / 疑似注入）。 */
export class AssetShaError extends Error {
  /** 被拒绝的原始值。 */
  readonly value: unknown

  constructor(value: unknown) {
    const shown = typeof value === 'string' ? JSON.stringify(value) : String(value)
    super(
      `[assets] sha 非法：${shown}；` +
        '必须匹配 /^[0-9a-f]{7,40}$/（7..40 位小写十六进制，不接受分支名 / 选项 / 任何 shell 字符）',
    )
    this.name = 'AssetShaError'
    this.value = value
  }
}

/** 读取历史版本内容失败（git 故障 / 对象不存在 / 超出 maxBuffer）。 */
export class AssetShowError extends Error {
  constructor(message: string) {
    super(`[assets] ${message}`)
    this.name = 'AssetShowError'
  }
}

/** {@link assetShow} 需要的运行时最小面。 */
export interface AssetShowRuntime {
  /** 资产仓库根目录（`<home>/assets`）。 */
  assetsDir: string
}

/** {@link assetShow} 入参。 */
export interface AssetShowInput {
  /** 运行时（含 `assetsDir`）。 */
  runtime: AssetShowRuntime
  /** 领域声明的资产类型（前缀白名单）。 */
  assetTypes: readonly AssetType[]
  /** 相对资产根目录的路径。 */
  path: string
  /** 目标版本：7..40 位小写十六进制 SHA。 */
  sha: string
  /** 自定义字节版 git 执行器（测试注入；缺省 {@link runGitBuffer}）。 */
  git?: GitBufferRunner
  /** git 命令超时。 */
  timeoutMs?: number
  /** 内容上限覆盖（测试用；缺省 {@link ASSET_SHOW_MAX_BYTES}）。 */
  maxBytes?: number
}

/** {@link assetShow} 结果。 */
export interface AssetShowResult {
  /** 归一化后的相对路径。 */
  path: string
  /** 实际读取的版本号（入参原样）。 */
  sha: string
  /** 文本内容（合法 UTF-8，永不含 U+FFFD）。 */
  content: string
  /** 是否因超出上限被截断。 */
  truncated: boolean
  /** 原始字节数（未截断时的完整大小）。 */
  bytes?: number
}

/** 校验 `sha` 格式（纯字符串比对，不触达 git）。 */
export function assertAssetSha(value: unknown): string {
  if (typeof value !== 'string' || !ASSET_SHOW_SHA_PATTERN.test(value)) {
    throw new AssetShaError(value)
  }
  return value
}

/**
 * 返回 `buf` 在 `limit` 字节内的**最长合法 UTF-8 前缀长度**（码点边界）。
 *
 * 同时处理两种「不完整」：
 *   - 末尾被 `limit` 截断的多字节序列 → 整段丢弃（回退到码点边界）；
 *   - 文件本身含非法 UTF-8 字节 → 在第一个非法字节前停下。
 *
 * 因此 `buf.subarray(0, 结果).toString('utf8')` 不可能产生 U+FFFD。
 */
export function validUtf8PrefixLength(buf: Buffer, limit: number): number {
  const max = Math.min(limit, buf.length)
  let index = 0
  while (index < max) {
    const lead = buf[index] as number
    let extra: number
    let minSecond = 0x80
    let maxSecond = 0xbf

    if (lead < 0x80) {
      index += 1
      continue
    }
    if (lead >= 0xc2 && lead <= 0xdf) {
      extra = 1
    } else if (lead >= 0xe0 && lead <= 0xef) {
      extra = 2
      // 排除过长编码与 UTF-16 代理区
      if (lead === 0xe0) minSecond = 0xa0
      if (lead === 0xed) maxSecond = 0x9f
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      extra = 3
      // 排除超出 U+10FFFF 的编码
      if (lead === 0xf0) minSecond = 0x90
      if (lead === 0xf4) maxSecond = 0x8f
    } else {
      // 续字节出现在首字节位置，或 0xc0 / 0xc1 / 0xf5..0xff：非法
      break
    }

    // 序列不完整（被 limit 截断）：整段丢弃，回退到本码点之前。
    if (index + extra >= max) break

    const second = buf[index + 1] as number
    if (second < minSecond || second > maxSecond) break
    let valid = true
    for (let offset = 2; offset <= extra; offset += 1) {
      const byte = buf[index + offset] as number
      if (byte < 0x80 || byte > 0xbf) {
        valid = false
        break
      }
    }
    if (!valid) break

    index += extra + 1
  }
  return index
}

/**
 * 按 UTF-8 码点边界截断为文本。
 *
 * @param buf 原始字节。
 * @param maxBytes 上限（字节）。
 * @returns `content` 永远是合法 UTF-8 字符串；`truncated` 表示有字节被丢弃。
 */
export function decodeTruncatedUtf8(
  buf: Buffer,
  maxBytes: number = ASSET_SHOW_MAX_BYTES,
): { content: string; truncated: boolean; bytes: number } {
  const bytes = buf.length
  const keep = validUtf8PrefixLength(buf, maxBytes)
  return {
    content: buf.subarray(0, keep).toString('utf8'),
    truncated: keep < bytes,
    bytes,
  }
}

/**
 * 读取某个资产文件在指定版本下的内容。
 *
 * @throws {AssetShaError} `sha` 不匹配 `/^[0-9a-f]{7,40}$/`（**不发生任何 git 调用**）。
 * @throws {AssetPathError} `path` 非法（**不发生任何 git 调用**）。
 * @throws {AssetShowError} git 故障 / 该版本下不存在该文件。
 */
export function assetShow(input: AssetShowInput): AssetShowResult {
  const sha = assertAssetSha(input.sha)
  const paths = validateAssetPaths([input.path], input.assetTypes)
  const path = paths[0] as string

  const dir = input.runtime?.assetsDir
  if (typeof dir !== 'string' || dir === '') {
    throw new TypeError('[assets] assetShow 需要 runtime.assetsDir（非空字符串）')
  }

  const timeoutMs = input.timeoutMs
  const run = (args: readonly string[]): ReturnType<GitBufferRunner> =>
    input.git !== undefined
      ? input.git(args, dir)
      : runGitBuffer(args, dir, {
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          maxBuffer: ASSET_SHOW_MAX_BUFFER,
        })

  // `${sha}:${path}` 作为**单个** argv 项传入：sha 已被正则锁定，path 已通过
  // 白名单校验（无 `..` / 绝对路径 / 反斜杠），不存在选项注入面。
  const result = run(['-C', dir, 'cat-file', '-p', `${sha}:${path}`])
  if (!result.ok) {
    throw new AssetShowError(
      `读取 ${sha}:${path} 失败（exit ${result.code}）：${result.stderr.trim()}`,
    )
  }

  const decoded = decodeTruncatedUtf8(
    result.stdout,
    input.maxBytes ?? ASSET_SHOW_MAX_BYTES,
  )
  return {
    path,
    sha,
    content: decoded.content,
    truncated: decoded.truncated,
    bytes: decoded.bytes,
  }
}

/**
 * 资源搬运脚本：把 `tsc` 不会产出的资源带进 `dist-server/`。
 *
 * 1. `src/**` 下的 Markdown 资源（SKILL 指南 / 人设 prompt）按原相对路径复制，
 *    使编译态下 `new URL('./x.md', import.meta.url)` 依然可解析；
 * 2. 仓库根的 `cordis.patch.yml` 复制到 `dist-server/cordis.patch.yml`，
 *    保证产物目录自包含（bundle 校验与离线分发均可直接读取）。
 *
 * 写入方式：读源 → 写唯一临时文件 → 原子 rename 覆盖目标，幂等且并发安全
 * （`fs.cpSync` 在并发下会对同一目标抛 EEXIST）。
 *
 * 用法：`node scripts/copy-assets.mjs`（由 `build` / `build:server` 调用）。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(root, 'src')
const outDir = path.join(root, 'dist-server')

/** 需要搬运的资源扩展名。 */
const ASSET_EXTENSIONS = new Set(['.md'])

/** 递归遍历目录，返回匹配扩展名的文件（相对 `srcDir` 的路径）。 */
function collectAssets(dir) {
  const results = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry)
    if (statSync(abs).isDirectory()) {
      results.push(...collectAssets(abs))
    } else if (ASSET_EXTENSIONS.has(path.extname(entry))) {
      results.push(path.relative(srcDir, abs))
    }
  }
  return results
}

/** 幂等写入：读源 → 写唯一临时文件 → 原子 rename 覆盖目标。 */
function copyAssetIdempotent(from, to) {
  mkdirSync(path.dirname(to), { recursive: true })
  const content = readFileSync(from)
  const tmp = `${to}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, content)
    renameSync(tmp, to)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore cleanup failure */
    }
    throw err
  }
}

mkdirSync(outDir, { recursive: true })

let count = 0
for (const rel of collectAssets(srcDir)) {
  const from = path.join(srcDir, rel)
  const to = path.join(outDir, rel)
  copyAssetIdempotent(from, to)
  console.log(`[dsh-rsi-agent-assets] ${path.relative(root, from)} -> ${path.relative(root, to)}`)
  count += 1
}

const patch = path.join(root, 'cordis.patch.yml')
if (existsSync(patch)) {
  const to = path.join(outDir, 'cordis.patch.yml')
  copyAssetIdempotent(patch, to)
  console.log(`[dsh-rsi-agent-assets] cordis.patch.yml -> ${path.relative(root, to)}`)
  count += 1
}

console.log(`[dsh-rsi-agent-assets] 共搬运 ${count} 个资源文件到 dist-server/`)

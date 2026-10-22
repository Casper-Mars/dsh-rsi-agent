#!/usr/bin/env node
/**
 * 领域词检查：core 仓库不得出现任何具体领域的业务词（Task-14 §四）。
 *
 * 背景：`dsh-rsi-agent` 是**与领域无关**的运行时；一旦 `src/` 里混入金融 /
 * 投资等词，领域无关性就被悄悄破坏（人设、提示词、默认文案都可能被带偏）。
 *
 * 规则：
 *   - 扫描 `src/**`（全部文本文件，跳过二进制）；
 *   - 匹配 finance / investment / ledger / predict / 金融 / 股票 / ETF，大小写不敏感；
 *   - 命中即打印 `文件:行号: 行内容` 并 exit 1；
 *   - 文件级白名单**为空**（不得豁免：豁免一次就会有第二次）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SCAN_DIR = join(ROOT, 'src')

/** 禁止出现的领域词（大小写不敏感）。 */
const FORBIDDEN = ['finance', 'investment', 'ledger', 'predict', '金融', '股票', 'ETF']

/** 文件级白名单：故意为空 —— 不允许任何文件豁免。 */
const ALLOWLIST = new Set([])

const PATTERN = new RegExp(`(${FORBIDDEN.join('|')})`, 'gi')

const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip'])

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(full))
    } else if (entry.isFile()) {
      files.push(full)
    }
  }
  return files
}

function main() {
  const problems = []

  let files
  try {
    files = walk(SCAN_DIR)
  } catch (error) {
    console.error(`[check-domain-words] 无法读取 ${SCAN_DIR}：${error.message}`)
    process.exit(2)
  }

  for (const file of files.sort()) {
    const rel = relative(ROOT, file)
    if (ALLOWLIST.has(rel)) continue
    if (BINARY_EXTENSIONS.has(rel.slice(rel.lastIndexOf('.')).toLowerCase())) continue

    let content
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // 跳过明显的二进制内容（含 NUL 字节）。
    if (content.includes('\0')) continue

    const lines = content.split('\n')
    lines.forEach((line, index) => {
      PATTERN.lastIndex = 0
      const match = PATTERN.exec(line)
      if (match !== null) {
        problems.push(`${rel}:${index + 1}: ${line.trim()}（命中 "${match[0]}"）`)
      }
    })
  }

  if (problems.length > 0) {
    console.error('[check-domain-words] 发现领域词（core 必须与领域无关）：')
    for (const problem of problems) console.error(`  ${problem}`)
    console.error(`\n共 ${problems.length} 处。请把领域相关文案/常量移到领域包。`)
    process.exit(1)
  }

  console.log(`[check-domain-words] OK：${files.length} 个文件，未发现禁用领域词。`)
}

main()

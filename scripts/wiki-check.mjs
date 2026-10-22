#!/usr/bin/env node
/**
 * 文档一致性检查（Task-14 §四）。
 *
 * 不是空壳：三条检查都会真实读文件、真实比对，任一失败 exit 1 并列出具体问题。
 *
 * 1. **路径引用存在**：`README.md` / `M0-组合验证.md` / `docs/**\/*.md` 中的
 *    - 相对 Markdown 链接（`[文本](相对路径)`），以及
 *    - 反引号里的仓库路径（`src/...`、`tests/...`、`scripts/...`、`docs/...`、
 *      `skills/...` 或根目录已知文件）
 *    必须真实存在。裸文件名（如 `service.ts`）不判定，避免误伤「模块名」叙述。
 *
 *    **例外（构建产物）**：`dist/`、`dist-server/`、`node_modules/`、`coverage/`
 *    被 `.gitignore` 排除，干净 clone 里不存在是正常的，只校验命名合理性、
 *    不校验存在性（并在输出里列出被跳过的引用）。
 * 2. **废弃概念**：文档不得出现 `engines.dsh`（唯一白名单：同一行明确写了
 *    「已删除 / 已废弃 / 不得 / 禁止」的说明行）、`skills.evolvable`、`SeedSkill`。
 * 3. **脚本文件存在**：`package.json` 的 `scripts` 里 `node <path>` 引用的文件
 *    必须存在（防止改名后 CI 静默跳过）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const ROOT = process.cwd()
const DOCS = ['README.md', 'M0-组合验证.md']
const DOCS_DIR = join(ROOT, 'docs')

/** 反引号中可识别为「仓库路径」的前缀。 */
const PATH_PREFIXES = ['src/', 'tests/', 'scripts/', 'docs/', 'skills/', 'dist-server/']

/**
 * 构建产物 / 依赖目录：**不校验存在性**。
 *
 * 这些目录被 `.gitignore` 排除，干净 clone（CI）里本来就不存在；若把它们当普通
 * 代码路径校验，verify job 必然在 Docs consistency 红（构建产物只有在 `pnpm build`
 * 之后才出现，而 CI 用的是 `tsc --noEmit`）。对这类引用只做「命名合理性」检查。
 */
const BUILD_PREFIXES = ['dist/', 'dist-server/', 'node_modules/', 'coverage/']

/** 命中的构建产物前缀（未命中返回 undefined）。 */
function buildPrefixOf(candidate) {
  return BUILD_PREFIXES.find((prefix) => candidate === prefix.slice(0, -1) || candidate.startsWith(prefix))
}

/** 根目录已知文件（反引号内出现即视为路径引用）。 */
const ROOT_FILES = new Set([
  'README.md',
  'M0-组合验证.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.server.json',
  'tsconfig.type-tests.json',
  'vitest.config.ts',
  'cordis.patch.yml',
  'LICENSE',
  '.gitignore',
])

/** 废弃概念 → 白名单判定。 */
const DEPRECATED = [
  {
    token: 'engines.dsh',
    allowed: (line) => /已删除|已废弃|不得|禁止/.test(line),
  },
  { token: 'skills.evolvable', allowed: () => false },
  { token: 'SeedSkill', allowed: () => false },
]

const problems = []

function collectDocs() {
  const docs = []
  for (const name of DOCS) {
    const full = join(ROOT, name)
    if (existsSync(full)) docs.push(full)
  }
  if (existsSync(DOCS_DIR) && statSync(DOCS_DIR).isDirectory()) {
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile() && entry.name.endsWith('.md')) docs.push(full)
      }
    }
    walk(DOCS_DIR)
  }
  return docs
}

function isExternal(target) {
  return (
    target === '' ||
    target.startsWith('#') ||
    target.startsWith('http://') ||
    target.startsWith('https://') ||
    target.startsWith('mailto:') ||
    target.startsWith('tel:')
  )
}

/** 去掉链接目标里的锚点与查询串。 */
function cleanTarget(target) {
  return target.split('#')[0].split('?')[0]
}

function checkLinks(file, content) {
  const relFile = relative(ROOT, file)
  const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let match
  while ((match = linkPattern.exec(content)) !== null) {
    const raw = match[1].trim()
    if (isExternal(raw)) continue
    const target = cleanTarget(raw)
    if (target === '') continue
    if (isAbsolute(target)) {
      problems.push(`${relFile}: 绝对路径链接不受支持：${raw}`)
      continue
    }
    const resolved = resolve(dirname(file), target)
    if (!existsSync(resolved)) {
      problems.push(`${relFile}: 链接目标不存在：${raw}`)
    }
  }
}

/**
 * 构建产物引用的「命名合理性」：目录本身（`dist-server/`）放行；具体文件必须
 * 带扩展名（`dist-server/index.js` 合理，`dist-server/index` 不合理）。
 *
 * @returns {string | undefined} 不合理原因。
 */
function buildArtifactNamingProblem(candidate) {
  const trimmed = candidate.replace(/\/$/, '')
  const segments = trimmed.split('/').filter((segment) => segment !== '')
  const last = segments[segments.length - 1] ?? ''
  if (/^[\w.-]+\.[A-Za-z0-9]+$/.test(last)) return undefined
  if (segments.length === 1) return undefined // 只引用目录本身（dist-server）→ 合理
  return `构建产物路径缺少文件扩展名：${candidate}`
}

function checkCodePaths(file, content, skipped) {
  const relFile = relative(ROOT, file)
  const codePattern = /`([^`\n]+)`/g
  let match
  while ((match = codePattern.exec(content)) !== null) {
    let candidate = match[1].trim()
    // 去掉常见行内修饰：命令行前缀 / 结尾标点。
    candidate = candidate.replace(/^\$\s+/, '').replace(/[，。；：、]$/, '')
    if (candidate === '' || candidate.includes(' ')) continue
    if (isExternal(candidate) || candidate.startsWith('/')) continue
    // glob / 占位符（`dist-server/*.js`）不是具体路径，跳过。
    if (/[*?{}\[\]]/.test(candidate)) continue

    const looksLikeRepoPath =
      PATH_PREFIXES.some((prefix) => candidate.startsWith(prefix)) || ROOT_FILES.has(candidate)
    if (!looksLikeRepoPath) continue

    const cleanPath = cleanTarget(candidate)
    const target = cleanPath.replace(/\/$/, '')
    if (target === '') continue

    // 构建产物 / 依赖目录：干净 clone 里不存在是正常的 —— 只校验命名，不校验存在性。
    if (buildPrefixOf(cleanPath) !== undefined) {
      const namingProblem = buildArtifactNamingProblem(cleanPath)
      if (namingProblem !== undefined) problems.push(`${relFile}: ${namingProblem}`)
      skipped.push(`${relFile}: ${candidate}`)
      continue
    }

    if (!existsSync(join(ROOT, target))) {
      problems.push(`${relFile}: 代码路径不存在：${candidate}`)
    }
  }
}

function checkDeprecated(file, content) {
  const relFile = relative(ROOT, file)
  const lines = content.split('\n')
  lines.forEach((line, index) => {
    for (const rule of DEPRECATED) {
      if (!line.includes(rule.token)) continue
      if (rule.allowed(line)) continue
      problems.push(
        `${relFile}:${index + 1}: 出现废弃概念 "${rule.token}"：${line.trim()}`,
      )
    }
  })
}

function checkScripts() {
  const pkgPath = join(ROOT, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (error) {
    problems.push(`package.json: 无法解析（${error.message}）`)
    return
  }
  const scripts = pkg.scripts ?? {}
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue
    const nodePattern = /(?:^|[\s;&|])node\s+([^\s;&|]+)/g
    let match
    while ((match = nodePattern.exec(command)) !== null) {
      const target = match[1].trim()
      if (target.startsWith('-')) continue
      const clean = cleanTarget(target)
      if (!existsSync(join(ROOT, clean))) {
        problems.push(`package.json: scripts.${name} 引用的脚本不存在：${clean}`)
      }
    }
  }
}

function main() {
  const docs = collectDocs()
  if (docs.length === 0) {
    problems.push('未找到任何文档（README.md / M0-组合验证.md / docs/**/*.md）')
  }

  /** 被跳过的构建产物引用（输出里说明，避免「静默不查」的错觉）。 */
  const skipped = []

  for (const file of docs) {
    let content
    try {
      content = readFileSync(file, 'utf8')
    } catch (error) {
      problems.push(`${relative(ROOT, file)}: 无法读取（${error.message}）`)
      continue
    }
    checkLinks(file, content)
    checkCodePaths(file, content, skipped)
    checkDeprecated(file, content)
  }

  checkScripts()

  if (problems.length > 0) {
    console.error('[wiki-check] 发现问题：')
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(`\n共 ${problems.length} 个问题。`)
    process.exit(1)
  }

  if (skipped.length > 0) {
    console.log(
      `[wiki-check] 跳过 ${skipped.length} 处构建产物引用（dist/ dist-server/ node_modules/ coverage/ 由 .gitignore 排除，不校验存在性）：`,
    )
    for (const item of skipped) console.log(`  · ${item}`)
  }
  console.log(`[wiki-check] OK：${docs.length} 个文档，链接 / 代码路径 / 废弃概念一致。`)
}

main()

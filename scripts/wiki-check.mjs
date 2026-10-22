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
 * 2. **废弃概念**：文档不得出现 `engines.dsh`、`skills.evolvable`、`SeedSkill`。
 *    白名单**按命中所在分句**判定：以 `。；;，,` 切句，只有该次命中所属分句里
 *    明确写了「已删除 / 已废弃 / 不得 / 禁止 / 不使用」才放行；同一行其它分句
 *    的免责词不得赦免本分句（防止「已启用 X，… 不得 …」这类同句洗白）。
 * 3. **脚本文件存在**：`package.json` 的 `scripts` 里 `node <path>` 引用的文件
 *    必须存在（防止改名后 CI 静默跳过）。
 * 4. **文档必备内容**（Task-15）：README.md 的四个关键小节、CHANGELOG.md 的
 *    首版本与双版本号、AGENTS.md 的两条边界必须真实出现。删掉即 exit 1，
 *    防止「文档还在、契约被悄悄删了」。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const ROOT = process.cwd()
const DOCS = ['README.md', 'AGENTS.md', 'CHANGELOG.md', 'M0-组合验证.md']
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
  'AGENTS.md',
  'CHANGELOG.md',
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

/**
 * 废弃概念 → 白名单判定。
 *
 * 免责词只对**命中位置所在分句**生效（见 {@link clauseAt}）：同一行里别处的
 * 免责词不能为本分句背书。
 */
const DEPRECATED = [
  { token: 'engines.dsh' },
  { token: 'skills.evolvable' },
  { token: 'SeedSkill' },
]

/** 分句边界（中英文标点对齐）。 */
const CLAUSE_BOUNDARY = new Set(['。', '；', ';', '，', ','])

/** 分句内的免责词。 */
const DISCLAIMERS = /已删除|已废弃|不得|禁止|不使用/

/**
 * 取 `index` 所在分句（不跨行；`。；;，,` 为边界）。
 *
 * @returns 命中位置所属的分句文本。
 */
function clauseAt(line, index) {
  let start = 0
  for (let i = index - 1; i >= 0; i -= 1) {
    if (CLAUSE_BOUNDARY.has(line[i])) {
      start = i + 1
      break
    }
  }
  let end = line.length
  for (let i = index; i < line.length; i += 1) {
    if (CLAUSE_BOUNDARY.has(line[i])) {
      end = i
      break
    }
  }
  return line.slice(start, end)
}

/**
 * 文档必备内容（Task-15）。
 *
 * 只判「必须出现这些字样」，不约束顺序 / 措辞细节；目的是让「删掉版本契约 /
 * 删掉 home 说明」这类退化在 CI 里立刻可见。
 */
const REQUIRED_CONTENT = [
  {
    file: 'README.md',
    needles: ['home 切换与资产可见性', '不要用 allow-version 豁免', '版本契约', '首发形态'],
  },
  {
    file: 'CHANGELOG.md',
    needles: ['## [0.1.0]', '0.2.0-rc.2', '0.2.1-rc.2'],
  },
  {
    file: 'AGENTS.md',
    needles: ['领域', 'AssetWriter'],
  },
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
      // 逐个命中单独判定：同一行出现多次、或命中分布在不同分句时，每处都必须
      // 有自己的分句级免责词；任意一处未豁免即记账。
      let offset = line.indexOf(rule.token)
      while (offset !== -1) {
        const clause = clauseAt(line, offset)
        if (!DISCLAIMERS.test(clause)) {
          problems.push(
            `${relFile}:${index + 1}: 出现废弃概念 "${rule.token}"：${line.trim()}`,
          )
          break
        }
        offset = line.indexOf(rule.token, offset + rule.token.length)
      }
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

/** 校验文档必备内容：文件缺失或缺少任一 needle 都记账。 */
function checkRequiredContent() {
  for (const rule of REQUIRED_CONTENT) {
    const full = join(ROOT, rule.file)
    if (!existsSync(full)) {
      problems.push(`${rule.file}: 必备文档不存在`)
      continue
    }
    let content
    try {
      content = readFileSync(full, 'utf8')
    } catch (error) {
      problems.push(`${rule.file}: 无法读取（${error.message}）`)
      continue
    }
    for (const needle of rule.needles) {
      if (!content.includes(needle)) {
        problems.push(`${rule.file}: 缺少必备内容 "${needle}"`)
      }
    }
  }
}

function main() {
  const docs = collectDocs()
  if (docs.length === 0) {
    problems.push(
      '未找到任何文档（README.md / AGENTS.md / CHANGELOG.md / M0-组合验证.md / docs/**/*.md）',
    )
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
  checkRequiredContent()

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
  const needles = REQUIRED_CONTENT.reduce((sum, rule) => sum + rule.needles.length, 0)
  console.log(
    `[wiki-check] OK：${docs.length} 个文档，链接 / 代码路径 / 废弃概念一致；` +
      `${REQUIRED_CONTENT.length} 份必备文档的 ${needles} 条必备内容齐全。`,
  )
}

main()

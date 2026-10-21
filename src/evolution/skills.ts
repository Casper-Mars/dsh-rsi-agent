/**
 * 固件 SKILL 的加载与注册（§10.1 / §11.3）。
 *
 * 三个固件 SKILL 随包发布，落在仓库根的 `skills/`（构建时复制到
 * `dist-server/skills/`）：
 *   - `rsi-evolution`：进化闭环规范，**正文含模板变量**，注册前按策略渲染；
 *   - `skill-authorship`：可进化 SKILL 的创作规范；
 *   - `task-authorship`：任务程序的结构契约。
 *
 * 路径解析同时兼容两种运行形态：
 *   - 源码 / 测试态：`src/evolution/skills.ts` → `<repo>/skills/`；
 *   - 发布态：`dist-server/evolution/skills.js` → `<repo>/dist-server/skills/`。
 * 逐个探测，取第一个含 `rsi-evolution/SKILL.md` 的目录。
 *
 * 注册走 `ctx.skills.register()` 静态注册（不经文件系统 provider、不落数据目录）；
 * dispose 由调用方把返回的 unregister 数组压入 teardown 的 `firmwareSkills` 阶段。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import type { AssetType, DomainPack } from '../types.js'
import { createDomainLogger } from '../runtime.js'
import { DomainPackValidationError } from '../validate.js'
import type { EvolutionPolicy } from './policy.js'
import { renderTemplate, type TemplateVars } from './template.js'

/** 三个固件 SKILL 名（kebab-case，顺序即注册顺序）。 */
export const FIRMWARE_SKILL_NAMES = Object.freeze([
  'rsi-evolution',
  'skill-authorship',
  'task-authorship',
] as const)

/** 固件 SKILL 名联合类型。 */
export type FirmwareSkillName = (typeof FIRMWARE_SKILL_NAMES)[number]

/** 需要模板渲染的固件 SKILL。 */
export const EVOLUTION_SKILL_NAME = 'rsi-evolution' as const

/** 一个已读取的固件 SKILL。 */
export interface LoadedFirmwareSkill {
  /** 目录名（同时要求等于 frontmatter.name）。 */
  readonly name: FirmwareSkillName
  /** SKILL.md 原文（含 frontmatter）。 */
  readonly content: string
  /** SKILL.md 的绝对路径。 */
  readonly path: string
}

/** 解析后的 frontmatter（三字段必填）。 */
export interface SkillFrontmatter {
  readonly name: string
  readonly description: string
  readonly whenToUse: string
}

/** 解析结果：frontmatter + 去掉 frontmatter 的正文。 */
export interface ParsedSkillMarkdown {
  readonly frontmatter: SkillFrontmatter
  readonly content: string
}

/** `registerFirmwareSkills` 的入参。 */
export interface RegisterFirmwareSkillsOptions {
  /** 领域包（只读使用 id / displayName / skills 声明）。 */
  readonly pack: Pick<DomainPack, 'id' | 'displayName' | 'skills'>
  /** 已合并的生效策略。 */
  readonly policy: EvolutionPolicy
  /** 领域资产类型（渲染 `{{assets}}` 用）。 */
  readonly assetTypes: readonly AssetType[]
}

/** `ctx.skills` 的最小结构：只依赖 dsh-skill 的公开 `register`。 */
interface SkillRegistryLike {
  register(skill: SkillRegistration): () => void
}

function readService(ctx: Context, name: string): unknown {
  const getter = (ctx as unknown as { get?: (serviceName: string) => unknown }).get
  if (typeof getter === 'function') {
    try {
      const value = getter.call(ctx, name)
      if (value !== undefined) return value
    } catch {
      // 落到属性读取
    }
  }
  try {
    return (ctx as unknown as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}

function readSkillRegistry(ctx: Context): SkillRegistryLike | undefined {
  const native = readService(ctx, 'skills')
  if (
    native &&
    typeof native === 'object' &&
    typeof (native as SkillRegistryLike).register === 'function'
  ) {
    return native as SkillRegistryLike
  }
  return undefined
}

/**
 * 候选 skills 根目录（按优先级）。
 *
 * `import.meta.url` 指向当前模块文件：
 *   - `src/evolution/skills.ts` → `../../skills` = `<repo>/skills`；
 *   - `dist-server/evolution/skills.js` → `../../skills` 仍是 `<repo>/skills`
 *     （源码目录在发布包中通常不存在），故再补 `../skills` =
 *     `<repo>/dist-server/skills`。
 */
function candidateSkillRoots(): string[] {
  const roots = [
    fileURLToPath(new URL('../../skills/', import.meta.url)),
    fileURLToPath(new URL('../skills/', import.meta.url)),
  ]
  return [...new Set(roots)]
}

/** 解析 SKILL.md 所在的根目录；找不到时抛契约错误（点名探测过的路径）。 */
function resolveSkillsRoot(): string {
  const candidates = candidateSkillRoots()
  for (const root of candidates) {
    if (existsSync(path.join(root, EVOLUTION_SKILL_NAME, 'SKILL.md'))) return root
  }
  throw new DomainPackValidationError(
    'skills.firmware',
    `找不到固件 SKILL 目录（已探测：[${candidates.join(', ')}]）`,
  )
}

/**
 * 读取三个固件 SKILL。
 *
 * @returns 顺序固定（{@link FIRMWARE_SKILL_NAMES}），每项含原文与绝对路径。
 * @throws {DomainPackValidationError} 文件缺失时。
 */
export function loadFirmwareSkills(): LoadedFirmwareSkill[] {
  const root = resolveSkillsRoot()
  return FIRMWARE_SKILL_NAMES.map((name) => {
    const file = path.join(root, name, 'SKILL.md')
    if (!existsSync(file)) {
      throw new DomainPackValidationError('skills.firmware', `固件 SKILL "${name}" 缺失：${file}`)
    }
    return { name, content: readFileSync(file, 'utf8'), path: file }
  })
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/**
 * 解析 SKILL.md 的 YAML frontmatter（只支持 `key: value` 扁平子集）。
 *
 * 刻意不引入 YAML 依赖：固件 SKILL 的 frontmatter 只有三个标量字段，
 * 轻量解析足以覆盖，也避免为一个字段引入完整 YAML 解析器的攻击面。
 *
 * @param markdown SKILL.md 原文。
 * @param source 出错时用于定位的来源（通常是文件路径）。
 * @throws {DomainPackValidationError} 缺 frontmatter 或三字段任一缺失时。
 */
export function parseSkillMarkdown(markdown: string, source = '<inline>'): ParsedSkillMarkdown {
  const normalized = markdown.replace(/^\uFEFF/, '')
  const match = FRONTMATTER_PATTERN.exec(normalized)
  if (!match) {
    throw new DomainPackValidationError(
      'skills.firmware',
      `SKILL "${source}" 缺少 YAML frontmatter（需以 "---" 开头）`,
    )
  }

  const fields: Record<string, string> = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = unquote(line.slice(separator + 1).trim())
    if (key.length > 0) fields[key] = value
  }

  for (const key of ['name', 'description', 'whenToUse'] as const) {
    if (!fields[key]) {
      throw new DomainPackValidationError(
        'skills.firmware',
        `SKILL "${source}" 的 frontmatter 缺少非空字段 "${key}"`,
      )
    }
  }

  return {
    frontmatter: {
      name: fields.name,
      description: fields.description,
      whenToUse: fields.whenToUse,
    },
    content: normalized.slice(match[0].length),
  }
}

/**
 * 把资产类型清单格式化为模板变量 `{{assets}}` 的文本。
 *
 * 调用方（{@link registerFirmwareSkills}）负责格式化；`renderTemplate` 只做替换，
 * 不关心清单结构。
 */
export function formatAssetTypes(assetTypes: readonly AssetType[]): string {
  if (assetTypes.length === 0) return '（未声明资产类型）'
  return assetTypes
    .map((assetType) => {
      const description = assetType.description ? ` — ${assetType.description}` : ''
      return `- \`${assetType.name}\`：\`${assetType.prefix}\`${description}`
    })
    .join('\n')
}

/**
 * 静态注册三个固件 SKILL。
 *
 * - `rsi-evolution` 的正文在注册前用生效策略渲染；其余两个原样注册；
 * - 与领域包 `skills.evolvable[] / skills.firmware[]` 重名 → 抛契约错误并点名；
 * - `ctx.skills` 缺失或不支持 `register()` → warn 降级，返回空数组（不中断 install）；
 * - 任一注册失败 → 回滚已注册项后抛契约错误。
 *
 * @returns 与注册顺序一致的 unregister 数组（调用方按 LIFO 压入 teardown）。
 */
export function registerFirmwareSkills(
  ctx: Context,
  options: RegisterFirmwareSkillsOptions,
): Array<() => void> {
  const { pack, policy, assetTypes } = options
  const loaded = loadFirmwareSkills()

  const declaredNames = new Set<string>()
  for (const skill of pack.skills?.evolvable ?? []) declaredNames.add(skill.name)
  for (const skill of pack.skills?.firmware ?? []) declaredNames.add(skill.name)
  const conflicts = loaded.map((skill) => skill.name).filter((name) => declaredNames.has(name))
  if (conflicts.length > 0) {
    throw new DomainPackValidationError(
      'skills.firmware',
      `固件 SKILL 与领域包已声明的 SKILL 重名（可进化与固有 SKILL 均不可占用）：[${conflicts.join(', ')}]`,
    )
  }

  const logger = createDomainLogger(readService(ctx, 'logger'), 'firmwareSkills')
  const registry = readSkillRegistry(ctx)
  if (!registry) {
    logger.warn('skills 服务缺失或不支持 register()，跳过固件 SKILL 注册（降级继续）')
    return []
  }

  const vars: TemplateVars = {
    'domain.id': pack.id,
    'domain.displayName': pack.displayName ?? pack.id,
    assets: formatAssetTypes(assetTypes),
    'policy.evidence.parameterChange.window': policy.evidence?.parameterChange?.window,
    'policy.evidence.methodologyChange.independentCases':
      policy.evidence?.methodologyChange?.independentCases,
    // `renderTemplate` 把 undefined 视为未知变量；notes 是可选字段，这里给出
    // 明确的「无补充约定」占位，避免默认可选字段让模板渲染必然失败。
    'policy.notes': policy.notes ?? '（无额外约定）',
  }

  const unregisters: Array<() => void> = []
  try {
    for (const skill of loaded) {
      const parsed = parseSkillMarkdown(skill.content, skill.path)
      if (parsed.frontmatter.name !== skill.name) {
        throw new DomainPackValidationError(
          'skills.firmware',
          `固件 SKILL 目录名与 frontmatter.name 不一致："${skill.name}" vs "${parsed.frontmatter.name}"（${skill.path}）`,
        )
      }

      const content =
        skill.name === EVOLUTION_SKILL_NAME
          ? renderTemplate(parsed.content, vars)
          : parsed.content

      const registration: SkillRegistration = {
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        whenToUse: parsed.frontmatter.whenToUse,
        path: skill.path,
        source: 'runtime',
        resourceBase: { kind: 'directory', path: path.dirname(skill.path) },
        content,
        invocation: { modelInvocable: true, userInvocable: true },
      }

      const unregister = registry.register(registration)
      if (typeof unregister !== 'function') {
        throw new TypeError(
          `ctx.skills.register("${parsed.frontmatter.name}") 未返回 unregister 函数（实际为 ${typeof unregister}）`,
        )
      }
      unregisters.push(unregister)
    }
  } catch (error) {
    const rolledBack: string[] = []
    for (let index = unregisters.length - 1; index >= 0; index -= 1) {
      try {
        unregisters[index]()
        rolledBack.push(loaded[index].name)
      } catch (rollbackError) {
        logger.warn(`回滚固件 SKILL "${loaded[index].name}" 失败`, rollbackError)
      }
    }
    if (error instanceof DomainPackValidationError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new DomainPackValidationError(
      'skills.firmware',
      `注册固件 SKILL 失败（已回滚 [${rolledBack.join(', ')}]）：${detail}`,
    )
  }

  return unregisters
}

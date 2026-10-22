/**
 * DomainPack 运行时校验（纯函数）。
 *
 * 校验分两类（技术方案 §4.5）：
 *   - **契约类**：`apiVersion` / 必填字段 / 正则 / semver / 大小上限 / 时区 /
 *     工具名一致性 / core 工具重名 —— 直接抛 {@link DomainPackValidationError}，
 *     使插件加载失败。
 *   - **基础设施类**：`git` 不可用、`ctx.logger` / `agents` / `sessionPersistence`
 *     缺失、skill provider 挂载失败 —— 由调用方 `warn` 后继续，本文件不处理。
 *
 * 错误信息一律带**具体字段路径**（如 `assets.types[2].prefix`），不使用笼统的
 * 「校验失败」。
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveCoreConfig } from './config.js'
import { LOG_LEVELS, isLogLevel } from './log/level.js'
import {
  checkPolicyIndependentCases,
  checkPolicyWindow,
} from './evolution/policy.js'
import { FIRMWARE_SKILL_NAMES } from './evolution/names.js'
import {
  DOMAIN_API_VERSION,
  type AssetWriter,
  type DomainPack,
  type DomainRuntime,
  type ToolDefinition,
} from './types.js'
import { SESSION_ID_MAX_LENGTH, SESSION_ID_PATTERN } from './runtime.js'

/** 人设 Markdown 的字节上限（64 KB）。 */
export const PERSONA_MAX_BYTES = 64 * 1024

/** 领域开场 notice 文案的字节上限（4 KB）。 */
export const OPENING_NOTICE_MAX_BYTES = 4 * 1024

/** 领域合规声明（唤醒正文末尾）的字节上限（1 KB）。 */
export const DISCLAIMER_MAX_BYTES = 1024

/**
 * 保留的资产类型名（技术方案 §6「资产类型保留字」）。
 *
 * 来源与理由：
 *   - `core`   —— 无领域时的 `domainId`（`runtime.CORE_DOMAIN_ID`），也是 core
 *                 自身保留的命名空间，不允许领域包占用；
 *   - `firmware` —— core 内置固件 SKILL 的保留分区名（`evolution/names.ts`
 *                 的语义归属），领域包不得用同名类型改写其含义；
 *   - `assets` —— 资产根目录（`<home>/assets`）自身的名字，作为类型名会与目录
 *                 语义缠绕，且易写出 `assets/` 这类与根重叠的前缀。
 */
export const RESERVED_ASSET_TYPE_NAMES: ReadonlySet<string> = new Set([
  'core',
  'firmware',
  'assets',
])

/**
 * `defaultSessionId` 的长度上限 —— 真源在 `./runtime.js`（会话 id 规则由
 * runtime 统一裁决），此处 re-export 保持既有导入路径不变。
 */
export { SESSION_ID_MAX_LENGTH, SESSION_ID_PATTERN } from './runtime.js'

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const KEBAB_CASE_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** 契约校验失败。`field` 指向具体字段路径。 */
export class DomainPackValidationError extends Error {
  /** 出错的字段路径（例如 `assets.types[0].prefix`）。 */
  readonly field: string

  constructor(field: string, detail: string) {
    super(`[domainPack] 字段 "${field}" 非法：${detail}`)
    this.name = 'DomainPackValidationError'
    this.field = field
  }
}

/** 外部（core）已知工具面，用于重名检查。 */
export interface CoreSurface {
  /** core 已注册的工具名集合。 */
  readonly toolNames?: Iterable<string>
  /** 当工具名无法枚举时，按名查询 core 是否已注册。 */
  hasTool?(name: string): boolean
  /** 传给 `pack.tools(ctx, rt)` 的上下文；缺省用最小占位对象。 */
  readonly toolContext?: Context
  /** 传给 `pack.tools(ctx, rt)` 的运行时；缺省用最小占位运行时。 */
  readonly runtime?: DomainRuntime
}

/** 校验通过后的规范化结果。 */
export interface ValidatedDomainPack {
  /** 原始领域包（字段已确认存在）。 */
  readonly pack: DomainPack
  /** 工具名声明（已去重校验）。 */
  readonly toolNames: readonly string[]
  /** `tools()` 实际返回的工具定义（快照）。 */
  readonly tools: readonly ToolDefinition[]
  /** 已渲染的人设 Markdown。 */
  readonly personaMarkdown: string
}

/** 领域身份字段（创建运行时所需的最小子集）。 */
export interface DomainIdentity {
  readonly pack: DomainPack
  readonly id: string
  readonly version: string
  readonly defaultSessionId: string
}

function fail(field: string, detail: string): never {
  throw new DomainPackValidationError(field, detail)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (typeof value === 'string') return `字符串 ${JSON.stringify(value)}`
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return '数组'
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${typeof value} ${String(value)}`
  }
  return typeof value
}

/**
 * 校验领域身份字段：`apiVersion`、`id`、`version`、`defaultSessionId`。
 *
 * 供 `install` 在创建运行时之前做前置校验，避免用未校验字段构造运行时。
 */
export function validateDomainIdentity(input: unknown): DomainIdentity {
  if (!isRecord(input)) fail('pack', `领域包必须是对象，实际为 ${describe(input)}`)

  const apiVersion = input.apiVersion
  if (apiVersion !== DOMAIN_API_VERSION) {
    fail(
      'apiVersion',
      `必须严格等于 ${DOMAIN_API_VERSION}，实际为 ${describe(apiVersion)}`,
    )
  }

  const id = input.id
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    fail('id', `必须匹配 ${ID_PATTERN}，实际为 ${describe(id)}`)
  }

  const version = input.version
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    fail('version', `必须是合法 semver（如 1.2.3），实际为 ${describe(version)}`)
  }

  const defaultSessionId = input.defaultSessionId
  if (typeof defaultSessionId !== 'string' || defaultSessionId.length === 0) {
    fail('defaultSessionId', `必须是非空字符串，实际为 ${describe(defaultSessionId)}`)
  }
  if (defaultSessionId.length > SESSION_ID_MAX_LENGTH) {
    fail(
      'defaultSessionId',
      `长度必须 ≤ ${SESSION_ID_MAX_LENGTH}，实际为 ${defaultSessionId.length}`,
    )
  }
  if (!SESSION_ID_PATTERN.test(defaultSessionId)) {
    fail(
      'defaultSessionId',
      `必须匹配 ${SESSION_ID_PATTERN}，实际为 "${defaultSessionId}"`,
    )
  }

  return {
    pack: input as unknown as DomainPack,
    id,
    version,
    defaultSessionId,
  }
}

function validatePersona(input: Record<string, unknown>): string {
  const persona = input.persona
  if (!isRecord(persona)) fail('persona', `必须是对象，实际为 ${describe(persona)}`)
  if (typeof persona.markdown !== 'function') {
    fail('persona.markdown', `必须是函数，实际为 ${describe(persona.markdown)}`)
  }

  let markdown: unknown
  try {
    markdown = (persona.markdown as () => unknown).call(persona)
  } catch (error) {
    fail('persona.markdown', `调用抛错：${error instanceof Error ? error.message : String(error)}`)
  }

  if (typeof markdown !== 'string' || markdown.length === 0) {
    fail('persona.markdown', `必须返回非空字符串，实际为 ${describe(markdown)}`)
  }
  // 孤立代理项在 UTF-8 编解码往返后会被替换为 U+FFFD，据此判定非法 UTF-8。
  if (Buffer.from(markdown, 'utf8').toString('utf8') !== markdown) {
    fail('persona.markdown', '必须是合法 UTF-8 字符串（含孤立代理项）')
  }

  const bytes = Buffer.byteLength(markdown, 'utf8')
  if (bytes > PERSONA_MAX_BYTES) {
    fail(
      'persona.markdown',
      `UTF-8 字节数必须 ≤ ${PERSONA_MAX_BYTES}（64 KB），实际为 ${bytes}`,
    )
  }

  return markdown
}

/**
 * 校验可选的领域开场 notice。
 *
 * 规则：出现该键（且不为 `undefined`）时必须是**非空**字符串、合法 UTF-8、
 * UTF-8 字节数 ≤ {@link OPENING_NOTICE_MAX_BYTES}。缺省返回 `undefined`。
 */
function validateOpeningNotice(input: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(input, 'openingNotice') || input.openingNotice === undefined) {
    return undefined
  }

  const value = input.openingNotice
  if (typeof value !== 'string' || value.trim() === '') {
    fail('openingNotice', `必须是非空字符串，实际为 ${describe(value)}`)
  }
  // 孤立代理项在 UTF-8 编解码往返后会被替换为 U+FFFD，据此判定非法 UTF-8。
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) {
    fail('openingNotice', '必须是合法 UTF-8 字符串（含孤立代理项）')
  }
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > OPENING_NOTICE_MAX_BYTES) {
    fail(
      'openingNotice',
      `UTF-8 字节数必须 ≤ ${OPENING_NOTICE_MAX_BYTES}（4 KB），实际为 ${bytes}`,
    )
  }
  return value
}

/**
 * 校验可选的领域合规声明（`domainPack.disclaimer`）。
 *
 * 规则：出现该键（且不为 `undefined`）时必须是**非空**字符串、合法 UTF-8、
 * UTF-8 字节数 ≤ {@link DISCLAIMER_MAX_BYTES}。缺省返回 `undefined`。
 *
 * 之所以与 `openingNotice` 分开校验：两者的用途与预算不同（开场白 4 KB、
 * 唤醒尾巴 1 KB），错误信息必须点名各自的字段路径。
 */
function validateDisclaimer(input: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(input, 'disclaimer') || input.disclaimer === undefined) {
    return undefined
  }

  const value = input.disclaimer
  if (typeof value !== 'string' || value.trim() === '') {
    fail('disclaimer', `必须是非空字符串，实际为 ${describe(value)}`)
  }
  // 孤立代理项在 UTF-8 编解码往返后会被替换为 U+FFFD，据此判定非法 UTF-8。
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) {
    fail('disclaimer', '必须是合法 UTF-8 字符串（含孤立代理项）')
  }
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > DISCLAIMER_MAX_BYTES) {
    fail(
      'disclaimer',
      `UTF-8 字节数必须 ≤ ${DISCLAIMER_MAX_BYTES}（1 KB），实际为 ${bytes}`,
    )
  }
  return value
}

/**
 * 校验可选的领域日志配置（`domainPack.logging`）。
 *
 * 宽松口径（技术方案 §13）：只校验**认识**的四个键的类型，未知键忽略；出现即要求
 * 类型正确，错误信息点名字段路径（如 `logging.retentionDays`）。
 */
function validateLogging(input: Record<string, unknown>): void {
  if (!Object.hasOwn(input, 'logging') || input.logging === undefined) return

  const value = input.logging
  if (!isRecord(value)) fail('logging', `必须是对象，实际为 ${describe(value)}`)

  if (Object.hasOwn(value, 'level') && value.level !== undefined) {
    if (!isLogLevel(value.level)) {
      fail('logging.level', `允许 ${LOG_LEVELS.join(' | ')}，实际为 ${describe(value.level)}`)
    }
  }

  if (Object.hasOwn(value, 'retentionDays') && value.retentionDays !== undefined) {
    const days = value.retentionDays
    if (typeof days !== 'number' || !Number.isFinite(days) || !Number.isInteger(days) || days < 1) {
      fail('logging.retentionDays', `必须是 ≥ 1 的整数，实际为 ${describe(days)}`)
    }
  }

  for (const key of ['secretKeys', 'amountKeys'] as const) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) continue
    const list = value[key]
    if (!Array.isArray(list)) {
      fail(`logging.${key}`, `必须是字符串数组，实际为 ${describe(list)}`)
    }
    list.forEach((item: unknown, index: number) => {
      if (typeof item !== 'string' || item.trim() === '') {
        fail(`logging.${key}[${index}]`, `必须是非空字符串，实际为 ${describe(item)}`)
      }
    })
  }
}

function validateFirmwareSkills(input: Record<string, unknown>): void {
  const firmwareSkills = input.firmwareSkills ?? []
  if (!Array.isArray(firmwareSkills)) {
    fail('firmwareSkills', `必须是数组，实际为 ${describe(firmwareSkills)}`)
  }

  const reserved = new Set<string>(FIRMWARE_SKILL_NAMES)
  const seen = new Set<string>()
  firmwareSkills.forEach((skill: unknown, index: number) => {
    const field = `firmwareSkills[${index}].name`
    if (!isRecord(skill)) fail(field, `SKILL 必须是对象，实际为 ${describe(skill)}`)
    const name = skill.name
    if (typeof name !== 'string' || !KEBAB_CASE_PATTERN.test(name)) {
      fail(field, `必须是 kebab-case（${KEBAB_CASE_PATTERN}），实际为 ${describe(name)}`)
    }
    if (seen.has(name)) fail(field, `名称 "${name}" 重复（firmwareSkills 必须唯一）`)
    if (reserved.has(name)) {
      fail(field, `名称 "${name}" 是 core 内置固件 SKILL 保留名，领域包不得占用`)
    }
    seen.add(name)
  })
}

/**
 * 拦截已废弃的顶层 `skills` 字段（技术方案 §4.5「契约错误要响亮」）。
 *
 * 为什么必须显式报错：旧契约用顶层 `skills` 字段同时表达种子资产
 * 与固件 SKILL。注册式契约启用后，该字段若被静默忽略，领域作者会得到
 * 「install 成功但种子资产全部丢失」的假成功 —— 静默的数据缺失比直接失败
 * 更难排查。因此只要出现该键（无论值是否合法）立即失败，并给出替代写法。
 */
function validateNoLegacySkills(pack: Record<string, unknown>): void {
  if (Object.hasOwn(pack, 'skills')) {
    const hasFirmwareSkills = Object.hasOwn(pack, 'firmwareSkills')
    const hint = hasFirmwareSkills
      ? '；已检测到顶层 firmwareSkills，该字段已生效（无需再写 skills.firmware）'
      : ''

    fail(
      'skills',
      '已废弃：请改用 assets.types 声明前缀，并在 assets.bootstrap 中用 ' +
        `writer.register 安装可进化资产（firmware skill 请放到顶层 firmwareSkills）${hint}`,
    )
  }
}

/** 前缀 → 路径段（去掉结尾空段）。 */
function prefixSegments(prefix: string): string[] {
  return prefix.slice(0, -1).split('/')
}

/** 两个前缀是否重叠（含包含关系）；按**路径段**比较，不看字符前缀。 */
function prefixesOverlap(left: readonly string[], right: readonly string[]): boolean {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function validateAssets(input: Record<string, unknown>): void {
  const assets = input.assets
  if (!isRecord(assets)) fail('assets', `必须是对象，实际为 ${describe(assets)}`)

  const types = assets.types
  if (!Array.isArray(types)) {
    fail('assets.types', `必须是数组，实际为 ${describe(types)}`)
  }
  if (types.length === 0) {
    fail('assets.types', '至少需要声明 1 个资产类型')
  }

  const names = new Map<string, number>()
  const prefixes: Array<{ index: number; name: string; segments: string[]; raw: string }> = []

  types.forEach((assetType: unknown, index: number) => {
    if (!isRecord(assetType)) {
      fail(`assets.types[${index}]`, `必须是对象，实际为 ${describe(assetType)}`)
    }

    const nameField = `assets.types[${index}].name`
    const name = assetType.name
    if (typeof name !== 'string' || !KEBAB_CASE_PATTERN.test(name)) {
      fail(nameField, `必须是 kebab-case（${KEBAB_CASE_PATTERN}），实际为 ${describe(name)}`)
    }
    if (RESERVED_ASSET_TYPE_NAMES.has(name)) {
      fail(
        nameField,
        `"${name}" 是保留的资产类型名（${[...RESERVED_ASSET_TYPE_NAMES].join(' / ')}）`,
      )
    }
    const previous = names.get(name)
    if (previous !== undefined) {
      fail(nameField, `类型名 "${name}" 重复（首次出现于 assets.types[${previous}]）`)
    }
    names.set(name, index)

    const prefixField = `assets.types[${index}].prefix`
    const prefix = assetType.prefix
    if (typeof prefix !== 'string' || prefix.length === 0) {
      fail(prefixField, `必须是非空字符串，实际为 ${describe(prefix)}`)
    }
    if (prefix.startsWith('/')) fail(prefixField, `必须是相对路径，不能以 "/" 开头：${JSON.stringify(prefix)}`)
    if (!prefix.endsWith('/')) fail(prefixField, `必须以 "/" 结尾：${JSON.stringify(prefix)}`)
    if (prefix.includes('\\')) fail(prefixField, `不能包含反斜杠：${JSON.stringify(prefix)}`)
    if (prefix.includes('..')) fail(prefixField, `不能包含 ".."：${JSON.stringify(prefix)}`)
    if (prefix.includes('.git')) fail(prefixField, `不能包含 ".git"：${JSON.stringify(prefix)}`)
    if (prefix.includes('\0')) fail(prefixField, `不能包含空字符：${JSON.stringify(prefix)}`)

    const segments = prefixSegments(prefix)
    if (segments.some((segment) => segment.length === 0 || segment === '.')) {
      fail(prefixField, `路径段不能为空或 "."：${JSON.stringify(prefix)}`)
    }

    const conflict = prefixes.find((item) => prefixesOverlap(item.segments, segments))
    if (conflict !== undefined) {
      fail(
        prefixField,
        `前缀 ${JSON.stringify(prefix)}（类型 "${name}"）与类型 "${conflict.name}" 的前缀 ` +
          `${JSON.stringify(conflict.raw)} 重叠（按路径段判断，不允许包含关系）`,
      )
    }

    if (assetType.validate !== undefined && typeof assetType.validate !== 'function') {
      fail(`assets.types[${index}].validate`, `若提供必须是函数，实际为 ${describe(assetType.validate)}`)
    }

    prefixes.push({ index, name, segments, raw: prefix })
  })

  const bootstrap = assets.bootstrap
  if (bootstrap === undefined) return
  if (typeof bootstrap !== 'function') {
    fail('assets.bootstrap', `若提供必须是函数，实际为 ${describe(bootstrap)}`)
  }
  // 提前拦住最常见的写法错误；真正的 thenable 返回值检查在 runAssetsBootstrap。
  if ((bootstrap as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction') {
    fail('assets.bootstrap', '必须是同步函数（不得声明为 async，返回值不得是 thenable/Promise）')
  }
}

/** 判断任意返回值是否为 thenable。 */
function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  return typeof (value as { then?: unknown }).then === 'function'
}

/**
 * 同步执行领域包的 `assets.bootstrap(writer)`。
 *
 * 与 `validateDomainPack` 的分工：`validateDomainPack` 只做**形状**校验（含 async 声明
 * 的提前拦截）；本函数在真实 writer 上执行，负责拦截「普通函数返回 thenable」
 * 的漏网写法。**bootstrap 内部抛出的错误原样透传**（不做包裹），以便领域作者
 * 看到自己的原始信息。
 *
 * @throws {DomainPackValidationError} 形态非法 / 返回 thenable。
 * @throws 任何 bootstrap 内部抛出的原始错误。
 */
export function runAssetsBootstrap(pack: DomainPack, writer: AssetWriter): void {
  const bootstrap = pack.assets?.bootstrap
  if (bootstrap === undefined) return
  if (typeof bootstrap !== 'function') {
    fail('assets.bootstrap', `若提供必须是函数，实际为 ${describe(bootstrap)}`)
  }

  const returned = bootstrap.call(pack.assets, writer)
  if (isThenable(returned)) {
    fail(
      'assets.bootstrap',
      '必须是同步函数，返回值不得是 thenable/Promise（检测到异步返回值）',
    )
  }
}

function validateScheduler(input: Record<string, unknown>): void {
  const scheduler = input.scheduler
  if (!isRecord(scheduler)) {
    fail('scheduler', `必须是对象，实际为 ${describe(scheduler)}`)
  }

  const timezone = scheduler.timezone
  if (typeof timezone !== 'string' || timezone.length === 0) {
    fail('scheduler.timezone', `必须是非空 IANA 时区字符串，实际为 ${describe(timezone)}`)
  }

  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone })
  } catch {
    fail('scheduler.timezone', `不是合法的 IANA 时区：${JSON.stringify(timezone)}`)
  }

  // 可选扩展：`runtimes`（运行时白名单）与 `tasksDir`（任务定义目录）。
  // 两者缺省合法；一旦出现就必须是「可用的声明」，避免调度器在运行期才发现。
  if (scheduler.runtimes !== undefined) {
    const runtimes = scheduler.runtimes
    if (!Array.isArray(runtimes)) {
      fail('scheduler.runtimes', `若提供必须是数组，实际为 ${describe(runtimes)}`)
    }
    const seen = new Set<string>()
    runtimes.forEach((runtime: unknown, index: number) => {
      const field = `scheduler.runtimes[${index}]`
      if (typeof runtime !== 'string' || runtime.trim() === '') {
        fail(field, `必须是非空字符串，实际为 ${describe(runtime)}`)
      }
      const name = runtime.trim()
      if (name !== runtime) {
        fail(field, `不得含首尾空白：${JSON.stringify(runtime)}`)
      }
      if (seen.has(name)) fail(field, `运行时 "${name}" 重复声明`)
      seen.add(name)
    })
  }

  if (scheduler.tasksDir !== undefined) {
    const tasksDir = scheduler.tasksDir
    if (typeof tasksDir !== 'string' || tasksDir.trim() === '') {
      fail('scheduler.tasksDir', `若提供必须是非空字符串，实际为 ${describe(tasksDir)}`)
    }
    if (tasksDir.includes('\0')) {
      fail('scheduler.tasksDir', '不得包含空字符')
    }
  }
}

function validateEvolutionPolicy(input: Record<string, unknown>): void {
  const policy = input.evolutionPolicy
  if (!isRecord(policy)) {
    fail('evolutionPolicy', `必须是对象，实际为 ${describe(policy)}`)
  }

  // 规则真源在 `./evolution/policy.js`：与嵌套进化策略共用同一组检查，
  // 避免「领域包扁平契约」与「进化引擎嵌套策略」各有一套口径。
  const cases = policy.independentCases
  const casesDetail = checkPolicyIndependentCases(cases)
  if (casesDetail) fail('evolutionPolicy.independentCases', casesDetail)

  const window = policy.window
  const windowDetail = checkPolicyWindow(window)
  if (windowDetail) fail('evolutionPolicy.window', windowDetail)

  // 所有数值字段必须 > 0（`independentCases` 已按正整数单独校验）。
  for (const [key, value] of Object.entries(policy)) {
    if (typeof value !== 'number') continue
    if (key === 'independentCases') continue
    if (!Number.isFinite(value) || value <= 0) {
      fail(`evolutionPolicy.${key}`, `数值字段必须 > 0，实际为 ${describe(value)}`)
    }
  }
}

/**
 * 工具定义形状校验：与 `@deepseek-ai/dsh-tools` 的 `ToolDefinition` 逐项对齐。
 *
 * 为什么在 core 侧提前校验：`ctx.tools.register()` 抛的是 `TypeError`，不带字段
 * 路径；提前失败能给领域作者**精确字段**，并避免注册到一半才发现。语义不做
 * JSON Schema 深度校验（那是 dsh-tools 的职责），只校验契约形状。
 */
function validateToolShape(item: Record<string, unknown>, index: number): void {
  const description = item.description
  if (typeof description !== 'string' || description.length === 0) {
    fail(`tools()[${index}].description`, `必须是非空字符串，实际为 ${describe(description)}`)
  }

  if (!isRecord(item.parameters)) {
    fail(`tools()[${index}].parameters`, `必须是 JSON Schema 对象，实际为 ${describe(item.parameters)}`)
  }

  const output = item.output
  if (!isRecord(output)) {
    fail(
      `tools()[${index}].output`,
      `必须声明 { schema, render }（dsh-tools 强制要求），实际为 ${describe(output)}`,
    )
  }
  if (!isRecord(output.schema)) {
    fail(
      `tools()[${index}].output.schema`,
      `必须是 JSON Schema 对象，实际为 ${describe(output.schema)}`,
    )
  }
  if (typeof output.render !== 'function') {
    fail(
      `tools()[${index}].output.render`,
      `必须是函数 (args, value) => ContentBlock[]，实际为 ${describe(output.render)}`,
    )
  }
  if (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function') {
    fail(
      `tools()[${index}].output.presentationMeta`,
      `若提供必须是函数，实际为 ${describe(output.presentationMeta)}`,
    )
  }

  if (typeof item.execute !== 'function') {
    fail(
      `tools()[${index}].execute`,
      `必须是异步函数 (args, exec) => Promise<unknown>，实际为 ${describe(item.execute)}`,
    )
  }
}

function validateTools(
  pack: DomainPack,
  core: CoreSurface,
  runtime: DomainRuntime,
  toolContext: Context,
): { tools: readonly ToolDefinition[]; toolNames: readonly string[] } {
  if (typeof pack.tools !== 'function') {
    fail('tools', `必须是函数 (ctx, rt) => ToolDefinition[]，实际为 ${describe(pack.tools)}`)
  }

  let raw: unknown
  try {
    raw = pack.tools(toolContext, runtime)
  } catch (error) {
    fail('tools', `调用抛错：${error instanceof Error ? error.message : String(error)}`)
  }

  if (!Array.isArray(raw)) {
    fail('tools', `必须返回数组，实际为 ${describe(raw)}`)
  }

  const tools: ToolDefinition[] = []
  const returned = new Set<string>()
  raw.forEach((item: unknown, index: number) => {
    const field = `tools()[${index}].name`
    if (!isRecord(item)) fail(field, `工具定义必须是对象，实际为 ${describe(item)}`)
    const name = item.name
    if (typeof name !== 'string' || name.length === 0) {
      fail(field, `必须是非空字符串，实际为 ${describe(name)}`)
    }
    if (returned.has(name)) fail(field, `工具名 "${name}" 重复`)
    returned.add(name)
    validateToolShape(item, index)
    tools.push(item as unknown as ToolDefinition)
  })

  const declaredRaw = pack.toolNames
  if (!Array.isArray(declaredRaw)) {
    fail('toolNames', `必须是数组，实际为 ${describe(declaredRaw)}`)
  }

  const declared = new Set<string>()
  declaredRaw.forEach((name: unknown, index: number) => {
    const field = `toolNames[${index}]`
    if (typeof name !== 'string' || name.length === 0) {
      fail(field, `必须是非空字符串，实际为 ${describe(name)}`)
    }
    if (declared.has(name)) fail(field, `工具名 "${name}" 重复声明`)
    declared.add(name)
  })

  const undeclared = [...returned].filter((name) => !declared.has(name))
  const missing = [...declared].filter((name) => !returned.has(name))
  if (undeclared.length > 0 || missing.length > 0) {
    const parts: string[] = []
    if (undeclared.length > 0) parts.push(`未在 toolNames 声明：[${undeclared.join(', ')}]`)
    if (missing.length > 0) parts.push(`声明但 tools() 未返回：[${missing.join(', ')}]`)
    fail('toolNames', `必须与实际返回的工具名集合完全一致；${parts.join('；')}`)
  }

  const coreNames = new Set<string>(core.toolNames ?? [])
  const conflicts = [...declared].filter(
    (name) => coreNames.has(name) || core.hasTool?.(name) === true,
  )
  if (conflicts.length > 0) {
    fail('toolNames', `与 core 已注册工具重名：[${conflicts.join(', ')}]`)
  }

  return { tools, toolNames: [...declared] }
}

/**
 * 校验并规范化一个领域包。
 *
 * 纯函数：不写全局状态、不注册任何服务；仅调用 `pack.persona.markdown()` 与
 * `pack.tools(ctx, rt)` 读取契约值。任一条不满足即抛
 * {@link DomainPackValidationError}。
 *
 * @param input 待校验的领域包（`unknown`，因为来源通常是外部插件）。
 * @param core core 已知工具面（用于重名检查），缺省视为无冲突。
 */
export function validateDomainPack(input: unknown, core: CoreSurface = {}): ValidatedDomainPack {
  const identity = validateDomainIdentity(input)
  const record = input as Record<string, unknown>

  // 先拦废弃字段：它不属于当前契约，越早失败越不容易被后续校验掩盖。
  validateNoLegacySkills(record)

  const personaMarkdown = validatePersona(record)
  validateOpeningNotice(record)
  validateDisclaimer(record)
  validateLogging(record)
  validateAssets(record)
  validateFirmwareSkills(record)
  validateScheduler(record)
  validateEvolutionPolicy(record)

  const runtime = core.runtime ?? createPlaceholderRuntime(identity.pack)
  const toolContext = core.toolContext ?? ({} as Context)

  const { tools, toolNames } = validateTools(identity.pack, core, runtime, toolContext)

  return {
    pack: identity.pack,
    toolNames,
    tools,
    personaMarkdown,
  }
}

/** 校验期占位运行时：不含任何 IO，仅满足 `pack.tools` 的读取需求。 */
function createPlaceholderRuntime(pack: DomainPack): DomainRuntime {
  return Object.freeze({
    apiVersion: DOMAIN_API_VERSION,
    domainId: typeof pack.id === 'string' ? pack.id : '',
    domainVersion: typeof pack.version === 'string' ? pack.version : '',
    home: '',
    sessionId: typeof pack.defaultSessionId === 'string' ? pack.defaultSessionId : '',
    timezone: 'UTC',
    assetsDir: '',
    dataDir: '',
    logsDir: '',
    workspaceDir: '',
    config: resolveCoreConfig({}, {}),
    logger: {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
    },
    commit: {
      isAvailable: () => false,
      commit: async () => ({ degraded: true, reason: 'validation placeholder' }),
    },
  })
}

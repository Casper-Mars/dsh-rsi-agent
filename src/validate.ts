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
 * 错误信息一律带**具体字段路径**（如 `assetTypes[2].prefix`），不使用笼统的
 * 「校验失败」。
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  DOMAIN_API_VERSION,
  type DomainPack,
  type DomainRuntime,
  type ToolDefinition,
} from './types.js'

/** 人设 Markdown 的字节上限（64 KB）。 */
export const PERSONA_MAX_BYTES = 64 * 1024

/** `defaultSessionId` 的长度上限。 */
export const SESSION_ID_MAX_LENGTH = 128

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]+$/
const KEBAB_CASE_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** 契约校验失败。`field` 指向具体字段路径。 */
export class DomainPackValidationError extends Error {
  /** 出错的字段路径（例如 `assetTypes[0].prefix`）。 */
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

function validateSkills(input: Record<string, unknown>): void {
  const skills = input.skills
  if (!isRecord(skills)) fail('skills', `必须是对象，实际为 ${describe(skills)}`)

  const evolvable = skills.evolvable
  const firmware = skills.firmware ?? []
  if (!Array.isArray(evolvable)) {
    fail('skills.evolvable', `必须是数组，实际为 ${describe(evolvable)}`)
  }
  if (!Array.isArray(firmware)) {
    fail('skills.firmware', `必须是数组，实际为 ${describe(firmware)}`)
  }

  const seen = new Set<string>()
  evolvable.forEach((skill: unknown, index: number) => {
    const field = `skills.evolvable[${index}].name`
    if (!isRecord(skill)) fail(field, `SKILL 必须是对象，实际为 ${describe(skill)}`)
    const name = skill.name
    if (typeof name !== 'string' || !KEBAB_CASE_PATTERN.test(name)) {
      fail(field, `必须是 kebab-case（${KEBAB_CASE_PATTERN}），实际为 ${describe(name)}`)
    }
    if (seen.has(name)) fail(field, `名称 "${name}" 重复（可进化 SKILL 必须全局唯一）`)
    seen.add(name)
  })

  firmware.forEach((skill: unknown, index: number) => {
    const field = `skills.firmware[${index}].name`
    if (!isRecord(skill)) fail(field, `SKILL 必须是对象，实际为 ${describe(skill)}`)
    const name = skill.name
    if (typeof name !== 'string' || name.length === 0) {
      fail(field, `必须是非空字符串，实际为 ${describe(name)}`)
    }
    if (seen.has(name)) {
      fail(field, `名称 "${name}" 与已声明的 SKILL 重名（可进化与固有 SKILL 不得冲突）`)
    }
    seen.add(name)
  })
}

function validateAssetTypes(input: Record<string, unknown>): void {
  const assetTypes = input.assetTypes
  if (!Array.isArray(assetTypes)) {
    fail('assetTypes', `必须是数组，实际为 ${describe(assetTypes)}`)
  }

  assetTypes.forEach((assetType: unknown, index: number) => {
    if (!isRecord(assetType)) {
      fail(`assetTypes[${index}]`, `必须是对象，实际为 ${describe(assetType)}`)
    }

    const name = assetType.name
    if (typeof name !== 'string' || name.length === 0) {
      fail(`assetTypes[${index}].name`, `必须是非空字符串，实际为 ${describe(name)}`)
    }

    const field = `assetTypes[${index}].prefix`
    const prefix = assetType.prefix
    if (typeof prefix !== 'string' || prefix.length === 0) {
      fail(field, `必须是非空字符串，实际为 ${describe(prefix)}`)
    }
    if (prefix.startsWith('/')) fail(field, `必须是相对路径，不能以 "/" 开头：${JSON.stringify(prefix)}`)
    if (!prefix.endsWith('/')) fail(field, `必须以 "/" 结尾：${JSON.stringify(prefix)}`)
    if (prefix.includes('\\')) fail(field, `不能包含反斜杠：${JSON.stringify(prefix)}`)
    if (prefix.includes('..')) fail(field, `不能包含 ".."：${JSON.stringify(prefix)}`)
    if (prefix.includes('.git')) fail(field, `不能包含 ".git"：${JSON.stringify(prefix)}`)
    if (prefix.includes('\0')) fail(field, `不能包含空字符：${JSON.stringify(prefix)}`)

    const segments = prefix.slice(0, -1).split('/')
    if (segments.some((segment) => segment.length === 0 || segment === '.')) {
      fail(field, `路径段不能为空或 "."：${JSON.stringify(prefix)}`)
    }
  })
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
}

function validateEvolutionPolicy(input: Record<string, unknown>): void {
  const policy = input.evolutionPolicy
  if (!isRecord(policy)) {
    fail('evolutionPolicy', `必须是对象，实际为 ${describe(policy)}`)
  }

  const cases = policy.independentCases
  if (typeof cases !== 'number' || !Number.isInteger(cases) || cases <= 0) {
    fail('evolutionPolicy.independentCases', `必须是正整数，实际为 ${describe(cases)}`)
  }

  const window = policy.window
  if (typeof window !== 'string' || window.trim().length === 0) {
    fail('evolutionPolicy.window', `必须是非空字符串，实际为 ${describe(window)}`)
  }

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

  const personaMarkdown = validatePersona(record)
  validateSkills(record)
  validateAssetTypes(record)
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
    sessionId: typeof pack.defaultSessionId === 'string' ? pack.defaultSessionId : '',
    assetsDir: '',
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

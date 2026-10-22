/**
 * 通用人设槽位（Persona Slot）—— core 启动时注册的**唯一** persona section。
 *
 * 设计要点（技术方案 §4.1 / §8.1）：
 *   1. **core 为基座，领域人设追加在后**：`text()` 返回 `core + 分隔符 + domain`；
 *      领域未安装（或领域正文为空）时返回纯 core。领域人设是**补充而非替代**。
 *   2. **单 section + 动态 text provider**：整个进程生命周期内只向 `systemPrompt`
 *      注册一个 `rsi-agent:persona` section，其 `text` 是组合 provider。领域
 *      install 时只改内部变量，uninstall 时回到纯 core —— 因此不论领域装/卸
 *      多少次，system prompt 里始终**只有 1 个** `rsi-agent:persona`，不会出现
 *      重复 section 或顺序漂移。
 *   3. **晚装不重建会话**：切换 persona 只是一次变量赋值，不触碰会话、不触发
 *      `agents.create/resume`。
 *   4. **core 只读一次**：core 正文懒加载后缓存，`restore()` 复用缓存，不重复
 *      读盘。
 *   5. 每次切换都记 `info`（含 `packId`），便于排障时确认「当前人设来自谁」。
 *
 * 通用人设正文放在 `./persona.md`，由 `scripts/copy-assets.mjs` 随构建复制到
 * `dist-server/prompts/persona.md`；源码态与编译态下 `new URL('./persona.md',
 * import.meta.url)` 都指向同名相对文件。
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { serviceOf } from '../context.js'

/** 通用人设 section 的唯一名称。 */
export const PERSONA_SECTION_NAME = 'rsi-agent:persona' as const

/** 通用人设 section 的排序位（persona 类靠前）。 */
export const PERSONA_SECTION_ORDER = 100 as const

/** core 正文与领域正文之间的固定分隔符（v1 不引入可配置项）。 */
export const PERSONA_DOMAIN_SEPARATOR = '\n\n---\n\n' as const

/** 资源缺失时的兜底人设（正常情况下不会用到，避免 system prompt 为空）。 */
export const CORE_PERSONA_FALLBACK =
  '# RSI Agent\n\n你是一个帮助用户把长期任务拆解为可执行、可复盘、可进化资产的通用助手。\n' +
  '你不冒充任何领域专家，不承诺具体结果，不编造专业结论。'

const CORE_PERSONA_URL = new URL('./persona.md', import.meta.url)

let cachedCoreMarkdown: string | undefined

/**
 * 读取通用人设 Markdown。
 *
 * 读取失败（打包缺陷）时返回 {@link CORE_PERSONA_FALLBACK}，保证 persona
 * section 永远有非空内容，不会把 `systemPrompt` 置空。
 */
export function loadCorePersonaMarkdown(): string {
  if (cachedCoreMarkdown !== undefined) return cachedCoreMarkdown
  try {
    cachedCoreMarkdown = readFileSync(CORE_PERSONA_URL, 'utf8')
  } catch {
    cachedCoreMarkdown = CORE_PERSONA_FALLBACK
  }
  return cachedCoreMarkdown
}

/** `systemPrompt` section 的最小结构契约（不引入运行时依赖）。 */
export interface PromptSectionLike {
  /** 唯一 name。 */
  readonly name: string
  /** 排序位。 */
  readonly order: number
  /** 静态文本或 provider（每次组装求值）。 */
  readonly text: string | ((context: unknown) => string)
}

/** `systemPrompt` 服务的最小结构契约。 */
export interface SystemPromptLike {
  section(section: PromptSectionLike): () => void
}

/** persona 切换日志面（`info` 携带 `{ packId }`）。 */
export interface PersonaSwitchLogger {
  info(message: string, meta?: unknown): void
  warn?(message: string, meta?: unknown): void
}

/** 人设来源：通用（core）或领域。 */
export type PersonaSource = 'core' | 'domain'

/** 人设槽位（可注入、无 IO 的纯状态机）。 */
export interface PersonaSlot {
  /** section 名（固定 {@link PERSONA_SECTION_NAME}）。 */
  readonly name: typeof PERSONA_SECTION_NAME
  /** section 排序位（固定 {@link PERSONA_SECTION_ORDER}）。 */
  readonly order: typeof PERSONA_SECTION_ORDER
  /** 当前生效的人设来源。 */
  readonly source: PersonaSource
  /** 当前领域 id（`source === 'core'` 时为 `undefined`）。 */
  readonly domainId: string | undefined
  /**
   * 当前生效的人设正文（每次调用返回即时值）。
   *
   * `core` 模式下严格等于通用人设原文；`domain` 模式下为
   * `core + {@link PERSONA_DOMAIN_SEPARATOR} + domain`。
   */
  text(): string
  /** 组装好的 section（`text` 为动态 provider）。 */
  section(): PromptSectionLike
  /** 叠加领域人设（core 保持在前，领域追加在后）；`packId` 必填并写入日志。 */
  useDomain(markdown: string, packId: string): void
  /**
   * 恢复为纯通用人设（移除领域补充）。
   *
   * @param packId 可选：仅当当前领域 id 匹配时才恢复，避免「旧安装的延迟拆卸
   *               把新安装的人设误恢复成通用」。
   * @returns 是否实际执行了恢复。
   */
  restore(packId?: string): boolean
}

/** 构造人设槽位。 */
export function createPersonaSlot(
  options: {
    /** 通用人设正文提供者（缺省读取 `persona.md`）。 */
    coreMarkdown?: () => string
    /** 切换日志面。 */
    logger?: PersonaSwitchLogger
  } = {},
): PersonaSlot {
  const readCore = options.coreMarkdown ?? loadCorePersonaMarkdown
  const logger = options.logger
  /** 懒加载并缓存的 core 正文；`undefined` 表示尚未读取。 */
  let coreText: string | undefined
  /** 领域正文；`undefined` / 空串表示当前没有领域补充。 */
  let domainText: string | undefined
  let source: PersonaSource = 'core'
  let domainId: string | undefined

  const getCore = (): string => {
    if (coreText === undefined) coreText = readCore()
    return coreText
  }

  const compose = (): string => {
    const core = getCore()
    const domain = domainText?.trim()
    if (domain === undefined || domain === '') return core
    return `${core}${PERSONA_DOMAIN_SEPARATOR}${domain}`
  }

  return {
    name: PERSONA_SECTION_NAME,
    order: PERSONA_SECTION_ORDER,
    get source() {
      return source
    },
    get domainId() {
      return domainId
    },
    text() {
      return compose()
    },
    section() {
      return {
        name: PERSONA_SECTION_NAME,
        order: PERSONA_SECTION_ORDER,
        // 单 section + 动态 provider：切换人设只改这里的闭包变量。
        text: () => compose(),
      }
    },
    useDomain(markdown: string, packId: string) {
      domainText = markdown
      source = 'domain'
      domainId = packId
      logger?.info('[rsi-agent] persona 已叠加领域人设（core + domain）', { packId })
    },
    restore(packId?: string) {
      if (packId !== undefined && domainId !== packId) return false
      // core 走缓存，只在首次使用时读盘。
      getCore()
      domainText = undefined
      source = 'core'
      domainId = undefined
      logger?.info('[rsi-agent] persona 已恢复为通用人设', { packId: packId ?? null })
      return true
    },
  }
}

/**
 * 把槽位注册到 `systemPrompt` 服务。
 *
 * @returns 注销器（由调用方或 cordis effect 持有）。
 */
export function registerPersonaSection(
  systemPrompt: SystemPromptLike,
  slot: PersonaSlot,
): () => void {
  return systemPrompt.section(slot.section())
}

/**
 * 在上下文可用时挂载 persona section。
 *
 * 通过 `ctx.inject(['systemPrompt'], cb)` **动态声明依赖**（顶层插件 `inject`
 * 保持 `['tools','skills','fs']` 不变）。回调返回值是注销器，服务于 cordis
 * 的服务变更重载语义：`systemPrompt` 变化时旧 section 先注销、再重新注册，
 * 因此永远不会出现重复 section。
 *
 * @param ctx 插件上下文。
 * @param slot 人设槽位。
 * @param logger 降级日志面。
 */
export function mountPersonaSlot(
  ctx: Context,
  slot: PersonaSlot,
  logger?: Pick<PersonaSwitchLogger, 'warn'>,
): void {
  try {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      const systemPrompt = serviceOf<SystemPromptLike>(promptCtx, 'systemPrompt')
      if (!systemPrompt || typeof systemPrompt.section !== 'function') {
        logger?.warn?.('[rsi-agent] systemPrompt 服务不可用，跳过 persona section 注册（降级）')
        return
      }
      return registerPersonaSection(systemPrompt, slot)
    })
  } catch (error) {
    // 极端场景（上下文已失活）：降级为无 persona，不阻断插件装配。
    logger?.warn?.('[rsi-agent] persona section 挂载失败（降级继续）', error)
  }
}

/**
 * 进化策略（§10.2）：默认值、深合并与字段校验。
 *
 * 设计要点：
 *   - **默认值只有一份**：{@link DEFAULT_EVOLUTION_POLICY} 深度冻结，领域未覆盖的
 *     字段一律回落到这里；
 *   - **深合并而非整体替换**：领域只覆盖 `evidence.parameterChange.window` 时，
 *     `evidence.parameterChange.outOfSample` / `discipline` 等其余字段保持默认值；
 *   - **校验规则只有一套**：标量规则以 {@link checkPolicyWindow} /
 *     {@link checkPolicyIndependentCases} / {@link checkPolicyNotes} 的形式导出，
 *     `src/validate.ts` 对 `DomainPack.evolutionPolicy`（扁平契约）复用同一组检查，
 *     本文件对嵌套策略复用同一组检查——不存在第二套口径。
 */
import type { EvolutionPolicy as DomainPackEvolutionPolicy } from '../types.js'

/**
 * 嵌套进化策略。
 *
 * 与 `DomainPack.evolutionPolicy`（扁平、必填 `window` / `independentCases`）不同，
 * 本类型描述**合并后的生效策略**：所有字段可选，缺省由
 * {@link DEFAULT_EVOLUTION_POLICY} 补齐。
 */
export interface EvolutionPolicy {
  /** 证据门槛。 */
  evidence?: {
    /**
     * 参数类变更的证据要求。
     *
     * `window` 为观察窗口标签（非空字符串）；`outOfSample` 表示是否要求样本外验证。
     */
    parameterChange?: { window: string; outOfSample?: boolean }
    /** 方法类变更的证据要求：相互独立的案例数（正整数）。 */
    methodologyChange?: { independentCases: number }
  }
  /** 变更纪律。 */
  discipline?: {
    /** 单变量：一轮只改一个变量。 */
    singleVariable?: boolean
    /** 预注册：验证口径先于改动写定。 */
    preregistration?: boolean
    /** 节流：两次变更之间的最小间隔描述（非空字符串）。 */
    throttle?: string
    /** 保留负结果：失败的实验同样记录。 */
    keepNegativeResults?: boolean
    /** 历史不可变：只追加，不改写既有记录。 */
    historyImmutable?: boolean
  }
  /** 领域补充约定（自由文本）。 */
  notes?: string
}

/** 策略校验失败。`field` 指向具体字段路径（如 `evidence.parameterChange.window`）。 */
export class EvolutionPolicyValidationError extends Error {
  /** 出错的字段路径。 */
  readonly field: string

  /** 具体原因（不含字段前缀）。 */
  readonly detail: string

  constructor(field: string, detail: string) {
    super(`[evolutionPolicy] 字段 "${field}" 非法：${detail}`)
    this.name = 'EvolutionPolicyValidationError'
    this.field = field
    this.detail = detail
  }
}

/** 深度冻结（数组按对象处理；本策略只含普通对象与标量）。 */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child)
    }
  }
  return value
}

/**
 * 文档默认策略（深度冻结）。
 *
 * 修改本常量等同于修改产品默认行为：单测对其做**固定深比较**，防止被悄悄改动。
 */
export const DEFAULT_EVOLUTION_POLICY: EvolutionPolicy = deepFreeze({
  evidence: {
    parameterChange: { window: '20 observations', outOfSample: true },
    methodologyChange: { independentCases: 3 },
  },
  discipline: {
    singleVariable: true,
    preregistration: true,
    throttle: 'one change per review cycle',
    keepNegativeResults: true,
    historyImmutable: true,
  },
})

function describe(value: unknown): string {
  if (typeof value === 'string') return `字符串 ${JSON.stringify(value)}`
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return '数组'
  if (typeof value === 'object') return '对象'
  return `${typeof value} ${String(value)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 检查「非空字符串」规则。
 *
 * @returns 合法时返回 `undefined`；非法时返回原因（调用方决定抛错类型与字段路径）。
 */
export function checkPolicyWindow(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return `必须是非空字符串，实际为 ${describe(value)}`
  }
  return undefined
}

/**
 * 检查「正整数」规则。
 *
 * @returns 合法时返回 `undefined`；非法时返回原因。
 */
export function checkPolicyIndependentCases(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return `必须是正整数，实际为 ${describe(value)}`
  }
  return undefined
}

/**
 * 检查「字符串」规则（允许空串）。
 *
 * @returns 合法时返回 `undefined`；非法时返回原因。
 */
export function checkPolicyNotes(value: unknown): string | undefined {
  if (typeof value !== 'string') return `必须是字符串，实际为 ${describe(value)}`
  return undefined
}

function checkBoolean(value: unknown): string | undefined {
  if (typeof value !== 'boolean') return `必须是布尔值，实际为 ${describe(value)}`
  return undefined
}

function fail(field: string, detail: string): never {
  throw new EvolutionPolicyValidationError(field, detail)
}

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) fail(field, `必须是对象，实际为 ${describe(value)}`)
  return value as Record<string, unknown>
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  field: string,
): boolean | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  const detail = checkBoolean(value)
  if (detail) fail(field, detail)
  return value as boolean
}

/**
 * 把领域覆盖深合并到默认策略上。
 *
 * - 未提供（`undefined` / `{}`）→ 返回 {@link DEFAULT_EVOLUTION_POLICY} 本身；
 * - 只覆盖部分字段时，其余层级保持默认值（深合并）；
 * - 每个**被提供**的字段都会校验，非法值抛
 *   {@link EvolutionPolicyValidationError} 并点名字段路径。
 *
 * 名为 `domain` 的参数即「领域覆盖」：调用方通常直接传入领域包声明的策略。
 * 兼容 `DomainPack.evolutionPolicy` 的扁平写法（顶层 `window` /
 * `independentCases`），由 {@link evolutionPolicyOverridesFromPack} 适配；
 * 本函数只接受嵌套形状，避免两套形状在同一层出现。
 */
export function mergeEvolutionPolicy(domain: EvolutionPolicy = {}): EvolutionPolicy {
  assertRecord(domain, 'policy')

  const defaults = DEFAULT_EVOLUTION_POLICY
  const evidence = domain.evidence
  let parameterChangeOverride: Record<string, unknown> = {}
  let methodologyChangeOverride: Record<string, unknown> = {}

  if (evidence !== undefined) {
    const evidenceRecord = assertRecord(evidence, 'evidence')

    if (evidenceRecord.parameterChange !== undefined) {
      const parameterChange = assertRecord(
        evidenceRecord.parameterChange,
        'evidence.parameterChange',
      )
      const window = parameterChange.window
      if (window !== undefined) {
        const detail = checkPolicyWindow(window)
        if (detail) fail('evidence.parameterChange.window', detail)
        parameterChangeOverride.window = window
      }
      const outOfSample = readOptionalBoolean(
        parameterChange,
        'outOfSample',
        'evidence.parameterChange.outOfSample',
      )
      if (outOfSample !== undefined) parameterChangeOverride.outOfSample = outOfSample
    }

    if (evidenceRecord.methodologyChange !== undefined) {
      const methodologyChange = assertRecord(
        evidenceRecord.methodologyChange,
        'evidence.methodologyChange',
      )
      const independentCases = methodologyChange.independentCases
      if (independentCases !== undefined) {
        const detail = checkPolicyIndependentCases(independentCases)
        if (detail) fail('evidence.methodologyChange.independentCases', detail)
        methodologyChangeOverride.independentCases = independentCases
      }
    }
  }

  const disciplineOverride: Record<string, unknown> = {}
  if (domain.discipline !== undefined) {
    const discipline = assertRecord(domain.discipline, 'discipline')
    for (const key of [
      'singleVariable',
      'preregistration',
      'keepNegativeResults',
      'historyImmutable',
    ] as const) {
      const value = readOptionalBoolean(discipline, key, `discipline.${key}`)
      if (value !== undefined) disciplineOverride[key] = value
    }
    if (discipline.throttle !== undefined) {
      const detail = checkPolicyWindow(discipline.throttle)
      if (detail) fail('discipline.throttle', detail)
      disciplineOverride.throttle = discipline.throttle
    }
  }

  if (domain.notes !== undefined) {
    const detail = checkPolicyNotes(domain.notes)
    if (detail) fail('notes', detail)
  }

  const merged: EvolutionPolicy = deepFreeze({
    evidence: {
      parameterChange: {
        ...defaults.evidence?.parameterChange,
        ...parameterChangeOverride,
      } as { window: string; outOfSample?: boolean },
      methodologyChange: {
        ...defaults.evidence?.methodologyChange,
        ...methodologyChangeOverride,
      } as { independentCases: number },
    },
    discipline: {
      ...defaults.discipline,
      ...disciplineOverride,
    },
    ...(domain.notes === undefined ? {} : { notes: domain.notes }),
  })

  return merged
}

/**
 * 把 `DomainPack.evolutionPolicy`（扁平契约）适配为嵌套覆盖。
 *
 * 扁平契约是领域包的历史形状（`{ window, independentCases }`）；嵌套策略是
 * 进化引擎的生效形状。适配只做字段搬运，不做校验——校验仍由
 * {@link mergeEvolutionPolicy} 统一执行。
 */
export function evolutionPolicyOverridesFromPack(
  policy: DomainPackEvolutionPolicy | undefined,
): EvolutionPolicy {
  if (!policy) return {}
  const overrides: EvolutionPolicy = {
    evidence: {},
  }
  const window = (policy as Record<string, unknown>).window
  if (window !== undefined) {
    overrides.evidence = {
      ...overrides.evidence,
      parameterChange: { window: window as string },
    }
  }
  const independentCases = (policy as Record<string, unknown>).independentCases
  if (independentCases !== undefined) {
    overrides.evidence = {
      ...overrides.evidence,
      methodologyChange: { independentCases: independentCases as number },
    }
  }
  const notes = (policy as Record<string, unknown>).notes
  if (typeof notes === 'string') overrides.notes = notes
  return overrides
}

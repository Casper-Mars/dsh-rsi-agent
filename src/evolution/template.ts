/**
 * 模板渲染（§10.3）：仅支持 `{{ name }}` 占位符。
 *
 * 安全边界（刻意做小）：
 *   - **固定白名单**：只有 {@link TEMPLATE_VARIABLES} 中的 6 个变量可渲染；
 *   - **不执行表达式**：占位符内容只做名称匹配，不 `eval`、不解析属性链之外的东西；
 *   - **不递归替换**：变量值里即使含 `{{ ... }}` 也原样输出，避免二次注入；
 *   - **`undefined` 视为未知变量**：缺失值直接抛错，而不是静默渲染成空串——
 *     静默空串会让「模板写错」在产物里隐身。
 */

/** 允许渲染的变量白名单（顺序即文档顺序）。 */
export const TEMPLATE_VARIABLES = Object.freeze([
  'domain.id',
  'domain.displayName',
  'assets',
  'policy.evidence.parameterChange.window',
  'policy.evidence.methodologyChange.independentCases',
  'policy.notes',
] as const)

/** 白名单变量名联合类型。 */
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number]

/** 变量取值：调用方需自行把数值/清单格式化为字符串；`undefined` 不被接受。 */
export type TemplateVars = Partial<Record<TemplateVariable, string | number | undefined>>

/** 模板渲染失败（未知变量 / 缺失值）。 */
export class TemplateRenderError extends Error {
  /** 出问题的变量名（原样保留，便于定位）。 */
  readonly variable: string

  constructor(variable: string, reason: string) {
    super(
      `[template] 变量 "${variable}" ${reason}；可用变量：[${TEMPLATE_VARIABLES.join(', ')}]`,
    )
    this.name = 'TemplateRenderError'
    this.variable = variable
  }
}

const isTemplateVariable = (name: string): name is TemplateVariable =>
  (TEMPLATE_VARIABLES as readonly string[]).includes(name)

/**
 * 占位符语法：`{{ name }}`，允许两侧空格；名称内部不含花括号。
 *
 * 用全局正则 + 替换函数实现：`String.prototype.replace` 不会对替换结果再次扫描，
 * 因此天然满足「不二次渲染」。
 */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g

/**
 * 渲染模板。
 *
 * @param template 原始模板文本。
 * @param vars 变量表；只读取白名单内的键。
 * @returns 渲染结果（替换值原样插入，不做递归渲染）。
 * @throws {TemplateRenderError} 变量不在白名单、或值为 `undefined` / `null` 时。
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(PLACEHOLDER, (_match, rawName: string) => {
    const name = rawName.trim()

    if (!isTemplateVariable(name)) {
      throw new TemplateRenderError(name, '不在模板白名单内')
    }

    const value = vars[name]
    if (value === undefined || value === null) {
      throw new TemplateRenderError(name, '未提供值（undefined 视为未知变量）')
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TemplateRenderError(name, `取值必须是字符串或数字，实际为 ${typeof value}`)
    }

    // 原样插入：值内若含 `{{ ... }}` 不再二次渲染（注入防线）。
    return String(value)
  })
}

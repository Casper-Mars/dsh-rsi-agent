/**
 * core 工具 `asset_commit` —— 技术方案 §9.2（写入即 commit 的对外入口）。
 *
 * 这是 core 自带工具（**不是**领域包工具）：任何领域都可以用它把已落盘的资产
 * 写入提交进单仓。因此本文件不得出现任何领域词，资产目录完全由领域包声明的
 * `assetTypes[].prefix` 驱动。
 *
 * 契约要点：
 *   - `parameters` 只声明 `paths` / `message`；`minItems: 1` 不在 dsh-tools
 *     支持的 JSON Schema 子集内，改由 `execute` 显式校验空数组并返回原因；
 *   - `output.schema` 覆盖 `committed / sha / degraded / reason / actions`，
 *     可选字段在无值时**不出现**（保证 output 是 lossless JSON）；
 *   - `execute` 必须异步；路径非法属于调用方错误 → 返回 `reason`，不抛错；
 *   - 注册走 `AgentHost` 的统一重名检查（与领域工具同一条路径）。
 */
import type { AssetType, ToolDefinition } from '../types.js'
import {
  AssetPathError,
  commitAssets,
  type AssetAction,
  type AssetActionRecord,
  type CommitAssetsLogger,
  type CommitAssetsResult,
  type CommitAssetsRuntime,
} from './commit.js'
import type { GitBufferRunner, GitRunner } from './git.js'
import {
  ASSET_HISTORY_MAX_LIMIT,
  AssetHistoryLimitError,
  assetHistory,
  type AssetHistoryEntry,
  type AssetHistoryResult,
} from './history.js'
import { assetShow, type AssetShowResult, type AssetShowRuntime } from './show.js'

/** core 工具名。 */
export const ASSET_COMMIT_TOOL_NAME = 'asset_commit'

/** `asset_commit` 的入参 JSON Schema。 */
export const ASSET_COMMIT_PARAMETERS = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      description: '相对资产根目录的路径列表（必须落在某个 assetTypes[].prefix 之下，至少 1 项）',
      items: { type: 'string' },
    },
    message: {
      type: 'string',
      description: '可选提交说明前缀；工具会自动追加本次变更的动作行',
    },
  },
  required: ['paths'],
  additionalProperties: false,
} as const

/** `asset_commit` 的出参 JSON Schema（dsh-tools 支持子集）。 */
export const ASSET_COMMIT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    committed: { type: 'boolean', description: '是否产生了新提交' },
    sha: { type: 'string', description: '提交的完整 SHA（仅成功提交时存在）' },
    degraded: { type: 'boolean', description: 'git 故障导致的降级标记' },
    reason: { type: 'string', description: '降级原因 / no-op 判据 / 路径拒绝原因' },
    actions: {
      type: 'array',
      description: '本次实际变更的文件与动作',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          action: { type: 'string', enum: ['create', 'update', 'delete'] },
        },
        required: ['path', 'action'],
        additionalProperties: false,
      },
    },
  },
  required: ['committed', 'degraded', 'actions'],
  additionalProperties: false,
} as const

/** {@link createAssetCommitTool} 依赖。 */
export interface AssetCommitToolDeps {
  /** 运行时（含 `assetsDir`；有 `logger` 时用于降级告警）。 */
  runtime: CommitAssetsRuntime
  /** 领域声明的资产类型（前缀白名单）。 */
  assetTypes: readonly AssetType[]
  /** 自定义 git 执行器（测试注入）。 */
  git?: GitRunner
  /** 自定义日志出口（优先于 `runtime.logger`）。 */
  logger?: CommitAssetsLogger
  /** git 命令超时。 */
  timeoutMs?: number
}

/** 把结果渲染成模型可读的一行摘要。 */
function renderResult(value: CommitAssetsResult): string {
  if (value.committed) {
    const detail = value.actions
      .map((action: AssetActionRecord) => `${action.action} ${action.path}`)
      .join(', ')
    const sha = value.sha === undefined ? '' : ` ${value.sha.slice(0, 12)}`
    return `已提交${sha}：${detail}`
  }
  const state = value.degraded ? '降级（未提交）' : '未提交'
  return value.reason === undefined ? state : `${state}：${value.reason}`
}

/** 校验入参形状；返回规范化后的 `paths` 或错误原因。 */
function readArgs(args: unknown): { paths: string[]; message?: string } | { error: string } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { error: `入参必须是对象，实际为 ${args === null ? 'null' : typeof args}` }
  }
  const record = args as { paths?: unknown; message?: unknown }

  if (!Array.isArray(record.paths)) {
    return { error: 'paths 必须是字符串数组' }
  }
  if (record.paths.length === 0) {
    return { error: 'paths 不能为空数组（至少 1 项）' }
  }
  const paths: string[] = []
  for (let index = 0; index < record.paths.length; index += 1) {
    const value: unknown = record.paths[index]
    if (typeof value !== 'string') {
      return { error: `paths[${index}] 必须是字符串，实际为 ${value === null ? 'null' : typeof value}` }
    }
    paths.push(value)
  }
  if (record.message !== undefined && typeof record.message !== 'string') {
    return { error: `message 必须是字符串，实际为 ${typeof record.message}` }
  }
  return record.message === undefined ? { paths } : { paths, message: record.message }
}

/**
 * 构造 core 工具 `asset_commit`。
 *
 * @param deps 运行时 / 资产类型 / 可注入 git 与 logger。
 */
export function createAssetCommitTool(deps: AssetCommitToolDeps): ToolDefinition {
  return {
    name: ASSET_COMMIT_TOOL_NAME,
    description:
      '把已写入资产目录的文件提交进资产单仓（写入即 commit）。' +
      '路径必须位于领域声明的资产前缀之下；无实际变更时不会产生空提交。',
    parameters: ASSET_COMMIT_PARAMETERS as unknown as Record<string, unknown>,
    output: {
      schema: ASSET_COMMIT_OUTPUT_SCHEMA as unknown as never,
      render: (_args: unknown, value: unknown) => [
        { type: 'text' as const, text: renderResult(value as CommitAssetsResult) },
      ],
    },
    execute: async (args: unknown): Promise<CommitAssetsResult> => {
      const parsed = readArgs(args)
      if ('error' in parsed) {
        return { committed: false, degraded: false, reason: parsed.error, actions: [] }
      }

      try {
        const result = commitAssets({
          runtime: deps.runtime,
          assetTypes: deps.assetTypes,
          paths: parsed.paths,
          ...(parsed.message === undefined ? {} : { message: parsed.message }),
          ...(deps.git === undefined ? {} : { git: deps.git }),
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
          ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        })
        return withActionTypes(result)
      } catch (error) {
        // 路径非法属于调用方错误：返回原因而非抛错，让模型自行修正。
        if (error instanceof AssetPathError) {
          return { committed: false, degraded: false, reason: error.message, actions: [] }
        }
        const reason = error instanceof Error ? error.message : String(error)
        return { committed: false, degraded: true, reason, actions: [] }
      }
    },
  }
}

/** 收敛 `actions[].action` 的类型（运行时已由 git 状态字母限定）。 */
function withActionTypes(result: CommitAssetsResult): CommitAssetsResult {
  const actions: AssetActionRecord[] = result.actions.map((action) => ({
    path: action.path,
    action: action.action as AssetAction,
  }))
  const next: CommitAssetsResult = {
    committed: result.committed,
    degraded: result.degraded,
    actions,
  }
  if (result.sha !== undefined) next.sha = result.sha
  if (result.reason !== undefined) next.reason = result.reason
  return next
}

// ---------------------------------------------------------------------------
// asset_history（§9.4）
// ---------------------------------------------------------------------------

/** core 工具名。 */
export const ASSET_HISTORY_TOOL_NAME = 'asset_history'

/** `asset_history` 的入参 JSON Schema。 */
export const ASSET_HISTORY_PARAMETERS = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: '相对资产根目录的文件路径（必须落在某个 assetTypes[].prefix 之下）',
    },
    limit: {
      type: 'integer',
      description: `返回条数上限：1..${ASSET_HISTORY_MAX_LIMIT} 的正整数，缺省 20`,
    },
  },
  required: ['path'],
  additionalProperties: false,
} as const

/** `asset_history` 的出参 JSON Schema（dsh-tools 支持子集）。 */
export const ASSET_HISTORY_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      description: '历史记录（新 → 旧）；降级时为空数组',
      items: {
        type: 'object',
        properties: {
          sha: { type: 'string' },
          author: { type: 'string' },
          date: { type: 'string' },
          subject: { type: 'string' },
        },
        required: ['sha', 'author', 'date', 'subject'],
        additionalProperties: false,
      },
    },
    degraded: { type: 'boolean', description: 'git 故障导致的降级标记' },
    reason: { type: 'string', description: '降级原因 / 参数拒绝原因' },
  },
  required: ['entries', 'degraded'],
  additionalProperties: false,
} as const

/** {@link createAssetHistoryTool} 依赖。 */
export interface AssetHistoryToolDeps {
  /** 运行时（含 `assetsDir`；有 `logger` 时用于降级告警）。 */
  runtime: CommitAssetsRuntime
  /** 领域声明的资产类型（前缀白名单）。 */
  assetTypes: readonly AssetType[]
  /** 自定义 git 执行器（测试注入）。 */
  git?: GitRunner
  /** 自定义日志出口（优先于 `runtime.logger`）。 */
  logger?: CommitAssetsLogger
  /** git 命令超时。 */
  timeoutMs?: number
}

/** 把历史结果渲染成模型可读文本。 */
function renderHistory(value: AssetHistoryResult): string {
  if (value.entries.length === 0) {
    const state = value.degraded ? '历史不可用（降级）' : '暂无提交历史'
    return value.reason === undefined ? state : `${state}：${value.reason}`
  }
  return value.entries
    .map(
      (entry: AssetHistoryEntry) =>
        `${entry.sha.slice(0, 12)} ${entry.date} ${entry.author} — ${entry.subject}`,
    )
    .join('\n')
}

/** 校验 `asset_history` 入参形状。 */
function readHistoryArgs(
  args: unknown,
): { path: string; limit?: number } | { error: string } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { error: `入参必须是对象，实际为 ${args === null ? 'null' : typeof args}` }
  }
  const record = args as { path?: unknown; limit?: unknown }
  if (typeof record.path !== 'string' || record.path.trim() === '') {
    return { error: 'path 必须是非空字符串' }
  }
  if (record.limit === undefined) return { path: record.path }
  return { path: record.path, limit: record.limit as number }
}

/**
 * 构造 core 工具 `asset_history`。
 *
 * 非法 `path` / `limit` 属于调用方错误：返回 `reason`（`entries: []`），不抛错。
 */
export function createAssetHistoryTool(deps: AssetHistoryToolDeps): ToolDefinition {
  return {
    name: ASSET_HISTORY_TOOL_NAME,
    description:
      '查询资产文件的提交历史（sha / author / date / subject）。' +
      '路径必须位于领域声明的资产前缀之下；limit 取值 1..100，缺省 20。',
    parameters: ASSET_HISTORY_PARAMETERS as unknown as Record<string, unknown>,
    output: {
      schema: ASSET_HISTORY_OUTPUT_SCHEMA as unknown as never,
      render: (_args: unknown, value: unknown) => [
        { type: 'text' as const, text: renderHistory(value as AssetHistoryResult) },
      ],
    },
    execute: async (args: unknown): Promise<AssetHistoryResult> => {
      const parsed = readHistoryArgs(args)
      if ('error' in parsed) {
        return { entries: [], degraded: false, reason: parsed.error }
      }
      try {
        const result = assetHistory({
          runtime: deps.runtime,
          assetTypes: deps.assetTypes,
          path: parsed.path,
          ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
          ...(deps.git === undefined ? {} : { git: deps.git }),
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
          ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        })
        const next: AssetHistoryResult = {
          entries: result.entries,
          degraded: result.degraded,
        }
        if (result.reason !== undefined) next.reason = result.reason
        return next
      } catch (error) {
        if (error instanceof AssetPathError || error instanceof AssetHistoryLimitError) {
          return { entries: [], degraded: false, reason: error.message }
        }
        const reason = error instanceof Error ? error.message : String(error)
        return { entries: [], degraded: true, reason }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// asset_show（§9.4）
// ---------------------------------------------------------------------------

/** core 工具名。 */
export const ASSET_SHOW_TOOL_NAME = 'asset_show'

/** `asset_show` 的入参 JSON Schema。 */
export const ASSET_SHOW_PARAMETERS = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: '相对资产根目录的文件路径（必须落在某个 assetTypes[].prefix 之下）',
    },
    sha: {
      type: 'string',
      description: '目标版本：7..40 位小写十六进制 SHA（不接受分支名 / 选项 / shell 字符）',
    },
  },
  required: ['path', 'sha'],
  additionalProperties: false,
} as const

/** `asset_show` 的出参 JSON Schema（dsh-tools 支持子集）。 */
export const ASSET_SHOW_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '归一化后的相对路径' },
    sha: { type: 'string', description: '实际读取的版本号' },
    content: { type: 'string', description: '文本内容（合法 UTF-8，不含 U+FFFD）' },
    truncated: { type: 'boolean', description: '是否因超过 256 KB 上限被截断' },
    bytes: { type: 'integer', description: '原始字节数' },
  },
  required: ['path', 'sha', 'content', 'truncated'],
  additionalProperties: false,
} as const

/** {@link createAssetShowTool} 依赖。 */
export interface AssetShowToolDeps {
  /** 运行时（含 `assetsDir`）。 */
  runtime: AssetShowRuntime
  /** 领域声明的资产类型（前缀白名单）。 */
  assetTypes: readonly AssetType[]
  /** 自定义字节版 git 执行器（测试注入）。 */
  git?: GitBufferRunner
  /** git 命令超时。 */
  timeoutMs?: number
}

/** 校验 `asset_show` 入参形状。 */
function readShowArgs(args: unknown): { path: string; sha: string } | { error: string } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { error: `入参必须是对象，实际为 ${args === null ? 'null' : typeof args}` }
  }
  const record = args as { path?: unknown; sha?: unknown }
  if (typeof record.path !== 'string' || record.path.trim() === '') {
    return { error: 'path 必须是非空字符串' }
  }
  if (typeof record.sha !== 'string') {
    return { error: 'sha 必须是字符串' }
  }
  return { path: record.path, sha: record.sha }
}

/** 把读取结果渲染成模型可读文本。 */
function renderShow(value: AssetShowResult): string {
  const size = value.bytes === undefined ? '' : `，${value.bytes} 字节`
  const hint = value.truncated ? '，已按 256 KB 截断' : ''
  return `${value.path}@${value.sha.slice(0, 12)}${size}${hint}\n\n${value.content}`
}

/**
 * 构造 core 工具 `asset_show`。
 *
 * 非法入参 / git 故障直接抛错（读取类工具没有可降级的返回值，错误必须显式
 * 暴露给模型，而不是返回空内容让模型误以为文件为空）。
 */
export function createAssetShowTool(deps: AssetShowToolDeps): ToolDefinition {
  return {
    name: ASSET_SHOW_TOOL_NAME,
    description:
      '读取资产文件在指定提交下的内容（≤ 256 KB，超出按 UTF-8 字符边界截断）。' +
      'sha 必须是 7..40 位小写十六进制。',
    parameters: ASSET_SHOW_PARAMETERS as unknown as Record<string, unknown>,
    output: {
      schema: ASSET_SHOW_OUTPUT_SCHEMA as unknown as never,
      render: (_args: unknown, value: unknown) => [
        { type: 'text' as const, text: renderShow(value as AssetShowResult) },
      ],
    },
    execute: async (args: unknown): Promise<AssetShowResult> => {
      const parsed = readShowArgs(args)
      if ('error' in parsed) throw new TypeError(`[assets] asset_show：${parsed.error}`)
      return assetShow({
        runtime: deps.runtime,
        assetTypes: deps.assetTypes,
        path: parsed.path,
        sha: parsed.sha,
        ...(deps.git === undefined ? {} : { git: deps.git }),
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// 组合入口
// ---------------------------------------------------------------------------

/** {@link createAssetTools} 依赖：commit + history + show。 */
export interface AssetToolsDeps extends AssetCommitToolDeps {
  /** `asset_show` 用的字节版 git 执行器（测试注入）。 */
  gitBuffer?: GitBufferRunner
}

/**
 * 构造全部 core 资产工具：`asset_commit` / `asset_history` / `asset_show`。
 *
 * `install` 的 `tools` 阶段统一注册本函数的返回值，dispose 时按 LIFO 反注册。
 */
export function createAssetTools(deps: AssetToolsDeps): ToolDefinition[] {
  const showDeps: AssetShowToolDeps = {
    runtime: deps.runtime,
    assetTypes: deps.assetTypes,
    ...(deps.gitBuffer === undefined ? {} : { git: deps.gitBuffer }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  }
  const historyDeps: AssetHistoryToolDeps = {
    runtime: deps.runtime,
    assetTypes: deps.assetTypes,
    ...(deps.git === undefined ? {} : { git: deps.git }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  }
  return [
    createAssetCommitTool(deps),
    createAssetHistoryTool(historyDeps),
    createAssetShowTool(showDeps),
  ]
}

/**
 * 构造 core 工具列表（向后兼容入口；语义等同 {@link createAssetTools}）。
 */
export function createAssetCommitTools(deps: AssetToolsDeps): ToolDefinition[] {
  return createAssetTools(deps)
}

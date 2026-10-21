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
import type { GitRunner } from './git.js'

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

/**
 * 构造 core 工具列表（当前只有 `asset_commit`；保持数组形态，便于后续扩展
 * `asset_history` / `asset_show` 时只改这一个函数）。
 */
export function createAssetCommitTools(deps: AssetCommitToolDeps): ToolDefinition[] {
  return [createAssetCommitTool(deps)]
}

/**
 * `dsh-rsi-agent` 包入口：汇聚导出 Cordis 插件三要素、配置层与 `agentHost`
 * 服务契约。
 *
 * `package.json` 的 `exports["."]` 指向本文件的编译产物
 * （`dist-server/index.js`），实际契约收敛在 `./plugin.js`、`./types.js`、
 * `./service.js` 与 `./validate.js`。
 */
export { name, apply, inject } from './plugin.js'
export {
  CORE_CONFIG_DEFAULTS,
  CORE_CONFIG_ENV,
  DEFAULT_RSI_AGENT_CONFIG,
  STARTUP_GRACE_MAX_MS,
  parseByteSize,
  resolveConfig,
  resolveCoreConfig,
  type CoreConfig,
  type LogLevel,
  type ResolvedCoreConfig,
  type RsiAgentConfig,
} from './config.js'

// ---- DomainPack / AgentHost 公共契约 ----
export { DOMAIN_API_VERSION } from './types.js'
export type {
  ActiveDomain,
  AgentHostService,
  AssetEntry,
  AssetSpec,
  AssetType,
  AssetWriter,
  CommitOptions,
  CommitPort,
  CommitResult,
  DomainAssets,
  DomainLogger,
  DomainPack,
  DomainRuntime,
  EvolutionPolicy,
  FirmwareSkill,
  InstallOptions,
  PersonaProvider,
  RegisterResult,
  RegisterStatus,
  SchedulerSpec,
  ToolDefinition,
  ToolOutputDefinition,
  ToolRunContext,
} from './types.js'

// ---- 服务与装配 ----
export {
  AgentHost,
  TEARDOWN_ORDER,
  TeardownRegistry,
  type AgentHostConfig,
  type Teardown,
  type TeardownRegistryOptions,
  type TeardownStage,
} from './service.js'

// ---- Runtime（§7：home / sessionId / 目录布局） ----
export {
  CORE_DOMAIN_ID,
  DEFAULT_SESSION_ID,
  InvalidSessionIdError,
  NotImplementedError,
  PRIVATE_DIR_MODE,
  RSI_AGENT_HOME_ENV,
  RSI_AGENT_HOME_NAME,
  RUNTIME_LAYOUT,
  SESSION_ID_MAX_LENGTH,
  SESSION_ID_PATTERN,
  SHARED_DIR_MODE,
  createDefaultCommitPort,
  createDomainLogger,
  createDomainRuntime,
  describeSessionIdError,
  resolveHomeRoot,
  resolveSessionId,
  resolveSystemTimezone,
  resolveTimezone,
  type CreateDomainRuntimeContext,
  type CreatedDomainRuntime,
  type DefaultCommitPortOptions,
  type DomainRuntimeConfig,
  type RuntimePack,
  type SessionIdSources,
} from './runtime.js'

// ---- 资产单仓（§9：git 执行器 / 仓库就绪 / 写入即 commit / core 工具） ----
export {
  DEFAULT_GIT_TIMEOUT_MS,
  GIT_IDENTITY_EMAIL,
  GIT_IDENTITY_NAME,
  GIT_PROBE_TIMEOUT_MS,
  ensureRepoConfig,
  gitIdentityArgs,
  initGitRepo,
  isGitAvailable,
  runGit,
  runGitBuffer,
  type GitBufferResult,
  type GitBufferRunner,
  type GitResult,
  type GitRunner,
  type IsGitAvailableOptions,
  type RunGitOptions,
} from './assets/git.js'
export {
  ASSETS_GITIGNORE,
  ASSETS_GITIGNORE_BLOCK_END,
  ASSETS_GITIGNORE_BLOCK_START,
  ASSETS_GITIGNORE_ENTRIES,
  ASSETS_GITIGNORE_HEADER,
  ensureAssetsRepo,
  type AssetsRepoLogger,
  type EnsureAssetsRepoDeps,
  type EnsureAssetsRepoResult,
  type GitignoreAction,
} from './assets/repo.js'
export {
  AssetPathError,
  commitAssets,
  validateAssetPaths,
  type AssetAction,
  type AssetActionRecord,
  type CommitAssetsInput,
  type CommitAssetsLogger,
  type CommitAssetsResult,
  type CommitAssetsRuntime,
} from './assets/commit.js'
export {
  ASSET_COMMIT_OUTPUT_SCHEMA,
  ASSET_COMMIT_PARAMETERS,
  ASSET_COMMIT_TOOL_NAME,
  ASSET_HISTORY_OUTPUT_SCHEMA,
  ASSET_HISTORY_PARAMETERS,
  ASSET_HISTORY_TOOL_NAME,
  ASSET_SHOW_OUTPUT_SCHEMA,
  ASSET_SHOW_PARAMETERS,
  ASSET_SHOW_TOOL_NAME,
  createAssetCommitTool,
  createAssetCommitTools,
  createAssetHistoryTool,
  createAssetShowTool,
  createAssetTools,
  type AssetCommitToolDeps,
  type AssetHistoryToolDeps,
  type AssetShowToolDeps,
  type AssetToolsDeps,
} from './assets/tools.js'
export {
  ASSET_HISTORY_DEFAULT_LIMIT,
  ASSET_HISTORY_MAX_LIMIT,
  AssetHistoryLimitError,
  assetHistory,
  parseAssetHistory,
  resolveHistoryLimit,
  type AssetHistoryEntry,
  type AssetHistoryInput,
  type AssetHistoryResult,
  type AssetHistoryRuntime,
} from './assets/history.js'
export {
  ASSET_SHOW_MAX_BUFFER,
  ASSET_SHOW_MAX_BYTES,
  ASSET_SHOW_SHA_PATTERN,
  AssetShaError,
  AssetShowError,
  assetShow,
  assertAssetSha,
  decodeTruncatedUtf8,
  validUtf8PrefixLength,
  type AssetShowInput,
  type AssetShowResult,
  type AssetShowRuntime,
} from './assets/show.js'
export {
  AssetRegisterError,
  AssetWriterError,
  createAssetWriter,
  type CreateAssetWriterOptions,
} from './assets/writer.js'

// ---- 进化引擎（§10：策略 / 模板渲染 / 固件 SKILL） ----
export {
  DEFAULT_EVOLUTION_POLICY,
  EvolutionPolicyValidationError,
  checkPolicyIndependentCases,
  checkPolicyNotes,
  checkPolicyWindow,
  evolutionPolicyOverridesFromPack,
  mergeEvolutionPolicy,
} from './evolution/policy.js'
// 嵌套生效策略与 `DomainPack.evolutionPolicy`（扁平契约，见上方类型导出）形状不同，
// 公开导出时改名区分，避免同名冲突。
export type { EvolutionPolicy as EvolutionPolicyConfig } from './evolution/policy.js'
export {
  TEMPLATE_VARIABLES,
  TemplateRenderError,
  renderTemplate,
  type TemplateVariable,
  type TemplateVars,
} from './evolution/template.js'
export {
  SKILL_ASSET_PREFIX,
  SKILL_PROVIDER_NAME,
  hasSkillAssetType,
  mountSkillFilesystemProvider,
  mountSkillFilesystemProviderAsync,
  resolveSkillDir,
  type MountSkillProviderOptions,
  type SkillProviderHandle,
  type SkillProviderMount,
} from './skills/provider.js'
export {
  EVOLUTION_SKILL_NAME,
  FIRMWARE_SKILL_NAMES,
  formatAssetTypes,
  loadFirmwareSkills,
  parseSkillMarkdown,
  registerFirmwareSkills,
  type FirmwareSkillName,
  type LoadedFirmwareSkill,
  type ParsedSkillMarkdown,
  type RegisterFirmwareSkillsOptions,
  type SkillFrontmatter,
} from './evolution/skills.js'

// ---- 校验 ----
export {
  DomainPackValidationError,
  PERSONA_MAX_BYTES,
  RESERVED_ASSET_TYPE_NAMES,
  runAssetsBootstrap,
  validateDomainIdentity,
  validateDomainPack,
  type CoreSurface,
  type DomainIdentity,
  type ValidatedDomainPack,
} from './validate.js'

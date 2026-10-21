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
  AssetType,
  CommitOptions,
  CommitPort,
  CommitResult,
  DomainLogger,
  DomainPack,
  DomainRuntime,
  DomainSkills,
  EvolutionPolicy,
  FirmwareSkill,
  InstallOptions,
  PersonaProvider,
  SchedulerSpec,
  SeedSkill,
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
  type GitResult,
  type GitRunner,
  type IsGitAvailableOptions,
  type RunGitOptions,
} from './assets/git.js'
export {
  ASSETS_GITIGNORE,
  ensureAssetsRepo,
  type AssetsRepoLogger,
  type EnsureAssetsRepoDeps,
  type EnsureAssetsRepoResult,
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
  createAssetCommitTool,
  createAssetCommitTools,
  type AssetCommitToolDeps,
} from './assets/tools.js'

// ---- 校验 ----
export {
  DomainPackValidationError,
  PERSONA_MAX_BYTES,
  validateDomainIdentity,
  validateDomainPack,
  type CoreSurface,
  type DomainIdentity,
  type ValidatedDomainPack,
} from './validate.js'

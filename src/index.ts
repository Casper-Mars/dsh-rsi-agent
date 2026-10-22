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
  DomainPackLogging,
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
  type ResolveTimezoneOptions,
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

// ---- Persona 槽位（§8.1：单 section + 动态 text） ----
export {
  CORE_PERSONA_FALLBACK,
  PERSONA_SECTION_NAME,
  PERSONA_SECTION_ORDER,
  createPersonaSlot,
  loadCorePersonaMarkdown,
  mountPersonaSlot,
  registerPersonaSection,
  type PersonaSlot,
  type PersonaSource,
  type PersonaSwitchLogger,
  type PromptSectionLike,
  type SystemPromptLike,
} from './prompts/persona.js'

// ---- 会话 ensure（§8.3：reuse / resume / create） ----
export {
  ensureSession,
  type EnsureAgent,
  type EnsureAgentHandle,
  type EnsureAgentOptions,
  type EnsureAgentsLike,
  type EnsureCreateOptions,
  type EnsureOutcome,
  type EnsureResumeOptions,
  type EnsureSessionDeps,
  type EnsureSessionPersistenceLike,
  type EnsureSessionResult,
} from './session-ensure.js'

// ---- 开场 notice（§8.4：blank → 一次性投递） ----
export {
  CORE_OPENING_NOTICE_SUMMARY,
  CORE_OPENING_NOTICE_TEXT,
  buildOpeningNoticeMessage,
  deliverOpeningNotice,
  isSessionBlank,
  type BlankCheckDeps,
  type OpeningNoticeAgent,
  type OpeningNoticeAgents,
  type OpeningNoticeDeps,
  type OpeningNoticeResult,
  type SessionEventLike,
  type SessionHandleLike,
  type SessionProjectionsLike,
} from './opening-notice.js'

// ---- 调度执行链（§12：任务定义 / cron / 依赖缓存 / runner / 唤醒 / 装配） ----
export {
  DEFAULT_KNOWN_RUNTIMES,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  DEFAULT_RUN_MAX_STDERR_BYTES,
  DEFAULT_RUN_MAX_STDOUT_BYTES,
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_TASK_TIMEOUT_MS,
  DEFAULT_WAKE_COOLDOWN_MS,
  DEFAULT_WAKE_TEXT_BUDGET,
  DEPS_CACHE_FILE,
  DEFAULT_INSTALL_TIMEOUT_MS,
  STDOUT_TRUNCATION_MARKER,
  SchedulerService,
  TASK_FILE_EXT,
  TASK_ID_PATTERN,
  TaskStore,
  TaskStoreError,
  Waker,
  assertTaskId,
  buildWakeText,
  checkTaskFileReadable,
  computeDepsHash,
  createAgentWakeSink,
  createDependencyCache,
  createNodeExecStrategy,
  createPnpmInstallStrategy,
  createSchedulerService,
  createTaskStore,
  createWaker,
  deriveWakeSummary,
  inferRuntime,
  isTaskDef,
  isValidCron,
  nextCronTime,
  parseCron,
  parseTaskOutput,
  resolveTaskPath,
  runTask,
  splitGraphemes,
  truncateText,
  type Clock,
  type CronField,
  type CronSchedule,
  type DepsCacheEntry,
  type DepsCacheFile,
  type DepsCacheFs,
  type DependencyCacheOptions,
  type EnsureDepsResult,
  type ExecInput,
  type ExecResult,
  type ExecStrategy,
  type InstallInput,
  type InstallStrategy,
  type NodeExecStrategyOptions,
  type PnpmInstallStrategyOptions,
  type RunTaskDeps,
  type SchedulerRuntimeLike,
  type SchedulerServiceOptions,
  type TaskDef,
  type TaskListResult,
  type TaskRunFailureKind,
  type TaskRunOutcome,
  type TaskScriptResult,
  type TaskStoreOptions,
  type Timer,
  type TimerHandle,
  type WakeAgentLike,
  type WakeAgentsLike,
  type WakeInput,
  type WakeResult,
  type WakeSink,
  type WakerOptions,
} from './scheduler/index.js'

// ---- 生产者消息源（V4 producer-owned kind） ----
export {
  PRODUCER_KIND,
  createNoticeMessage,
  type NoticeMessageSource,
  type NoticeUserMessage,
} from './message-source.js'

// ---- 启动宽限（§4.1 / §20 第 1、5 条） ----
export {
  runGenericStartup,
  startStartupSequence,
  type GenericStartupResult,
  type StartupController,
  type StartupDeps,
  type StartupServices,
  type StartupSessionPersistence,
} from './startup.js'

// ---- 校验 ----
export {
  DISCLAIMER_MAX_BYTES,
  DomainPackValidationError,
  OPENING_NOTICE_MAX_BYTES,
  PERSONA_MAX_BYTES,
  RESERVED_ASSET_TYPE_NAMES,
  runAssetsBootstrap,
  validateDomainIdentity,
  validateDomainPack,
  type CoreSurface,
  type DomainIdentity,
  type ValidatedDomainPack,
} from './validate.js'

// ---- 日志（§13：门面 / JSONL exporter / 脱敏 / trace / 保留策略） ----
export {
  DEFAULT_LOG_LEVEL,
  LEVEL_RANK,
  LOG_LEVELS,
  LOG_LEVEL_ENV,
  isLogLevel,
  resolveLevel,
  shouldEmit,
} from './log/level.js'
export {
  TRACE_ENV,
  currentTrace,
  ensureTrace,
  newTraceId,
  runWithTrace,
  traceFromEnv,
  traceToEnv,
  withTraceMeta,
  type TraceContext,
} from './log/trace.js'
export {
  BASE_SECRET_KEY_PATTERNS,
  CIRCULAR_MARKER,
  DEFAULT_AMOUNT_KEY_PATTERNS,
  DEFAULT_MAX_ARRAY_LENGTH,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_STACK_LINES,
  DEFAULT_MAX_TEXT_LENGTH,
  MAX_DEPTH_MARKER,
  REDACTED,
  TRUNCATED_SUFFIX,
  isAmountKey,
  isSensitiveKey,
  redactRecord,
  redactText,
  type RedactOptions,
} from './log/redact.js'
export {
  DEFAULT_LOG_RETENTION_DAYS,
  LOG_RETENTION_DAYS_ENV,
  cleanupExpiredLogs,
  isDatedLogFileName,
  resolveRetentionDays,
  type CleanupExpiredLogsOptions,
  type CleanupExpiredLogsResult,
} from './log/retention.js'
export {
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_SINK_NAMESPACES,
  LOG_MAX_BYTES_ENV,
  LOG_MAX_SIZE_ENV,
  createJsonlSink,
  resolveMaxBytes,
  type JsonlLogRecord,
  type JsonlSink,
  type JsonlSinkOptions,
} from './log/exporter.js'
export {
  createLogging,
  type CreateLoggingOptions,
  type LoggingHandle,
  type LoggingLogger,
} from './log/index.js'

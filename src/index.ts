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
  DEFAULT_RSI_AGENT_CONFIG,
  resolveConfig,
  type LogLevel,
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
  NotImplementedError,
  TEARDOWN_ORDER,
  TeardownRegistry,
  createDefaultCommitPort,
  createDefaultDomainRuntime,
  createDomainLogger,
  type AgentHostConfig,
  type DefaultCommitPortOptions,
  type DefaultDomainRuntimeOptions,
  type Teardown,
  type TeardownRegistryOptions,
  type TeardownStage,
} from './service.js'

// ---- 校验 ----
export {
  DomainPackValidationError,
  PERSONA_MAX_BYTES,
  SESSION_ID_MAX_LENGTH,
  validateDomainIdentity,
  validateDomainPack,
  type CoreSurface,
  type DomainIdentity,
  type ValidatedDomainPack,
} from './validate.js'

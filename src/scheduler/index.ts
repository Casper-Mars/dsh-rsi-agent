/**
 * 调度执行链公共出口（技术方案 §12.1–12.4）。
 *
 * 模块划分：
 *   - `types`  —— 契约（TaskDef / 结局 / 可注入策略）；
 *   - `cron`   —— 5 段 cron 解析与指定时区的下一触发时刻；
 *   - `store`  —— 任务定义持久化（写入即 commit，git 降级不抛）；
 *   - `deps-cache` —— 依赖指纹缓存 + pnpm 安装策略；
 *   - `runner` —— node 执行策略 + stdout 末行 JSON 解析；
 *   - `wake`   —— 截断 / 冷却 / 降级护栏；
 *   - `task`   —— 完整触发链 `runTask`；
 *   - `service` —— 调度器装配（start/stop/reload）。
 */
export type {
  Clock,
  ExecInput,
  ExecResult,
  ExecStrategy,
  InstallInput,
  InstallStrategy,
  TaskDef,
  TaskRunFailureKind,
  TaskRunOutcome,
  TaskScriptResult,
  Timer,
  TimerHandle,
  WakeInput,
  WakeSink,
} from './types.js'

export {
  isValidCron,
  localParts,
  next as nextCronTime,
  parseCron,
  type CronField,
  type CronSchedule,
} from './cron.js'

export {
  TASK_FILE_EXT,
  TASK_ID_PATTERN,
  TaskStore,
  TaskStoreError,
  assertTaskId,
  createTaskStore,
  isTaskDef,
  type TaskListResult,
  type TaskStoreLogger,
  type TaskStoreOptions,
} from './store.js'

export {
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEPS_CACHE_FILE,
  DependencyCache,
  DepsInstallError,
  computeDepsHash,
  createDependencyCache,
  createPnpmInstallStrategy,
  type DepsCacheEntry,
  type DepsCacheFile,
  type DepsCacheFs,
  type DependencyCacheOptions,
  type EnsureDepsResult,
  type PnpmInstallStrategyOptions,
} from './deps-cache.js'

export {
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  DEFAULT_TASK_TIMEOUT_MS,
  STDOUT_TRUNCATION_MARKER,
  createNodeExecStrategy,
  parseTaskOutput,
  truncationDetail,
  type NodeExecStrategyOptions,
} from './runner.js'

export {
  DEFAULT_WAKE_COOLDOWN_MS,
  DEFAULT_WAKE_TEXT_BUDGET,
  WAKE_SUMMARY_MAX,
  Waker,
  buildWakeText,
  createWaker,
  deriveWakeSummary,
  splitGraphemes,
  truncateText,
  type WakeResult,
  type WakerOptions,
} from './wake.js'

export {
  DEFAULT_KNOWN_RUNTIMES,
  DEFAULT_RUN_MAX_STDERR_BYTES,
  DEFAULT_RUN_MAX_STDOUT_BYTES,
  DEFAULT_RUN_TIMEOUT_MS,
  checkTaskFileReadable,
  inferRuntime,
  resolveTaskPath,
  runTask,
  type RunTaskDeps,
} from './task.js'

export {
  SchedulerService,
  createAgentWakeSink,
  createSchedulerService,
  type SchedulerRuntimeLike,
  type SchedulerServiceOptions,
  type WakeAgentLike,
  type WakeAgentsLike,
} from './service.js'

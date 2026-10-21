/**
 * SKILL provider 装配层 —— 接入 dsh 原生 `skill-filesystem` provider（§4.2 / §11.1）。
 *
 * 背景：
 *   3 个固件 SKILL（`rsi-evolution` / `skill-authorship` / `task-authorship`）由
 *   `src/evolution/skills.ts` 以 `ctx.skills.register()` **静态注册**，随包发布、
 *   不参与进化；本模块**不**碰它们。
 *
 *   领域 `bootstrap` 落盘的「可进化 SKILL」写在 `<assetsDir>/skills/`，历史实现
 *   需要重启才能被感知。本模块把 dsh 原生 filesystem provider 挂到该目录上并
 *   开启 `watch`，改 `SKILL.md` 无需重启即可被技能列表感知（验收 4）。
 *
 * 范围与隔离：
 *   - 只扫 `<assetsDir>/skills`（`includeDefaultRoots: false`），不扫项目 / 用户
 *     默认目录，因此固件 SKILL 只可能来自静态注册，不会被 provider 重复发现。
 *   - `providerName` 固定 {@link SKILL_PROVIDER_NAME}，避免与 preset 内默认的
 *     `filesystem` provider 同层重名。
 *
 * 条件化（验收 3）：
 *   仅当 `pack.assets.types` 中存在 `prefix` 的**首段**为 `skills`（大小写折叠）
 *   的类型时才挂载；否则不加载依赖、不产生任何副作用（见
 *   {@link hasSkillAssetType}）。
 *
 * 同步装配 + 异步挂载：
 *   `install` 必须保持同步，故 {@link mountSkillFilesystemProvider} 立即返回句柄，
 *   内部以 fire-and-forget 方式惰性 `import()` 并 `ctx.plugin(...)`；
 *   {@link SkillProviderHandle.dispose} 是**同步可调用**的（返回同一 Promise），
 *   供 `TeardownRegistry` 的 `'skillProvider'` 阶段直接入栈。
 *
 * 就绪时机（最终一致，毫秒级）：
 *   动态 `import()` + `ctx.plugin()` + provider 首轮目录扫描都需要时间（本机实测
 *   7–60ms，vitest 负载下更高），因此 `install` 返回瞬间 `ctx.skills.list()` 可能
 *   还看不到 provider 贡献的 SKILL。需要确定性等待时用
 *   {@link SkillProviderHandle.ready}（`AgentHost.skillProviderReady` 透出同一
 *   Promise）：它 resolve 后**立即** `list()` 即可见。
 *
 * 注销时序（最终一致）：
 *   {@link SkillProviderHandle.dispose} 同步返回（内部 Promise 立即开始执行），
 *   但 chokidar 的 `watcher.close()` 是异步收敛的 —— 本机实测约 8ms 后活跃
 *   `FSWatcher` 才归零。连续 install → dispose → install 时瞬时 watcher 数可能
 *   叠加，但静置后收敛、无永久泄漏。因此「watcher 已关闭」的断言必须轮询等待，
 *   不能假设 dispose 返回后立即为 0。
 *
 * 降级语义（验收 7）：
 *   `@deepseek-ai/dsh-skill-filesystem` 是 optional peer；解析失败 / 挂载失败
 *   一律 `logger.warn` 降级，**不抛、不阻断 install**。
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AssetType, DomainLogger } from '../types.js'
import { createDomainLogger } from '../runtime.js'

/** 本插件在 `ctx.skills` 注册表中的唯一 provider 名。 */
export const SKILL_PROVIDER_NAME = 'rsi-skills'

/** 领域资产中「可进化 SKILL」的根前缀（相对 `assetsDir`）。 */
export const SKILL_ASSET_PREFIX = 'skills/'

/** 已挂载的 provider 句柄（异步入口）。 */
export interface SkillProviderMount {
  /** 被扫描的 skills 目录（`<assetsDir>/skills`）。 */
  readonly dir: string
  /** 注册进 `ctx.skills` 的 provider 名。 */
  readonly providerName: string
  /**
   * 注销器：卸载 provider 并关闭其 watch。
   *
   * **同步返回**（内部注销 Promise 立即开始执行），可 await 以等待注销完成。
   * 注意 watch 的真实关闭是异步收敛的（本机 ~8ms），await 之后活跃 `FSWatcher`
   * 通常已归零，但断言「watcher 已关闭」仍应轮询而非瞬时判定。
   */
  dispose(): Promise<void>
}

/** 同步装配入口返回的句柄。 */
export interface SkillProviderHandle extends SkillProviderMount {
  /**
   * 就绪信号：provider 已注册进 `ctx.skills` 且完成**首轮发现**（`list()` 立即可见
   * 其贡献的 SKILL）；成功或降级（warn）后 resolve，**永不 reject**。
   *
   * 供调用方 / 测试确定性等待用；install 本身不 await 它（保持同步装配）。
   */
  readonly ready: Promise<void>
}

/** 挂载选项。 */
export interface MountSkillProviderOptions {
  /** 资产根目录（`runtime.assetsDir`），必填，避免模块内重复推导路径。 */
  readonly assetsDir: string
  /** provider 名（默认 {@link SKILL_PROVIDER_NAME}）。 */
  readonly providerName?: string
  /** 是否开启 watch 热更新（默认 `true`，验收 4 依赖它）。 */
  readonly watch?: boolean
  /** 日志出口；缺省从 `ctx.logger` 派生。 */
  readonly logger?: DomainLogger
}

/** `<assetsDir>/skills`。 */
export function resolveSkillDir(assetsDir: string): string {
  return join(assetsDir, 'skills')
}

/**
 * 判断资产类型列表中是否存在 `skills/` 前缀（按**路径段**比较，大小写折叠）。
 *
 * 覆盖：`skills/`、`skills/sub/`、`Skills/` → `true`；`notes/`、`skillz/` → `false`。
 * 只比较首段，因此 `skills-archive/` 之类不会被误判。
 */
export function hasSkillAssetType(types: readonly AssetType[]): boolean {
  return types.some((type) => {
    if (typeof type?.prefix !== 'string') return false
    const first = type.prefix.split('/')[0]
    return first !== undefined && first.toLowerCase() === 'skills'
  })
}

/** `ctx.logger` 的只读探测器（与 `service.ts` / `evolution/skills.ts` 同款降级策略）。 */
function readService(ctx: Context, name: string): unknown {
  const getter = (ctx as unknown as { get?: (serviceName: string) => unknown }).get
  if (typeof getter === 'function') {
    try {
      const value = getter.call(ctx, name)
      if (value !== undefined) return value
    } catch {
      // 落到属性读取
    }
  }
  try {
    return (ctx as unknown as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}

function resolveLogger(ctx: Context, explicit?: DomainLogger): DomainLogger {
  return explicit ?? createDomainLogger(readService(ctx, 'logger'), 'skills')
}

/**
 * 挂载 `skill-filesystem` provider（**异步**，等待插件加载完成）。
 *
 * 动态加载 optional peer 并 `ctx.plugin(...)` 到当前 ctx（未 scoped ⇒ global 层）。
 * 失败时**抛出**，由调用方决定降级（同步入口会 catch 并 warn）。
 */
export async function mountSkillFilesystemProviderAsync(
  ctx: Context,
  options: MountSkillProviderOptions,
): Promise<SkillProviderMount> {
  const providerName = options.providerName ?? SKILL_PROVIDER_NAME
  const watch = options.watch ?? true
  const dir = resolveSkillDir(options.assetsDir)

  // `skill-filesystem` 声明了 `inject: ['skills']`；服务缺失时 `ctx.plugin`
  // 会永久 pending，ready/dispose 都不会 settle。提前降级（由同步入口 warn）。
  if (readService(ctx, 'skills') === undefined) {
    throw new Error('ctx.skills 服务不可用，跳过 skill-filesystem provider 挂载')
  }

  // 惰性加载：optional peer，模块图（chokidar / yaml）不随插件本体强制解析。
  const mod = await import('@deepseek-ai/dsh-skill-filesystem')

  // 仅扫自定义目录、不做 project/user 默认 roots 发现；指向资产层 skills 目录。
  const fiber = ctx.plugin(mod as never, {
    providerName,
    includeDefaultRoots: false,
    customSkillDirs: [dir],
    watch,
  } as never)
  await fiber

  // `await fiber` 只保证 provider 已注册；首轮扫描（chokidar open + 目录遍历）
  // 仍可能滞后。主动触发一次 `list()`，把 `ready` 的语义钉死为「立即 list 可见」。
  // 首次发现失败不应升级为安装失败（后续 list 仍可重试），故只吞掉错误。
  const skills = readService(ctx, 'skills') as
    | { list?: (options: unknown) => Promise<unknown> }
    | undefined
  if (typeof skills?.list === 'function') {
    try {
      await skills.list({})
    } catch {
      // 探测失败交由后续真实调用重试；ready 仍 resolve（降级语义）。
    }
  }

  return {
    dir,
    providerName,
    dispose: () => fiber.dispose(),
  }
}

/**
 * 挂载 `skill-filesystem` provider（**同步**装配入口）。
 *
 * 立即返回句柄；内部异步挂载，失败只 `logger.warn` 降级（不抛、不中断 install）。
 * 注销器绑定 `ctx.effect`（若可用），插件 fiber 卸载时自动注销并关闭 watch；
 * 同时 `dispose()` 幂等且同步可调用，可直接压入 `TeardownRegistry`。
 */
export function mountSkillFilesystemProvider(
  ctx: Context,
  options: MountSkillProviderOptions,
): SkillProviderHandle {
  const providerName = options.providerName ?? SKILL_PROVIDER_NAME
  const logger = resolveLogger(ctx, options.logger)
  const dir = resolveSkillDir(options.assetsDir)

  const started: Promise<SkillProviderMount | undefined> = mountSkillFilesystemProviderAsync(ctx, options).catch(
    (error: unknown) => {
      // 依赖不可解析 / 挂载失败：降级不抛，install 继续（验收 7）。
      logger.warn('skill-filesystem provider 挂载失败（降级，可进化 SKILL 需重启后生效）', error)
      return undefined
    },
  )

  let mounting: SkillProviderMount | undefined
  const ready: Promise<void> = started.then((mount) => {
    mounting = mount
  })

  let disposing: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposing === undefined) {
      disposing = (async () => {
        const mount = await started
        if (mount !== undefined) await mount.dispose()
      })().catch((error: unknown) => {
        logger.warn('skill-filesystem provider 注销失败（已忽略）', error)
      })
    }
    return disposing
  }

  // 插件 fiber 卸载时自动注销；effect 主体只登记 disposer，不阻塞装配。
  const effect = (ctx as unknown as { effect?: (body: () => () => void, label?: string) => unknown })
    .effect
  if (typeof effect === 'function') {
    try {
      effect.call(ctx, () => () => void dispose(), 'rsi skill-filesystem provider')
    } catch (error) {
      logger.warn('skill-filesystem provider 未能绑定 ctx.effect（改为仅由 teardown 注销）', error)
    }
  }

  return { dir, providerName, ready, dispose }
}

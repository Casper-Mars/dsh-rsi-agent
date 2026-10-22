# dsh-rsi-agent

> RSI Agent 运行时（dsh 插件 core）：以「递归自我改进」为主循环的通用 Agent 宿主。

`dsh-rsi-agent` 是一个基于 [DeepSeek Harness（dsh）](https://deepseek-harness.github.io/deepseek-harness/) 的 Cordis 插件。它本身**不是**一个能干活的业务 Agent，而是一层**与领域无关的运行时**：提供 agentHost 契约与装配、单仓资产（写入即 commit）、进化引擎、调度执行链、任务定义工具与统一日志，供领域包（DomainPack）挂载具体业务能力。

## 这是什么 / 不是什么

**是什么**

- **dsh 插件 core**：导出 `name` / `inject` / `apply`，通过 `cordis.patch.yml` 挂进 dsh profile。
- **agentHost 契约**：`AgentHost.install(pack)` 接收领域包，做完整契约校验（`src/validate.ts`），装配工具 / 固件 SKILL / 资产 / 调度，失败整体回滚，同一时刻只允许一个领域激活。
- **通用运行时能力**：单仓资产与 `asset_*` 工具、进化引擎（策略 / 模板渲染 / 固件守卫）、调度执行链与 `task_*` 工具、日志门面（JSONL / 脱敏 / trace）、固定会话与开场 notice。

**不是什么**

- **不是业务 Agent**：不含任何行业人设、业务规则或默认业务流程。
- **不含领域词**：`src/**` 里不允许出现具体领域业务词，由 `pnpm check:domain-words` 强制（白名单为空，不允许单文件豁免）。
- **不是模型 / 框架替代品**：不实现 LLM 调用、工具协议或插件容器，这些全部由 dsh（`@deepseek-ai/cordis`、`dsh-llm`、`dsh-tools`、`dsh-skill`）提供。
- **不替领域决定语义**：资产类型、任务程序、进化策略阈值都由领域包声明，core 只提供机制与守卫。

## 安装

前置：Node.js >= 22.19.0、pnpm >= 11.7.0，以及 dsh 宿主（支持 `0.2.0-rc.2` 与 `0.2.1-rc.2`，见[版本契约](#版本契约)）。

### 只装 core（无领域包）

```sh
dsh plugin --profile <p> add <path-or-pkg>
```

`<path-or-pkg>` 可以是本地目录（如 `.`、`../dsh-rsi-agent`），也可以是包名。装完后 profile 里只有 `rsi-agent` 一个插件；因为没有任何领域 `install`，home 落在 `<homeRoot>/core`。

### core + 领域包

```sh
dsh plugin --profile <p> add <domain-path>
```

领域包的 `cordis.patch.yml` 会**同时插入 core 与自身**（`rsi-agent` 在前，领域插件在后），因此不需要先手动装一遍 core。两个插件都进 profile 后，领域在 `apply` 阶段调用 `AgentHost.install(pack)`，home 随即切到 `<homeRoot>/<domainId>`。

> 插件挂载顺序有意义：core 必须先于领域插件加载，否则领域的 `inject` 拿不到 `agentHost` 服务。

### 本地开发形态

```sh
git clone https://github.com/Casper-Mars/dsh-rsi-agent.git
cd dsh-rsi-agent
pnpm i
pnpm build
dsh plugin --profile dev add .
```

`pnpm build` 会先 `pnpm clean`，再跑类型检查、`tsc -p tsconfig.server.json`，最后由 `scripts/copy-assets.mjs` 把 `skills/`、`src/prompts/persona.md` 与 `cordis.patch.yml` 搬进 `dist-server/`。**未 build 的目录直接 `add` 会因 `main` 指向不存在的 `dist-server/index.js` 而加载失败。**

验证装好了：

```sh
dsh --profile <p> --dump-config
```

输出里应出现 `id: rsi-agent`，且**没有** `skipping` 字样（`skipping` 表示某个 patch 条目解析失败被跳过）。

## home 切换与资产可见性

这是本插件**最容易被误解**的一点，单独成节说明。

### home 在哪

home 根目录（`homeRoot`）按以下优先级解析（`src/runtime.ts` 的 `resolveHomeRoot`）：

1. `DSH_RSI_HOME`（非空）
2. 插件配置 `homeRoot`
3. `$DSH_HOME/.dsh-rsi-agent`
4. `~/.dsh-rsi-agent`

**home** 则是 `homeRoot` 下的一级子目录：

| 场景 | home 路径 | 举例（`homeRoot = ~/.dsh-rsi-agent`） |
|------|-----------|----------------------------------------|
| 未安装任何领域（只有 core） | `<homeRoot>/core` | `~/.dsh-rsi-agent/core` |
| 已安装领域（`pack.id = <domainId>`） | `<homeRoot>/<domainId>` | `~/.dsh-rsi-agent/example-domain` |

也就是说：**装领域包会把工作目录整体换掉**，从 `core/` 换到 `<domainId>/`。`assets`、`data`、`logs`、`workspace` 四个子目录全部跟着 home 走。

### 切换 ≠ 删除

切换 home **不会删除**旧目录里的任何东西。旧 `core/` 下的资产、数据、日志原样保留在磁盘上，只是当前进程不再读写它们。

具体路径示例：

```
~/.dsh-rsi-agent/
├── core/                      # 曾经无领域时使用的 home（卸载领域后仍然在）
│   ├── assets/                # 旧资产仓库（装过领域后即独立 git 仓）
│   ├── data/
│   ├── logs/
│   └── workspace/
└── example-domain/            # 装上领域后的新 home
    ├── assets/
    ├── data/
    ├── logs/
    └── workspace/
```

### 怎么回看旧 home 的资产

- **直接看文件**：`ls ~/.dsh-rsi-agent/core/assets`。
- **看提交历史**：`assets/` 的 git 仓在**领域装配后（install / 首次资产写入）**才初始化（`AgentHost.install` 调 `ensureAssetsRepo`），每个 home 各自独立；装过领域的 home 直接 `git -C ~/.dsh-rsi-agent/core/assets log --stat`。
  core-only（没装领域）的 home 只会创建空 `assets/` 目录、**不会** `git init`，此时首次 `git log` 报 `fatal: not a git repository` 属预期，不是故障。
- **用工具看**：`asset_history` 只查**当前 home** 的资产仓。要查旧 home，要么把 `DSH_RSI_HOME` 指回原来的 `homeRoot`（此时没有领域 → home 又是 `core`），要么直接用上面的 git 命令。

> 常见误判：以为「装上领域」等于「迁移数据」。**没有迁移**——core home 与领域 home 是两套互不相干的目录。需要复用旧资产时，请手动从旧 `assets/` 复制（或 `git` cherry-pick）到新 home，并自行确认资产类型前缀合法。

## 版本契约

**唯一真源是 `peerDependencies`**，不是 `engines`，也不是启动器的 manifest 校验。

| 依赖 | 区间 / 版本 | 作用 |
|------|------------|------|
| `@deepseek-ai/cordis` | `^4.0.5`（peer） | 插件容器 |
| `@deepseek-ai/dsh-llm` | `^0.2.0-rc.2`（peer） | LLM 接入 |
| `@deepseek-ai/dsh-skill` | `^0.2.0-rc.2`（peer，optional） | SKILL 注册 |
| `@deepseek-ai/dsh-skill-filesystem` | `^0.2.0-rc.2`（peer，optional） | 文件系统 SKILL provider |
| `@deepseek-ai/dsh-tools` | `^0.2.0-rc.2`（peer，optional） | 工具注册 |

约定：

1. **四个 `@deepseek-ai/dsh-*` 的 peer 区间必须互等**（当前统一 `^0.2.0-rc.2`）。它们由同一套宿主发布，区间不一致意味着允许了从未一起验证过的组合。
2. **devDependencies 钉死最新已验证版本**（当前 `0.2.1-rc.2`，不带 `^` / `~`）：本地与 CI 的默认测试跑在最新版上，而 peer 区间负责放行最低版。
3. **CI 跑双版本矩阵**：`0.2.0-rc.2`（最低支持）与 `0.2.1-rc.2`（当前最新）各跑一遍 `check:peers` / `typecheck` / `check:domain-words` / `wiki:check` / `test`，任一失败即红。
4. **不声明 `engines.dsh`**：该字段已于 2026-10-21 拍板**已删除**。官方的安装器与加载器都不校验它，写了只会制造「假锁」——用户以为被拦住，实际照装不误，于是版本门槛出现两个真源并静默漂移。`tests/version-guard.spec.ts` 现在断言 `engines` 中**不得**存在 `dsh` 字段，防止有人把它加回来。

支持的运行时版本范围因此是：**`0.2.0-rc.2` 与 `0.2.1-rc.2`**（以及 `^0.2.0-rc.2` 区间内未来通过 CI 的补丁版）。

5. **peer 门槛要真的能红**：pnpm 11.7 的 `pnpm install` 遇到 peer 不匹配只打 `WARN`、退出码仍是 `0`；`strict-peer-dependencies` / `strictPeerDependencies` 在该版本都不改变这个行为（`.npmrc` 的项目级配置也已不被读取）。所以本仓把 `pnpm peers check` 作为门槛，接入 `pnpm verify` 与 CI（`pnpm check:peers`）——不满足 peer 区间时它 `exit 1` 并点名「谁要什么、实际装了什么」。

### 不要用 allow-version 豁免

遇到 peer 不匹配时，**不要**用 `--no-strict-peer-dependencies`、`.npmrc` 里的 `strict-peer-dependencies=false`，或任何 `allow-version` / `ignore-peer` 之类的手段把校验关掉：

```sh
# ❌ 不要这样
dsh plugin --profile <p> add <path-or-pkg> --no-strict-peer-dependencies
```

理由：

- 关掉校验只是**让安装继续**，不改变实际解析到的运行时版本。契约不匹配（工具 schema、SKILL 注册签名、`Service` 生命周期）会在运行期才爆，错误位置离原因很远。
- 本包的能力全部建立在 dsh 的公共契约上；peer 区间是「验证过的组合」的声明式表达，绕过它等于声称未验证的组合可用。
- 豁免会静默传染：一次本地豁免能装上，CI 双版本矩阵就不再能代表真实安装路径。

> 现状（pnpm 11.7）：`install` 本身对 peer 冲突只告警、不失败，所以「装上了」不等于「契约成立」。判断是否真的成立，看 `pnpm check:peers` 的退出码，而不是 `install` 的退出码。

正确做法二选一：

1. **升级运行时**到 peer 区间内的版本（推荐）；
2. **改区间**：如果确实需要新的运行时语义，同时更新四个 peer 区间、钉新版 devDependencies、把新版本加进 CI 矩阵，并在 CHANGELOG 里写明。

## 演进闭环速览

```
资产（领域声明的类型，如 skills/ records/ tasks/ programs/）
   │  写入
   ▼
AssetWriter.register()  ──►  落盘 + 单次 git commit（写入即 commit）
   │
   ├──► asset_history   回溯某路径的提交历史
   ├──► asset_show      读当前内容（含类型 / 大小）
   └──► asset_commit    对已有改动补一次提交
```

- **资产单仓**：领域装配后（`install` 时 `ensureAssetsRepo`），`<home>/assets` 是资产层唯一的 git 仓库，所有资产类型共用它，没有嵌套仓。写盘与提交在同一个 `register()` 调用里完成——不存在「写了但没进版本库」的中间态（git 不可用时降级为 `degraded: true`，资产已落盘但未提交，调用方能在返回值里看到）。
- **写入即 commit**：`register()` 是同步且批量原子的：一批 spec 要么全部落盘 + 一个 commit，要么一个都不写。
- **任务定义**：`task_create` / `task_list` / `task_get` / `task_update` / `task_delete` / `task_enable` / `task_disable` 七个工具管理任务定义（cron、程序、启停），落盘走 `TaskStore`，同样进资产仓。
- **进化引擎**：`EvolutionPolicy` 提供证据门槛与变更纪律（单变量、预注册、节流、保留负结果、历史不可变）；`rsi-evolution` / `skill-authorship` / `task-authorship` 三个固件 SKILL 随包发布、不参与进化，注册前按策略渲染模板变量。
- **日志**：分级门面（`debug` / `info` / `warn` / `error`）同时转发 `ctx.logger` 与 JSONL exporter；字段级脱敏在写盘前执行；`trace` 提供跨调用的关联 id。

## 目录布局

运行时目录全部在 `<home>` 下动态创建（**不是**仓库里的目录）：

```
<home>/
├── assets/       # 资产层；领域装配后成为 git 仓库；0755
├── data/         # 私有运行时数据；0700
├── logs/         # JSONL 运行日志；0700
└── workspace/    # 任务程序 / 临时工作区；0755
```

| 目录 | 权限 | 理由 |
|------|------|------|
| `assets/` | `0o755` | 资产可分享、可进 git，允许同机其他用户读取 |
| `data/` | `0o700` | 含用户私有运行时数据，仅属主可访问 |
| `logs/` | `0o700` | 日志可能含会话内容，仅属主可访问（文件 `0o600`） |
| `workspace/` | `0o755` | 任务程序执行目录，允许同机读取 |

`homeRoot` 与 `home` 以 `0o755` 创建，**实际权限受进程 umask 影响**（如 `umask 077` 下落到 `0o700`）——`mkdir` 的 `mode` 只是申请值。且**不会 chmod 已存在的上层目录**：如果你把 `homeRoot` 指到自己的私有目录（如 `0o700`），本插件不会把它放宽（见 `src/runtime.ts` 的 `ensureParentDir`）。

日志策略：按天切割 `<home>/logs/<UTC 日期>.jsonl`；单文件超过 500 MB 滚动为 `-1` / `-2`… 后缀；默认保留 30 天。可用 `DSH_RSI_LOG_LEVEL` / `DSH_RSI_LOG_RETENTION_DAYS` / `DSH_RSI_LOG_MAX_SIZE` 覆盖，`DSH_RSI_HOME` 覆盖 homeRoot，`DSH_RSI_SESSION_ID` 覆盖会话 id。

## 开发与验证

```sh
pnpm typecheck          # 源码 + 类型测试（tsconfig.json / tsconfig.type-tests.json）
pnpm test               # vitest，777 例
pnpm check:peers        # peer 区间门槛（pnpm 11 的 install 只告警，这里才真红）
pnpm check:domain-words # core 领域无关性（白名单为空）
pnpm wiki:check         # 文档一致性：链接 / 代码路径（按分句判免责）/ 废弃概念 / 必备小节
pnpm verify             # 上面五条按序全跑
pnpm build              # clean + typecheck + 编译 + 搬运 .md / patch 资源
```

**CI 下测试文件串行**（`vitest.config.ts` 里 `CI` 时 `fileParallelism: false`、`maxWorkers: 1`）：本仓大量用例真实起 `git` / `node` 子进程，这些**同步**子进程会阻塞 worker 事件循环，多 worker 洪峰下主进程的 `onTaskUpdate` RPC 会超时（birpc 默认 60s），表现为「用例全过但 exit 1」。串行是为结果确定性付出的时间成本，不是性能配置失误。

更多用例矩阵见 `docs/test-matrix.md`。

## 首发形态

**GitHub tag + 本地路径安装**：

```sh
git clone https://github.com/Casper-Mars/dsh-rsi-agent.git
cd dsh-rsi-agent && pnpm i && pnpm build
dsh plugin --profile <p> add .
```

**明确暂不发 npm**：当前发布形态（bundle patch 的插入顺序、领域包与 core 的 peer 关系、home 切换语义）尚未稳定，而 npm 一旦发出就不能撤回——版本号会被永久占用，错误的 `files` / `exports` 也会被缓存传播。首发只通过仓库 tag 分发；等形态稳定、且有一次真实的「第三方领域包接入」验证后，再讨论上架。

打包自检（不发也能验）：

```sh
pnpm pack
tar -tzf dsh-rsi-agent-0.1.0.tgz
```

包内应含 `cordis.patch.yml`、`dist-server/**`、`skills/`、`README.md`、`AGENTS.md`、`CHANGELOG.md`、`LICENSE`，**不含** `src/`、`tests/`、`.github/`、`docs/`。

## License

Apache-2.0

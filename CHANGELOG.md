# Changelog

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed

- **领域人设改为叠加而非替换**：`useDomain()` 此前直接把 core 正文覆盖掉，导致装领域后 system prompt 只剩领域人设。现槽位内部分持 `coreText`（懒加载、只读一次）与 `domainText`，`text()` 返回「core + `\n\n---\n\n` + domain」；领域正文为空时不产生孤立分隔符；卸载后恢复纯 core。单 section 与「不重建会话」语义不变。

- **peer 门槛恢复可执行**：删掉 `.npmrc` 里的 `strict-peer-dependencies=false`（该键在 pnpm 11 已不生效，留着只会误导）。实测 pnpm 11.7 的 `install` 对 peer 不匹配只告警、exit 0，故新增 `pnpm check:peers`（`pnpm peers check`）并接入 `verify` 与 CI 两个 job——peer 区间不满足时真红。
- **wiki-check 废弃概念按分句判定**：免责词只对命中所在分句生效（以 `。；;，,` 切句），同句其它分句的「不得 / 已删除」不再赦免本分句。
- **README 权限说法**：`homeRoot` / `home` 改为「以 `0o755` 创建，实际权限受 umask 影响；不 chmod 已存在的上层目录」。
- **README 资产仓说法**：限定为「领域装配后（install / 首次资产写入）初始化」，并说明 core-only 空目录首次 `git log` 报 `not a git repository` 属预期。

## [0.1.0] - 2026-10-22

首个版本。**仅通过 GitHub 仓库 tag 分发，未发布到 npm。**

### Added

- **agentHost 契约与装配**：`AgentHost` 作为 cordis `Service` 提供 `install(pack)`；`DomainPack` 契约（`apiVersion` / `assets` / 工具 / 固件 SKILL / 进化策略 / 调度 / 日志 / notice）在装配前完整校验，失败整体回滚；同一时刻只允许一个领域激活（`src/validate.ts`）。
- **运行时与 home 体系**：`homeRoot` 优先级 `DSH_RSI_HOME` > 配置 > `$DSH_HOME/.dsh-rsi-agent` > `~/.dsh-rsi-agent`；home 为 `<homeRoot>/core`（无领域）或 `<homeRoot>/<pack.id>`（有领域）；`assets` / `data` / `logs` / `workspace` 四目录按需创建并设置权限（`0755` / `0700` / `0700` / `0755`）。
- **资产单仓 + 写入即 commit**：`<home>/assets` 是唯一资产 git 仓库；`AssetWriter.register()` 批量原子落盘并产生单个 commit；路径白名单拒绝 `..`、绝对路径、`.git`、反斜杠；`seed` / `upsert` 两种写入模式；git 不可用时显式降级（`degraded: true`）。
- **资产工具**：`asset_commit` / `asset_history` / `asset_show`。
- **进化引擎**：`EvolutionPolicy` 默认值深合并；证据门槛与变更纪律（单变量、预注册、节流、保留负结果、历史不可变）；模板渲染与未知变量校验；固件 SKILL 保留名的双层防线。
- **固件 SKILL**：`rsi-evolution`（正文含模板变量，注册前渲染）/ `skill-authorship` / `task-authorship`，随包发布、不参与进化。
- **调度执行链**：cron 解析、依赖缓存、独立进程 runner、唤醒护栏与去重。
- **任务定义工具**：`task_create` / `task_list` / `task_get` / `task_update` / `task_delete` / `task_enable` / `task_disable`；落盘走 `TaskStore`，与资产同仓提交。
- **启动编排**：persona 槽位（core 唯一 section，随领域 install 叠加 core 基座 + 领域补充）、固定会话 ensure、开场 notice 投递、启动宽限期（装配中顺延，失败不消耗宽限）。
- **日志体系**：分级门面（同时转发 `ctx.logger` 与 exporter）、按天 JSONL（`<UTC 日期>.jsonl`）、超限滚动、保留期清理、字段级脱敏、`trace` 关联 id。
- **测试体系与 CI**：777 例；六条安全反例（`tests/counterexamples.spec.ts`）；`version-guard` 守护；领域词检查；文档一致性检查；GitHub Actions 的 `verify` job 与 dsh 双版本矩阵。

### Version contract

- **版本门槛的唯一真源是 `peerDependencies`**：四个 `@deepseek-ai/dsh-*` 的区间互等，统一 `^0.2.0-rc.2`；`@deepseek-ai/cordis` 为 `^4.0.5`。
- **`engines.dsh` 已删除**：2026-10-21 拍板移除。官方安装器 / 加载器都不校验该字段，保留只会制造「假锁」并让版本门槛出现两个真源；`tests/version-guard.spec.ts` 现断言 `engines` 中不得存在 `dsh` 字段。node / pnpm 门槛仍保留在 `engines`。
- **devDependencies 钉死**：四个 dsh 包钉 `0.2.1-rc.2`（无 `^` / `~`），保证本地与 CI 默认跑在最新已验证版本上。
- **支持的 dsh 版本**：`0.2.0-rc.2`（最低）与 `0.2.1-rc.2`（最新），两者均在 CI 矩阵中全量验证。
- **不要用豁免开关**：遇到 peer 不匹配时升级运行时或改区间，不用 `--no-strict-peer-dependencies` 之类手段绕过校验。

### Notes

- **分发方式**：GitHub tag + `dsh plugin --profile <p> add <path>`，暂不发 npm（发布形态未稳，npm 发出不可撤回）。发布清单见 `AGENTS.md`。
- **包内容**：`files` 包含 `dist-server/**`、`skills/`、`cordis.patch.yml`、`README.md`、`AGENTS.md`、`CHANGELOG.md`；不含 `src/`、`tests/`、`.github/`、`docs/`。
- **home 切换不迁移数据**：装领域后 home 从 `core/` 换到 `<domainId>/`，旧目录原样保留，详见 README「home 切换与资产可见性」。

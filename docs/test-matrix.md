# 测试矩阵（方案 §18 · 16 条验收 → 用例）

> 用途：CI 的 `pnpm wiki:check` 会校验本文件里的代码路径真实存在；人读时用它回答
> 「这条验收由哪个用例守着」。**用例名必须与磁盘上的 `it(...)` 字面量一致**，
> 改测试名时请同步改本表（`scripts/wiki-check.mjs` 只强制路径存在，不解析用例名，
> 一致性靠 review 保证）。
>
> 统计口径：`pnpm test`（vitest，41 个 spec 文件）。
> 方案原文不在本仓，条目名按本仓实现语义重述；每条都给出可直接点开的测试文件。

| # | 验收项 | 测试文件 › 用例名 | 状态 |
|---|--------|------------------|------|
| 1 | DomainPack 契约：全字段合法即通过；任何字段非法都点名具体字段 | `tests/agent-host.contract.spec.ts` › 「第二次 install 抛错，信息含已激活 id 与 version」；`tests/validate-domain-pack.spec.ts` › 「所有字段齐备时校验通过，返回工具快照与人设 Markdown」 | ✅ |
| 2 | 单领域约束：第二个领域 install 必败，且不破坏已激活领域 | `tests/counterexamples.spec.ts` › 「已激活领域存在时再次 install → 抛错点名两者，且不破坏已激活领域」；`tests/lifecycle-hmr.spec.ts` › 「第二个领域被拒后 dispose 第一个 → 第二个可正常安装」 | ✅ |
| 3 | 运行时路径与权限：home 优先级、四个目录落地、data/logs=0700、assets/workspace=0755 | `tests/runtime.spec.ts` › 「data / logs 为 0o700，assets / workspace 为 0o755，且四个目录真实存在」；`tests/runtime-home-priority.spec.ts` › 「installOptions.home 压过 DSH_RSI_HOME 与 config.homeRoot」 | ✅ |
| 4 | 会话 ensure 三分支：live 复用 / 持久化 resume / 新建 create | `tests/session-ensure.spec.ts` › 「分支 1：agents.get 命中 → 复用，不调用 stat / resume / create」；同文件「分支 2：stat 命中 → resume，不调用 create」「分支 3：都不存在 → create，cwd 精确等于 workspaceDir」 | ✅ |
| 5 | blank 判读与开场 notice：blank 才投递、领域文案优先、grace 时序 | `tests/startup-grace.spec.ts` › 「grace 内 install → 取消计时器，只出现领域开场」；`tests/opening-notice.spec.ts` › 「判读优先级 1：投影 blank=true → 直接 blank，不打开事件日志」 | ✅ |
| 6 | 人设切换与恢复：section 动态 text，dispose 恢复通用人设 | `tests/persona-slot.spec.ts` › 「section 使用动态 text provider：同一个 section 对象在切换后返回新文案」；`tests/agent-host.contract.spec.ts` › 「当前 install 登记 active + tools 两步，dispose 后均失效」 | ✅ |
| 7 | 工具真实注册：进 `ctx.tools` 可执行、重名拒绝、失败回滚 | `tests/agent-host.contract.spec.ts` › 「install 后 ctx.tools.get(name) 可执行，dispose 后消失」「与 ctx.tools 已注册工具重名 → 抛契约错误并点名冲突工具」「注册中途失败 → 回滚已注册工具、不留 active」 | ✅ |
| 8 | 资产 bootstrap：注册即落盘 + 一次 register 只产生一个 commit | `tests/assets-writer.spec.ts` › 「首次 seed → 恰好 1 个 commit，作者固定，message 含 create 与 spec.message」「一次 register 多文件 → 只产生 1 个 commit」 | ✅ |
| 9 | 资产批量原子性：一条非法则整批不落盘（文件清单 + commit 数双断言） | `tests/counterexamples.spec.ts` › 「1 条合法 + 1 条越界 → 文件清单不变、commit 数不变」；`tests/assets-writer.spec.ts` › 「整批拒绝 → assets 下无新增文件、无新增 commit、工作区保持干净」 | ✅ |
| 10 | 资产历史 / 版本内容：sha 白名单注入防护、UTF-8 边界截断、history/show 契约 | `tests/assets-history.spec.ts` › 「可注入执行器：非法 sha 全部拒绝，且执行器调用次数为 0」「300 KB 中文文件 → truncated:true，content 中 U+FFFD 出现 0 次」 | ✅ |
| 11 | async bootstrap 必败，错误信息含 `bootstrap` | `tests/counterexamples.spec.ts` › 「assets.bootstrap 声明为 async → install 抛 DomainPackValidationError，message 含 bootstrap」；`tests/assets-writer.spec.ts` › 「普通函数返回 Promise → install 失败，错误信息含 bootstrap」 | ✅ |
| 12 | 可进化 SKILL provider：条件挂载、watch 热更新、卸载、依赖缺失降级 | `tests/skills-provider.spec.ts` › 「未声明 skills/ 前缀：install 成功、不加载 provider 依赖、技能列表无 provider 贡献」「改写 SKILL.md → 技能列表在无重启情况下反映新内容」 | ✅ |
| 13 | 任务定义工具 task_*（create/update/disable/enable/delete/list + 落盘基准） | `tests/scheduler-tools.spec.ts` › 「写入 assets/tasks/<id>.json，产生一次 commit，message 首行为 tasks: create <id>」「真实 SchedulerService：disable → 移出调度；enable → 重新装配」 | ✅ |
| 14 | 调度触发链：install / spawn / exec / parse 失败分类、超时、stdout 上限、冷却、单飞 | `tests/scheduler-task.spec.ts` › 「未知运行时（.py）→ failed / install 并点名 python」「spawn 失败 → failed / spawn」「超时 → failed / exec」「stdout 截断 → failed / exec（标记已生效）」「冷却中 → skipped」 | ✅ |
| 15 | cron：只接受 5 段、时区感知的下一触发、DOM/DOW 或语义、永不命中报错 | `tests/scheduler-cron.spec.ts` › 「段数不是 5 → 报错并给出实际段数」「Asia/Shanghai：每天 09:00 对应 01:00Z」「日/周同时受限取「或」语义」「永不命中的表达式（2 月 31 日）→ 抛错」 | ✅ |
| 16 | 日志治理：脱敏、跨天滚动、0700/0600、trace 跨进程、保留清理 | `tests/log-exporter.spec.ts` › 「token=abc 与 meta 深层 token 全部为 [REDACTED]，无明文残留」「注入时钟跨天 → 生成两个 YYYY-MM-DD.jsonl」；`tests/zz-task12-independent.spec.ts` › 「真实 spawn 子进程继承同一 traceId」 | ✅ |

## 附录：Task-14 新增的工程守卫（不属于 §18 验收，但进 CI）

| 守卫 | 测试文件 › 用例名 | 状态 |
|------|------------------|------|
| 版本门槛唯一真源是 `peerDependencies`；`engines` 不得再承载 dsh 版本 | `tests/version-guard.spec.ts` › 「package.json.engines 不存在 dsh 字段（防止已删除字段被加回）」 | ✅ |
| 四个 dsh peer 区间一致、dev 版本钉死且满足 peer 区间 | `tests/version-guard.spec.ts` › 「四个 peer 区间完全一致」「dev 版本满足对应 peer 区间（includePrerelease）」 | ✅ |
| core 与领域无关：`src/` 不得出现领域词 | `scripts/check-domain-words.mjs`（`pnpm check:domain-words`） | ✅ |
| 文档一致性：链接 / 代码路径存在、无废弃概念、scripts 引用的文件存在 | `scripts/wiki-check.mjs`（`pnpm wiki:check`） | ✅ |
| 构建产物引用（`dist/` `dist-server/` `node_modules/` `coverage/`）不校验存在性（干净 clone 里本就不存在），只校验命名并在输出里列出跳过项 | `scripts/wiki-check.mjs` | ✅ |
| 六条红线反例 | `tests/counterexamples.spec.ts`（反例 1–6） | ✅ |
| HMR 重入无 timer / 工具残留 | `tests/lifecycle-hmr.spec.ts` › 「调度器 timer 在 dispose 后归零，重装后重新装回（无泄漏、无叠加）」 | ✅ |

# AGENTS.md

给**未来维护者**与**在本仓库里干活的 Agent** 的边界说明。写代码前先读完；与 README 冲突时，以本文件与守护测试为准。

## 1. 这个仓库不做业务

`dsh-rsi-agent` 是**与领域无关**的运行时（core）。领域语义只能出现在领域包里，不能出现在这里。

- **硬禁令**：`src/**` 不得出现具体领域的业务词。当前禁词表：`finance` / `investment` / `ledger` / `predict` / `金融` / `股票` / `ETF`（大小写不敏感）。
- **执行者**：`node scripts/check-domain-words.mjs`（`pnpm check:domain-words`），命中即 `exit 1` 并打印 `文件:行号: 行内容`。
- **白名单故意为空**：不允许单文件豁免。「这次特殊」是领域语义渗进 core 的唯一入口。
- **同义替换也算违规**：禁词表是下限，不是全部。写「行情」「持仓」「标的」这类词同样破坏领域无关性，评审要拦。
- **提示词同样受限**：`src/prompts/` 是通用人设槽位，不得写死任何行业角色或业务流程。

## 2. 唯一写入入口：AssetWriter / TaskStore

**资产必须先落盘再进版本库，且两者必须是同一次调用。**

- **资产写入**：只能走 `AssetWriter.register()`（`src/assets/writer.ts`）。它负责路径白名单校验（拒绝 `..`、绝对路径、`.git`、反斜杠）、类型前缀归属校验、批量原子落盘，以及**一次调用产生一个 commit**。
- **任务定义**：只能走 `TaskStore`（`src/scheduler/store.ts`）。任务的增删改查、启停都必须经过它，由它维护文件形状与提交。
- **禁止**：不得用 `writeFileSync` / `fs.writeFile` / `createWriteStream` 直接往 `<home>/assets` 里写任何东西。绕过后资产不会进 git，`asset_history` 看不到，回滚与审计全部失效。
- **禁止**：不得自己 `git add` / `git commit` 资产目录。提交信息由 `src/assets/commit.ts` 统一生成（`assets: create …` / `assets: update …` 形态），自己拼会破坏历史可读性。
- **降级是例外不是常态**：git 不可用时 `register()` 返回 `degraded: true`，资产已落盘但未提交。调用方必须把这个标记透出去，不得静默当成成功。

## 3. 契约变更规则

公共契约在 `src/types.ts`，校验在 `src/validate.ts`。

- **`DOMAIN_API_VERSION` 递增条件**：任何**不兼容**变更都必须 +1。包括但不限于：删除 / 重命名字段、收紧已有字段的取值范围、改变方法的同步 / 异步语义、改变返回值结构、给 `AssetType.prefix` 增加新的保留规则。
- **`DomainPack` 只能可选新增**：新增字段必须是可选的，且缺省行为要与「字段不存在」时完全一致。必填新增 = 破坏性变更 = 必须递增 `DOMAIN_API_VERSION`（而首发期我们不做破坏性变更）。
- **校验只有一套**：`validate.ts` 是唯一校验入口；进化策略的标量规则复用 `src/evolution/policy.ts` 导出的检查函数，不得在别处再写一份口径。
- **单领域约束**：同一时刻只允许一个领域 `install`，第二个必须抛错。不要为了「多领域共存」放宽这条——home 目录语义（`<homeRoot>/<domainId>`）依赖它。
- **失败必须整体回滚**：`install` 中途失败不得留下半个激活领域（工具、固件 SKILL、服务注册都要逆序撤销）。

## 4. 版本契约

- **peer 为真源**：`package.json.peerDependencies` 是版本门槛的唯一来源。四个 `@deepseek-ai/dsh-*` 的区间必须**互等**（当前统一 `^0.2.0-rc.2`），`@deepseek-ai/cordis` 为 `^4.0.5`。
- **devDeps 钉版本**：`devDependencies` 里四个 dsh 包必须钉死具体版本（无 `^` / `~`，当前 `0.2.1-rc.2`），且必须满足 peer 区间。
- **禁止加回 `engines.dsh`**：该字段**不得**再加回 `package.json`。原因：官方安装器 / 加载器都不校验它，写了只是「假锁」，会让版本门槛出现两个真源并静默漂移。2026-10-21 已拍板删除。
- **守护测试位置**：`tests/version-guard.spec.ts`。它断言 `engines` 存在 `node` / `pnpm`、但**不存在** `dsh` 字段；断言四个 peer 区间完全一致且形如 `^0.2.x-rc.x`；断言 devDeps 钉死且满足区间。改版本时先看这个文件，别改断言去迁就代码。
- **改版本的正确姿势**：同时改 ①四个 peer 区间 ②四个 devDeps 版本 ③CI 矩阵版本列表 ④CHANGELOG。四处缺一，`version-guard` 或矩阵 job 就会红。
- **不要用豁免开关**：`--no-strict-peer-dependencies`、`strict-peer-dependencies=false` 之类的手段一律不用，理由见 README「不要用 allow-version 豁免」。
- **门槛的执行者是 `pnpm check:peers`**：pnpm 11 的 `install` 对 peer 不匹配只告警（exit 0），别拿 install 绿了当契约成立。`verify` 与 CI 都已接入该命令，本地改依赖后也跑一遍。

## 5. 测试红线

- **六条反例不可删、不可弱化**：`tests/counterexamples.spec.ts` 里的六条是安全边界，不是普通用例——
  1. 第二个领域 `install` 必败（单领域约束）
  2. `../` 路径必拒（写入与执行两个入口）
  3. 未知模板变量必败
  4. `type` 未声明的注册必拒
  5. 批量中一条非法则整批不落盘（文件清单 + commit 数双断言）
  6. 异步 `bootstrap` 必败，错误信息含 `bootstrap`

  改这六条的任何断言前，先问「我是不是在拆守卫」。答案是「是」就停手。
- **突变验证**：新增或修改守卫逻辑时，必须做一次「删掉守卫 → 测试必须报红」的验证，并在 PR 描述里贴出红/绿对比。只有绿、没有红，说明用例没有真正覆盖该分支。
- **不允许 `skip` / `only` 进主干**：临时跳过可以本地用，提交前必须删。
- **测试不得污染真实 home**：`tests/setup-env.ts` 负责隔离（`DSH_RSI_HOME` 指到临时目录）。不要在用例里直接读写 `~/.dsh-rsi-agent`。
- **CI 串行是刻意的**：`vitest.config.ts` 在 `CI` 下 `fileParallelism: false` / `maxWorkers: 1`，因为同步子进程洪峰会饿死主进程 reporter 的 `onTaskUpdate` RPC。不要为了「快」改回并行——那会得到随机的 `exit 1`。

## 6. 发布清单

首发形态是 **GitHub tag + 本地路径安装**，暂不发 npm。每次打 tag 前逐条过：

1. `pnpm install --frozen-lockfile` —— 锁文件与 `package.json` 一致。
2. `pnpm verify` —— `typecheck` / `check:domain-words` / `wiki:check` / `test` 全绿。
3. `pnpm build` —— 干净构建通过。
4. `pnpm pack`，然后 `tar -tzf dsh-rsi-agent-<version>.tgz` 核对：
   - **必须含**：`cordis.patch.yml`、`dist-server/**`、`skills/`、`README.md`、`AGENTS.md`、`CHANGELOG.md`、`LICENSE`；
   - **必须不含**：`src/`、`tests/`、`.github/`、`docs/`、`node_modules/`。
5. **全新 clone 冒烟**：`git clone <本仓> /tmp/smoke && cd /tmp/smoke && pnpm i --frozen-lockfile && pnpm build`，再 `DSH_HOME=/tmp/smoke-home dsh plugin --profile smoke add .`，最后 `dsh --profile smoke --dump-config` 确认含 `id: rsi-agent` 且无 `skipping`。
6. `CHANGELOG.md` 有对应版本小节，含支持的 dsh 版本范围（当前 `0.2.0-rc.2` / `0.2.1-rc.2`）。
7. `package.json.version` 与 tag 一致；**不要**顺手改版本号或往 `engines` 里加 `dsh`。

> 不发 npm 的理由：发布形态（patch 插入顺序、core 与领域包的 peer 关系、home 切换语义）还没稳，而 npm 发出不可撤回。等有一次真实的第三方领域包接入验证后再讨论上架。

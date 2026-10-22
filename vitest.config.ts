import { defineConfig } from 'vitest/config'

/**
 * Vitest 配置。
 *
 * Task-01 阶段仅有骨架级用例；`passWithNoTests` 保证在测试集为空时也能
 * 以成功状态退出，便于 CI 在骨架期直接接入。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.test.ts'],
    // 隔离 home：单测不得在真实 `~/.dsh-rsi-agent` 下建目录。
    setupFiles: ['tests/setup-env.ts'],
    passWithNoTests: true,
    // 资产仓库相关用例会真实起 git 子进程（install / commit / 回滚），并行
    // worker 下偶发超过 5s 默认值；放宽到 15s，避免把机器负载误判为逻辑失败。
    testTimeout: 15_000,
    // 本仓用例大量使用真实子进程（git / node 任务脚本，单个用例可达 5–9s）。
    // 这些**同步**子进程调用会阻塞 worker 的事件循环，主进程的 `onTaskUpdate`
    // RPC 因此可能超时（birpc 默认 60s），表现为「用例全过但 exit 1」。
    //
    // 实测（同一台机器、同一份代码，每次均 777 例全过）：
    //   · maxWorkers=4：连续 2 次全量各出现 3 个
    //     `[vitest-worker]: Timeout calling "onTaskUpdate"` → exit 1；
    //   · maxWorkers=2：连续 3 次 exit 0（另有一次在并发跑别的验证时出现 1 个同类超时）；
    //   · 单独跑未改动的 `tests/assets-history.spec.ts`（18 例 / 76s）同样复现该超时
    //     → 与具体用例无关，是多 worker 同步子进程洪峰饿死主进程 reporter 的池级问题。
    // 故 **CI 固定文件串行**（结果必须确定性，宁可慢）；本地保留 2 worker 维持开发体验。
    pool: 'forks',
    ...(process.env.CI ? { fileParallelism: false, maxWorkers: 1 } : { maxWorkers: 2 }),
    minWorkers: 1,
  },
})

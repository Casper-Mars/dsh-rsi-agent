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
    // 线程池下这些**同步**子进程调用会阻塞 worker 的事件循环，主进程的
    // `onTaskUpdate` RPC 因此超时（birpc 默认 60s），表现为「用例全过但 exit 1」。
    // 换成进程池（forks）+ 固定 4 个 worker：RPC 走 IPC 且互相隔离，退出码稳定。
    pool: 'forks',
    maxWorkers: 4,
    minWorkers: 1,
  },
})

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
  },
})

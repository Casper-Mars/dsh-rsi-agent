/**
 * 测试环境隔离：把 `DSH_RSI_HOME` 指到一个临时目录，避免单测在真实
 * `~/.dsh-rsi-agent` 下创建目录；同时清除 `DSH_HOME`，防止宿主环境干扰断言。
 *
 * 使用 `process.env` 是测试文件的特权（`src/**` 仍禁止直接读取环境变量）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_RSI_HOME = mkdtempSync(join(tmpdir(), 'dsh-rsi-vitest-'))
delete process.env.DSH_HOME

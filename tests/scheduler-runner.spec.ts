/**
 * runner：末行 JSON 解析 / 独立进程执行 / 超时强杀 / stdout 1MiB 上限 / stderr 有界。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_STDOUT_BYTES,
  DEFAULT_TASK_TIMEOUT_MS,
  createNodeExecStrategy,
  parseTaskOutput,
} from '../src/scheduler/runner'

const roots: string[] = []

function script(source: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rsi-runner-'))
  roots.push(dir)
  const file = join(dir, 'task.mjs')
  writeFileSync(file, source, 'utf8')
  return { dir, file }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('runner · 末行 JSON 解析', () => {
  it('取最后一个非空行（忽略日志行与尾随空行）', () => {
    const stdout = 'log line\n{"shouldWake":false}\n\n  \n'
    expect(parseTaskOutput(stdout)).toEqual({ shouldWake: false })
  })

  it('唤醒分支保留 data 原文', () => {
    expect(parseTaskOutput('{"shouldWake":true,"data":"你好\\n世界"}')).toEqual({
      shouldWake: true,
      data: '你好\n世界',
    })
  })

  it('干扰行不是 JSON → 只要末行合法就成功', () => {
    expect(parseTaskOutput('{"bad":1}\n{"shouldWake":false}')).toEqual({ shouldWake: false })
  })

  it('末行 JSON 非法 → null', () => {
    expect(parseTaskOutput('{"shouldWake":false}\nnot-json')).toBeNull()
  })

  it('空输出 / 全空白 → null', () => {
    expect(parseTaskOutput('')).toBeNull()
    expect(parseTaskOutput('\n \n\t')).toBeNull()
  })

  it('shouldWake 非 boolean → null', () => {
    expect(parseTaskOutput('{"shouldWake":"yes"}')).toBeNull()
    expect(parseTaskOutput('{"data":"x"}')).toBeNull()
  })

  it('shouldWake=true 但 data 非 string → null', () => {
    expect(parseTaskOutput('{"shouldWake":true}')).toBeNull()
    expect(parseTaskOutput('{"shouldWake":true,"data":1}')).toBeNull()
  })

  it('数组 / 标量 JSON → null', () => {
    expect(parseTaskOutput('[1,2]')).toBeNull()
    expect(parseTaskOutput('42')).toBeNull()
  })
})

describe('runner · 默认限额', () => {
  it('超时 60s、stdout 上限 1 MiB', () => {
    expect(DEFAULT_TASK_TIMEOUT_MS).toBe(60_000)
    expect(DEFAULT_MAX_STDOUT_BYTES).toBe(1_048_576)
  })
})

describe('runner · node 执行策略（真实子进程）', () => {
  const exec = createNodeExecStrategy()

  it('exit 0 + stdout 可用，cwd 为任务目录', async () => {
    const { dir, file } = script('console.log("noise")\nconsole.log(JSON.stringify({shouldWake:false}))\nconsole.log(process.cwd())\n')
    const result = await exec.exec({
      taskPath: file,
      cwd: dir,
      timeoutMs: 5000,
      maxStdoutBytes: 1_048_576,
      maxStderrBytes: 4096,
    })
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.stdout).toContain(dir)
    expect(parseTaskOutput(result.stdout)).toBeNull() // 末行是 cwd，不是 JSON
  })

  it('非零退出码被如实返回', async () => {
    const { dir, file } = script('process.exit(3)\n')
    const result = await exec.exec({
      taskPath: file,
      cwd: dir,
      timeoutMs: 5000,
      maxStdoutBytes: 1_048_576,
      maxStderrBytes: 4096,
    })
    expect(result.exitCode).toBe(3)
  })

  it('stderr 被收集并受上限约束', async () => {
    const { dir, file } = script('process.stderr.write("x".repeat(5000))\n')
    const result = await exec.exec({
      taskPath: file,
      cwd: dir,
      timeoutMs: 5000,
      maxStdoutBytes: 1_048_576,
      maxStderrBytes: 100,
    })
    expect(result.stderr).toHaveLength(100)
    expect(result.stderr).toBe('x'.repeat(100))
  })

  it('超时 → timedOut 且进程被强杀', async () => {
    const { dir, file } = script('setInterval(() => {}, 1000)\n')
    const started = Date.now()
    const result = await exec.exec({
      taskPath: file,
      cwd: dir,
      timeoutMs: 150,
      maxStdoutBytes: 1_048_576,
      maxStderrBytes: 4096,
    })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('stdout 超限 → 截断并标记，缓冲不超过上限', async () => {
    const { dir, file } = script('process.stdout.write("a".repeat(5000))\nsetTimeout(()=>{},200)\n')
    const result = await exec.exec({
      taskPath: file,
      cwd: dir,
      timeoutMs: 5000,
      maxStdoutBytes: 100,
      maxStderrBytes: 4096,
    })
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(100)
    expect(result.stdout).toBe('a'.repeat(100))
  })

  it('任务文件不存在 → node 以非零退出码失败（stderr 有诊断）', async () => {
    const { dir } = script('')
    const result = await exec.exec({
      taskPath: join(dir, 'missing.mjs'),
      cwd: dir,
      timeoutMs: 5000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('spawn 抛错（注入）→ spawnError', async () => {
    const strategy = createNodeExecStrategy({
      spawn: (() => {
        throw new Error('EACCES')
      }) as never,
    })
    const { dir, file } = script('')
    const result = await strategy.exec({
      taskPath: file,
      cwd: dir,
      timeoutMs: 5000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
    })
    expect(result.spawnError).toBe('EACCES')
  })
})


describe('runner · stdout 上限按 UTF-8 字节（L2）', () => {
  const exec = createNodeExecStrategy()

  it('CJK 内容按字节截断：600,027 个汉字（1,800,081 字节）被拦下', async () => {
    const { dir, file } = script('process.stdout.write("中".repeat(600027))\nsetTimeout(()=>{},200)\n')
    const result = await exec.exec({
      taskPath: file,
      cwd: dir,
      timeoutMs: 8000,
      maxStdoutBytes: DEFAULT_MAX_STDOUT_BYTES,
      maxStderrBytes: 4096,
    })

    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(DEFAULT_MAX_STDOUT_BYTES)
    // 贴近上限（只差不到一个字符），说明不是被提前砍掉。
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeGreaterThan(DEFAULT_MAX_STDOUT_BYTES - 8)
    // 全是完整汉字：既无替换符，也无残字节（长度必为 3 的倍数）。
    expect(result.stdout.includes('\uFFFD')).toBe(false)
    expect(Buffer.byteLength(result.stdout, 'utf8') % 3).toBe(0)
    expect(result.stdout).toBe('中'.repeat(result.stdout.length))
  })

  it('emoji 结尾不被切开（无孤立代理项 / 替换符）', async () => {
    const { dir, file } = script('process.stdout.write("😀".repeat(100))\nsetTimeout(()=>{},200)\n')
    const result = await exec.exec({
      taskPath: file,
      cwd: dir,
      // 11 字节：放得下 2 个 4 字节 emoji，第 3 个整块丢弃（不能留 3 个残字节）。
      maxStdoutBytes: 11,
      maxStderrBytes: 4096,
      timeoutMs: 5000,
    })

    expect(result.truncated).toBe(true)
    expect(result.stdout).toBe('😀😀')
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(11)
    expect(result.stdout.includes('\uFFFD')).toBe(false)
    // 每个码点都是完整的 emoji（不含孤立代理项）
    expect(Array.from(result.stdout).every((char) => char === '😀')).toBe(true)
  })
})

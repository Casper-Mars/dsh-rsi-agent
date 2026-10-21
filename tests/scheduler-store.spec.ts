/**
 * 任务定义存储：id 防穿越 / 损坏跳过 / save·remove 走 commitAssets（git 降级不抛）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitResult, GitRunner } from '../src/assets/git'
import {
  TaskStoreError,
  assertTaskId,
  createTaskStore,
  isTaskDef,
  type TaskDef,
} from '../src/scheduler/store'

const roots: string[] = []

function tempAssets(): { root: string; assetsDir: string; tasksDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rsi-tasks-'))
  roots.push(root)
  const assetsDir = join(root, 'assets')
  const tasksDir = join(assetsDir, 'tasks')
  mkdirSync(join(assetsDir, '.git'), { recursive: true })
  mkdirSync(tasksDir, { recursive: true })
  return { root, assetsDir, tasksDir }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

const ok = (stdout = ''): GitResult => ({ ok: true, stdout, stderr: '', code: 0 })
const bad = (stderr = 'boom'): GitResult => ({ ok: false, stdout: '', stderr, code: 1 })

/** 记录调用；默认让一次提交成功。 */
function fakeGit(options: { failAdd?: boolean; throwAt?: string; status?: string } = {}): {
  run: GitRunner
  calls: string[][]
} {
  const calls: string[][] = []
  const run: GitRunner = (args) => {
    calls.push([...args])
    if (options.throwAt !== undefined && args[0] === options.throwAt) throw new Error('git crashed')
    if (options.failAdd === true && args[0] === 'add') return bad('add failed')
    switch (args[0]) {
      case 'diff':
        if (args.includes('--name-only')) return ok('tasks/demo.json\0')
        return ok(`${options.status ?? 'A'}\ttasks/demo.json\n`)
      case 'rev-parse':
        return ok('deadbeef\n')
      default:
        return ok()
    }
  }
  return { run, calls }
}

const TASK: TaskDef = {
  id: 'demo',
  name: '示例任务',
  cron: '0 9 * * *',
  task_path: 'programs/demo/task.ts',
  enabled: true,
}

describe('任务 id 防目录穿越', () => {
  it('接受字母数字开头的常规 id', () => {
    expect(assertTaskId('market-pulse')).toBe('market-pulse')
    expect(assertTaskId('a.b_c-1')).toBe('a.b_c-1')
  })

  it('拒绝空串 / 特殊路径段', () => {
    expect(() => assertTaskId('')).toThrow(TaskStoreError)
    expect(() => assertTaskId('.')).toThrow(/特殊路径段/)
    expect(() => assertTaskId('..')).toThrow(/特殊路径段/)
  })

  it('拒绝路径分隔符与反斜杠', () => {
    expect(() => assertTaskId('../etc/passwd')).toThrow(/路径分隔符/)
    expect(() => assertTaskId('a/b')).toThrow(/路径分隔符/)
    expect(() => assertTaskId('a\\b')).toThrow(/路径分隔符/)
  })

  it('拒绝空字符与超长 id', () => {
    expect(() => assertTaskId('a\0b')).toThrow(/空字符/)
    expect(() => assertTaskId(`a${'b'.repeat(200)}`)).toThrow(/必须匹配/)
  })

  it('get 对穿越 id 抛错（编程错误要响亮）', () => {
    const { assetsDir, tasksDir } = tempAssets()
    const store = createTaskStore({ tasksDir, assetsDir })
    expect(() => store.get('../../evil')).toThrow(/路径分隔符/)
  })

  it('filePath 拼接结果始终位于 tasksDir 下', () => {
    const { assetsDir, tasksDir } = tempAssets()
    const store = createTaskStore({ tasksDir, assetsDir })
    expect(store.filePath('demo')).toBe(join(tasksDir, 'demo.json'))
  })
})

describe('任务结构守卫', () => {
  it('合法任务返回 true', () => {
    expect(isTaskDef(TASK)).toBe(true)
  })

  it('缺字段 / 类型不符 / 非对象一律 false', () => {
    expect(isTaskDef({ ...TASK, enabled: 'yes' })).toBe(false)
    expect(isTaskDef({ ...TASK, cron: undefined })).toBe(false)
    expect(isTaskDef(null)).toBe(false)
    expect(isTaskDef([])).toBe(false)
  })

  it('id 非法的记录也不算有效任务', () => {
    expect(isTaskDef({ ...TASK, id: '../x' })).toBe(false)
  })
})

describe('读写与损坏文件', () => {
  it('save 后 get / list 立即可读（跨实例恢复）', () => {
    const { assetsDir, tasksDir } = tempAssets()
    createTaskStore({ tasksDir, assetsDir }).save(TASK)
    const store = createTaskStore({ tasksDir, assetsDir })
    expect(store.get('demo')).toEqual(TASK)
    expect(store.list().tasks).toEqual([TASK])
  })

  it('save 落盘格式为可读 JSON（带换行）', () => {
    const { assetsDir, tasksDir } = tempAssets()
    createTaskStore({ tasksDir, assetsDir }).save(TASK)
    const raw = readFileSync(join(tasksDir, 'demo.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual(TASK)
  })

  it('list 按 id 升序', () => {
    const { assetsDir, tasksDir } = tempAssets()
    const store = createTaskStore({ tasksDir, assetsDir })
    store.save({ ...TASK, id: 'zeta' })
    store.save({ ...TASK, id: 'alpha' })
    expect(store.list().tasks.map((task) => task.id)).toEqual(['alpha', 'zeta'])
  })

  it('损坏 JSON / 结构非法 → 归入 corrupted，不中断其它任务', () => {
    const { assetsDir, tasksDir } = tempAssets()
    const store = createTaskStore({ tasksDir, assetsDir })
    store.save({ ...TASK, id: 'good' })
    writeFileSync(join(tasksDir, 'broken.json'), '{not json', 'utf8')
    writeFileSync(join(tasksDir, 'shape.json'), JSON.stringify({ id: 'shape' }), 'utf8')
    const result = store.list()
    expect(result.tasks.map((task) => task.id)).toEqual(['good'])
    expect(result.corrupted.sort()).toEqual(['broken', 'shape'])
  })

  it('非 .json 文件被忽略', () => {
    const { assetsDir, tasksDir } = tempAssets()
    writeFileSync(join(tasksDir, 'note.md'), '# nope', 'utf8')
    const result = createTaskStore({ tasksDir, assetsDir }).list()
    expect(result).toEqual({ tasks: [], corrupted: [] })
  })

  it('目录不存在 → 空清单', () => {
    const { assetsDir } = tempAssets()
    const store = createTaskStore({ tasksDir: join(assetsDir, 'missing'), assetsDir })
    expect(store.list()).toEqual({ tasks: [], corrupted: [] })
  })

  it('get 不存在 / 损坏 → undefined', () => {
    const { assetsDir, tasksDir } = tempAssets()
    const store = createTaskStore({ tasksDir, assetsDir })
    expect(store.get('nope')).toBeUndefined()
    writeFileSync(join(tasksDir, 'bad.json'), 'x', 'utf8')
    expect(store.get('bad')).toBeUndefined()
  })

  it('save 结构非法 → 抛错且不落盘', () => {
    const { assetsDir, tasksDir } = tempAssets()
    const store = createTaskStore({ tasksDir, assetsDir })
    expect(() => store.save({ ...TASK, enabled: 1 } as unknown as TaskDef)).toThrow(TaskStoreError)
    expect(existsSync(join(tasksDir, 'demo.json'))).toBe(false)
  })

  it('remove 删除文件；重复删除返回 false', () => {
    const { assetsDir, tasksDir } = tempAssets()
    const store = createTaskStore({ tasksDir, assetsDir })
    store.save(TASK)
    expect(store.remove('demo')).toBe(true)
    expect(existsSync(join(tasksDir, 'demo.json'))).toBe(false)
    expect(store.remove('demo')).toBe(false)
  })
})

describe('写入即 commit（git 降级不抛）', () => {
  it('save 产生一次 add + commit，paths 为 tasks/<id>.json', () => {
    const { assetsDir, tasksDir } = tempAssets()
    const { run, calls } = fakeGit()
    createTaskStore({ tasksDir, assetsDir, git: run }).save(TASK)
    const add = calls.find((args) => args[0] === 'add')
    expect(add).toEqual(['add', '--', 'tasks/demo.json'])
    expect(calls.some((args) => args[0] === 'commit')).toBe(true)
  })

  it('remove 也提交（delete 动作）', () => {
    const { assetsDir, tasksDir } = tempAssets()
    const { run, calls } = fakeGit({ status: 'D' })
    const store = createTaskStore({ tasksDir, assetsDir, git: run })
    store.save(TASK)
    calls.length = 0
    store.remove('demo')
    expect(calls.some((args) => args[0] === 'add')).toBe(true)
    expect(calls.some((args) => args[0] === 'commit')).toBe(true)
  })

  it('git add 失败 → 只 warn，save 不抛且文件已落盘', () => {
    const { assetsDir, tasksDir } = tempAssets()
    const warnings: string[] = []
    const store = createTaskStore({
      tasksDir,
      assetsDir,
      git: fakeGit({ failAdd: true }).run,
      logger: (message) => warnings.push(message),
    })
    expect(() => store.save(TASK)).not.toThrow()
    expect(existsSync(join(tasksDir, 'demo.json'))).toBe(true)
    expect(warnings.join('\n')).toMatch(/降级/)
  })

  it('git 执行器抛错 → 被吞掉并 warn（磁盘成功即业务成功）', () => {
    const { assetsDir, tasksDir } = tempAssets()
    const warnings: string[] = []
    const store = createTaskStore({
      tasksDir,
      assetsDir,
      git: fakeGit({ throwAt: 'add' }).run,
      logger: { warn: (message) => warnings.push(message) },
    })
    expect(() => store.save(TASK)).not.toThrow()
    expect(warnings.join('\n')).toMatch(/提交异常/)
  })

  it('任务目录不在资产目录内 → 跳过提交但仍落盘', () => {
    const { root, assetsDir } = tempAssets()
    const tasksDir = join(root, 'data', 'tasks')
    const warnings: string[] = []
    const { run, calls } = fakeGit()
    const store = createTaskStore({
      tasksDir,
      assetsDir,
      git: run,
      logger: (message) => warnings.push(message),
    })
    store.save(TASK)
    expect(existsSync(join(tasksDir, 'demo.json'))).toBe(true)
    expect(calls).toEqual([])
    expect(warnings.join('\n')).toMatch(/不在资产目录/)
  })

  it('缺少 .git 仓库 → commitAssets 降级，save 不抛', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rsi-tasks-nogit-'))
    roots.push(root)
    const tasksDir = join(root, 'assets', 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    const store = createTaskStore({ tasksDir, assetsDir: join(root, 'assets') })
    expect(() => store.save(TASK)).not.toThrow()
    expect(store.get('demo')).toEqual(TASK)
  })
})


describe('list · 文件内 id 与文件名一致性（M2）', () => {
  it('文件名与 id 不一致 → 归入 corrupted 并 warn，不进入 tasks', () => {
    const { assetsDir, tasksDir } = tempAssets()
    const warnings: string[] = []
    const store = createTaskStore({
      tasksDir,
      assetsDir,
      logger: { warn: (message: string) => warnings.push(message) },
      git: fakeGit().run,
    })
    writeFileSync(join(tasksDir, 'a.json'), `${JSON.stringify(TASK, null, 2)}\n`, 'utf8')
    writeFileSync(join(tasksDir, 'demo.json'), `${JSON.stringify(TASK, null, 2)}\n`, 'utf8')

    const listed = store.list()
    expect(listed.tasks.map((task) => task.id)).toEqual(['demo'])
    expect(listed.corrupted).toEqual(['a'])
    expect(warnings.join('\n')).toMatch(/与文件名/)
  })

  it('文件名与 id 一致 → 正常进入 tasks，corrupted 为空', () => {
    const { assetsDir, tasksDir } = tempAssets()
    const warnings: string[] = []
    const store = createTaskStore({
      tasksDir,
      assetsDir,
      logger: { warn: (message: string) => warnings.push(message) },
      git: fakeGit().run,
    })
    writeFileSync(join(tasksDir, 'demo.json'), `${JSON.stringify(TASK, null, 2)}\n`, 'utf8')

    const listed = store.list()
    expect(listed.tasks.map((task) => task.id)).toEqual(['demo'])
    expect(listed.corrupted).toEqual([])
    expect(warnings).toEqual([])
  })

  it('结构非法与 id 不一致同时存在 → 全部计入 corrupted', () => {
    const { assetsDir, tasksDir } = tempAssets()
    const store = createTaskStore({ tasksDir, assetsDir, git: fakeGit().run })
    writeFileSync(join(tasksDir, 'broken.json'), '{ not json', 'utf8')
    writeFileSync(join(tasksDir, 'other.json'), `${JSON.stringify(TASK, null, 2)}\n`, 'utf8')

    const listed = store.list()
    expect(listed.tasks).toEqual([])
    expect(listed.corrupted.sort()).toEqual(['broken', 'other'])
  })
})

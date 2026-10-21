/**
 * 类型级契约：core 公开的 `ToolDefinition` 必须与 `@deepseek-ai/dsh-tools`
 * 的同名类型**完全等价**。
 *
 * 本文件由 `tsconfig.type-tests.json` 参与 `pnpm typecheck` 的编译期检查；
 * 运行期断言只是占位（类型错误在 `tsc` 阶段就已失败）。
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ToolDefinition as DshToolDefinition } from '@deepseek-ai/dsh-tools'
import type {
  ToolDefinition as CoreToolDefinition,
  ToolOutputDefinition as CoreToolOutputDefinition,
} from '../src/types'

describe('ToolDefinition 与 dsh-tools 对齐', () => {
  it('两个类型完全等价（expectTypeOf，编译期）', () => {
    expectTypeOf<CoreToolDefinition>().toEqualTypeOf<DshToolDefinition>()
    expectTypeOf<CoreToolOutputDefinition>().toEqualTypeOf<DshToolDefinition['output']>()
    expect(true).toBe(true)
  })

  it('core 工具定义可直接传给 dsh-tools 的 register（编译期赋值）', () => {
    const definition = {
      name: 'type-probe',
      description: '编译期赋值探针',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { echoed: { type: 'string' } },
          required: ['echoed'],
          additionalProperties: false,
        },
        render: (_args: unknown, value: unknown) => [
          { type: 'text' as const, text: JSON.stringify(value) },
        ],
      },
      execute: async (args: unknown) => ({ echoed: String(args ?? '') }),
    } satisfies CoreToolDefinition

    // 编译期：core 类型可赋值给 dsh-tools 的 ToolDefinition（含必填 output / 异步 execute）。
    const asDsh: DshToolDefinition = definition
    expect(asDsh.name).toBe('type-probe')
    expect(typeof asDsh.output.render).toBe('function')
  })
})

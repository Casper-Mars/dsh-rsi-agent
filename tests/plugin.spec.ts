import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../src/plugin'
import { DEFAULT_RSI_AGENT_CONFIG, resolveConfig } from '../src/config'

describe('rsi-agent 插件契约', () => {
  it('插件名为 rsi-agent', () => {
    expect(name).toBe('rsi-agent')
  })

  it('inject 与 cordis.patch.yml 保持一致', () => {
    expect(inject).toEqual(['tools', 'skills', 'fs'])
  })

  it('apply 暴露为可调用函数', () => {
    expect(typeof apply).toBe('function')
  })

  it('apply 注册 agentHost 并启动启动序列（无会话服务时降级）', () => {
    const ctx = new Context()
    apply(ctx, { startupGraceMs: 0 })
    expect(ctx.agentHost).toBeDefined()
    expect(ctx.agentHost.apiVersion).toBe(1)
    expect(ctx.agentHost.active).toBeUndefined()
  })
})

describe('rsi-agent 配置层', () => {
  it('缺省返回默认配置', () => {
    expect(resolveConfig()).toEqual(DEFAULT_RSI_AGENT_CONFIG)
  })

  it('传入部分字段时覆盖默认值', () => {
    expect(resolveConfig({ logLevel: 'debug' })).toEqual({ logLevel: 'debug' })
  })

  it('默认配置为冻结对象', () => {
    expect(Object.isFrozen(DEFAULT_RSI_AGENT_CONFIG)).toBe(true)
  })
})

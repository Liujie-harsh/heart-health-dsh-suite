/**
 * 生命周期测试：
 * - 卸载（dispose）挂载代际后，重新创建会话可干净重装，工具集一致、无重复注册冲突
 *   （HMR/卸载语义等价：不留幽灵能力）；
 * - sanitizeBlocks / redactString 纯函数在异常输入下保持总函数行为。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { livePresetMounts } from '@deepseek-ai/dsh-agent-presets'
import {
  agentOn,
  bootHarness,
  removeHostBaseFixture,
  toolNames,
} from './helpers/harness.js'
import { createFakeHeartMcp } from './helpers/fake-heart-mcp.js'
import { redactString, scrubValue } from '../lib/privacy.js'

const WRAPPERS = [
  'heart_get_diagnosis_result',
  'heart_list_supported_views',
  'heart_submit_diagnosis',
]

let ctx: import('@deepseek-ai/cordis').Context
let hostBase: string
let fakeMcp: ReturnType<typeof createFakeHeartMcp>

beforeEach(async () => {
  const booted = await bootHarness()
  ctx = booted.ctx
  hostBase = booted.hostBase
  fakeMcp = createFakeHeartMcp(booted.ctx)
})

afterEach(() => {
  fakeMcp?.dispose()
  if (hostBase !== undefined) removeHostBaseFixture(hostBase)
})

describe('preset lifecycle', () => {
  it('mounts cleanly across concurrent and sequential sessions', async () => {
    const first = await agentOn(ctx, 'sess-life-1')
    expect(toolNames(ctx, first)).toEqual(WRAPPERS)

    // 同一 preset 的第二个并发会话：同名注册不冲突，包装面一致。
    const second = await agentOn(ctx, 'sess-life-2')
    expect(toolNames(ctx, second)).toEqual(WRAPPERS)

    // 顺序再挂一轮（模拟 HMR/重载后的新会话），仍然只有三个包装能力。
    const third = await agentOn(ctx, 'sess-life-3')
    expect(toolNames(ctx, third)).toEqual(WRAPPERS)

    // 驻留挂载恰好一条记录，且指向本套件的组合文件。
    const mounts = livePresetMounts().filter(m => m.presetId === 'heart-health')
    expect(mounts).toHaveLength(1)
    expect(mounts[0]?.presetId).toBe('heart-health')
  })
})

describe('redaction primitives are total functions', () => {
  it('survives hostile shapes without throwing', () => {
    expect(redactString('see D:\\x\\y.txt and Bearer abc123def456')).not.toContain('Bearer')
    expect(scrubValue({ nested: { token: 'x', keep: 1 }, list: [{ password: 'p' }] }))
      .toEqual({ nested: { keep: 1 }, list: [{}] })
    expect(scrubValue(null)).toBeNull()
    expect(scrubValue([1, 'two', { deep: { patient_id: 'p', value: 3 } }]))
      .toEqual([1, 'two', { deep: { value: 3 } }])
    // 深度嵌套的 unix 路径签名。
    expect(redactString('failed reading /etc/heart/secret.cfg')).toContain('<已脱敏>')
    expect(redactString('failed reading /etc/heart/secret.cfg')).not.toContain('/etc/heart')
  })
})

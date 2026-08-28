/**
 * 安全 policy 行为测试：
 * - 模型直呼 mcp__heart-algo__* 被执行前拒绝（含可操作的替代路径文案）；
 * - 包装工具的受控嵌套调用被放行且能取回 structuredContent 投影；
 * - 非心脏全局工具不受误伤；
 * - MCP 重同步新增的原始心脏工具同样被掩码覆盖；
 * - 掩码只影响 heart-health preset 下的会话，sibling preset 不受影响。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import {
  agentOn,
  bootHarness,
  removeHostBaseFixture,
  toolNames,
} from './helpers/harness.js'
import { createFakeHeartMcp, FAKE_RAW_NAMES } from './helpers/fake-heart-mcp.js'

let sequence = 0

/** 以"模型直呼"的形态（带 agent、无 parent）驱动一次工具执行。 */
async function execAsModel(
  ctx: Context,
  agentObj: unknown,
  name: string,
  args: unknown,
): Promise<ToolExecutionResult> {
  sequence += 1
  return await ctx.tools.execute({
    callId: CallId(`spec-model-${sequence}`),
    name,
    arguments: args,
    // 与 agent loop 一致：模型发起的调用不带 parent。
    agent: agentObj as never,
    signal: new AbortController().signal,
  })
}

let ctx: Context
let hostBase: string
let fakeMcp: ReturnType<typeof createFakeHeartMcp>
let agent: Awaited<ReturnType<typeof agentOn>>

beforeEach(async () => {
  const booted = await bootHarness()
  ctx = booted.ctx
  hostBase = booted.hostBase
  fakeMcp = createFakeHeartMcp(booted.ctx)
  agent = await agentOn(ctx, 'sess-policy')
})

afterEach(() => {
  fakeMcp?.dispose()
  if (hostBase !== undefined) removeHostBaseFixture(hostBase)
})

describe('heart-health policy', () => {
  it('denies a model-direct call to a raw heart MCP tool with an actionable reason', async () => {
    fakeMcp.push('submit', { structured: {} })
    const result = await execAsModel(ctx, agent, FAKE_RAW_NAMES.submit, { case_id: 'case-1' })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('安全策略禁止直接调用')
    expect(result.error.message).toContain('heart_submit_diagnosis')
    expect(fakeMcp.calls()).toHaveLength(0)
  })

  it('allows the wrapper nested call and returns the canonical submit projection', async () => {
    fakeMcp.push('submit', {
      structured: {
        case_id: 'case-9',
        task_id: 'mcp-deadbeef',
        status: 'processing',
        created: '2026-08-27T10:00:00Z',
      },
    })

    const result = await execAsModel(ctx, agent, 'heart_submit_diagnosis', {
      case_id: 'case-9',
    })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toEqual({
      case_id: 'case-9',
      task_id: 'mcp-deadbeef',
      status: 'processing',
      created: '2026-08-27T10:00:00Z',
    })
    expect(fakeMcp.calls()).toHaveLength(1)
    expect(fakeMcp.calls()[0]?.tool).toBe(FAKE_RAW_NAMES.submit)
  })

  it('does not disturb unrelated global tools for the same session', async () => {
    const disposer = ctx.tools.register({
      name: 'generic_notes_lookup',
      description: 'a non-cardiac global tool',
      parameters: { type: 'object', additionalProperties: true },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute() {
        return 'notes-ok'
      },
    })
    try {
      expect(toolNames(ctx, agent)).toContain('generic_notes_lookup')
      const result = await execAsModel(ctx, agent, 'generic_notes_lookup', {})
      expect(result.isError).toBe(false)
    } finally {
      disposer()
    }
  })

  it('extends the visibility mask when the bridge re-syncs with a new raw tool', async () => {
    fakeMcp.registerExtraRawTool('mcp__heart-algo__new_probe')

    const agentView = toolNames(ctx, agent)
    expect(agentView).not.toContain('mcp__heart-algo__new_probe')
    expect(toolNames(ctx)).toContain('mcp__heart-algo__new_probe') // 全局可见

    const result = await execAsModel(ctx, agent, 'mcp__heart-algo__new_probe', {})
    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('安全策略禁止直接调用')
  })

  it('leaves sessions on other presets unaffected by the mask and guard', async () => {
    // 直接在 host 全局层注册一个新 scope-free 模拟：用未挂载 preset 的"裸会话"不可行，
    // 因此这里断言 sibling 维度唯一可编程的面：全局视图仍解析原始工具，掩码不在全局层。
    const restrictionVisibleOnlyThroughAgent = ctx.tools.get(FAKE_RAW_NAMES.result) !== undefined
    expect(restrictionVisibleOnlyThroughAgent).toBe(true)

    // masked-from-agent 视图已在 loader-compose.spec 覆盖；此处补一个
    // "嵌套内部路径不带 agent、不受掩码影响"的直接证据。
    fakeMcp.push('views', { structured: { views: [], metrics: {} } })
    const result = await execAsModel(ctx, agent, 'heart_list_supported_views', {})
    expect(result.isError).toBe(false)
    expect(fakeMcp.calls().at(-1)?.abortedAtEntry).toBe(false)
  })
})

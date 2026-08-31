/**
 * P0 最高层验收（PRD 测试决策）：真实 Loader 组装的 heart-health profile。
 *
 * 断言的是外部行为：
 * - 组合行能被真实 Loader 加载（含裸包名经宿主 base 的 native ESM 解析）；
 * - 选择 heart-health preset 的会话只看到三个 heart_* 包装工具；
 * - 原始 mcp__heart-algo__* 从模型可见 schema 与解析中消失，但仍在全局层注册；
 * - 常驻 guidance 与临床 persona 进入装配后的 system prompt。
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { Context } from '@deepseek-ai/cordis'
import { guidanceText } from '../lib/guidance.js'
import {
  agentOn,
  assembleContextFor,
  bootHarness,
  removeHostBaseFixture,
  toolNames,
} from './helpers/harness.js'
import { createFakeHeartMcp, FAKE_RAW_NAMES } from './helpers/fake-heart-mcp.js'

const WRAPPERS = [
  'heart_analyze_case_files',
  'heart_compare_diagnoses',
  'heart_generate_report',
  'heart_get_case_detail',
  'heart_get_diagnosis_result',
  'heart_get_review_status',
  'heart_interpret_diagnosis',
  'heart_list_cases',
  'heart_list_supported_views',
  'heart_list_tasks',
  'heart_submit_diagnosis',
  'heart_submit_review',
]

let ctx: Context
let hostBase: string
let fakeMcp: ReturnType<typeof createFakeHeartMcp>

beforeEach(async () => {
  const booted = await bootHarness()
  ctx = booted.ctx
  hostBase = booted.hostBase
  // 在任何会话挂载之前注册假底层 MCP（模拟全局层的心脏 MCP bridge）。
  fakeMcp = createFakeHeartMcp(ctx)
})

afterEach(() => {
  fakeMcp?.dispose()
  if (hostBase !== undefined) removeHostBaseFixture(hostBase)
})

describe('real-loader heart-health profile composition', () => {
  it('mounts the preset and exposes only the three wrapper tools to the session', async () => {
    const agent = await agentOn(ctx, 'sess-heart')

    expect(toolNames(ctx, agent)).toEqual(WRAPPERS)
    // 全局层里原始工具仍然存在（包装工具的受控内部路径依赖这一点）。
    const globalNames = toolNames(ctx)
    for (const raw of Object.values(FAKE_RAW_NAMES)) {
      expect(globalNames).toContain(raw)
    }
    // 但该会话的解析视图认为它们不存在（restrict 掩码作用于继承面）。
    expect(ctx.tools.get(FAKE_RAW_NAMES.submit, scopeOf((agent as unknown as { ctx: Context }).ctx)))
      .toBeUndefined()
  })

  it('keeps wrapper executions independent of another session on the same preset', async () => {
    const alpha = await agentOn(ctx, 'sess-alpha')
    const beta = await agentOn(ctx, 'sess-beta')

    expect(toolNames(ctx, alpha)).toEqual(WRAPPERS)
    expect(toolNames(ctx, beta)).toEqual(WRAPPERS)
    expect(toolNames(ctx)).not.toContain('heart_submit_diagnosis') // 全局层不包含包装工具
  })

  it('assembles resident guidance and clinical persona into the system prompt', async () => {
    const agent: Agent = await agentOn(ctx, 'sess-prompt')
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))

    const texts = assembly.sections.map(section => section.text).join('\n\n')
    expect(texts).toContain(guidanceText())
    expect(texts).toContain('心血管临床场景')
    expect(texts).toContain('只查询一次')
    expect(texts).toContain('绝不编造缺失的测量值、患者信息或预测')

    // 原始心脏 MCP 工具不得出现在模型可见 schema 列表或提示词中。
    const serializedTools = JSON.stringify(assembly.tools)
    expect(serializedTools).not.toContain('mcp__heart-algo__')
    const submittedSchema = assembly.tools.find(tool => tool.name === 'heart_submit_diagnosis')
    expect(submittedSchema).toBeDefined()
    expect(Object.keys(submittedSchema!.parameters as object)).toContain('properties')
  })

  it('exposes stable wrapper schemas for automation consumers', async () => {
    const agent = await agentOn(ctx, 'sess-schema')
    const schemas = ctx.tools.schemas(agent)

    const submit = schemas.find(schema => schema.name === 'heart_submit_diagnosis')
    expect(submit?.description).toContain('case_id')
    expect(JSON.stringify(submit?.parameters)).toContain('"required":["case_id"]')
    expect(JSON.stringify(submit?.parameters)).toContain('asset_ids')

    const result = schemas.find(schema => schema.name === 'heart_get_diagnosis_result')
    expect(result?.description).toContain('task_id')

    const views = schemas.find(schema => schema.name === 'heart_list_supported_views')
    expect(views).toBeDefined()
  })
})

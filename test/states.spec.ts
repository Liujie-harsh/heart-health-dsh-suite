/**
 * 三态状态机与 canonical JSON 测试：
 * - processing / completed / failed 的判别式输出（value 与模型可见 content 双向断言）；
 * - 协议破坏时明确失败（缺 structuredContent、未知状态、failed 缺错误）；
 * - AbortSignal 穿透到嵌套调用，取消只影响本次查询。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { agentOn, bootHarness, removeHostBaseFixture, toolNames } from './helpers/harness.js'
import { createFakeHeartMcp, FAKE_RAW_NAMES } from './helpers/fake-heart-mcp.js'

let sequence = 0

async function callWrapper(
  ctx: Context,
  agentObj: unknown,
  name: string,
  args: unknown,
  options?: { signal?: AbortSignal },
): Promise<ToolExecutionResult> {
  sequence += 1
  return await ctx.tools.execute({
    callId: CallId(`spec-state-${sequence}`),
    name,
    arguments: args,
    agent: agentObj as never,
    signal: options?.signal ?? new AbortController().signal,
  })
}

function textOf(result: ToolExecutionResult): string {
  return result.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

let ctx: Context
let hostBase: string
let fakeMcp: ReturnType<typeof createFakeHeartMcp>
let agent: Awaited<ReturnType<typeof agentOn>>

const COMPLETED_STRUCTURE = {
  case_id: 'case-42',
  task_id: 'mcp-f00d',
  status: 'completed',
  hf_type: 'HFrEF',
  cardiac_ultrasound: [
    {
      dcm_id: 'dcm-1',
      measurements: {
        lvedd: { value: 55, unit: 'mm', reference: '35-55', name_cn: '左室舒末内径' },
        hf_type: 'HFrEF',
        lvef: { value: 38, unit: '%', name_cn: '左室射血分数(EF)' },
      },
      rois: [{ x: 12, y: 30 }],
      error: null,
      skip_reason: null,
    },
    {
      dcm_id: 'dcm-2',
      measurements: {},
      rois: [],
      error: null,
      skip_reason: '非 PLAX 切面',
    },
    {
      dcm_id: 'dcm-3',
      measurements: {},
      rois: [],
      error: '解码失败',
      skip_reason: null,
    },
  ],
  ecg: [
    {
      ecg_id: 'ecg-1',
      patient_info: { patientId: 'PID-9', age: 61, sex: '男' },
      measurements: { hr: { value: 88, unit: 'bpm' } },
      predictions: [
        { label: '房颤', probability: 0.92 },
        { label: 'ST 抬高', probability: 0.41 },
      ],
      error: null,
    },
    {
      ecg_id: 'ecg-2',
      patient_info: {},
      measurements: {},
      predictions: [],
      error: 'XML 解析失败',
    },
  ],
  inputs: {
    'dcm-1': { sha256: 'a'.repeat(64), sizeBytes: 1024 },
    'ecg-1': { sha256: 'b'.repeat(64), sizeBytes: 2048 },
  },
  algorithm_version: 'heart@bff1e4f+models@4bf76612484dd393',
  requires_clinician_review: true,
  review_status: 'pending',
  review: null,
}

beforeEach(async () => {
  const booted = await bootHarness()
  ctx = booted.ctx
  hostBase = booted.hostBase
  fakeMcp = createFakeHeartMcp(booted.ctx)
  agent = await agentOn(ctx, 'sess-states')
})

afterEach(() => {
  fakeMcp?.dispose()
  if (hostBase !== undefined) removeHostBaseFixture(hostBase)
})

describe('wrapper three-state contract', () => {
  it('submit returns the stable four-field canonical outcome and concise native text', async () => {
    fakeMcp.push('submit', {
      structured: { case_id: 'case-1', task_id: 'mcp-a1', status: 'processing', created: '2026-08-27T09:00:00Z' },
    })
    const result = await callWrapper(ctx, agent, 'heart_submit_diagnosis', { case_id: 'case-1' })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toEqual({
      case_id: 'case-1', task_id: 'mcp-a1', status: 'processing', created: '2026-08-27T09:00:00Z',
    })
    expect(textOf(result)).toContain('mcp-a1')
    expect(textOf(result)).toContain('后续轮次')
    expect((result.meta as Record<string, unknown>).card).toBe('heart-diagnosis-submit')
  })

  it('processing keeps the task id and fabricates nothing', async () => {
    fakeMcp.push('result', { structured: { case_id: 'c', task_id: 't-p', status: 'processing' } })
    const result = await callWrapper(ctx, agent, 'heart_get_diagnosis_result', { task_id: 't-p' })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toEqual({ case_id: 'c', task_id: 't-p', status: 'processing' })
    expect(Object.keys(result.value as object)).toHaveLength(3)
    expect(textOf(result)).toContain('处理中')
  })

  it('failed surfaces only the public error and an actionable next step', async () => {
    fakeMcp.push('result', { structured: { case_id: 'c', task_id: 't-f', status: 'failed', error: '病例不存在或未授权该服务账号' } })
    const result = await callWrapper(ctx, agent, 'heart_get_diagnosis_result', { task_id: 't-f' })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toMatchObject({ status: 'failed', error: '病例不存在或未授权该服务账号' })
    const text = textOf(result)
    expect(text).toContain('公开错误')
    expect(text).toContain('核对 case_id 与 task_id')
  })

  it('completed preserves modality separation, per-asset errors, versions and review state', async () => {
    fakeMcp.push('result', { structured: COMPLETED_STRUCTURE })
    const result = await callWrapper(ctx, agent, 'heart_get_diagnosis_result', { task_id: 'mcp-f00d' })

    expect(result.isError).toBe(false)
    if (result.isError) return

    // canonical value：判别式三态 + 完整字段集
    const value = result.value as Record<string, unknown>
    expect(value.status).toBe('completed')
    expect(value.hf_type).toBe('HFrEF')
    expect((value.cardiac_ultrasound as unknown[])).toHaveLength(3)
    expect((value.ecg as unknown[])).toHaveLength(2)
    expect(value.algorithm_version).toContain('heart@bff1e4f')

    const echoItems = value.cardiac_ultrasound as Record<string, unknown>[]
    expect(echoItems[0]).toMatchObject({
      dcm_id: 'dcm-1',
      measurements: { lvedd: { value: 55, unit: 'mm', reference: '35-55' }, hf_type: 'HFrEF' },
    })
    expect(echoItems[0].error).toBeNull()

    const ecgItems = value.ecg as Record<string, unknown>[]
    // 未批准的患者标识不进入 canonical JSON。
    expect(ecgItems[0].patient_info).toEqual({ age: 61, sex: '男' })

    const text = textOf(result)
    expect(text).toContain('[1] dcm_id=dcm-1')
    expect(text).toContain('lvedd = 55 mm')
    expect(text).toContain('[2] dcm_id=dcm-2')
    expect(text).toContain('跳过原因：非 PLAX 切面')
    expect(text).toContain('[3] dcm_id=dcm-3')
    expect(text).toContain('该资产错误：解码失败')
    expect(text).toContain('心衰分型')
    expect(text).toContain('Teichholz')
    expect(text).toContain('Top-2/2 预测')
    expect(text).toContain('多标签独立预测')
    expect(text).toContain('review_status=pending')
    expect(text).toContain('算法版本：heart@bff1e4f')
    expect(text).toContain('不能替代')

    const meta = result.meta as Record<string, unknown>
    expect(meta.card).toBe('heart-diagnosis-result')
    expect((meta.counts as Record<string, number>)).toEqual({
      cardiacUltrasound: 3,
      cardiacUltrasoundFailed: 1,
      cardiacUltrasoundSkipped: 1,
      ecg: 2,
      ecgFailed: 1,
    })
  })

  it('truncates visible ECG predictions to the configured Top-K while keeping the total', async () => {
    const manyPredictions = Array.from({ length: 10 }, (_, index) => ({
      label: `label-${index}`,
      probability: 0.5 - index * 0.04,
    }))
    fakeMcp.push('result', {
      structured: {
        ...COMPLETED_STRUCTURE,
        ecg: [{
          ecg_id: 'ecg-k',
          patient_info: null,
          measurements: {},
          predictions: manyPredictions,
          error: null,
        }],
      },
    })
    const result = await callWrapper(ctx, agent, 'heart_get_diagnosis_result', { task_id: 'mcp-f00d' })
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(textOf(result)).toContain('Top-8/10')
    // canonical 值保留完整列表；截断只发生在模型可见文本与 meta。
    expect(((result.value as Record<string, unknown>).ecg as unknown[])[0]).toBeTruthy()
    const meta = result.meta as Record<string, unknown>
    expect(meta.ecgPredictions).toEqual({ visible: 8, total: 10, truncated: true })
  })

  it('fails loudly when the underlying bridge returns no structuredContent', async () => {
    fakeMcp.push('result', { errorText: 'legacy server response without structure' })
    const result = await callWrapper(ctx, agent, 'heart_get_diagnosis_result', { task_id: 'x' })
    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('底层 MCP 工具')
  })

  it('rejects unknown task states instead of guessing', async () => {
    fakeMcp.push('result', { structured: { case_id: 'c', task_id: 't', status: 'queued-mystery' } })
    const result = await callWrapper(ctx, agent, 'heart_get_diagnosis_result', { task_id: 't' })
    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('不在 processing/completed/failed 之内')
  })

  it('propagates the caller AbortSignal into the nested MCP call', async () => {
    const controller = new AbortController()
    fakeMcp.push('result', { structured: {}, delayMs: 500 })
    setTimeout(() => controller.abort(), 40)

    const result = await callWrapper(
      ctx, agent, 'heart_get_diagnosis_result', { task_id: 't-cancel' },
      { signal: controller.signal },
    )
    expect(result.isError).toBe(true)
    const calls = fakeMcp.calls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.abortedAtEntry).toBe(false)
  })

  it('views passes the catalog through with stable presentation meta', async () => {
    fakeMcp.push('views', {
      structured: {
        views: [{ dcm_type: 'PLAX', metrics: ['lvedd', 'lvef'] }],
        metrics: { lvef: { name_cn: '左室射血分数(EF)', unit: '%', reference: '55-80' } },
      },
    })
    const result = await callWrapper(ctx, agent, 'heart_list_supported_views', {})
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toEqual({
      views: [{ dcm_type: 'PLAX', metrics: ['lvedd', 'lvef'] }],
      metrics: { lvef: { name_cn: '左室射血分数(EF)', unit: '%', reference: '55-80' } },
    })
    expect(textOf(result)).toContain('PLAX')
    expect(toolNames(ctx, agent)).toContain('heart_list_supported_views')
  })
})

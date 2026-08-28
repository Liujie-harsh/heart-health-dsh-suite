/**
 * 隐私与输入校验：
 * - 上游 structuredContent 里注入路径/stderr/Token 样式字段/额外患者标识，
 *   模型可见 content、presentation meta、canonical value 都不得包含它们；
 * - keepPatientInfo=false 配置使 patient_info 整体消失；
 * - URL / 本地路径 / 多余字段的诊断输入被拒绝并给出病例上传的正确指引。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { agentOn, bootHarness, removeHostBaseFixture } from './helpers/harness.js'
import { createFakeHeartMcp, FAKE_RAW_NAMES } from './helpers/fake-heart-mcp.js'

let sequence = 0

async function callWrapper(
  ctx: Context,
  agentObj: unknown,
  name: string,
  args: unknown,
): Promise<ToolExecutionResult> {
  sequence += 1
  return await ctx.tools.execute({
    callId: CallId(`spec-privacy-${sequence}`),
    name,
    arguments: args,
    agent: agentObj as never,
    signal: new AbortController().signal,
  })
}

function allText(result: ToolExecutionResult): string {
  return [
    ...result.content.map(block => (block.type === 'text' ? block.text : '')),
    JSON.stringify(result.meta ?? {}),
    JSON.stringify(result.value ?? {}),
  ].join('\n')
}

const LEAKY_COMPLETED = {
  case_id: 'case-leak',
  task_id: 'mcp-leak',
  status: 'completed',
  hf_type: null,
  cardiac_ultrasound: [
    {
      dcm_id: 'dcm-l1',
      measurements: { lvef: { value: 60, unit: '%' } },
      rois: [{ note: 'C:\\heart-data\\tmp\\raw_9527.dcm' }],
      error: null,
      skip_reason: '资产位于 /var/lib/heart/uploads/raw_9527.dcm，跳过分析',
    },
  ],
  ecg: [
    {
      ecg_id: 'ecg-l1',
      patient_info: { patientId: 'PID-9527', patient_name: '张某某', age: 55, sex: '女', address: '某市某路1号', phone: '13800000000' },
      measurements: {},
      predictions: [{ label: '窦性心律', probability: 0.9 }],
      error: 'upstream failed: Bearer eyJhbGciOiJIUzI1NiJ9.fake Signature rejected; stderr=Traceback (most recent call last)',
    },
  ],
  inputs: { 'dcm-l1': { sha256: 'c'.repeat(64), sizeBytes: 12 } },
  algorithm_version: 'heart@test',
  requires_clinician_review: true,
  review_status: 'pending',
  review: { token: 'super-secret-token-value', internal_path: 'D:\\heart\\internal\\cache', stderr: 'boom' },
}

describe('privacy minimization over model-visible surfaces', () => {
  let ctx: Context
  let hostBase: string
  let fakeMcp: ReturnType<typeof createFakeHeartMcp>
  let agent: Awaited<ReturnType<typeof agentOn>>

  beforeEach(async () => {
    const booted = await bootHarness()
    ctx = booted.ctx
    hostBase = booted.hostBase
    fakeMcp = createFakeHeartMcp(booted.ctx)
    agent = await agentOn(ctx, 'sess-privacy')
  })

  afterEach(() => {
    fakeMcp?.dispose()
    if (hostBase !== undefined) removeHostBaseFixture(hostBase)
  })

  it('strips paths, tokens, stderr and unapproved identifiers from every visible surface', async () => {
    fakeMcp.push('result', { structured: LEAKY_COMPLETED })
    const result = await callWrapper(ctx, agent, 'heart_get_diagnosis_result', { task_id: 'mcp-leak' })

    // 投影必须成功（净化不是协议失败）。
    expect(result.isError).toBe(false)
    const text = allText(result)

    for (const forbidden of [
      'C:\\heart-data', '/var/lib/heart', 'eyJhbGciOiJIUzI1NiJ9',
      'Bearer eyJ', 'PID-9527', '张某某', '某市某路1号', '13800000000',
      'super-secret-token-value', 'D:\\heart\\internal', 'Traceback (most recent call last)',
      'address', 'patientId',
    ]) {
      expect(text).not.toContain(forbidden)
    }

    // 投影文本中出现脱敏占位符；该 ecg 资产整体失败，因此不展示患者信息行。
    expect(text).toContain('<已脱敏>')

    // canonical value 的 review 同样被净化。
    const value = result.value as Record<string, unknown>
    const review = value.review as Record<string, unknown>
    expect(review.token).toBeUndefined()
    expect(review.internal_path).toBeUndefined()
    expect(review.stderr).toBeUndefined()

    // 合法保留的年龄性别仍保留在 canonical value 中（结构化投影），供后续轮次解读。
    const ecgItems = value.ecg as { patient_info: Record<string, unknown> | null }[]
    expect(ecgItems[0]?.patient_info).toEqual({ age: 55, sex: '女' })
  })

  it('can be configured to drop patient_info entirely', async () => {
    process.env.HEART_HEALTH_KEEP_PATIENT_INFO = 'false'
    try {
      const booted = await bootHarness()
      const ctx2 = booted.ctx
      const hostBase2 = booted.hostBase
      const fakeMcp2 = createFakeHeartMcp(ctx2)
      const agent2 = await agentOn(ctx2, 'sess-privacy-nopii')
      try {
        fakeMcp2.push('result', { structured: LEAKY_COMPLETED })
        const result = await callWrapper(ctx2, agent2, 'heart_get_diagnosis_result', { task_id: 'x' })
        expect(result.isError).toBe(false)
        expect(allText(result)).not.toContain('age=55')
        expect(allText(result)).not.toContain('sex=')
        const ecg = ((result.value as Record<string, unknown>).ecg as unknown[])[0] as Record<string, unknown>
        expect(ecg.patient_info).toBeNull()
      } finally {
        fakeMcp2.dispose()
        removeHostBaseFixture(hostBase2)
        delete process.env.HEART_HEALTH_KEEP_PATIENT_INFO
      }
    } finally {
      delete process.env.HEART_HEALTH_KEEP_PATIENT_INFO
    }
  })
})

describe('diagnostic input rejection', () => {
  let ctx: Context
  let hostBase: string
  let fakeMcp: ReturnType<typeof createFakeHeartMcp>
  let agent: Awaited<ReturnType<typeof agentOn>>

  beforeEach(async () => {
    const booted = await bootHarness()
    ctx = booted.ctx
    hostBase = booted.hostBase
    fakeMcp = createFakeHeartMcp(booted.ctx)
    agent = await agentOn(ctx, 'sess-inputs')
  })

  afterEach(() => {
    fakeMcp?.dispose()
    if (hostBase !== undefined) removeHostBaseFixture(hostBase)
  })

  it.each([
    ['http://evil.example/case-1'],
    ['file://D:/secret/case.dcm'],
    ['C:\\Users\\clinician\\a.dcm'],
    ['\\\\nas\\share\\case'],
    ['/home/user/case'],
    ['https%3a%2f%2fcase'],
  ])('rejects %s as case_id with upload guidance', async (badCaseId) => {
    fakeMcp.push('submit', { structured: {} })
    const result = await callWrapper(ctx, agent, 'heart_submit_diagnosis', { case_id: badCaseId })
    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('病例门户或病例 HTTP API')
    expect(fakeMcp.calls()).toHaveLength(0)
  })

  it('requires case_id and rejects undeclared extra fields', async () => {
    const missing = await callWrapper(ctx, agent, 'heart_submit_diagnosis', {})
    expect(missing.isError).toBe(true)

    const extra = await callWrapper(ctx, agent, 'heart_submit_diagnosis', {
      case_id: 'case-ok',
      dicom_url: 'http://x/y.dcm',
    })
    expect(extra.isError).toBe(true)
    if (!extra.isError) return
    expect(extra.error.message).toContain('不接受参数 "dicom_url"')

    const resultExtras = await callWrapper(ctx, agent, 'heart_get_diagnosis_result', {
      task_id: 't',
      wait_seconds: 300,
    })
    expect(resultExtras.isError).toBe(true)
    if (!resultExtras.isError) return
    expect(resultExtras.error.message).toContain('wait_seconds')
  })

  it('views rejects any arguments to keep the surface minimal', async () => {
    const sneaky = await callWrapper(ctx, agent, 'heart_list_supported_views', { server_hint: '../../etc/passwd' })
    expect(sneaky.isError).toBe(true)
    if (!sneaky.isError) return
    expect(sneaky.error.message).toContain('不接受参数 "server_hint"')
  })
})

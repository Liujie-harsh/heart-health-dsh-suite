/**
 * 扩展九件套包装工具测试：
 * - 每个工具的 canonical 投影（白名单字段）与模型可见中文文本；
 * - 输入校验（多余字段、非法枚举、空 files、路径类输入按工具语义放行或拒绝）；
 * - 底层 MCP 错误透传与隐私净化（报告内容中的路径被脱敏）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { agentOn, bootHarness, removeHostBaseFixture } from './helpers/harness.js'
import { createFakeHeartMcp } from './helpers/fake-heart-mcp.js'

const LF_CH = String.fromCharCode(10)

let sequence = 0

async function callWrapper(
  ctx: Context,
  agentObj: unknown,
  name: string,
  args: unknown,
): Promise<ToolExecutionResult> {
  sequence += 1
  return await ctx.tools.execute({
    callId: CallId('spec-ext-' + String(sequence)),
    name,
    arguments: args,
    agent: agentObj as never,
    signal: new AbortController().signal,
  })
}

function textOf(result: ToolExecutionResult): string {
  return result.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join(LF_CH)
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
  agent = await agentOn(ctx, 'sess-ext')
})

afterEach(() => {
  fakeMcp?.dispose()
  if (hostBase !== undefined) removeHostBaseFixture(hostBase)
})

const A64 = 'a'.repeat(64)
const B64 = 'b'.repeat(64)
const C64 = 'c'.repeat(64)

describe('heart_analyze_case_files', () => {
  it('projects one-stop outcome and forwards files to the raw tool', async () => {
    fakeMcp.push('analyze', {
      structured: {
        case_id: 'case-new',
        case_created: true,
        assets: [
          { asset_id: 'asset-echo', modality: 'CARDIAC_ULTRASOUND', dcm_type: 'PLAX', sha256: A64, size_bytes: 132, created: true },
          { asset_id: 'asset-ecg', modality: 'ECG', dcm_type: null, sha256: B64, size_bytes: 30, created: true },
        ],
        task_id: 'mcp-beef',
        status: 'processing',
        created: true,
      },
    })
    const result = await callWrapper(ctx, agent, 'heart_analyze_case_files', {
      files: [
        { path: 'D:/cases-local/echo.dcm', modality: 'CARDIAC_ULTRASOUND', dcm_type: 'PLAX', asset_id: 'asset-echo' },
        { path: 'D:/cases-local/ecg.xml', modality: 'ECG', asset_id: 'asset-ecg' },
      ],
      request_id: 'mcp-batch-1',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      case_id: 'case-new',
      case_created: true,
      assets: [
        { asset_id: 'asset-echo', modality: 'CARDIAC_ULTRASOUND', dcm_type: 'PLAX', sha256: A64, size_bytes: 132, created: true },
        { asset_id: 'asset-ecg', modality: 'ECG', dcm_type: null, sha256: B64, size_bytes: 30, created: true },
      ],
      task_id: 'mcp-beef',
      status: 'processing',
      created: true,
    })
    expect(textOf(result)).toContain('已创建病例 case-new')
    expect(textOf(result)).toContain('task_id: mcp-beef')
    const last = fakeMcp.calls()[fakeMcp.calls().length - 1]
    expect(last?.tool).toBe('mcp__heart-algo__analyze_case_files')
    expect((last?.args as Record<string, unknown>)['submit']).toBe(true)
    expect((last?.args as Record<string, unknown>)['request_id']).toBe('mcp-batch-1')
  })

  it('rejects empty files, unknown modality, missing dcm_type and extra keys', async () => {
    const badBodies = [
      { files: [] },
      { files: [{ path: 'x.dcm', modality: 'MRI' }] },
      { files: [{ path: 'x.dcm', modality: 'CARDIAC_ULTRASOUND' }] },
      { files: [{ path: 'x.xml', modality: 'ECG', dcm_type: 'PLAX' }] },
      { files: [{ path: 'x.dcm', modality: 'ECG' }], bogus: 1 },
    ]
    for (const args of badBodies) {
      const result = await callWrapper(ctx, agent, 'heart_analyze_case_files', args)
      expect(result.isError).toBe(true)
    }
    expect(fakeMcp.calls()).toHaveLength(0)
  })
})

describe('heart_interpret_diagnosis', () => {
  it('projects completed interpretation with abnormal findings', async () => {
    fakeMcp.push('interpret', {
      structured: {
        task_id: 'mcp-f00d',
        case_id: 'case-42',
        status: 'completed',
        hf_type: 'HFrEF',
        algorithm_version: 'heart@test',
        requires_clinician_review: true,
        review_status: 'pending',
        lvef_value: 38,
        lvef_classification: 'HFrEF',
        abnormal_findings: [
          { scope: 'dcm-1', metric: 'lvef', name_cn: '左室射血分数(EF)', value: 38, unit: '%', reference: '55-70', status: 'low' },
        ],
        unavailable_assets: [],
        combined_indicators: [
          { name: 'E/A', value: 2.02, reference: '0.8-2.0', status: 'high', basis: 'measured' },
        ],
        ecg_highlights: [],
        notes: ['规则比对输出，仅供辅助。'],
      },
    })
    const result = await callWrapper(ctx, agent, 'heart_interpret_diagnosis', { task_id: 'mcp-f00d' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      task_id: 'mcp-f00d',
      status: 'completed',
      lvef_classification: 'HFrEF',
    })
    expect(textOf(result)).toContain('LVEF（Teichholz 估算）：38%')
    expect(textOf(result)).toContain('左室射血分数(EF)')
    expect(textOf(result)).toContain('规则比对输出')
  })

  it('passes processing through without inventing interpretation', async () => {
    fakeMcp.push('interpret', {
      structured: { task_id: 'mcp-1', case_id: 'case-1', status: 'processing' },
    })
    const result = await callWrapper(ctx, agent, 'heart_interpret_diagnosis', { task_id: 'mcp-1' })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ task_id: 'mcp-1', case_id: 'case-1', status: 'processing' })
    expect(textOf(result)).toContain('处理中')
  })
})

describe('heart_generate_report', () => {
  it('maps artifact metadata and scrubs paths inside report content', async () => {
    const BS = String.fromCharCode(92)
    const leakedPath = 'D:' + BS + 'data' + BS + 'report.md'
    fakeMcp.push('report', {
      structured: {
        task_id: 'mcp-f00d',
        case_id: 'case-42',
        status: 'completed',
        format: 'markdown',
        content: '报告正文，内部路径 ' + leakedPath + ' 不应出现。',
        artifact: { artifactId: 'report-mcp-f00d.md', sha256: C64, sizeBytes: 128, createdAt: '2026-08-28T12:00:00Z' },
      },
    })
    const result = await callWrapper(ctx, agent, 'heart_generate_report', {
      task_id: 'mcp-f00d',
      format: 'markdown',
      save_to_case: true,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      task_id: 'mcp-f00d',
      format: 'markdown',
      artifact: {
        artifact_id: 'report-mcp-f00d.md',
        sha256: C64,
        size_bytes: 128,
        created_at: '2026-08-28T12:00:00Z',
      },
    })
    const content = (result.value as { content: string }).content
    expect(content).toContain('<已脱敏>')
    expect(content).not.toContain(leakedPath)
    expect(textOf(result)).toContain('已存回病例工件')
  })

  it('rejects unsupported format before calling the raw tool', async () => {
    const result = await callWrapper(ctx, agent, 'heart_generate_report', {
      task_id: 'mcp-f00d',
      format: 'pdf',
    })
    expect(result.isError).toBe(true)
    expect(fakeMcp.calls()).toHaveLength(0)
  })
})

describe('heart_compare_diagnoses', () => {
  it('projects metric deltas and classification change', async () => {
    fakeMcp.push('compare', {
      structured: {
        case_id: 'case-42',
        task_id_a: 'mcp-aaa1',
        task_id_b: 'mcp-bbb2',
        comparison: {
          metrics: [
            {
              metric: 'lvef', name_cn: '左室射血分数(EF)', unit: '%',
              value_a: 35.48, value_b: 45, delta: 9.52, pct_change: 26.83,
              direction: 'increased', notable: true,
            },
          ],
          lvef_classification: { from: 'HFrEF', to: 'HFmrEF' },
          notes: ['对比仅供参考。'],
        },
      },
    })
    const result = await callWrapper(ctx, agent, 'heart_compare_diagnoses', {
      case_id: 'case-42',
      task_id_a: 'mcp-aaa1',
      task_id_b: 'mcp-bbb2',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      case_id: 'case-42',
      comparison: {
        metrics: [{ metric: 'lvef', delta: 9.52, direction: 'increased', notable: true }],
        lvef_classification: { from: 'HFrEF', to: 'HFmrEF' },
      },
    })
    expect(textOf(result)).toContain('HFrEF → HFmrEF')
    expect(textOf(result)).toContain('变化显著')
  })

  it('renders the not-both-completed arm without comparison', async () => {
    fakeMcp.push('compare', {
      structured: {
        case_id: 'case-42',
        task_id_a: 'mcp-aaa1',
        task_id_b: 'mcp-bbb2',
        status_a: 'completed',
        status_b: 'processing',
        comparison: null,
      },
    })
    const result = await callWrapper(ctx, agent, 'heart_compare_diagnoses', {
      case_id: 'case-42',
      task_id_a: 'mcp-aaa1',
      task_id_b: 'mcp-bbb2',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ comparison: null })
    expect(textOf(result)).toContain('纵向对比要求两个任务均已完成')
  })
})

describe('case and task retrieval wrappers', () => {
  it('heart_list_cases maps camelCase server fields to snake_case', async () => {
    fakeMcp.push('cases', {
      structured: {
        cases: [{
          caseId: 'case-42', sysUserId: 'doctor-1', createdAt: '2026-08-28T10:00:00Z',
          assetCount: 2, diagnosisCount: 1, reviewDecision: null,
        }],
        count: 1,
      },
    })
    const result = await callWrapper(ctx, agent, 'heart_list_cases', {})
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      cases: [{
        case_id: 'case-42', sys_user_id: 'doctor-1', created_at: '2026-08-28T10:00:00Z',
        asset_count: 2, diagnosis_count: 1, review_decision: null,
      }],
      count: 1,
    })
    expect(textOf(result)).toContain('case-42')
  })

  it('heart_get_case_detail exposes no path keys anywhere', async () => {
    fakeMcp.push('detail', {
      structured: {
        caseId: 'case-42',
        createdAt: '2026-08-28T10:00:00Z',
        assets: [
          { assetId: 'asset-echo', modality: 'CARDIAC_ULTRASOUND', dcmType: 'PLAX', sha256: A64, sizeBytes: 132, createdAt: '2026-08-28T10:01:00Z' },
        ],
        diagnoses: [
          { taskId: 'mcp-f00d', requestId: 'req-1', assetIds: ['asset-echo'], submissionState: 2, createdAt: '2026-08-28T10:02:00Z', status: 'completed' },
        ],
        artifacts: [],
        review: null,
        reviewHistory: [],
      },
    })
    const result = await callWrapper(ctx, agent, 'heart_get_case_detail', { case_id: 'case-42' })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.value)).not.toContain('path')
    expect(result.value).toMatchObject({
      case_id: 'case-42',
      diagnoses: [{ task_id: 'mcp-f00d', status: 'completed' }],
    })
    expect(textOf(result)).toContain('最近复核')
  })

  it('heart_list_tasks forwards optional case_id filter', async () => {
    fakeMcp.push('tasks', {
      structured: {
        tasks: [{ case_id: 'case-42', task_id: 'mcp-f00d', created: '2026-08-28T10:02:00Z', submission_state: 2, status: 'completed' }],
        count: 1,
      },
    })
    const result = await callWrapper(ctx, agent, 'heart_list_tasks', { case_id: 'case-42' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ count: 1, tasks: [{ task_id: 'mcp-f00d', status: 'completed' }] })
    const last = fakeMcp.calls()[fakeMcp.calls().length - 1]
    expect(last?.args).toEqual({ case_id: 'case-42' })
  })
})

describe('review wrappers', () => {
  it('heart_get_review_status projects pending state', async () => {
    fakeMcp.push('reviewStatus', {
      structured: {
        task_id: 'mcp-f00d',
        case_id: 'case-42',
        review_status: 'pending',
        requires_clinician_review: true,
        review: null,
        review_count: 0,
      },
    })
    const result = await callWrapper(ctx, agent, 'heart_get_review_status', { task_id: 'mcp-f00d' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ review_status: 'pending', review_count: 0 })
    expect(textOf(result)).toContain('尚未经临床复核确认')
  })

  it('heart_submit_review validates decision client-side and maps the outcome', async () => {
    const bad = await callWrapper(ctx, agent, 'heart_submit_review', {
      task_id: 'mcp-f00d',
      decision: 'maybe',
      reviewer_id: 'cardiologist-7',
    })
    expect(bad.isError).toBe(true)
    expect(fakeMcp.calls()).toHaveLength(0)

    fakeMcp.push('reviewSubmit', {
      structured: {
        case_id: 'case-42',
        taskId: 'mcp-f00d',
        reviewerId: 'cardiologist-7',
        decision: 'approved',
        comment: '已核对',
        reviewedAt: '2026-08-28T12:00:00Z',
      },
    })
    const result = await callWrapper(ctx, agent, 'heart_submit_review', {
      task_id: 'mcp-f00d',
      decision: 'approved',
      reviewer_id: 'cardiologist-7',
      comment: '已核对',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      case_id: 'case-42',
      task_id: 'mcp-f00d',
      reviewer_id: 'cardiologist-7',
      decision: 'approved',
      comment: '已核对',
      reviewed_at: '2026-08-28T12:00:00Z',
    })
  })

  it('surfaces raw review errors (e.g. self-review) as tool errors', async () => {
    fakeMcp.push('reviewSubmit', {
      errorText: '病例所有者不能自我复核',
    })
    const result = await callWrapper(ctx, agent, 'heart_submit_review', {
      task_id: 'mcp-f00d',
      decision: 'approved',
      reviewer_id: 'doctor-1',
    })
    expect(result.isError).toBe(true)
  })
})
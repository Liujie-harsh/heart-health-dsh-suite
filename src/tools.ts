/**
 * 三个 heart_* 包装工具：对模型暴露的稳定领域接口。
 *
 * - heart_submit_diagnosis(case_id, asset_ids?)  -> 提交契约 canonical JSON
 * - heart_get_diagnosis_result(task_id)          -> processing/completed/failed 判别式三态
 * - heart_list_supported_views()                 -> 支持切面与指标目录
 *
 * 每个工具：
 * 1) 输入只接受已登记标识符（拒绝 URL/路径/多余字段）；
 * 2) 通过受控嵌套调用读取底层 MCP structuredContent（不解析渲染文本）；
 * 3) 投影为稳定 canonical JSON；Native 文本与 presentationMeta 与之分离。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  JsonSchemaNode,
  ToolDefinition,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { resolveSuiteConfig } from './config.js'
import type { HeartSuiteConfig } from './config.js'
import {
  assertValidIdentifier,
  parseDiagnosisOutcome,
  parseSubmitOutcome,
  parseViewsOutcome,
} from './contract.js'
import type { DiagnosisOutcome, SubmitOutcome, ViewsOutcome } from './contract.js'
import { GUIDANCE_SECTION_NAME, GUIDANCE_SECTION_ORDER, guidanceText } from './guidance.js'
import { callUnderlyingStructured } from './mcp.js'
// 数据最小化在构造 canonical value 时就地完成（不依赖监听器兜底顺序）。
import { scrubValue } from './privacy.js'
import {
  diagnosisPresentationMeta,
  renderDiagnosis,
  renderSubmit,
  renderViews,
  submitPresentationMeta,
  viewsPresentationMeta,
} from './render.js'

export const WRAPPER_TOOL_NAMES = {
  submit: 'heart_submit_diagnosis',
  result: 'heart_get_diagnosis_result',
  views: 'heart_list_supported_views',
} as const

// ── 原始 JSON Schema（发布契约的一部分；修改需同步测试快照） ────────────────

const STRING_NODE: JsonSchemaNode = { type: 'string' }
const NULL_STRING: JsonSchemaNode = { oneOf: [STRING_NODE, { type: 'null' }] }
const OPEN_OBJECT: JsonSchemaNode = { type: 'object', additionalProperties: true }

const ECHO_ITEM_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['dcm_id', 'measurements', 'rois', 'error', 'skip_reason'],
  properties: {
    dcm_id: STRING_NODE,
    measurements: OPEN_OBJECT,
    // 无约束节点：省略 type 表示任意 JSON 值（ROI 几何结构由服务定义）。
    rois: {},
    error: NULL_STRING,
    skip_reason: NULL_STRING,
  },
}

const ECG_ITEM_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['ecg_id', 'patient_info', 'measurements', 'predictions', 'error'],
  properties: {
    ecg_id: STRING_NODE,
    patient_info: { oneOf: [OPEN_OBJECT, { type: 'null' }] },
    measurements: OPEN_OBJECT,
    predictions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'probability'],
        properties: { label: STRING_NODE, probability: { type: 'number' } },
      },
    },
    error: NULL_STRING,
  },
}

export const SUBMIT_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['case_id', 'task_id', 'status'],
  properties: {
    case_id: STRING_NODE,
    task_id: STRING_NODE,
    status: { type: 'string', enum: ['processing', 'completed', 'failed'] },
    created: STRING_NODE,
  },
}

function completedArm(): JsonSchemaNode {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'case_id', 'task_id', 'status', 'hf_type', 'cardiac_ultrasound', 'ecg',
      'inputs', 'algorithm_version', 'requires_clinician_review', 'review_status', 'review',
    ],
    properties: {
      case_id: STRING_NODE,
      task_id: STRING_NODE,
      status: { type: 'string', const: 'completed' },
      hf_type: NULL_STRING,
      cardiac_ultrasound: { type: 'array', items: ECHO_ITEM_SCHEMA },
      ecg: { type: 'array', items: ECG_ITEM_SCHEMA },
      inputs: OPEN_OBJECT,
      algorithm_version: STRING_NODE,
      requires_clinician_review: { type: 'boolean' },
      review_status: STRING_NODE,
      review: {},
    },
  }
}

/** 查询结果的判别式输出 schema。 */
export const DIAGNOSIS_OUTPUT_SCHEMA: JsonSchemaNode = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['case_id', 'task_id', 'status'],
      properties: {
        case_id: STRING_NODE,
        task_id: STRING_NODE,
        status: { type: 'string', const: 'processing' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['case_id', 'task_id', 'status', 'error'],
      properties: {
        case_id: STRING_NODE,
        task_id: STRING_NODE,
        status: { type: 'string', const: 'failed' },
        error: STRING_NODE,
      },
    },
    completedArm(),
  ],
}

/** 支持切面查询的输出 schema。 */
export const VIEWS_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['views', 'metrics'],
  properties: {
    views: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['dcm_type', 'metrics'],
        properties: {
          dcm_type: STRING_NODE,
          metrics: { type: 'array', items: STRING_NODE },
        },
      },
    },
    metrics: OPEN_OBJECT,
  },
}

// ── 输入参数 schema 与手工校验 ──────────────────────────────────────────────

const SUBMIT_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['case_id'],
  properties: {
    case_id: { type: 'string', description: '已登记病例的 case_id；不接受 URL 或文件路径' },
    asset_ids: {
      type: 'array',
      description: '可选：只分析指定资产（心超 DICOM / ECG XML 的 assetId 列表）',
      items: { type: 'string' },
    },
  },
}

const RESULT_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['task_id'],
  properties: {
    task_id: { type: 'string', description: '提交时返回的任务 ID；一次调用只查询一次' },
  },
}

const VIEWS_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

function expectArgumentsObject(exec: ToolRunContext): Record<string, unknown> {
  if (exec.arguments === null || typeof exec.arguments !== 'object' || Array.isArray(exec.arguments)) {
    throw new Error('参数必须是 JSON 对象')
  }
  return exec.arguments as Record<string, unknown>
}

function rejectExtraKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `不接受参数 "${key}"。heart 工具只接受 ${allowed.map(k => `"${k}"`).join(', ')}；`
          + '病例资料必须先经病例门户或病例 HTTP API 上传。',
      )
    }
  }
}

function requireIdentifierArg(
  args: Record<string, unknown>,
  key: 'case_id' | 'task_id',
): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`缺少必填字符串参数 ${key}`)
  }
  if (key === 'case_id') assertValidIdentifier(value, 'case_id')
  return value
}

function requireAssetIdsArg(args: Record<string, unknown>): string[] | undefined {
  const value = args['asset_ids']
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('参数 asset_ids 必须是字符串数组')
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`asset_ids[${index}] 必须是非空字符串`)
    }
    assertValidIdentifier(item, 'asset_id')
    return item
  })
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

function metaValue(meta: Record<string, unknown>): never {
  // presentationMeta 的返回类型是 lossless-JSON 值；对象形态完全兼容。
  return meta as never
}

// ── 定义工厂 ────────────────────────────────────────────────────────────────

/**
 * 构造三个包装工具定义。
 * @param hostCtx 注册这些工具的 Cordis 上下文（嵌套调用也从它发起）。
 */
export function createHeartToolDefinitions(
  hostCtx: Context,
  config: HeartSuiteConfig,
): ToolDefinition[] {
  const underlying = {
    submit: `mcp__${config.serverName}__${config.rawSubmitTool}`,
    result: `mcp__${config.serverName}__${config.rawResultTool}`,
    views: `mcp__${config.serverName}__${config.rawViewsTool}`,
  }

  const submit: ToolDefinition = {
    name: WRAPPER_TOOL_NAMES.submit,
    description:
      '提交一个已登记心脏病例的分析任务。只接受病例门户/HTTP API 返回的 case_id 与可选 asset_ids；'
      + '立即返回 task_id 与初始状态，不等待推理完成。',
    parameters: SUBMIT_PARAMETERS as Record<string, unknown>,
    output: {
      schema: SUBMIT_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) =>
        textBlock(renderSubmit(value as SubmitOutcome)),
      presentationMeta: (_args: unknown, value: unknown) =>
        metaValue(submitPresentationMeta(value as SubmitOutcome)),
    },
    async execute(_args: unknown, exec: ToolRunContext) {
      const args = expectArgumentsObject(exec)
      rejectExtraKeys(args, ['case_id', 'asset_ids'])
      const caseId = requireIdentifierArg(args, 'case_id')
      const assetIds = requireAssetIdsArg(args)
      const structured = await callUnderlyingStructured(hostCtx, exec, underlying.submit, {
        ...(assetIds !== undefined ? { asset_ids: assetIds } : {}),
        case_id: caseId,
      })
      return scrubValue(parseSubmitOutcome(structured))
    },
  }

  const result: ToolDefinition = {
    name: WRAPPER_TOOL_NAMES.result,
    description:
      '按 task_id 查询一次心脏分析任务结果，返回 processing、completed 或 failed 三种状态之一；'
      + '单次调用不做等待循环。',
    parameters: RESULT_PARAMETERS as Record<string, unknown>,
    output: {
      schema: DIAGNOSIS_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) =>
        textBlock(renderDiagnosis(value as DiagnosisOutcome, config)),
      presentationMeta: (_args: unknown, value: unknown) =>
        metaValue(diagnosisPresentationMeta(value as DiagnosisOutcome, config)),
    },
    async execute(_args: unknown, exec: ToolRunContext) {
      const args = expectArgumentsObject(exec)
      rejectExtraKeys(args, ['task_id'])
      const taskId = requireIdentifierArg(args, 'task_id')
      const structured = await callUnderlyingStructured(hostCtx, exec, underlying.result, {
        task_id: taskId,
      })
      return scrubValue(parseDiagnosisOutcome(structured, { keepPatientInfo: config.keepPatientInfo }))
    },
  }

  const views: ToolDefinition = {
    name: WRAPPER_TOOL_NAMES.views,
    description: '查询算法服务支持的心超切面类型和测量指标目录，用于上传前核对。',
    parameters: VIEWS_PARAMETERS as Record<string, unknown>,
    output: {
      schema: VIEWS_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) =>
        textBlock(renderViews(value as ViewsOutcome)),
      presentationMeta: (_args: unknown, value: unknown) =>
        metaValue(viewsPresentationMeta(value as ViewsOutcome)),
    },
    async execute(_args: unknown, exec: ToolRunContext) {
      const args = expectArgumentsObject(exec)
      rejectExtraKeys(args, [])
      const structured = await callUnderlyingStructured(hostCtx, exec, underlying.views, {})
      return scrubValue(parseViewsOutcome(structured))
    },
  }

  return [submit, result, views]
}

/**
 * preset 组合行插件：注册包装工具与常驻指导。
 */
export const name = 'heart-health-tools'

export function apply(ctx: Context, rowConfig?: Record<string, unknown>): void {
  const config = resolveSuiteConfig(rowConfig)
  ctx.effect(() => ctx.systemPrompt.section({
    name: GUIDANCE_SECTION_NAME,
    order: GUIDANCE_SECTION_ORDER,
    text: guidanceText(),
  }))
  for (const definition of createHeartToolDefinitions(ctx, config)) {
    ctx.effect(() => ctx.tools.register(definition))
  }
}

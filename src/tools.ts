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
  assertFreeIdentifier,
  assertValidIdentifier,
  parseAnalyzeOutcome,
  parseCaseDetailOutcome,
  parseCompareOutcome,
  parseDiagnosisOutcome,
  parseInterpretOutcome,
  parseListCasesOutcome,
  parseListTasksOutcome,
  parseReportOutcome,
  parseReviewOutcome,
  parseReviewStatusOutcome,
  parseSubmitOutcome,
  parseViewsOutcome,
} from './contract.js'
import type {
  AnalyzeOutcome,
  CaseDetailOutcome,
  CompareOutcome,
  DiagnosisOutcome,
  InterpretOutcome,
  ListCasesOutcome,
  ListTasksOutcome,
  ReportOutcome,
  ReviewOutcome,
  ReviewStatusOutcome,
  SubmitOutcome,
  ViewsOutcome,
} from './contract.js'
import { GUIDANCE_SECTION_NAME, GUIDANCE_SECTION_ORDER, guidanceText } from './guidance.js'
import { callUnderlyingStructured } from './mcp.js'
// 数据最小化在构造 canonical value 时就地完成（不依赖监听器兜底顺序）。
import { scrubValue } from './privacy.js'
import {
  analyzePresentationMeta,
  caseDetailPresentationMeta,
  comparePresentationMeta,
  diagnosisPresentationMeta,
  interpretPresentationMeta,
  listCasesPresentationMeta,
  listTasksPresentationMeta,
  renderAnalyze,
  renderCaseDetail,
  renderCompare,
  renderDiagnosis,
  renderInterpret,
  renderListCases,
  renderListTasks,
  renderReport,
  renderReviewStatus,
  renderReviewSubmit,
  renderSubmit,
  renderViews,
  reportPresentationMeta,
  reviewStatusPresentationMeta,
  reviewSubmitPresentationMeta,
  submitPresentationMeta,
  viewsPresentationMeta,
} from './render.js'

export const WRAPPER_TOOL_NAMES = {
  submit: 'heart_submit_diagnosis',
  result: 'heart_get_diagnosis_result',
  views: 'heart_list_supported_views',
  analyze: 'heart_analyze_case_files',
  interpret: 'heart_interpret_diagnosis',
  report: 'heart_generate_report',
  compare: 'heart_compare_diagnoses',
  listCases: 'heart_list_cases',
  caseDetail: 'heart_get_case_detail',
  listTasks: 'heart_list_tasks',
  reviewStatus: 'heart_get_review_status',
  reviewSubmit: 'heart_submit_review',
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
    created: { oneOf: [STRING_NODE, { type: 'boolean' }] },
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

const ANALYZE_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      description: '要登记的文件列表（1..20 项）；path 必须是算法服务所在主机上已存在的 DICOM/XML 文件路径',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'modality'],
        properties: {
          path: { type: 'string', description: '服务端主机上的本地文件路径' },
          modality: { type: 'string', enum: ['CARDIAC_ULTRASOUND', 'ECG'] },
          dcm_type: { type: 'string', description: '心超必填：受支持切面（见 heart_list_supported_views）' },
          asset_id: { type: 'string', description: '可选：自定义资产 ID' },
        },
      },
    },
    request_id: { type: 'string', description: '可选：传稳定值让建病例步骤幂等' },
    submit: { type: 'boolean', description: '默认 true：登记后立即提交分析' },
  },
}

const INTERPRET_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['task_id'],
  properties: {
    task_id: { type: 'string', description: '已 completed 的诊断任务 ID' },
  },
}

const REPORT_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['task_id'],
  properties: {
    task_id: { type: 'string', description: '已 completed 的诊断任务 ID' },
    format: { type: 'string', enum: ['markdown', 'json'], description: '默认 markdown' },
    save_to_case: { type: 'boolean', description: '默认 false：是否把报告存回病例工件' },
  },
}

const COMPARE_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['case_id', 'task_id_a', 'task_id_b'],
  properties: {
    case_id: { type: 'string', description: '同一病例的 case_id' },
    task_id_a: { type: 'string', description: '基线任务 ID（较早）' },
    task_id_b: { type: 'string', description: '随访任务 ID（较晚）' },
  },
}

const LIST_CASES_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

const CASE_DETAIL_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['case_id'],
  properties: {
    case_id: { type: 'string', description: '已登记病例的 case_id' },
  },
}

const LIST_TASKS_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    case_id: { type: 'string', description: '可选：只看该病例的任务' },
  },
}

const REVIEW_STATUS_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['task_id'],
  properties: {
    task_id: { type: 'string', description: '诊断任务 ID' },
  },
}

const REVIEW_SUBMIT_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['task_id', 'decision', 'reviewer_id'],
  properties: {
    task_id: { type: 'string', description: '已 completed 的诊断任务 ID' },
    decision: { type: 'string', enum: ['approved', 'rejected'], description: '必须来自真实临床人员的明确结论' },
    reviewer_id: { type: 'string', description: '作出结论的临床人员标识；不能与病例所有者相同' },
    comment: { type: 'string', description: '可选：复核意见' },
  },
}

const ANALYZE_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['case_id', 'case_created', 'assets'],
  properties: {
    case_id: STRING_NODE,
    case_created: { type: 'boolean' },
    assets: { type: 'array', items: OPEN_OBJECT },
    task_id: STRING_NODE,
    status: { type: 'string', enum: ['processing', 'completed', 'failed'] },
    created: { type: 'boolean' },
  },
}

const INTERPRET_OUTPUT_SCHEMA: JsonSchemaNode = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['task_id', 'case_id', 'status'],
      properties: {
        task_id: STRING_NODE,
        case_id: STRING_NODE,
        status: { type: 'string', const: 'processing' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['task_id', 'case_id', 'status', 'error'],
      properties: {
        task_id: STRING_NODE,
        case_id: STRING_NODE,
        status: { type: 'string', const: 'failed' },
        error: STRING_NODE,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['task_id', 'case_id', 'status', 'requires_clinician_review', 'review_status'],
      properties: {
        task_id: STRING_NODE,
        case_id: STRING_NODE,
        status: { type: 'string', const: 'completed' },
        hf_type: NULL_STRING,
        algorithm_version: STRING_NODE,
        requires_clinician_review: { type: 'boolean' },
        review_status: STRING_NODE,
        lvef_value: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        lvef_classification: NULL_STRING,
        abnormal_findings: { type: 'array', items: OPEN_OBJECT },
        unavailable_assets: { type: 'array', items: OPEN_OBJECT },
        combined_indicators: { type: 'array', items: OPEN_OBJECT },
        ecg_highlights: { type: 'array', items: OPEN_OBJECT },
        notes: { type: 'array', items: STRING_NODE },
      },
    },
  ],
}

const REPORT_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['task_id', 'case_id', 'status', 'content'],
  properties: {
    task_id: STRING_NODE,
    case_id: STRING_NODE,
    status: { type: 'string', enum: ['processing', 'completed', 'failed'] },
    format: { type: 'string', enum: ['markdown', 'json'] },
    content: NULL_STRING,
    artifact: OPEN_OBJECT,
  },
}

const COMPARE_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['case_id', 'task_id_a', 'task_id_b', 'comparison'],
  properties: {
    case_id: STRING_NODE,
    task_id_a: STRING_NODE,
    task_id_b: STRING_NODE,
    status_a: { type: 'string', enum: ['processing', 'completed', 'failed'] },
    status_b: { type: 'string', enum: ['processing', 'completed', 'failed'] },
    comparison: { oneOf: [{ type: 'null' }, OPEN_OBJECT] },
  },
}

const LIST_CASES_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['cases', 'count'],
  properties: {
    cases: { type: 'array', items: OPEN_OBJECT },
    count: { type: 'number' },
  },
}

const CASE_DETAIL_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: true,
  required: ['caseId', 'assets', 'diagnoses'],
  properties: {
    caseId: STRING_NODE,
    createdAt: STRING_NODE,
    assets: { type: 'array', items: OPEN_OBJECT },
    diagnoses: { type: 'array', items: OPEN_OBJECT },
    artifacts: { type: 'array', items: OPEN_OBJECT },
    review: {},
    reviewHistory: { type: 'array', items: OPEN_OBJECT },
  },
}

const LIST_TASKS_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks', 'count'],
  properties: {
    tasks: { type: 'array', items: OPEN_OBJECT },
    count: { type: 'number' },
  },
}

const REVIEW_STATUS_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['task_id', 'case_id', 'review_status', 'requires_clinician_review', 'review_count'],
  properties: {
    task_id: STRING_NODE,
    case_id: STRING_NODE,
    review_status: STRING_NODE,
    requires_clinician_review: { type: 'boolean' },
    review: {},
    review_count: { type: 'number' },
  },
}

const REVIEW_SUBMIT_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['case_id', 'task_id', 'reviewer_id', 'decision', 'reviewed_at'],
  properties: {
    case_id: STRING_NODE,
    task_id: STRING_NODE,
    reviewer_id: STRING_NODE,
    decision: { type: 'string', enum: ['approved', 'rejected'] },
    comment: STRING_NODE,
    reviewed_at: STRING_NODE,
  },
}

/** 一站式分析的 files 参数校验：路径形态在此工具中是合法输入（由服务端读取）。 */
function requireFilesArg(args: Record<string, unknown>): Record<string, unknown>[] {
  const value = args['files']
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('参数 files 必须是非空数组')
  }
  if (value.length > 20) {
    throw new Error('单次最多登记 20 个文件；请分批调用')
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`files[${index}] 必须是对象`)
    }
    const record = item as Record<string, unknown>
    const allowed = ['path', 'modality', 'dcm_type', 'asset_id']
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) {
        throw new Error(`不接受参数 "files[${index}].${key}"。只允许 ${allowed.map(k => '"' + k + '"').join(', ')}`)
      }
    }
    const path = record['path']
    if (typeof path !== 'string' || path.trim() === '') {
      throw new Error(`files[${index}].path 必须是非空字符串（算法服务主机上的本地路径）`)
    }
    if (/[\r\n\u0000]/.test(path)) {
      throw new Error(`files[${index}].path 含有非法控制字符`)
    }
    const modalityRaw = record['modality']
    const modality = typeof modalityRaw === 'string' ? modalityRaw.trim().toUpperCase() : ''
    if (modality !== 'CARDIAC_ULTRASOUND' && modality !== 'ECG') {
      throw new Error(`files[${index}].modality 必须是 CARDIAC_ULTRASOUND 或 ECG`)
    }
    const entry: Record<string, unknown> = { path, modality }
    const dcmType = record['dcm_type']
    if (modality === 'CARDIAC_ULTRASOUND') {
      if (typeof dcmType !== 'string' || dcmType.trim() === '') {
        throw new Error(`files[${index}].dcm_type 心超资产必填（见 heart_list_supported_views）`)
      }
      entry['dcm_type'] = dcmType.trim()
    } else if (dcmType !== undefined) {
      throw new Error(`files[${index}].dcm_type 仅心超资产可设置`)
    }
    const assetId = record['asset_id']
    if (assetId !== undefined) {
      if (typeof assetId !== 'string' || assetId.trim() === '') {
        throw new Error(`files[${index}].asset_id 必须是非空字符串`)
      }
      assertValidIdentifier(assetId, 'asset_id')
      entry['asset_id'] = assetId
    }
    return entry
  })
}

function requireOptionalBoolean(
  args: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = args[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`参数 ${key} 必须是布尔值`)
  return value
}

function requireOptionalFreeIdentifier(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`参数 ${key} 必须是非空字符串`)
  }
  assertFreeIdentifier(value, key)
  return value
}

function requireFreeIdentifierArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`缺少必填字符串参数 ${key}`)
  }
  assertFreeIdentifier(value, key)
  return value
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
    analyze: `mcp__${config.serverName}__${config.rawAnalyzeTool}`,
    interpret: `mcp__${config.serverName}__${config.rawInterpretTool}`,
    report: `mcp__${config.serverName}__${config.rawReportTool}`,
    compare: `mcp__${config.serverName}__${config.rawCompareTool}`,
    listCases: `mcp__${config.serverName}__${config.rawListCasesTool}`,
    caseDetail: `mcp__${config.serverName}__${config.rawCaseDetailTool}`,
    listTasks: `mcp__${config.serverName}__${config.rawListTasksTool}`,
    reviewStatus: `mcp__${config.serverName}__${config.rawReviewStatusTool}`,
    reviewSubmit: `mcp__${config.serverName}__${config.rawSubmitReviewTool}`,
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


  const analyze: ToolDefinition = {
    name: WRAPPER_TOOL_NAMES.analyze,
    description:
      '一站式分析：把算法服务所在主机上已存在的本地 DICOM/XML 文件登记为病例资产并提交诊断。'
      + 'path 必须是服务端主机可读的文件路径（不是用户设备路径）；返回 case_id 与 task_id。',
    parameters: ANALYZE_PARAMETERS as Record<string, unknown>,
    output: {
      schema: ANALYZE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) =>
        textBlock(renderAnalyze(value as AnalyzeOutcome)),
      presentationMeta: (_args: unknown, value: unknown) =>
        metaValue(analyzePresentationMeta(value as AnalyzeOutcome)),
    },
    async execute(_args: unknown, exec: ToolRunContext) {
      const args = expectArgumentsObject(exec)
      rejectExtraKeys(args, ['files', 'request_id', 'submit'])
      const files = requireFilesArg(args)
      const requestId = requireOptionalFreeIdentifier(args, 'request_id')
      const submitFlag = requireOptionalBoolean(args, 'submit', true)
      const structured = await callUnderlyingStructured(hostCtx, exec, underlying.analyze, {
        files,
        submit: submitFlag,
        ...(requestId !== undefined ? { request_id: requestId } : {}),
      })
      return scrubValue(parseAnalyzeOutcome(structured))
    },
  }

  const interpret: ToolDefinition = {
    name: WRAPPER_TOOL_NAMES.interpret,
    description:
      '对已 completed 的诊断任务做规则解读：按参考范围标注异常指标、给出 LVEF 分型'
      + '（HFrEF/HFmrEF/HFpEF）与 E/A、E/e′ 组合指标。规则比对输出，不构成诊断。',
    parameters: INTERPRET_PARAMETERS as Record<string, unknown>,
    output: {
      schema: INTERPRET_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) =>
        textBlock(renderInterpret(value as InterpretOutcome)),
      presentationMeta: (_args: unknown, value: unknown) =>
        metaValue(interpretPresentationMeta(value as InterpretOutcome)),
    },
    async execute(_args: unknown, exec: ToolRunContext) {
      const args = expectArgumentsObject(exec)
      rejectExtraKeys(args, ['task_id'])
      const taskId = requireIdentifierArg(args, 'task_id')
      const structured = await callUnderlyingStructured(hostCtx, exec, underlying.interpret, {
        task_id: taskId,
      })
      return scrubValue(parseInterpretOutcome(structured))
    },
  }

  const report: ToolDefinition = {
    name: WRAPPER_TOOL_NAMES.report,
    description:
      '把已 completed 的诊断任务渲染成报告草稿（markdown/json），可存回病例工件。'
      + '报告是算法输出草稿，必须经临床人员复核。',
    parameters: REPORT_PARAMETERS as Record<string, unknown>,
    output: {
      schema: REPORT_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) =>
        textBlock(renderReport(value as ReportOutcome)),
      presentationMeta: (_args: unknown, value: unknown) =>
        metaValue(reportPresentationMeta(value as ReportOutcome)),
    },
    async execute(_args: unknown, exec: ToolRunContext) {
      const args = expectArgumentsObject(exec)
      rejectExtraKeys(args, ['task_id', 'format', 'save_to_case'])
      const taskId = requireIdentifierArg(args, 'task_id')
      const formatRaw = args['format']
      if (formatRaw !== undefined && formatRaw !== 'markdown' && formatRaw !== 'json') {
        throw new Error('参数 format 只允许 markdown 或 json')
      }
      const saveToCase = requireOptionalBoolean(args, 'save_to_case', false)
      const structured = await callUnderlyingStructured(hostCtx, exec, underlying.report, {
        task_id: taskId,
        format: typeof formatRaw === 'string' ? formatRaw : 'markdown',
        save_to_case: saveToCase,
      })
      return scrubValue(parseReportOutcome(structured))
    },
  }

  const compare: ToolDefinition = {
    name: WRAPPER_TOOL_NAMES.compare,
    description:
      '对比同一病例两次已完成任务的同名指标变化（绝对差、百分比、方向）与 LVEF 分型迁移。'
      + '差异不构成病情结论。',
    parameters: COMPARE_PARAMETERS as Record<string, unknown>,
    output: {
      schema: COMPARE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) =>
        textBlock(renderCompare(value as CompareOutcome)),
      presentationMeta: (_args: unknown, value: unknown) =>
        metaValue(comparePresentationMeta(value as CompareOutcome)),
    },
    async execute(_args: unknown, exec: ToolRunContext) {
      const args = expectArgumentsObject(exec)
      rejectExtraKeys(args, ['case_id', 'task_id_a', 'task_id_b'])
      const caseId = requireIdentifierArg(args, 'case_id')
      const taskIdA = requireFreeIdentifierArg(args, 'task_id_a')
      const taskIdB = requireFreeIdentifierArg(args, 'task_id_b')
      const structured = await callUnderlyingStructured(hostCtx, exec, underlying.compare, {
        case_id: caseId,
        task_id_a: taskIdA,
        task_id_b: taskIdB,
      })
      return scrubValue(parseCompareOutcome(structured))
    },
  }

  const listCases: ToolDefinition = {
    name: WRAPPER_TOOL_NAMES.listCases,
    description: '列出服务账号可见的病例摘要（资产与任务计数、最近复核决定）。',
    parameters: LIST_CASES_PARAMETERS as Record<string, unknown>,
    output: {
      schema: LIST_CASES_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) =>
        textBlock(renderListCases(value as ListCasesOutcome)),
      presentationMeta: (_args: unknown, value: unknown) =>
        metaValue(listCasesPresentationMeta(value as ListCasesOutcome)),
    },
    async execute(_args: unknown, exec: ToolRunContext) {
      const args = expectArgumentsObject(exec)
      rejectExtraKeys(args, [])
      const structured = await callUnderlyingStructured(hostCtx, exec, underlying.listCases, {})
      return scrubValue(parseListCasesOutcome(structured))
    },
  }

  const caseDetail: ToolDefinition = {
    name: WRAPPER_TOOL_NAMES.caseDetail,
    description: '查看病例的资产清单、分析任务实时状态、复核历史与报告工件（不含任何磁盘路径）。',
    parameters: CASE_DETAIL_PARAMETERS as Record<string, unknown>,
    output: {
      schema: CASE_DETAIL_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) =>
        textBlock(renderCaseDetail(value as CaseDetailOutcome)),
      presentationMeta: (_args: unknown, value: unknown) =>
        metaValue(caseDetailPresentationMeta(value as CaseDetailOutcome)),
    },
    async execute(_args: unknown, exec: ToolRunContext) {
      const args = expectArgumentsObject(exec)
      rejectExtraKeys(args, ['case_id'])
      const caseId = requireIdentifierArg(args, 'case_id')
      const structured = await callUnderlyingStructured(hostCtx, exec, underlying.caseDetail, {
        case_id: caseId,
      })
      return scrubValue(parseCaseDetailOutcome(structured))
    },
  }

  const listTasks: ToolDefinition = {
    name: WRAPPER_TOOL_NAMES.listTasks,
    description: '列出分析任务及其实时状态，可用 case_id 过滤。',
    parameters: LIST_TASKS_PARAMETERS as Record<string, unknown>,
    output: {
      schema: LIST_TASKS_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) =>
        textBlock(renderListTasks(value as ListTasksOutcome)),
      presentationMeta: (_args: unknown, value: unknown) =>
        metaValue(listTasksPresentationMeta(value as ListTasksOutcome)),
    },
    async execute(_args: unknown, exec: ToolRunContext) {
      const args = expectArgumentsObject(exec)
      rejectExtraKeys(args, ['case_id'])
      const caseId = requireOptionalFreeIdentifier(args, 'case_id')
      const structured = await callUnderlyingStructured(hostCtx, exec, underlying.listTasks, {
        ...(caseId !== undefined ? { case_id: caseId } : {}),
      })
      return scrubValue(parseListTasksOutcome(structured))
    },
  }

  const reviewStatus: ToolDefinition = {
    name: WRAPPER_TOOL_NAMES.reviewStatus,
    description: '查询诊断任务的临床复核状态与全部复核记录。',
    parameters: REVIEW_STATUS_PARAMETERS as Record<string, unknown>,
    output: {
      schema: REVIEW_STATUS_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) =>
        textBlock(renderReviewStatus(value as ReviewStatusOutcome)),
      presentationMeta: (_args: unknown, value: unknown) =>
        metaValue(reviewStatusPresentationMeta(value as ReviewStatusOutcome)),
    },
    async execute(_args: unknown, exec: ToolRunContext) {
      const args = expectArgumentsObject(exec)
      rejectExtraKeys(args, ['task_id'])
      const taskId = requireFreeIdentifierArg(args, 'task_id')
      const structured = await callUnderlyingStructured(hostCtx, exec, underlying.reviewStatus, {
        task_id: taskId,
      })
      return scrubValue(parseReviewStatusOutcome(structured))
    },
  }

  const reviewSubmit: ToolDefinition = {
    name: WRAPPER_TOOL_NAMES.reviewSubmit,
    description:
      '为已完成任务登记临床复核结论（approved/rejected）。结论必须由真实临床人员作出并明确'
      + '传达给你；复核人不能与病例所有者相同。你不得代替临床人员决定结论。',
    parameters: REVIEW_SUBMIT_PARAMETERS as Record<string, unknown>,
    output: {
      schema: REVIEW_SUBMIT_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) =>
        textBlock(renderReviewSubmit(value as ReviewOutcome)),
      presentationMeta: (_args: unknown, value: unknown) =>
        metaValue(reviewSubmitPresentationMeta(value as ReviewOutcome)),
    },
    async execute(_args: unknown, exec: ToolRunContext) {
      const args = expectArgumentsObject(exec)
      rejectExtraKeys(args, ['task_id', 'decision', 'reviewer_id', 'comment'])
      const taskId = requireFreeIdentifierArg(args, 'task_id')
      const decisionRaw = args['decision']
      if (decisionRaw !== 'approved' && decisionRaw !== 'rejected') {
        throw new Error('参数 decision 只允许 approved 或 rejected')
      }
      const reviewerId = requireFreeIdentifierArg(args, 'reviewer_id')
      const commentRaw = args['comment']
      if (commentRaw !== undefined && typeof commentRaw !== 'string') {
        throw new Error('参数 comment 必须是字符串')
      }
      const structured = await callUnderlyingStructured(hostCtx, exec, underlying.reviewSubmit, {
        task_id: taskId,
        decision: decisionRaw,
        reviewer_id: reviewerId,
        ...(typeof commentRaw === 'string' ? { comment: commentRaw } : {}),
      })
      return scrubValue(parseReviewOutcome(structured))
    },
  }

  return [
    submit, result, views,
    analyze, interpret, report, compare,
    listCases, caseDetail, listTasks,
    reviewStatus, reviewSubmit,
  ]
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

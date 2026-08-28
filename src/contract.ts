/**
 * 底层 MCP structuredContent -> 包装层 canonical JSON 的投影与校验。
 *
 * 判别式三态：processing / failed / completed（PRD 用户故事 20、实现决策）。
 * 结构性缺失（缺 structuredContent、未知状态、类型不符）一律抛 HeartContractError，
 * 由包装工具转成明确的失败结果；多余或未批准字段一律不透传。
 */

import { isRecord } from './errors.js'
import { projectPatientInfo, redactString, scrubValue } from './privacy.js'

export const DIAGNOSIS_STATUSES = ['processing', 'completed', 'failed'] as const
export type DiagnosisStatus = (typeof DIAGNOSIS_STATUSES)[number]

export interface SubmitOutcome {
  readonly case_id: string
  readonly task_id: string
  readonly status: DiagnosisStatus
  readonly created?: string
}

/** 测量值：单值（如 hf_type）或带目录元数据的结构。 */
export type MeasurementValue =
  | number
  | string
  | boolean
  | { value: number | string | boolean; name_cn?: string; unit?: string; reference?: string }

export interface EchoItem {
  readonly dcm_id: string
  readonly measurements: Record<string, MeasurementValue>
  /** ROI 几何数据：净化后按原样保留。 */
  readonly rois: unknown
  readonly error: string | null
  readonly skip_reason: string | null
}

export interface EcgPrediction {
  readonly label: string
  readonly probability: number
}

export interface EcgItem {
  readonly ecg_id: string
  readonly patient_info: Record<string, unknown> | null
  readonly measurements: Record<string, MeasurementValue>
  readonly predictions: readonly EcgPrediction[]
  readonly error: string | null
}

export interface InputsEntry {
  readonly sha256: string
  readonly sizeBytes: number
}

export interface CompletedDiagnosis {
  readonly case_id: string
  readonly task_id: string
  readonly status: 'completed'
  readonly hf_type: string | null
  readonly cardiac_ultrasound: readonly EchoItem[]
  readonly ecg: readonly EcgItem[]
  readonly inputs: Record<string, InputsEntry>
  readonly algorithm_version: string
  readonly requires_clinician_review: boolean
  readonly review_status: string
  readonly review: unknown
}

export type DiagnosisOutcome =
  | { readonly case_id: string; readonly task_id: string; readonly status: 'processing' }
  | { readonly case_id: string; readonly task_id: string; readonly status: 'failed'; readonly error: string }
  | CompletedDiagnosis

export interface ViewsOutcome {
  readonly views: readonly { dcm_type: string; metrics: readonly string[] }[]
  readonly metrics: Record<string, unknown>
}

// ── 小型期望值工具 ──────────────────────────────────────────────────────────

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`底层结果字段 ${field} 缺失或不是非空字符串`)
  }
  return value
}

function expectOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`底层结果字段 ${field} 应为字符串`)
  return value
}

function expectOptionalNullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`底层结果字段 ${field} 应为字符串或 null`)
  return value
}

function expectArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`底层结果字段 ${field} 缺失或不是数组`)
  return value
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`底层结果字段 ${field} 缺失或不是对象`)
  return value
}

// ── 输入检查 ───────────────────────────────────────────────────────────────

const INPUT_REJECT_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, reason: '看起来是一个 URL' },
  { pattern: /^file:/i, reason: '看起来是一个文件地址' },
  { pattern: /^[A-Za-z]:[\\/]/, reason: '看起来是一个 Windows 路径' },
  { pattern: /^\\\\/, reason: '看起来是一个网络共享路径' },
  { pattern: /^\.{0,2}\//, reason: '看起来是一个文件系统路径' },
  { pattern: /%3a/i, reason: '看起来像编码后的路径/URL' },
]

/**
 * 校验调用方传入的 case_id / asset_id。
 * 病例必须先经病例门户或 HTTP API 登记资产；URL、本地路径、二进制内容都不是合法输入。
 */
export function assertValidIdentifier(value: string, kind: 'case_id' | 'asset_id'): void {
  for (const rule of INPUT_REJECT_PATTERNS) {
    if (rule.pattern.test(value)) {
      throw new Error(
        `参数 ${kind} "${redactString(value)}" ${rule.reason}。`
          + ' 请先通过病例门户或病例 HTTP API（POST /heart-algo/cases 与 '
          + 'POST /heart-algo/cases/{case_id}/assets）登记病例与资产，再提交返回的标识符。',
      )
    }
  }
  if (/[\r\n\u0000]/.test(value)) {
    throw new Error(`参数 ${kind} 含有非法控制字符`)
  }
}

// ── 投影 ───────────────────────────────────────────────────────────────────

function projectionMeasurement(value: unknown): MeasurementValue {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (isRecord(value)) {
    const inner = value['value']
    if (inner === undefined) throw new Error('测量条目缺少 value')
    const projected: { value: number | string | boolean; name_cn?: string; unit?: string; reference?: string } = {
      value: inner as number | string | boolean,
    }
    for (const key of ['name_cn', 'unit', 'reference'] as const) {
      const meta = value[key]
      if (meta !== undefined && typeof meta === 'string') projected[key] = meta
    }
    return projected
  }
  throw new Error('测量条目的类型不受支持')
}

function parseMeasurements(raw: unknown): Record<string, MeasurementValue> {
  const source = expectRecord(raw, 'measurements')
  const out: Record<string, MeasurementValue> = {}
  for (const [key, item] of Object.entries(source)) {
    out[key] = projectionMeasurement(item)
  }
  return out
}

function parseEchoItems(raw: unknown): EchoItem[] {
  return expectArray(raw, 'cardiac_ultrasound').map((item, index) => {
    const source = expectRecord(item, `cardiac_ultrasound[${index}]`)
    const echo: EchoItem = {
      dcm_id: expectString(source['dcm_id'], `cardiac_ultrasound[${index}].dcm_id`),
      measurements: parseMeasurements(source['measurements'] ?? {}),
      rois: scrubValue(source['rois'] ?? null),
      error: expectOptionalNullableString(source['error'], `cardiac_ultrasound[${index}].error`),
      skip_reason: expectOptionalNullableString(source['skip_reason'], `cardiac_ultrasound[${index}].skip_reason`),
    }
    return echo
  })
}

function parsePredictions(raw: unknown): EcgPrediction[] {
  const source = raw ?? []
  return expectArray(source, 'predictions').map((item, index) => {
    const record = expectRecord(item, `predictions[${index}]`)
    const probability = record['probability']
    if (typeof probability !== 'number' || !Number.isFinite(probability)) {
      throw new Error(`predictions[${index}].probability 应为有限数值`)
    }
    const label = record['label']
    if (label !== undefined && typeof label !== 'string') {
      throw new Error(`predictions[${index}].label 应为字符串`)
    }
    return {
      label: typeof label === 'string' ? label : `label-${index}`,
      probability,
    }
  })
}

function parseEcgItems(raw: unknown, keepPatientInfo: boolean): EcgItem[] {
  return expectArray(raw, 'ecg').map((item, index) => {
    const source = expectRecord(item, `ecg[${index}]`)
    return {
      ecg_id: expectString(source['ecg_id'], `ecg[${index}].ecg_id`),
      patient_info: projectPatientInfo(source['patient_info'], keepPatientInfo),
      measurements: parseMeasurements(source['measurements'] ?? {}),
      predictions: parsePredictions(source['predictions']),
      error: expectOptionalNullableString(source['error'], `ecg[${index}].error`),
    }
  })
}

function parseInputs(raw: unknown): Record<string, InputsEntry> {
  if (raw === undefined || raw === null) return {}
  const source = expectRecord(raw, 'inputs')
  const out: Record<string, InputsEntry> = {}
  for (const [assetId, entry] of Object.entries(source)) {
    const record = expectRecord(entry, `inputs["${assetId}"]`)
    out[assetId] = {
      sha256: expectString(record['sha256'], `inputs["${assetId}"].sha256`),
      sizeBytes: Number(record['sizeBytes'] ?? 0),
    }
  }
  return out
}

/** 提交契约解析（mcp_server._submit_contract）。 */
export function parseSubmitOutcome(structured: unknown): SubmitOutcome {
  const source = expectRecord(structured, 'structuredContent')
  const status = expectString(source['status'], 'status')
  assertKnownStatus(status)
  const outcome: { case_id: string; task_id: string; status: DiagnosisStatus; created?: string } = {
    case_id: expectString(source['case_id'], 'case_id'),
    task_id: expectString(source['task_id'], 'task_id'),
    status: status as DiagnosisStatus,
  }
  const created = expectOptionalString(source['created'], 'created')
  if (created !== undefined) outcome.created = created
  return outcome
}

function assertKnownStatus(status: string): void {
  if (!(DIAGNOSIS_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`底层结果状态 "${status}" 不在 processing/completed/failed 之内，拒绝猜测`)
  }
}

/** 查询契约解析（mcp_server._result_contract）：判别式三态。 */
export function parseDiagnosisOutcome(
  structured: unknown,
  options: { keepPatientInfo: boolean },
): DiagnosisOutcome {
  const source = expectRecord(structured, 'structuredContent')
  const status = expectString(source['status'], 'status')
  assertKnownStatus(status)
  const caseId = expectString(source['case_id'], 'case_id')
  const taskId = expectString(source['task_id'], 'task_id')

  if (status === 'processing') {
    return { case_id: caseId, task_id: taskId, status: 'processing' }
  }
  if (status === 'failed') {
    const errorRaw = source['error']
    if (errorRaw === undefined || errorRaw === null || errorRaw === '') {
      throw new Error('failed 结果缺少公开错误消息')
    }
    const errorText = typeof errorRaw === 'string'
      ? redactString(errorRaw)
      : redactString(JSON.stringify(errorRaw))
    return { case_id: caseId, task_id: taskId, status: 'failed', error: errorText }
  }

  // completed
  return {
    case_id: caseId,
    task_id: taskId,
    status: 'completed',
    hf_type: expectOptionalNullableString(source['hf_type'], 'hf_type'),
    cardiac_ultrasound: parseEchoItems(source['cardiac_ultrasound']),
    ecg: parseEcgItems(source['ecg'], options.keepPatientInfo),
    inputs: parseInputs(source['inputs']),
    algorithm_version: expectOptionalString(source['algorithm_version'], 'algorithm_version') ?? 'unknown',
    requires_clinician_review: typeof source['requires_clinician_review'] === 'boolean'
      ? source['requires_clinician_review']
      : true,
    review_status: expectOptionalString(source['review_status'], 'review_status') ?? 'pending',
    review: scrubValue(source['review'] ?? null),
  }
}

/** 支持切面查询契约解析（mcp_server.list_supported_views）。 */
export function parseViewsOutcome(structured: unknown): ViewsOutcome {
  const source = expectRecord(structured, 'structuredContent')
  const views = expectArray(source['views'], 'views').map((item, index) => {
    const record = expectRecord(item, `views[${index}]`)
    return {
      dcm_type: expectString(record['dcm_type'], `views[${index}].dcm_type`),
      metrics: expectArray(record['metrics'], `views[${index}].metrics`).map((metric, mIndex) => {
        if (typeof metric !== 'string') {
          throw new Error(`views[${index}].metrics[${mIndex}] 应为字符串`)
        }
        return metric
      }),
    }
  })
  const metricsRaw = source['metrics']
  if (metricsRaw !== undefined && !isRecord(metricsRaw)) {
    throw new Error('底层结果字段 metrics 应为对象')
  }
  return { views, metrics: scrubValue(metricsRaw ?? {}) }
}

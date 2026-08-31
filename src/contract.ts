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
  /** 服务端 v2 为布尔（是否新建诊断）；保留旧字符串形态兼容。 */
  readonly created?: string | boolean
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
  const outcome: { case_id: string; task_id: string; status: DiagnosisStatus; created?: string | boolean } = {
    case_id: expectString(source['case_id'], 'case_id'),
    task_id: expectString(source['task_id'], 'task_id'),
    status: status as DiagnosisStatus,
  }
  const createdRaw = source['created']
  if (createdRaw !== undefined && createdRaw !== null) {
    outcome.created = typeof createdRaw === 'boolean'
      ? createdRaw
      : expectOptionalString(createdRaw, 'created')
  }
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

// ── 扩展工具契约（mcp_server.py 扩展九件套） ────────────────────────────────

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`底层结果字段 ${field} 缺失或不是布尔值`)
  return value
}

function expectNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`底层结果字段 ${field} 缺失或不是有限数值`)
  }
  return value
}

function expectNullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`底层结果字段 ${field} 应为字符串或 null`)
  return value
}

function expectOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  return expectNumber(value, field)
}

/** 自由标识符（task_id/reviewer_id/request_id 等）：拒绝路径与 URL 形态。 */
export function assertFreeIdentifier(value: string, label: string): void {
  for (const rule of INPUT_REJECT_PATTERNS) {
    if (rule.pattern.test(value)) {
      throw new Error(`参数 ${label} "${redactString(value)}" ${rule.reason}，不是合法标识符`)
    }
  }
  if (/[\r\n\u0000]/.test(value)) {
    throw new Error(`参数 ${label} 含有非法控制字符`)
  }
}

export interface AnalyzeAssetEntry {
  readonly asset_id: string
  readonly modality: string
  readonly dcm_type: string | null
  readonly sha256: string
  readonly size_bytes: number
  readonly created: boolean
}

export interface AnalyzeOutcome {
  readonly case_id: string
  readonly case_created: boolean
  readonly assets: readonly AnalyzeAssetEntry[]
  readonly task_id?: string
  readonly status?: DiagnosisStatus
  readonly created?: boolean
}

/** 一站式分析契约解析（mcp_server.analyze_case_files）。 */
export function parseAnalyzeOutcome(structured: unknown): AnalyzeOutcome {
  const source = expectRecord(structured, 'structuredContent')
  const assets = expectArray(source['assets'], 'assets').map((item, index) => {
    const record = expectRecord(item, `assets[${index}]`)
    const entry: AnalyzeAssetEntry = {
      asset_id: expectString(record['asset_id'], `assets[${index}].asset_id`),
      modality: expectString(record['modality'], `assets[${index}].modality`),
      dcm_type: expectNullableString(record['dcm_type'], `assets[${index}].dcm_type`),
      sha256: expectString(record['sha256'], `assets[${index}].sha256`),
      size_bytes: expectNumber(record['size_bytes'], `assets[${index}].size_bytes`),
      created: expectBoolean(record['created'], `assets[${index}].created`),
    }
    return entry
  })
  const outcome: {
    case_id: string
    case_created: boolean
    assets: AnalyzeAssetEntry[]
    task_id?: string
    status?: DiagnosisStatus
    created?: boolean
  } = {
    case_id: expectString(source['case_id'], 'case_id'),
    case_created: expectBoolean(source['case_created'], 'case_created'),
    assets,
  }
  if (source['task_id'] !== undefined) {
    outcome.task_id = expectString(source['task_id'], 'task_id')
    const status = expectString(source['status'], 'status')
    assertKnownStatus(status)
    outcome.status = status as DiagnosisStatus
    if (typeof source['created'] === 'boolean') outcome.created = source['created']
  }
  return outcome
}

export interface AbnormalFinding {
  readonly scope: string | null
  readonly metric: string
  readonly name_cn: string
  readonly value: number
  readonly unit: string
  readonly reference: string
  readonly status: 'low' | 'high'
}

export interface UnavailableAsset {
  readonly dcm_id: string | null
  readonly error: string | null
  readonly skip_reason: string | null
}

export interface CombinedIndicator {
  readonly name: string
  readonly value: number
  readonly reference: string
  readonly status: string
  readonly basis: string
}

export interface EcgHighlight {
  readonly ecg_id: string | null
  readonly top_predictions: readonly { label: string | null; probability: number }[]
  readonly error: string | null
}

export interface CompletedInterpretation {
  readonly task_id: string
  readonly case_id: string
  readonly status: 'completed'
  readonly hf_type: string | null
  readonly algorithm_version: string
  readonly requires_clinician_review: boolean
  readonly review_status: string
  readonly lvef_value: number | null
  readonly lvef_classification: string | null
  readonly abnormal_findings: readonly AbnormalFinding[]
  readonly unavailable_assets: readonly UnavailableAsset[]
  readonly combined_indicators: readonly CombinedIndicator[]
  readonly ecg_highlights: readonly EcgHighlight[]
  readonly notes: readonly string[]
}

export type InterpretOutcome =
  | { readonly task_id: string; readonly case_id: string; readonly status: 'processing' }
  | { readonly task_id: string; readonly case_id: string; readonly status: 'failed'; readonly error: string }
  | CompletedInterpretation

function parseAbnormalFindings(raw: unknown): AbnormalFinding[] {
  return expectArray(raw, 'abnormal_findings').map((item, index) => {
    const record = expectRecord(item, `abnormal_findings[${index}]`)
    const status = expectString(record['status'], `abnormal_findings[${index}].status`)
    if (status !== 'low' && status !== 'high') {
      throw new Error(`abnormal_findings[${index}].status 只允许 low/high`)
    }
    return {
      scope: expectNullableString(record['scope'], `abnormal_findings[${index}].scope`),
      metric: expectString(record['metric'], `abnormal_findings[${index}].metric`),
      name_cn: expectString(record['name_cn'], `abnormal_findings[${index}].name_cn`),
      value: expectNumber(record['value'], `abnormal_findings[${index}].value`),
      unit: expectNullableString(record['unit'], `abnormal_findings[${index}].unit`) ?? '',
      reference: expectNullableString(record['reference'], `abnormal_findings[${index}].reference`) ?? '',
      status,
    }
  })
}

function parseCombinedIndicators(raw: unknown): CombinedIndicator[] {
  return expectArray(raw, 'combined_indicators').map((item, index) => {
    const record = expectRecord(item, `combined_indicators[${index}]`)
    return {
      name: expectString(record['name'], `combined_indicators[${index}].name`),
      value: expectNumber(record['value'], `combined_indicators[${index}].value`),
      reference: expectNullableString(record['reference'], `combined_indicators[${index}].reference`) ?? '',
      status: expectString(record['status'], `combined_indicators[${index}].status`),
      basis: expectNullableString(record['basis'], `combined_indicators[${index}].basis`) ?? '',
    }
  })
}

function parseUnavailableAssets(raw: unknown): UnavailableAsset[] {
  return expectArray(raw, 'unavailable_assets').map((item, index) => {
    const record = expectRecord(item, `unavailable_assets[${index}]`)
    return {
      dcm_id: expectNullableString(record['dcm_id'], `unavailable_assets[${index}].dcm_id`),
      error: expectNullableString(record['error'], `unavailable_assets[${index}].error`),
      skip_reason: expectNullableString(record['skip_reason'], `unavailable_assets[${index}].skip_reason`),
    }
  })
}

function parseEcgHighlights(raw: unknown): EcgHighlight[] {
  return expectArray(raw, 'ecg_highlights').map((item, index) => {
    const record = expectRecord(item, `ecg_highlights[${index}]`)
    const predictions = expectArray(record['top_predictions'] ?? [], `ecg_highlights[${index}].top_predictions`)
      .map((prediction, pIndex) => {
        const pRecord = expectRecord(prediction, `top_predictions[${pIndex}]`)
        return {
          label: expectNullableString(pRecord['label'], `top_predictions[${pIndex}].label`),
          probability: expectNumber(pRecord['probability'], `top_predictions[${pIndex}].probability`),
        }
      })
    return {
      ecg_id: expectNullableString(record['ecg_id'], `ecg_highlights[${index}].ecg_id`),
      top_predictions: predictions,
      error: expectNullableString(record['error'], `ecg_highlights[${index}].error`),
    }
  })
}

/** 规则解读契约解析（mcp_server.interpret_diagnosis）：未完成时透传状态。 */
export function parseInterpretOutcome(structured: unknown): InterpretOutcome {
  const source = expectRecord(structured, 'structuredContent')
  const status = expectString(source['status'], 'status')
  const taskId = expectString(source['task_id'], 'task_id')
  const caseId = expectString(source['case_id'], 'case_id')
  if (status === 'processing') {
    return { task_id: taskId, case_id: caseId, status: 'processing' }
  }
  if (status === 'failed') {
    const errorRaw = source['error']
    const errorText = typeof errorRaw === 'string' && errorRaw.trim() !== '' ? errorRaw : '未知错误'
    return { task_id: taskId, case_id: caseId, status: 'failed', error: redactString(errorText) }
  }
  if (status !== 'completed') {
    throw new Error(`底层结果状态 "${status}" 不在 processing/completed/failed 之内，拒绝猜测`)
  }
  return {
    task_id: taskId,
    case_id: caseId,
    status: 'completed',
    hf_type: expectNullableString(source['hf_type'], 'hf_type'),
    algorithm_version: expectOptionalString(source['algorithm_version'], 'algorithm_version') ?? 'unknown',
    requires_clinician_review: typeof source['requires_clinician_review'] === 'boolean'
      ? source['requires_clinician_review']
      : true,
    review_status: expectOptionalString(source['review_status'], 'review_status') ?? 'pending',
    lvef_value: expectOptionalNumber(source['lvef_value'], 'lvef_value') ?? null,
    lvef_classification: expectNullableString(source['lvef_classification'], 'lvef_classification'),
    abnormal_findings: parseAbnormalFindings(source['abnormal_findings'] ?? []),
    unavailable_assets: parseUnavailableAssets(source['unavailable_assets'] ?? []),
    combined_indicators: parseCombinedIndicators(source['combined_indicators'] ?? []),
    ecg_highlights: parseEcgHighlights(source['ecg_highlights'] ?? []),
    notes: (expectArray(source['notes'] ?? [], 'notes') as unknown[]).map((note, index) => {
      if (typeof note !== 'string') throw new Error(`notes[${index}] 应为字符串`)
      return note
    }),
  }
}

export interface ReportArtifact {
  readonly artifact_id: string
  readonly sha256: string
  readonly size_bytes: number
  readonly created_at: string
}

export interface ReportOutcome {
  readonly task_id: string
  readonly case_id: string
  readonly status: DiagnosisStatus
  readonly format?: 'markdown' | 'json'
  readonly content: string | null
  readonly artifact?: ReportArtifact
}

/** 报告草稿契约解析（mcp_server.generate_report）。 */
export function parseReportOutcome(structured: unknown): ReportOutcome {
  const source = expectRecord(structured, 'structuredContent')
  const status = expectString(source['status'], 'status')
  assertKnownStatus(status)
  const format = source['format']
  if (format !== undefined && format !== 'markdown' && format !== 'json') {
    throw new Error('底层结果字段 format 只允许 markdown/json')
  }
  const artifactRaw = source['artifact']
  const outcome: ReportOutcome = {
    task_id: expectString(source['task_id'], 'task_id'),
    case_id: expectString(source['case_id'], 'case_id'),
    status: status as DiagnosisStatus,
    content: expectNullableString(source['content'], 'content'),
    ...(format !== undefined ? { format } : {}),
    ...(isRecord(artifactRaw)
      ? {
          artifact: {
            artifact_id: expectString(artifactRaw['artifactId'], 'artifact.artifactId'),
            sha256: expectString(artifactRaw['sha256'], 'artifact.sha256'),
            size_bytes: expectNumber(artifactRaw['sizeBytes'], 'artifact.sizeBytes'),
            created_at: expectString(artifactRaw['createdAt'], 'artifact.createdAt'),
          },
        }
      : {}),
  }
  return outcome
}

export interface CompareMetricRow {
  readonly metric: string
  readonly name_cn: string
  readonly unit: string
  readonly value_a: number
  readonly value_b: number
  readonly delta: number
  readonly pct_change: number | null
  readonly direction: 'increased' | 'decreased' | 'unchanged'
  readonly notable: boolean
}

export interface ComparisonDetail {
  readonly metrics: readonly CompareMetricRow[]
  readonly lvef_classification: { readonly from: string | null; readonly to: string | null } | null
  readonly notes: readonly string[]
}

export interface CompareOutcome {
  readonly case_id: string
  readonly task_id_a: string
  readonly task_id_b: string
  readonly status_a?: DiagnosisStatus
  readonly status_b?: DiagnosisStatus
  readonly comparison: ComparisonDetail | null
}

function parseComparisonDetail(raw: unknown): ComparisonDetail {
  const source = expectRecord(raw, 'comparison')
  const metrics = expectArray(source['metrics'], 'comparison.metrics').map((item, index): CompareMetricRow => {
    const record = expectRecord(item, `comparison.metrics[${index}]`)
    const direction = expectString(record['direction'], `comparison.metrics[${index}].direction`)
    if (direction !== 'increased' && direction !== 'decreased' && direction !== 'unchanged') {
      throw new Error(`comparison.metrics[${index}].direction 取值不受支持`)
    }
    return {
      metric: expectString(record['metric'], `comparison.metrics[${index}].metric`),
      name_cn: expectNullableString(record['name_cn'], `comparison.metrics[${index}].name_cn`) ?? '',
      unit: expectNullableString(record['unit'], `comparison.metrics[${index}].unit`) ?? '',
      value_a: expectNumber(record['value_a'], `comparison.metrics[${index}].value_a`),
      value_b: expectNumber(record['value_b'], `comparison.metrics[${index}].value_b`),
      delta: expectNumber(record['delta'], `comparison.metrics[${index}].delta`),
      pct_change: expectOptionalNumber(record['pct_change'], `comparison.metrics[${index}].pct_change`) ?? null,
      direction,
      notable: expectBoolean(record['notable'], `comparison.metrics[${index}].notable`),
    }
  })
  const classificationRaw = source['lvef_classification']
  let classification: ComparisonDetail['lvef_classification'] = null
  if (isRecord(classificationRaw)) {
    classification = {
      from: expectNullableString(classificationRaw['from'], 'lvef_classification.from'),
      to: expectNullableString(classificationRaw['to'], 'lvef_classification.to'),
    }
  }
  const notes = expectArray(source['notes'] ?? [], 'comparison.notes').map((note, index) => {
    if (typeof note !== 'string') throw new Error(`comparison.notes[${index}] 应为字符串`)
    return note
  })
  return { metrics, lvef_classification: classification, notes }
}

/** 纵向对比契约解析（mcp_server.compare_diagnoses）。 */
export function parseCompareOutcome(structured: unknown): CompareOutcome {
  const source = expectRecord(structured, 'structuredContent')
  const statusA = source['status_a']
  const statusB = source['status_b']
  let statusATyped: DiagnosisStatus | undefined
  let statusBTyped: DiagnosisStatus | undefined
  if (statusA !== undefined) {
    const status = expectString(statusA, 'status_a')
    assertKnownStatus(status)
    statusATyped = status as DiagnosisStatus
  }
  if (statusB !== undefined) {
    const status = expectString(statusB, 'status_b')
    assertKnownStatus(status)
    statusBTyped = status as DiagnosisStatus
  }
  const outcome: CompareOutcome = {
    case_id: expectString(source['case_id'], 'case_id'),
    task_id_a: expectString(source['task_id_a'], 'task_id_a'),
    task_id_b: expectString(source['task_id_b'], 'task_id_b'),
    comparison: source['comparison'] !== null && source['comparison'] !== undefined
      ? parseComparisonDetail(source['comparison'])
      : null,
    ...(statusATyped !== undefined ? { status_a: statusATyped } : {}),
    ...(statusBTyped !== undefined ? { status_b: statusBTyped } : {}),
  }
  return outcome
}

export interface CaseSummary {
  readonly case_id: string
  readonly sys_user_id: string | null
  readonly created_at: string | null
  readonly asset_count: number
  readonly diagnosis_count: number
  readonly review_decision: string | null
}

export interface ListCasesOutcome {
  readonly cases: readonly CaseSummary[]
  readonly count: number
}

/** 病例列表契约解析（mcp_server.list_cases）。 */
export function parseListCasesOutcome(structured: unknown): ListCasesOutcome {
  const source = expectRecord(structured, 'structuredContent')
  const cases = expectArray(source['cases'], 'cases').map((item, index) => {
    const record = expectRecord(item, `cases[${index}]`)
    return {
      case_id: expectString(record['caseId'], `cases[${index}].caseId`),
      sys_user_id: expectNullableString(record['sysUserId'], `cases[${index}].sysUserId`),
      created_at: expectNullableString(record['createdAt'], `cases[${index}].createdAt`),
      asset_count: expectNumber(record['assetCount'], `cases[${index}].assetCount`),
      diagnosis_count: expectNumber(record['diagnosisCount'], `cases[${index}].diagnosisCount`),
      review_decision: expectNullableString(record['reviewDecision'], `cases[${index}].reviewDecision`),
    }
  })
  return { cases, count: expectNumber(source['count'] ?? cases.length, 'count') }
}

export interface CaseAssetEntry {
  readonly asset_id: string
  readonly modality: string
  readonly dcm_type: string | null
  readonly sha256: string
  readonly size_bytes: number
  readonly created_at: string | null
}

export interface CaseDiagnosisEntry {
  readonly task_id: string
  readonly request_id: string | null
  readonly asset_ids: readonly string[]
  readonly submission_state: string | null
  readonly created_at: string | null
  readonly status?: string
}

export interface CaseArtifactEntry {
  readonly artifact_id: string
  readonly sha256: string
  readonly size_bytes: number
  readonly created_at: string | null
}

export interface ReviewHistoryEntry {
  readonly task_id: string
  readonly reviewer_id: string
  readonly decision: string
  readonly comment: string
  readonly reviewed_at: string
}

export interface CaseDetailOutcome {
  readonly case_id: string
  readonly created_at: string | null
  readonly assets: readonly CaseAssetEntry[]
  readonly diagnoses: readonly CaseDiagnosisEntry[]
  readonly artifacts: readonly CaseArtifactEntry[]
  readonly review: unknown
  readonly review_history: readonly ReviewHistoryEntry[]
}

/** 病例详情契约解析（mcp_server.get_case_detail）。 */
export function parseCaseDetailOutcome(structured: unknown): CaseDetailOutcome {
  const source = expectRecord(structured, 'structuredContent')
  const assets = expectArray(source['assets'] ?? [], 'assets').map((item, index) => {
    const record = expectRecord(item, `assets[${index}]`)
    return {
      asset_id: expectString(record['assetId'], `assets[${index}].assetId`),
      modality: expectString(record['modality'], `assets[${index}].modality`),
      dcm_type: expectNullableString(record['dcmType'], `assets[${index}].dcmType`),
      sha256: expectString(record['sha256'], `assets[${index}].sha256`),
      size_bytes: expectNumber(record['sizeBytes'], `assets[${index}].sizeBytes`),
      created_at: expectNullableString(record['createdAt'], `assets[${index}].createdAt`),
    }
  })
  const diagnoses = expectArray(source['diagnoses'] ?? [], 'diagnoses').map((item, index) => {
    const record = expectRecord(item, `diagnoses[${index}]`)
    const statusRaw = record['status']
    const entry: CaseDiagnosisEntry = {
      task_id: expectString(record['taskId'], `diagnoses[${index}].taskId`),
      request_id: expectNullableString(record['requestId'], `diagnoses[${index}].requestId`),
      asset_ids: expectArray(record['assetIds'] ?? [], `diagnoses[${index}].assetIds`).map((id, aIndex) => {
        if (typeof id !== 'string') throw new Error(`diagnoses[${index}].assetIds[${aIndex}] 应为字符串`)
        return id
      }),
      submission_state: expectNullableString(record['submissionState'], `diagnoses[${index}].submissionState`),
      created_at: expectNullableString(record['createdAt'], `diagnoses[${index}].createdAt`),
      ...(statusRaw !== undefined ? { status: expectString(statusRaw, `diagnoses[${index}].status`) } : {}),
    }
    return entry
  })
  const artifacts = expectArray(source['artifacts'] ?? [], 'artifacts').map((item, index) => {
    const record = expectRecord(item, `artifacts[${index}]`)
    return {
      artifact_id: expectString(record['artifactId'], `artifacts[${index}].artifactId`),
      sha256: expectString(record['sha256'], `artifacts[${index}].sha256`),
      size_bytes: expectNumber(record['sizeBytes'], `artifacts[${index}].sizeBytes`),
      created_at: expectNullableString(record['createdAt'], `artifacts[${index}].createdAt`),
    }
  })
  const reviewHistory = expectArray(source['reviewHistory'] ?? [], 'reviewHistory').map((item, index) => {
    const record = expectRecord(item, `reviewHistory[${index}]`)
    return {
      task_id: expectString(record['taskId'], `reviewHistory[${index}].taskId`),
      reviewer_id: expectString(record['reviewerId'], `reviewHistory[${index}].reviewerId`),
      decision: expectString(record['decision'], `reviewHistory[${index}].decision`),
      comment: expectNullableString(record['comment'], `reviewHistory[${index}].comment`) ?? '',
      reviewed_at: expectString(record['reviewedAt'], `reviewHistory[${index}].reviewedAt`),
    }
  })
  return {
    case_id: expectString(source['caseId'], 'caseId'),
    created_at: expectNullableString(source['createdAt'], 'createdAt'),
    assets,
    diagnoses,
    artifacts,
    review: scrubValue(source['review'] ?? null),
    review_history: reviewHistory,
  }
}

export interface TaskSummary {
  readonly case_id: string
  readonly task_id: string
  readonly created_at: string | null
  readonly submission_state: string | null
  readonly status: string
}

export interface ListTasksOutcome {
  readonly tasks: readonly TaskSummary[]
  readonly count: number
}

/** 任务列表契约解析（mcp_server.list_tasks）。 */
export function parseListTasksOutcome(structured: unknown): ListTasksOutcome {
  const source = expectRecord(structured, 'structuredContent')
  const tasks = expectArray(source['tasks'], 'tasks').map((item, index) => {
    const record = expectRecord(item, `tasks[${index}]`)
    return {
      case_id: expectString(record['case_id'], `tasks[${index}].case_id`),
      task_id: expectString(record['task_id'], `tasks[${index}].task_id`),
      created_at: expectNullableString(record['created'], `tasks[${index}].created`),
      submission_state: expectNullableString(record['submission_state'], `tasks[${index}].submission_state`),
      status: expectString(record['status'], `tasks[${index}].status`),
    }
  })
  return { tasks, count: expectNumber(source['count'] ?? tasks.length, 'count') }
}

export interface ReviewStatusOutcome {
  readonly task_id: string
  readonly case_id: string
  readonly review_status: string
  readonly requires_clinician_review: boolean
  readonly review: unknown
  readonly review_count: number
}

/** 复核状态契约解析（mcp_server.get_review_status）。 */
export function parseReviewStatusOutcome(structured: unknown): ReviewStatusOutcome {
  const source = expectRecord(structured, 'structuredContent')
  return {
    task_id: expectString(source['task_id'], 'task_id'),
    case_id: expectString(source['case_id'], 'case_id'),
    review_status: expectString(source['review_status'], 'review_status'),
    requires_clinician_review: expectBoolean(source['requires_clinician_review'], 'requires_clinician_review'),
    review: scrubValue(source['review'] ?? null),
    review_count: expectNumber(source['review_count'], 'review_count'),
  }
}

export interface ReviewOutcome {
  readonly case_id: string
  readonly task_id: string
  readonly reviewer_id: string
  readonly decision: 'approved' | 'rejected'
  readonly comment: string
  readonly reviewed_at: string
}

/** 复核登记契约解析（mcp_server.submit_review）。 */
export function parseReviewOutcome(structured: unknown): ReviewOutcome {
  const source = expectRecord(structured, 'structuredContent')
  const decision = expectString(source['decision'], 'decision')
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new Error('底层结果字段 decision 只允许 approved/rejected')
  }
  return {
    case_id: expectString(source['case_id'], 'case_id'),
    task_id: expectString(source['taskId'], 'taskId'),
    reviewer_id: expectString(source['reviewerId'], 'reviewerId'),
    decision,
    comment: expectNullableString(source['comment'], 'comment') ?? '',
    reviewed_at: expectString(source['reviewedAt'], 'reviewedAt'),
  }
}

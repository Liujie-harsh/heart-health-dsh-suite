/**
 * Native 模式的模型可见文本与持久化 presentation metadata。
 *
 * 与 canonical JSON 分离：模型看到的是简洁中文文本，Web UI 的 generic 结果卡片
 * 从这里的 presentationMeta 纯函数重放（P1 再加专用卡片）。
 * 所有函数都是纯函数：相同输入产生相同输出（快照测试的基础）。
 */

import type {
  AnalyzeOutcome,
  CaseDetailOutcome,
  CompletedDiagnosis,
  CompareOutcome,
  DiagnosisOutcome,
  EcgItem,
  InterpretOutcome,
  ListCasesOutcome,
  ListTasksOutcome,
  ReportOutcome,
  ReviewOutcome,
  ReviewStatusOutcome,
  SubmitOutcome,
  ViewsOutcome,
} from './contract.js'
import type { HeartSuiteConfig } from './config.js'

// ── submit ─────────────────────────────────────────────────────────────────

export function renderSubmit(outcome: SubmitOutcome): string {
  const lines = [
    `已提交病例 ${outcome.case_id} 的心脏分析任务。`,
    `task_id: ${outcome.task_id}`,
    `状态: ${outcome.status}`,
  ]
  if (outcome.status === 'processing') {
    lines.push('推理进行中（数十秒到数分钟）。请在后续轮次用 heart_get_diagnosis_result 查询，本轮无需等待。')
  }
  lines.push('结果仅供临床辅助，必须经过临床人员复核。')
  return lines.join('\n')
}

export function submitPresentationMeta(outcome: SubmitOutcome): Record<string, unknown> {
  return {
    card: 'heart-diagnosis-submit',
    caseId: outcome.case_id,
    taskId: outcome.task_id,
    status: outcome.status,
  }
}

// ── get result ─────────────────────────────────────────────────────────────

export function renderDiagnosis(
  outcome: DiagnosisOutcome,
  config: HeartSuiteConfig,
): string {
  if (outcome.status === 'processing') {
    return [
      `诊断任务 ${outcome.task_id} 尚在处理中。`,
      '请稍后在后续轮次再次查询，不要重复提交同一病例的新任务。',
    ].join('\n')
  }
  if (outcome.status === 'failed') {
    return [
      `诊断任务 ${outcome.task_id} 失败。`,
      `公开错误：${outcome.error}`,
      '建议：核对 case_id 与 task_id 是否正确；确认资产已成功上传；稍后重试或联系系统运维。',
      '本消息不包含内部细节；不要向用户推测失败的技术原因。',
    ].join('\n')
  }
  return renderCompleted(outcome, config)
}

function renderCompleted(completed: CompletedDiagnosis, config: HeartSuiteConfig): string {
  const lines: string[] = []
  lines.push(`诊断任务 ${completed.task_id} 已完成（状态仅供算法参考，尚需临床复核判定）。`)

  // 模态分开展示。
  lines.push('')
  lines.push('── 心超（cardiac_ultrasound）──')
  if (completed.cardiac_ultrasound.length === 0) {
    lines.push('本次任务没有心超资产或均未产生心超结果。')
  }
  let echoIndex = 0
  for (const item of completed.cardiac_ultrasound) {
    echoIndex += 1
    lines.push(`[${echoIndex}] dcm_id=${item.dcm_id}`)
    if (item.skip_reason !== null) {
      lines.push(`    跳过原因：${item.skip_reason}`)
    }
    if (item.error !== null) {
      lines.push(`    该资产错误：${item.error}`)
      continue
    }
    const entries = Object.entries(item.measurements)
    if (entries.length === 0) {
      lines.push('    （无测量值输出——如实说明缺失，不得补造）')
    }
    for (const [key, value] of entries) {
      lines.push(`    ${key} = ${formatMeasurement(value)}`)
    }
  }
  if (completed.hf_type !== null && completed.hf_type !== '') {
    lines.push('')
    lines.push(`心衰分型（算法模型分型，非医生诊断）：${completed.hf_type}`)
    lines.push('注意：LVEF 为 LVEDD/LVESD 经 Teichholz 公式估算值，存在已知局限。')
  }

  lines.push('')
  lines.push('── ECG（ecg）──')
  if (completed.ecg.length === 0) {
    lines.push('本次任务没有 ECG 资产或均未产生 ECG 结果。')
  }
  let ecgIndex = 0
  for (const item of completed.ecg) {
    ecgIndex += 1
    lines.push(`[${ecgIndex}] ecg_id=${item.ecg_id}`)
    if (item.error !== null) {
      lines.push(`    该资产错误：${item.error}`)
      continue
    }
    if (item.patient_info !== null) {
      lines.push(`    患者信息：${Object.entries(item.patient_info).map(([k, v]) => `${k}=${String(v)}`).join('，')}`)
    }
    const measurementEntries = Object.entries(item.measurements)
    if (measurementEntries.length > 0) {
      const joined = measurementEntries.map(([k, v]) => `${k}=${formatMeasurement(v)}`).join('；')
      lines.push(`    测量：${joined}`)
    }
    appendPredictionLines(lines, item, config)
    lines.push('    说明：ECG 为多标签独立预测，各概率相互独立、总和不要求等于 1。')
  }

  lines.push('')
  lines.push('── 追溯信息 ──')
  const inputCount = Object.keys(completed.inputs).length
  lines.push(`输入资产 ${inputCount} 个（可按 SHA-256 追溯）；算法版本：${completed.algorithm_version}`)

  if ((completed.requires_clinician_review || completed.review_status !== 'approved')
    && config.reviewReminder) {
    lines.push('')
    lines.push(renderReviewReminder(completed.review_status))
  }
  lines.push('以上内容为算法辅助分析，不能替代心内科医生的诊断。')
  return lines.join('\n')
}

function appendPredictionLines(lines: string[], item: EcgItem, config: HeartSuiteConfig): void {
  const total = item.predictions.length
  if (total === 0) {
    lines.push('    预测：无（ECG-only 结果也不得写成心衰分型）')
    return
  }
  const visibleCount = Math.min(total, config.maxVisibleEcgPredictions)
  lines.push(`    Top-${visibleCount}/${total} 预测（按概率降序）：`)
  for (let index = 0; index < visibleCount; index += 1) {
    const prediction = item.predictions[index]
    const percent = (prediction.probability * 100).toFixed(2)
    lines.push(`    - ${prediction.label}: ${percent}%`)
  }
}

function formatMeasurement(value: import('./contract.js').MeasurementValue): string {
  if (typeof value === 'object' && value !== null) {
    const unitSuffix = value.unit !== undefined ? ` ${value.unit}` : ''
    const reference = value.reference !== undefined ? `（参考 ${value.reference}）` : ''
    return `${String(value.value)}${unitSuffix}${reference}`
  }
  return String(value)
}

/** 临床复核警示文案（配置可关闭）。 */
export function renderReviewReminder(reviewStatus: string): string {
  return `临床复核提示：review_status=${reviewStatus}，该结果尚未经临床人员复核确认，禁止作为最终临床结论使用。`
}

export function diagnosisPresentationMeta(
  outcome: DiagnosisOutcome,
  config: HeartSuiteConfig,
): Record<string, unknown> {
  if (outcome.status !== 'completed') {
    return { card: 'heart-diagnosis-result', taskId: outcome.task_id, status: outcome.status }
  }
  const totalPredictions = outcome.ecg.reduce((sum, item) => sum + item.predictions.length, 0)
  const visiblePredictions = outcome.ecg.reduce(
    (sum, item) => sum + Math.min(item.predictions.length, config.maxVisibleEcgPredictions),
    0,
  )
  const truncated = visiblePredictions < totalPredictions
  const requiresReview = outcome.requires_clinician_review
  const meta: Record<string, unknown> = {
    card: 'heart-diagnosis-result',
    taskId: outcome.task_id,
    status: outcome.status,
    hfType: outcome.hf_type,
    algorithmVersion: outcome.algorithm_version,
    counts: {
      cardiacUltrasound: outcome.cardiac_ultrasound.length,
      cardiacUltrasoundFailed: outcome.cardiac_ultrasound.filter(i => i.error !== null).length,
      cardiacUltrasoundSkipped: outcome.cardiac_ultrasound.filter(i => i.skip_reason !== null).length,
      ecg: outcome.ecg.length,
      ecgFailed: outcome.ecg.filter(i => i.error !== null).length,
    },
    requiresClinicianReview: requiresReview,
    reviewStatus: outcome.review_status,
  }
  // presentationMeta 必须是 lossless-JSON：可选字段缺省时直接省略键，不能写 undefined。
  if (truncated) {
    meta['ecgPredictions'] = { visible: visiblePredictions, total: totalPredictions, truncated: true }
  }
  return meta
}

// ── views ──────────────────────────────────────────────────────────────────

export function renderViews(views: ViewsOutcome): string {
  const lines: string[] = []
  lines.push('心脏算法服务支持以下心超切面与指标：')
  for (const view of views.views) {
    lines.push(`- ${view.dcm_type}: ${view.metrics.join(', ') || '（无固定指标目录）'}`)
  }
  lines.push('上传前请核对切面类型；不在列表中的切面可能被跳过或失败。')
  return lines.join('\n')
}

export function viewsPresentationMeta(views: ViewsOutcome): Record<string, unknown> {
  return {
    card: 'heart-supported-views',
    viewTypes: views.views.map(view => view.dcm_type),
  }
}

// ── 扩展九件套的渲染 ────────────────────────────────────────────────────────

export function renderAnalyze(outcome: AnalyzeOutcome): string {
  const lines: string[] = []
  lines.push(outcome.case_created
    ? `已创建病例 ${outcome.case_id} 并登记 ${outcome.assets.length} 个资产。`
    : `复用已有病例 ${outcome.case_id}，新登记 ${outcome.assets.length} 个资产。`)
  for (const asset of outcome.assets) {
    const kind = asset.dcm_type !== null ? asset.dcm_type : asset.modality
    lines.push(`- ${asset.asset_id}（${kind}，SHA-256 前 8 位 ${asset.sha256.slice(0, 8)}）`)
  }
  if (outcome.task_id !== undefined) {
    lines.push(`已提交分析任务 task_id: ${outcome.task_id}（状态 ${outcome.status ?? 'processing'}）。`)
    lines.push('推理进行中时请在后续轮次用 heart_get_diagnosis_result 查询，本轮无需等待。')
  } else {
    lines.push('仅登记资产，未提交分析。需要分析时用 heart_submit_diagnosis 提交。')
  }
  lines.push('结果仅供临床辅助，必须经过临床人员复核。')
  return lines.join('\n')
}

export function analyzePresentationMeta(outcome: AnalyzeOutcome): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    card: 'heart-analyze',
    caseId: outcome.case_id,
    caseCreated: outcome.case_created,
    assets: outcome.assets.length,
  }
  if (outcome.task_id !== undefined) {
    meta['taskId'] = outcome.task_id
    meta['status'] = outcome.status ?? 'processing'
  }
  return meta
}

export function renderInterpret(outcome: InterpretOutcome): string {
  if (outcome.status === 'processing') {
    return `任务 ${outcome.task_id} 尚在处理中，规则解读需要任务 completed 后才能进行。`
  }
  if (outcome.status === 'failed') {
    return [`任务 ${outcome.task_id} 失败。`, `公开错误：${outcome.error}`].join('\n')
  }
  const lines: string[] = []
  lines.push(`任务 ${outcome.task_id} 的规则解读（参考范围比对，不构成诊断）：`)
  if (outcome.lvef_value !== null) {
    lines.push(`- LVEF（Teichholz 估算）：${outcome.lvef_value}%，规则分型：${outcome.lvef_classification ?? '无法判定'}`)
  } else {
    lines.push('- 本次结果没有可用的 LVEF 测量。')
  }
  if (outcome.abnormal_findings.length === 0) {
    lines.push('- 未发现超出参考范围的指标。')
  } else {
    for (const finding of outcome.abnormal_findings) {
      const direction = finding.status === 'high' ? '偏高' : '偏低'
      const scope = finding.scope !== null ? `（来源 ${finding.scope}）` : ''
      lines.push(`- ${finding.name_cn} ${finding.value} ${finding.unit}（参考 ${finding.reference}）${direction}${scope}`)
    }
  }
  for (const indicator of outcome.combined_indicators) {
    const flag = indicator.status === 'high' ? '异常' : indicator.status === 'low' ? '偏低' : '正常'
    lines.push(`- 组合指标 ${indicator.name} = ${indicator.value}（${indicator.reference}，${flag}；${indicator.basis}）`)
  }
  for (const asset of outcome.unavailable_assets) {
    if (asset.error !== null) lines.push(`- 资产 ${asset.dcm_id ?? '?'} 分析失败：${asset.error}`)
    if (asset.skip_reason !== null) lines.push(`- 资产 ${asset.dcm_id ?? '?'} 被跳过：${asset.skip_reason}`)
  }
  lines.push('以上是规则比对输出，仅供辅助，必须由临床人员复核后使用。')
  return lines.join('\n')
}

export function interpretPresentationMeta(outcome: InterpretOutcome): Record<string, unknown> {
  if (outcome.status !== 'completed') {
    return { card: 'heart-interpret', taskId: outcome.task_id, status: outcome.status }
  }
  return {
    card: 'heart-interpret',
    taskId: outcome.task_id,
    status: outcome.status,
    lvef: outcome.lvef_value,
    lvefClassification: outcome.lvef_classification,
    abnormalCount: outcome.abnormal_findings.length,
    combinedIndicators: outcome.combined_indicators.length,
    unavailableAssets: outcome.unavailable_assets.length,
  }
}

export function renderReport(outcome: ReportOutcome): string {
  if (outcome.status !== 'completed') {
    return `任务 ${outcome.task_id} 状态为 ${outcome.status}，报告要等任务 completed 后才能生成。`
  }
  const lines: string[] = []
  lines.push(`报告草稿已生成（${outcome.format ?? 'markdown'}，${(outcome.content ?? '').length} 字符）：`)
  lines.push('')
  lines.push(outcome.content ?? '（报告内容为空）')
  if (outcome.artifact !== undefined) {
    lines.push('')
    lines.push(`已存回病例工件 ${outcome.artifact.artifact_id}（SHA-256 前 8 位 ${outcome.artifact.sha256.slice(0, 8)}）。`)
  }
  return lines.join('\n')
}

export function reportPresentationMeta(outcome: ReportOutcome): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    card: 'heart-report',
    taskId: outcome.task_id,
    caseId: outcome.case_id,
    status: outcome.status,
    format: outcome.format ?? null,
    savedToCase: outcome.artifact !== undefined,
  }
  if (outcome.artifact !== undefined) meta['artifactId'] = outcome.artifact.artifact_id
  return meta
}

export function renderCompare(outcome: CompareOutcome): string {
  if (outcome.comparison === null) {
    return [
      `对比未完成：task ${outcome.task_id_a} 状态 ${outcome.status_a ?? 'unknown'}，task ${outcome.task_id_b} 状态 ${outcome.status_b ?? 'unknown'}。`,
      '纵向对比要求两个任务均已完成。',
    ].join('\n')
  }
  const lines: string[] = []
  lines.push(`同病例两次任务对比（${outcome.task_id_a} → ${outcome.task_id_b}）：`)
  for (const row of outcome.comparison.metrics) {
    const pct = row.pct_change !== null ? `，${row.pct_change > 0 ? '+' : ''}${row.pct_change}%` : ''
    const mark = row.notable ? '，变化显著' : ''
    lines.push(`- ${row.name_cn}(${row.metric})：${row.value_a} → ${row.value_b} ${row.unit}（Δ${row.delta}${pct}，${row.direction}${mark}）`)
  }
  const classification = outcome.comparison.lvef_classification
  if (classification !== null) {
    lines.push(`LVEF 规则分型：${classification.from ?? '?'} → ${classification.to ?? '?'}。`)
  }
  lines.push('差异可能来自图像质量与操作者变异，不构成病情结论；必须由临床人员复核。')
  return lines.join('\n')
}

export function comparePresentationMeta(outcome: CompareOutcome): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    card: 'heart-compare',
    caseId: outcome.case_id,
    taskIdA: outcome.task_id_a,
    taskIdB: outcome.task_id_b,
    compared: outcome.comparison !== null,
  }
  if (outcome.comparison !== null) {
    meta['metricCount'] = outcome.comparison.metrics.length
    meta['notableCount'] = outcome.comparison.metrics.filter(row => row.notable).length
  }
  return meta
}

export function renderListCases(outcome: ListCasesOutcome): string {
  const lines: string[] = []
  lines.push(`服务账号可见 ${outcome.count} 个病例：`)
  for (const item of outcome.cases) {
    const review = item.review_decision !== null ? `，复核 ${item.review_decision}` : ''
    lines.push(`- ${item.case_id}（资产 ${item.asset_count}，任务 ${item.diagnosis_count}${review}）`)
  }
  return lines.join('\n')
}

export function listCasesPresentationMeta(outcome: ListCasesOutcome): Record<string, unknown> {
  return { card: 'heart-case-list', count: outcome.count }
}

export function renderCaseDetail(outcome: CaseDetailOutcome): string {
  const lines: string[] = []
  lines.push(`病例 ${outcome.case_id}（创建于 ${outcome.created_at ?? '?'}）：`)
  lines.push(`资产 ${outcome.assets.length} 个：${outcome.assets.map(asset => asset.asset_id).join(', ') || '无'}`)
  lines.push(`分析任务 ${outcome.diagnoses.length} 个：`)
  for (const diagnosis of outcome.diagnoses) {
    lines.push(`- ${diagnosis.task_id}（状态 ${diagnosis.status ?? 'unknown'}）`)
  }
  if (outcome.artifacts.length > 0) {
    lines.push(`报告工件 ${outcome.artifacts.length} 个：${outcome.artifacts.map(artifact => artifact.artifact_id).join(', ')}`)
  }
  const latestReview = outcome.review_history[outcome.review_history.length - 1]
  lines.push(latestReview !== undefined
    ? `最近复核：${latestReview.reviewer_id} 作出 ${latestReview.decision}。`
    : '该病例尚无临床复核记录。')
  return lines.join('\n')
}

export function caseDetailPresentationMeta(outcome: CaseDetailOutcome): Record<string, unknown> {
  return {
    card: 'heart-case-detail',
    caseId: outcome.case_id,
    assets: outcome.assets.length,
    diagnoses: outcome.diagnoses.length,
    artifacts: outcome.artifacts.length,
    reviewHistory: outcome.review_history.length,
  }
}

export function renderListTasks(outcome: ListTasksOutcome): string {
  const lines: string[] = []
  lines.push(`共 ${outcome.count} 个分析任务：`)
  for (const task of outcome.tasks) {
    lines.push(`- ${task.case_id} / ${task.task_id}（${task.status}）`)
  }
  return lines.join('\n')
}

export function listTasksPresentationMeta(outcome: ListTasksOutcome): Record<string, unknown> {
  return { card: 'heart-task-list', count: outcome.count }
}

export function renderReviewStatus(outcome: ReviewStatusOutcome): string {
  return [
    `任务 ${outcome.task_id} 的复核状态：${outcome.review_status}（共 ${outcome.review_count} 条复核记录）。`,
    outcome.requires_clinician_review
      ? '该结果尚未经临床复核确认，不能作为最终临床结论。'
      : '该结果已经临床复核通过。',
  ].join('\n')
}

export function reviewStatusPresentationMeta(outcome: ReviewStatusOutcome): Record<string, unknown> {
  return {
    card: 'heart-review-status',
    taskId: outcome.task_id,
    caseId: outcome.case_id,
    reviewStatus: outcome.review_status,
    reviewCount: outcome.review_count,
  }
}

export function renderReviewSubmit(outcome: ReviewOutcome): string {
  return [
    `已为任务 ${outcome.task_id} 登记复核结论：${outcome.reviewer_id} 于 ${outcome.reviewed_at} 作出「${outcome.decision}」。`,
    '复核结论只能由真实临床人员作出；Agent 只负责登记，不得代替复核。',
  ].join('\n')
}

export function reviewSubmitPresentationMeta(outcome: ReviewOutcome): Record<string, unknown> {
  return {
    card: 'heart-review-submit',
    caseId: outcome.case_id,
    taskId: outcome.task_id,
    reviewerId: outcome.reviewer_id,
    decision: outcome.decision,
  }
}

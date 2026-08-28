/**
 * Native 模式的模型可见文本与持久化 presentation metadata。
 *
 * 与 canonical JSON 分离：模型看到的是简洁中文文本，Web UI 的 generic 结果卡片
 * 从这里的 presentationMeta 纯函数重放（P1 再加专用卡片）。
 * 所有函数都是纯函数：相同输入产生相同输出（快照测试的基础）。
 */

import type { CompletedDiagnosis, DiagnosisOutcome, EcgItem, SubmitOutcome, ViewsOutcome } from './contract.js'
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

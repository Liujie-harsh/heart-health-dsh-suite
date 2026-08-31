/**
 * 套件配置：所有部署可变项集中在这里解析与校验（PRD 用户故事 32/33）。
 *
 * 配置来源优先级：preset 组合里的显式 row config > 进程环境变量 > 内置默认值。
 * 任何类型错误、超出范围的数值都会在插件加载（首次可解析点）明确失败，
 * 绝不静默回退成一个没有诊断能力的 Agent。
 */

/** 核心 + 扩展共 12 个底层 raw 工具的配置键名（与 HeartSuiteConfig 字段一一对应）。 */
export const RAW_TOOL_KEYS = [
  'rawSubmitTool',
  'rawResultTool',
  'rawViewsTool',
  'rawAnalyzeTool',
  'rawInterpretTool',
  'rawReportTool',
  'rawCompareTool',
  'rawListCasesTool',
  'rawCaseDetailTool',
  'rawListTasksTool',
  'rawReviewStatusTool',
  'rawSubmitReviewTool',
] as const

export type RawToolKey = (typeof RAW_TOOL_KEYS)[number]

export interface HeartSuiteConfig {
  /** MCP bridge 的 serverName（决定原始工具名前缀 mcp__<serverName>__*）。 */
  readonly serverName: string
  /** 底层 MCP 工具的 raw 名称（核心三个 + 扩展九个，默认与 mcp_server.py 对齐）。 */
  readonly rawSubmitTool: string
  readonly rawResultTool: string
  readonly rawViewsTool: string
  readonly rawAnalyzeTool: string
  readonly rawInterpretTool: string
  readonly rawReportTool: string
  readonly rawCompareTool: string
  readonly rawListCasesTool: string
  readonly rawCaseDetailTool: string
  readonly rawListTasksTool: string
  readonly rawReviewStatusTool: string
  readonly rawSubmitReviewTool: string
  /** completed 结果中是否向模型保留 ECG 的 patient_info（age/sex）。 */
  readonly keepPatientInfo: boolean
  /** 模型可见内容中每条 ECG 最多展示的预测条数（Top-K 截断）。 */
  readonly maxVisibleEcgPredictions: number
  /** completed 且需要临床复核时，是否在模型可见内容中保留复核警示。 */
  readonly reviewReminder: boolean
}

export const DEFAULT_SERVER_NAME = 'heart-algo'

/** 各 raw 工具键的默认 raw 名与环境变量旋钮（顺序与 RAW_TOOL_KEYS 一致）。 */
export const RAW_TOOL_DEFAULTS: Readonly<Record<RawToolKey, { fallback: string; env: string }>> = {
  rawSubmitTool: { fallback: 'diagnose_heart_failure', env: 'HEART_HEALTH_RAW_TOOL_SUBMIT' },
  rawResultTool: { fallback: 'get_diagnosis_result', env: 'HEART_HEALTH_RAW_TOOL_RESULT' },
  rawViewsTool: { fallback: 'list_supported_views', env: 'HEART_HEALTH_RAW_TOOL_VIEWS' },
  rawAnalyzeTool: { fallback: 'analyze_case_files', env: 'HEART_HEALTH_RAW_TOOL_ANALYZE' },
  rawInterpretTool: { fallback: 'interpret_diagnosis', env: 'HEART_HEALTH_RAW_TOOL_INTERPRET' },
  rawReportTool: { fallback: 'generate_report', env: 'HEART_HEALTH_RAW_TOOL_REPORT' },
  rawCompareTool: { fallback: 'compare_diagnoses', env: 'HEART_HEALTH_RAW_TOOL_COMPARE' },
  rawListCasesTool: { fallback: 'list_cases', env: 'HEART_HEALTH_RAW_TOOL_LIST_CASES' },
  rawCaseDetailTool: { fallback: 'get_case_detail', env: 'HEART_HEALTH_RAW_TOOL_CASE_DETAIL' },
  rawListTasksTool: { fallback: 'list_tasks', env: 'HEART_HEALTH_RAW_TOOL_LIST_TASKS' },
  rawReviewStatusTool: { fallback: 'get_review_status', env: 'HEART_HEALTH_RAW_TOOL_REVIEW_STATUS' },
  rawSubmitReviewTool: { fallback: 'submit_review', env: 'HEART_HEALTH_RAW_TOOL_SUBMIT_REVIEW' },
}

function envBool(value: string | undefined, fallback: boolean, label: string): boolean {
  if (value === undefined || value.trim() === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  throw new Error(`heart-health-dsh-suite 配置错误：${label} 只接受 true/false，收到 "${value}"`)
}

function envInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`heart-health-dsh-suite 配置错误：${label} 必须是 ${min}..${max} 的整数，收到 "${value}"`)
  }
  return parsed
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`heart-health-dsh-suite 配置错误：${label} 不能为空`)
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`heart-health-dsh-suite 配置错误：${label} 只允许 [A-Za-z0-9_-]，收到 "${value}"`)
  }
  return value
}

/** 从 row config（可能部分缺省）与环境变量合并出最终配置，出错即抛。 */
export function resolveSuiteConfig(
  rowConfig: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): HeartSuiteConfig {
  const row = rowConfig ?? {}
  const readRowString = (key: string): string | undefined => {
    const value = row[key]
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }

  const serverName = requireNonEmpty(
    readRowString('serverName')
      ?? env.HEART_HEALTH_MCP_SERVER_NAME
      ?? DEFAULT_SERVER_NAME,
    'serverName',
  )

  const maxVisibleEcgPredictionsRaw =
    row.maxVisibleEcgPredictions !== undefined ? String(row.maxVisibleEcgPredictions) : undefined
  const keepPatientInfoRaw = row.keepPatientInfo !== undefined ? String(row.keepPatientInfo) : undefined
  const reviewReminderRaw = row.reviewReminder !== undefined ? String(row.reviewReminder) : undefined

  const rawTools = {} as Record<RawToolKey, string>
  for (const key of RAW_TOOL_KEYS) {
    const { fallback, env: envKey } = RAW_TOOL_DEFAULTS[key]
    rawTools[key] = requireNonEmpty(readRowString(key) ?? env[envKey] ?? fallback, key)
  }

  const config: HeartSuiteConfig = {
    serverName,
    ...rawTools,
    keepPatientInfo: envBool(keepPatientInfoRaw ?? env.HEART_HEALTH_KEEP_PATIENT_INFO, true, 'keepPatientInfo'),
    maxVisibleEcgPredictions: envInt(maxVisibleEcgPredictionsRaw ?? env.HEART_HEALTH_MAX_VISIBLE_ECG_PREDICTIONS, 8, 1, 50, 'maxVisibleEcgPredictions'),
    reviewReminder: envBool(reviewReminderRaw ?? env.HEART_HEALTH_REVIEW_REMINDER, true, 'reviewReminder'),
  }
  validate(config)
  return config
}

/** 纯校验入口：对象形态的配置（如测试）直接调用。 */
export function validate(config: HeartSuiteConfig): void {
  requireNonEmpty(config.serverName, 'serverName')
  for (const key of RAW_TOOL_KEYS) {
    requireNonEmpty(config[key], key)
  }
  if (!Number.isInteger(config.maxVisibleEcgPredictions)
    || config.maxVisibleEcgPredictions < 1
    || config.maxVisibleEcgPredictions > 50) {
    throw new Error('heart-health-dsh-suite 配置错误：maxVisibleEcgPredictions 必须是 1..50 的整数')
  }
}

/** 与 heart-algo-dsh-plugin 中一致的 serverName 校验边界。 */
export function assertValidServerName(serverName: string): void {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
    throw new Error(`heart-health-dsh-suite 配置错误：serverName 必须匹配 [A-Za-z0-9_-]{1,32}，收到 "${serverName}"`)
  }
}

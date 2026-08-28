/**
 * 套件配置：所有部署可变项集中在这里解析与校验（PRD 用户故事 32/33）。
 *
 * 配置来源优先级：preset 组合里的显式 row config > 进程环境变量 > 内置默认值。
 * 任何类型错误、超出范围的数值都会在插件加载（首次可解析点）明确失败，
 * 绝不静默回退成一个没有诊断能力的 Agent。
 */

export interface HeartSuiteConfig {
  /** MCP bridge 的 serverName（决定原始工具名前缀 mcp__<serverName>__*）。 */
  readonly serverName: string
  /** 底层三个 MCP 工具的 raw 名称。 */
  readonly rawSubmitTool: string
  readonly rawResultTool: string
  readonly rawViewsTool: string
  /** completed 结果中是否向模型保留 ECG 的 patient_info（age/sex）。 */
  readonly keepPatientInfo: boolean
  /** 模型可见内容中每条 ECG 最多展示的预测条数（Top-K 截断）。 */
  readonly maxVisibleEcgPredictions: number
  /** completed 且需要临床复核时，是否在模型可见内容中保留复核警示。 */
  readonly reviewReminder: boolean
}

export const DEFAULT_SERVER_NAME = 'heart-algo'

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

  const config: HeartSuiteConfig = {
    serverName,
    rawSubmitTool:
      requireNonEmpty(readRowString('rawSubmitTool') ?? env.HEART_HEALTH_RAW_TOOL_SUBMIT ?? 'diagnose_heart_failure', 'rawSubmitTool'),
    rawResultTool:
      requireNonEmpty(readRowString('rawResultTool') ?? env.HEART_HEALTH_RAW_TOOL_RESULT ?? 'get_diagnosis_result', 'rawResultTool'),
    rawViewsTool:
      requireNonEmpty(readRowString('rawViewsTool') ?? env.HEART_HEALTH_RAW_TOOL_VIEWS ?? 'list_supported_views', 'rawViewsTool'),
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
  for (const key of ['rawSubmitTool', 'rawResultTool', 'rawViewsTool'] as const) {
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

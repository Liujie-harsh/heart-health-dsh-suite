/**
 * 包装层统一错误工具。
 *
 * 原则（对应 PRD）：底层 MCP 工具未注册、名称冲突或输出缺少预期字段时，
 * 包装工具必须明确失败，绝不静默降级到自然语言解析；对上层只暴露稳定的
 * 中文错误消息，不透传内部路径、stderr 或凭据。
 */

/** 判断值是否为普通对象（非数组、非 null）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 底层 MCP 契约被破坏时抛出。
 * 例如结果缺少 structuredContent、状态不在三态之内、completed 缺少必备字段等。
 */
export class HeartContractError extends Error {
  readonly kind = 'heart-contract' as const

  constructor(message: string) {
    super(`[heart-health] ${message}`)
    this.name = 'HeartContractError'
  }
}

/**
 * 输入参数在 schema 校验之外仍不合法时抛出
 * （如把 URL、本地路径当作 case_id/asset_id 传入）。
 */
export class HeartInputError extends Error {
  readonly kind = 'heart-input' as const

  constructor(message: string) {
    super(message)
    this.name = 'HeartInputError'
  }
}

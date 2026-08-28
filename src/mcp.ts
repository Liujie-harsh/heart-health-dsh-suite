/**
 * 受控嵌套调用通道：包装工具访问底层 MCP 工具的唯一途径。
 *
 * 设计要点（对应 handoff 约束）：
 * - 通过公开的 ctx.tools.execute() 走完整管线，并携带 parent execution token 与
 *   AbortSignal，使上游取消可以传播；
 * - 不传递 agent：底层 MCP 工具注册在 host/profile 全局层，而可见性掩码
 *   （tools.restrict）施加在 preset 层。省略 agent 的全局视图解析不受该掩码影响，
 *   这就是"不受 agent 可见性掩码影响的受控内部调用路径"；
 * - 只从 canonical value 的 structuredContent 字段读取上游结构，绝不解析渲染文本。
 */

import { CallId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'

/** 底层 MCP 桥的 canonical 成功值形状（mcp-client McpResult）。 */
interface McpValue {
  readonly content?: unknown
  readonly structuredContent?: unknown
}

export function isToolFailure(result: ToolExecutionResult): boolean {
  return result.isError === true
}

/** 与 Code Mode 一致的子调用 CallId 命名：<父callId>:heart:<n>。 */
export function childCallId(exec: ToolRunContext, n: number): ReturnType<typeof CallId> {
  return CallId(`${String(exec.callId)}:heart:${n}`)
}

/**
 * 调用一个底层 MCP 工具并提取 structuredContent。
 * 任何协议级失败（isError、缺 value、缺 structuredContent）都以 Error 抛出。
 */
export async function callUnderlyingStructured(
  hostCtx: Context,
  exec: ToolRunContext,
  rawToolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await hostCtx.tools.execute({
    callId: childCallId(exec, 1),
    rootCallId: exec.rootCallId,
    name: rawToolName,
    arguments: args,
    // 刻意不传 agent：见模块头注释。
    parent: exec.token,
    signal: exec.signal,
  })
  if (result.isError) {
    const message = result.error?.message
    const detail = typeof message === 'string' && message.trim() !== '' ? message : '未知错误'
    throw new Error(`底层 MCP 工具 ${rawToolName} 失败：${detail}`)
  }
  const value = result.value as McpValue | null
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`底层 MCP 工具 ${rawToolName} 返回的 canonical value 不是对象`)
  }
  if (!('structuredContent' in value) || value['structuredContent'] === undefined) {
    throw new Error(`底层 MCP 工具 ${rawToolName} 未返回 structuredContent，拒绝降级解析文本`)
  }
  return value['structuredContent']
}

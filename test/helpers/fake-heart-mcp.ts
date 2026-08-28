/**
 * 可编程的假底层 MCP：在 host 全局层注册 mcp__heart-algo__* 三个工具，
 * 按 FIFO 返回脚本化的 canonical 值（与真实 dsh-mcp-client 的 McpResult 形状一致：
 * `{ content: JsonValue[], structuredContent? }`；失败以抛错表达，对应 MCP isError）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

export const FAKE_RAW_NAMES = {
  submit: 'mcp__heart-algo__diagnose_heart_failure',
  result: 'mcp__heart-algo__get_diagnosis_result',
  views: 'mcp__heart-algo__list_supported_views',
} as const

export interface ScriptedOutcome {
  /** 底层成功时的 structuredContent。 */
  readonly structured?: unknown
  /** 抛出错误（对应 MCP isError 路径）。 */
  readonly errorText?: string
  /** 模拟延迟；期间外部信号中止则协作式失败。 */
  readonly delayMs?: number
}

export interface UnderlyingCall {
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
  readonly abortedAtEntry: boolean
}

export interface FakeHeartMcp {
  push(tool: string, outcome: ScriptedOutcome): void
  /** 模拟 MCP 重同步后新增一个原始心脏工具（可见性动态覆盖用例）。 */
  registerExtraRawTool(name: string): void
  calls(): readonly UnderlyingCall[]
  registeredNames(): string[]
  dispose(): void
}

const UNRESTRICTED_OUTPUT = {} as Record<string, unknown>
const OPEN_OBJECT_PARAMETERS = { type: 'object', additionalProperties: true } as const

function sleepWithAbort(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(finish, ms)
    function finish(): void {
      signal.removeEventListener('abort', finish)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

export function createFakeHeartMcp(ctx: Context): FakeHeartMcp {
  const callLog: UnderlyingCall[] = []
  const queues = new Map<string, ScriptedOutcome[]>()
  const disposers: (() => void)[] = []
  const registered = new Set<string>(Object.values(FAKE_RAW_NAMES))

  const install = (toolName: string): void => {
    const definition: ToolDefinition = {
      name: toolName,
      description: `fake underlying ${toolName}`,
      parameters: OPEN_OBJECT_PARAMETERS,
      output: {
        schema: UNRESTRICTED_OUTPUT,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec: ToolRunContext) {
        callLog.push({
          tool: toolName,
          args: args as Readonly<Record<string, unknown>>,
          abortedAtEntry: exec.signal.aborted,
        })
        const queue = queues.get(toolName)
        const outcome = queue?.shift()
        if (outcome === undefined) {
          throw new Error(`fake heart MCP: 未为 ${toolName} 编排结果`)
        }
        if (outcome.delayMs !== undefined && outcome.delayMs > 0) {
          await sleepWithAbort(exec.signal, outcome.delayMs)
          if (exec.signal.aborted) throw new Error('fake heart MCP: 调用已取消')
        }
        if (outcome.errorText !== undefined) throw new Error(outcome.errorText)
        return {
          content: [{ type: 'text', text: `fake:${toolName}` }],
          structuredContent: outcome.structured,
        }
      },
    }
    disposers.push(ctx.tools.register(definition))
    registered.add(toolName)
  }

  for (const name of Object.values(FAKE_RAW_NAMES)) install(name)

  return {
    push(tool, outcome) {
      // 允许测试用短别名（'submit'/'result'/'views'）编排。
      const key = (FAKE_RAW_NAMES as Record<string, string>)[tool] ?? tool
      const list = queues.get(key) ?? []
      list.push(outcome)
      queues.set(key, list)
    },
    registerExtraRawTool(name) {
      install(name)
    },
    calls() {
      return [...callLog]
    },
    registeredNames() {
      return [...registered].sort()
    },
    dispose() {
      for (const disposer of disposers.splice(0)) disposer()
    },
  }
}

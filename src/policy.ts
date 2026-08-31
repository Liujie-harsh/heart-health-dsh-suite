/**
 * heart-health 安全 policy（preset 层生效，不影响同进程其他 preset / 非心脏工具）：
 *
 * 1. 执行前：拒绝模型直接调用 mcp__<server>__* 原始工具。
 *    模型发起的调用没有 parent token；包装工具的受控嵌套调用携带 parent，
 *    据此区分两种来源。guard 是单调的：任何后置监听都不能把拒绝翻回允许。
 * 2. 可见性：用 ctx.tools.restrict({deny}) 把继承自全局层的原始心脏 MCP 工具
 *    从本 preset 所有会话的可见集中移除（schemas 与解析同时消失）。
 *    掩码随 tools/change 重算，MCP 断线重连、新增或注销工具时保持覆盖；
 *    底层三个工具始终未出现则明确失败（不静默启动没有诊断能力的 Agent）。
 * 3. 执行后：对 heart_* 包装工具结果的内容块做纵深净化（防线二），
 *    兜底清除路径/Token/stderr 等泄露签名。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { resolveSuiteConfig } from './config.js'
import type { HeartSuiteConfig } from './config.js'
import { redactString } from './privacy.js'

export const name = 'heart-health-policy'

/** deny 掩码安装的重试参数（用于与 MCP bridge 异步发现竞态）；测试可收紧。 */
let restrictRetryAttempts = 40
let restrictRetryDelayMs = 250

/** 测试接缝：缩短等待窗口，避免用例拖慢。 */
export function configureRestrictRetryForTests(attempts: number, delayMs: number): void {
  restrictRetryAttempts = attempts
  restrictRetryDelayMs = delayMs
}

export function policyUnderlyingPrefix(serverName: string): string {
  return `mcp__${serverName}__`
}

/**
 * 守卫拒绝文案：给出替代路径（包装工具名），满足 PRD 的可操作错误要求。
 */
export function directCallDenialReason(config: HeartSuiteConfig): string {
  return (
    `安全策略禁止直接调用 ${policyUnderlyingPrefix(config.serverName)}* 原始工具；`
    + '请改用 heart_ 前缀包装工具（heart_submit_diagnosis / heart_get_diagnosis_result / '
    + 'heart_list_supported_views / heart_analyze_case_files / heart_interpret_diagnosis / '
    + 'heart_generate_report / heart_compare_diagnoses / heart_list_cases / heart_get_case_detail / '
    + 'heart_list_tasks / heart_get_review_status / heart_submit_review）。'
  )
}

function underlyingNames(config: HeartSuiteConfig): string[] {
  return [
    `mcp__${config.serverName}__${config.rawSubmitTool}`,
    `mcp__${config.serverName}__${config.rawResultTool}`,
    `mcp__${config.serverName}__${config.rawViewsTool}`,
  ]
}

/** 当前全局层中应被 deny 的名字（配置的三个 + 一切前缀匹配者，排除保留传输）。 */
export function computePolicyDenyNames(
  globalNames: readonly string[],
  config: HeartSuiteConfig,
): string[] {
  const prefix = policyUnderlyingPrefix(config.serverName)
  const names = new Set<string>(underlyingNames(config))
  for (const candidate of globalNames) {
    if (candidate.startsWith(prefix)) names.add(candidate)
  }
  names.delete('run_code')
  return [...names].sort()
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export async function apply(ctx: Context, rowConfig?: Record<string, unknown>): Promise<void> {
  const config = resolveSuiteConfig(rowConfig)

  // ── 1. 执行前守卫：仅拦模型直呼（无 parent）────────────────────────────
  ctx.effect(() => ctx.tools.guard((execution: Readonly<ToolExecution>) => {
    if (execution.parent !== undefined) return undefined
    if (!execution.name.startsWith(policyUnderlyingPrefix(config.serverName))) return undefined
    return directCallDenialReason(config)
  }))

  // ── 2. 可见性掩码：deny 继承的心脏 MCP 工具，随注册表变化重算 ───────────
  let activeMaskDisposer: (() => void) | undefined
  let applying = false

  const installMask = (): void => {
    if (applying) return
    applying = true
    try {
      const globalNames = ctx.tools.schemas().map(schema => schema.name)
      const deny = computePolicyDenyNames(globalNames, config)
      const previous = activeMaskDisposer
      activeMaskDisposer = undefined
      previous?.()
      activeMaskDisposer = ctx.tools.restrict({ deny })
    } finally {
      applying = false
    }
  }

  const namesKnown = (): boolean => {
    const visible = new Set(ctx.tools.schemas().map(schema => schema.name))
    return underlyingNames(config).every(candidate => visible.has(candidate))
  }

  let changeHandler: (() => void) | undefined
  ctx.effect(() => () => {
    changeHandler?.()
    changeHandler = undefined
    activeMaskDisposer?.()
    activeMaskDisposer = undefined
  })

  if (namesKnown()) {
    installMask()
    changeHandler = ctx.on('tools/change', () => {
      try {
        installMask()
      } catch {
        // 注册表瞬变（例如整代重同步中）导致的失败留给下一次 tools/change 修正。
      }
    })
  } else {
    // 竞态窗口：MCP bridge 尚未完成发现。有限次等待后仍不可见即明确失败。
    let installed = false
    for (let attempt = 0; attempt < restrictRetryAttempts; attempt += 1) {
      await sleep(restrictRetryDelayMs)
      if (namesKnown()) {
        installMask()
        installed = true
        break
      }
    }
    if (!installed) {
      throw new Error(
        'heart-health-dsh-suite 配置错误：底层 MCP 工具 '
          + `${underlyingNames(config).join(', ')} 未在等待窗口内注册。`
          + ' 请确认 heart-algo-dsh-plugin 已安装在 profile 全局层、服务已启动且 serverName 匹配。',
      )
    }
    changeHandler = ctx.on('tools/change', () => {
      try {
        installMask()
      } catch {
        // 同上：交给下一次变更事件。
      }
    })
  }

  // ── 3. 执行后纵深净化：heart_* 结果内容兜底脱敏 ─────────────────────────
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (!exec.name.startsWith('heart_')) return downstream
    if (downstream.kind === 'accept' && downstream.value !== undefined) {
      // value 替换路径服务于程序化消费者，内容由定义自身渲染，这里不动。
      return downstream
    }
    if (downstream.kind === 'block') {
      const sanitized = sanitizeBlocks(downstream.feedback)
      if (sanitized === null) return downstream
      return { ...downstream, feedback: sanitized }
    }
    const original = downstream.content ?? result.content
    const sanitized = sanitizeBlocks(original)
    if (sanitized === null) return downstream
    return { ...downstream, content: sanitized }
  })
}

/**
 * 净化内容块；未发生变化时返回 null 以便调用方原样透传（决策对象保持身份稳定）。
 */
export function sanitizeBlocks(blocks: readonly ContentBlock[]): ContentBlock[] | null {
  let changed = false
  const out: ContentBlock[] = blocks.map((block): ContentBlock => {
    if (block.type !== 'text') return block
    const redacted = redactString(block.text)
    if (redacted !== block.text) {
      changed = true
      return { type: 'text', text: redacted }
    }
    return block
  })
  return changed ? out : null
}

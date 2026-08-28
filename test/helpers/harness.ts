/**
 * 真实 Loader 组合测试的宿主环境：
 * - 创建一个带 node_modules/@deepseek-ai/* 目录连接（junction）的临时 base 目录，
 *   使组合行的裸包名（@deepseek-ai/dsh-persona、runtime 内的 @deepseek-ai/dsh-llm）
 *   按生产同款 Node ESM 规则解析——Loader 对裸名使用 `loader.internal.import`，
 *   完全绕开 vitest 别名，这是发布配置可被真实加载的最有力证据；
 * - 按 packages/preset/agent-presets/tests/mount.spec.ts 的同一形状装配
 *   Llm/Session/SystemPrompt/Tools/Agents/Loop/Presets 服务栈。
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AgentRegistry, { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import type { Config as PresetsConfig } from '@deepseek-ai/dsh-agent-presets'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

// 本文件位于 test/helpers/ 下：上两级即 suite 根。
const HELPER_DIR = dirname(fileURLToPath(import.meta.url))
export const SUITE_ROOT = resolve(HELPER_DIR, '..', '..')
/** preset 发现根：suite 的 presets/ 目录本身就是一个 root。 */
export const PRESETS_ROOT = join(SUITE_ROOT, 'presets')
const DSH_ROOT = resolve(process.env.DSH_CHECKOUT ?? 'D:/project/dsh/deepseek-harness')

/** scoped 裸名（@deepseek-ai/*）→ Harness checkout 内的包目录。 */
const HOST_BASE_JUNCTIONS: Record<string, string> = {
  cordis: join(DSH_ROOT, 'vendor', 'cordis'),
  'dsh-home-paths': join(DSH_ROOT, 'packages', 'util', 'home-paths'),
  'dsh-llm': join(DSH_ROOT, 'packages', 'llm', 'llm'),
  'dsh-persona': join(DSH_ROOT, 'packages', 'preset', 'persona'),
  'dsh-system-prompt': join(DSH_ROOT, 'packages', 'core', 'system-prompt'),
  'dsh-tools': join(DSH_ROOT, 'packages', 'core', 'tools'),
}

/** 无 scope 的裸名（本套件自身）→ suite 根目录（模拟 dsh plugin add 安装后的位置）。 */
const HOST_BASE_FLAT_JUNCTIONS: Record<string, string> = {
  'heart-health-dsh-suite': SUITE_ROOT,
}

/**
 * 生产中套件被安装进某个 node_modules 树，内部裸导入（@deepseek-ai/dsh-llm 等）
 * 通过目录向上解析命中同层的兄弟包。测试环境里 suite 直接位于仓库源码处，
 * 因此在 suite 本地补一组与安装布局一致的 junction（幂等，不影响打包）。
 */
function ensureSuiteLocalPeerJunctions(): void {
  const localScope = join(SUITE_ROOT, 'node_modules', '@deepseek-ai')
  mkdirSync(localScope, { recursive: true })
  for (const [name, target] of Object.entries(HOST_BASE_JUNCTIONS)) {
    const link = join(localScope, name)
    try {
      if (!existsSync(link)) symlinkSync(target, link, 'junction')
    } catch {
      // 并发创建时的 EEXIST/EPERM 竞态无害：连接已存在即满足需求。
      if (!existsSync(link)) throw new Error(`无法创建 junction ${link} -> ${target}`)
    }
  }
}

let counter = 0

/**
 * 建一个带 junction 的 base 目录并返回其路径；用 removeHostBaseFixture 清理。
 */
export function createHostBaseFixture(): string {
  ensureSuiteLocalPeerJunctions()
  counter += 1
  const base = join(tmpdir(), `heart-suite-host-${process.pid}-${Date.now()}-${counter}`)
  const scopeDir = join(base, 'node_modules', '@deepseek-ai')
  mkdirSync(scopeDir, { recursive: true })
  for (const [name, target] of Object.entries(HOST_BASE_JUNCTIONS)) {
    symlinkSync(target, join(scopeDir, name), 'junction')
  }
  for (const [name, target] of Object.entries(HOST_BASE_FLAT_JUNCTIONS)) {
    symlinkSync(target, join(base, 'node_modules', name), 'junction')
  }
  return base
}

export function removeHostBaseFixture(base: string): void {
  rmSync(base, { recursive: true, force: true })
}

export interface BootedHarness {
  readonly ctx: Context
  /** 当前挂载的 base 目录（native 裸名解析的锚点）。 */
  readonly hostBase: string
}

/**
 * 启动真实服务栈（不加载 bundle patch、不做 IO 假设）。
 * preset 组合行通过 roots 指向 suite 发布物目录（trust system）。
 */
export async function bootHarness(options?: {
  presetsRoot?: string
}): Promise<BootedHarness> {
  const hostBase = createHostBaseFixture()
  const presetsRoot = options?.presetsRoot ?? PRESETS_ROOT
  const roster: PresetsConfig = {
    default: 'heart-health',
    roots: [{ path: presetsRoot, trust: 'system' }],
    includeUserRoot: false,
  }
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(hostBase).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, roster)
  return { ctx, hostBase }
}

/** 用生产同款 setup 钩子把一个会话挂到指定 preset 上。 */
export async function agentOn(ctx: Context, id: string, presetId = 'heart-health'): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, presetId),
  })
  return handle.agent
}

export const toolNames = (ctx: Context, agent?: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name).sort()

export { assembleContextFor }

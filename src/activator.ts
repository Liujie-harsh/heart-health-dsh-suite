/**
 * heart-health-dsh-suite 的宿主激活插件（bundle 唯一的 host 平面 row）。
 *
 * 职责：把包内携带的 heart-health preset 组合（agent.cordis.yml、preset.yml、
 * runtime/*.js）幂等地落地到用户 preset 根 `<DSH_HOME>/.agent-presets/heart-health/`。
 * 用户根是 launcher 场景下唯一不会被 `composeProfile` 的 roots 覆盖抹掉的发现位置。
 *
 * - 内容一致（字节相同）时不动文件，避免无谓地打断会话的 standing 组合代际；
 * - 版本升级或内容变化时整体覆盖，使下一次挂载生效；
 * - 本插件不发布任何服务，不注册任何工具：领域能力全部由 preset 组合的行提供；
 * - 本文件运行在 host 组成内，peer 包按宿主依赖图正常解析。
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

export const name = 'heart-health-activator'

export const PRESET_ID = 'heart-health'
export const COMPOSITION_FILE = 'agent.cordis.yml'
export const METADATA_FILE = 'preset.yml'

/** 从模块位置推导包目录（lib/index.js 的上一级）。 */
export function packageRoot(moduleUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..')
}

interface PendingFile {
  readonly relative: string
  readonly bytes: Buffer
}

function collectPresetFiles(root: string): PendingFile[] {
  const presetDir = join(root, 'presets', PRESET_ID)
  const files: PendingFile[] = []
  const walk = (dir: string, relativeBase: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      const relative = relativeBase === '' ? entry.name : `${relativeBase}/${entry.name}`
      if (entry.isDirectory()) {
        walk(absolute, relative)
        continue
      }
      files.push({ relative, bytes: readFileSync(absolute) })
    }
  }
  walk(presetDir, '')
  return files
}

function writeFileIfChanged(target: string, bytes: Buffer): boolean {
  try {
    if (readFileSync(target).equals(bytes)) return false
  } catch {
    // 首次写入：目标不存在。
  }
  writeFileSync(target, bytes)
  return true
}

/**
 * 幂等落地 preset 目录；返回发生变化的相对路径列表（测试用）。
 */
export function materializePreset(
  targetDir: string,
  sourceFiles: readonly PendingFile[],
): string[] {
  const changed: string[] = []
  for (const file of sourceFiles) {
    const target = join(targetDir, ...file.relative.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    if (writeFileIfChanged(target, file.bytes)) changed.push(file.relative)
  }
  return changed
}

/** 发布物完整性校验：组合与显示元数据缺一不可。 */
export function assertCompletePreset(files: readonly { readonly relative: string }[]): void {
  if (!files.some(file => file.relative === COMPOSITION_FILE)) {
    throw new Error('heart-health-dsh-suite 发布物缺少 presets/heart-health/agent.cordis.yml')
  }
  if (!files.some(file => file.relative === METADATA_FILE)) {
    throw new Error('heart-health-dsh-suite 发布物缺少 presets/heart-health/preset.yml')
  }
}

export function apply(ctx: Context): void {
  const root = packageRoot()
  const files = collectPresetFiles(root)
  assertCompletePreset(files)
  const targetDir = dshHomePath('.agent-presets', PRESET_ID)
  mkdirSync(targetDir, { recursive: true })
  materializePreset(targetDir, files)
  ctx.logger?.info?.(`heart-health preset installed at ${targetDir}`)
}

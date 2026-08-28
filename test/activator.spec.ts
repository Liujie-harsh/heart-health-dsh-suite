/**
 * 激活器单元测试：发布物落地的幂等性与完整性校验。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertCompletePreset,
  COMPOSITION_FILE,
  materializePreset,
  METADATA_FILE,
  packageRoot,
  PRESET_ID,
} from '../lib/index.js'

let target: string

beforeEach(() => {
  target = mkdtempSync(join(tmpdir(), 'heart-suite-activator-'))
})

afterEach(() => {
  rmSync(target, { recursive: true, force: true })
})

function shippedFiles(): { relative: string; bytes: Buffer }[] {
  const source = join(packageRoot(), 'presets', PRESET_ID)
  return ['agent.cordis.yml', 'preset.yml']
    .map(relative => ({
      relative,
      bytes: readFileSync(join(source, ...relative.split('/'))),
    }))
}

describe('heart-health activator', () => {
  it('derives the package root from the module location', () => {
    expect(packageRoot().endsWith('heart-health-dsh-suite')).toBe(true)
    // 纯函数：任意模块 URL 都能按同一规则回溯（Windows 盘符 URL 形态）。
    expect(packageRoot('file:///D:/pkg/lib/index.js')).toBe('D:\\pkg')
  })

  it('materializes files under the given directory idempotently', () => {
    const files = shippedFiles()

    const firstPass = materializePreset(target, files)
    expect(firstPass).toEqual(expect.arrayContaining(files.map(f => f.relative)))

    const secondPass = materializePreset(target, files)
    expect(secondPass).toEqual([])

    const copied = readFileSync(join(target, COMPOSITION_FILE))
    expect(copied.equals(readFileSync(join(packageRoot(), 'presets', PRESET_ID, COMPOSITION_FILE)))).toBe(true)
    expect(readFileSync(join(target, METADATA_FILE)).length).toBeGreaterThan(0)
  })

  it('refuses incomplete shipments loudly', () => {
    expect(() => assertCompletePreset([])).toThrow('agent.cordis.yml')
    expect(() => assertCompletePreset([{ relative: COMPOSITION_FILE }])).toThrow('preset.yml')
    expect(() => assertCompletePreset([
      { relative: COMPOSITION_FILE },
      { relative: METADATA_FILE },
    ])).not.toThrow()
    expect(METADATA_FILE).toBe('preset.yml')
  })
})

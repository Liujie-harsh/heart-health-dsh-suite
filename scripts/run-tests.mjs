#!/usr/bin/env node
/**
 * 用 Harness checkout 自带的 vitest 运行本套件测试。
 * 不需要本地安装任何 npm 依赖：测试文件对 @deepseek-ai/* 的导入由
 * vitest.config.mts 的别名直接指向 DSH_CHECKOUT 内已构建的 lib/。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const suiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(process.env.DSH_CHECKOUT ?? 'D:/project/dsh/deepseek-harness')

const vitestEntry = join(dshRoot, 'node_modules', 'vitest', 'vitest.mjs')
if (!existsSync(vitestEntry)) {
  console.error(`[heart-health-dsh-suite] 未找到 vitest：${vitestEntry}`)
  process.exit(1)
}

const args = ['run', '--config', join(suiteRoot, 'vitest.config.mts'), ...process.argv.slice(2)]
const result = spawnSync(process.execPath, [vitestEntry, ...args], {
  stdio: 'inherit',
  cwd: suiteRoot,
  env: { ...process.env, DSH_CHECKOUT: dshRoot },
})
process.exit(result.status ?? 1)

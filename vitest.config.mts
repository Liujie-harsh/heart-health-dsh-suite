import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 测试配置（零安装）：
 * - 不从 'vitest/config' 导入（本目录没有安装依赖）；vitest 接受普通对象配置；
 * - 测试直接导入的少量 Harness 包通过别名指向其「已构建的 lib/index.js」，
 *   与发布物运行时形态一致；这些包自身内部的依赖由其所在目录向上解析到
 *   Harness 工作区的 node_modules，无需安装任何东西。
 */

const dshRoot = resolve(process.env.DSH_CHECKOUT ?? 'D:/project/dsh/deepseek-harness')

/** suite 直接导入的 Harness 包 -> checkout 内包目录。 */
const IMPORTED_PACKAGES = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/cordis-plugin-loader': 'vendor/loader',
  '@deepseek-ai/cordis-plugin-include': 'vendor/include',
  '@deepseek-ai/dsh-agent': 'packages/core/agent',
  '@deepseek-ai/dsh-agent-loop': 'packages/core/agent-loop',
  '@deepseek-ai/dsh-agent-presets': 'packages/preset/agent-presets',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-home-paths': 'packages/util/home-paths',
  '@deepseek-ai/dsh-persona': 'packages/preset/persona',
  '@deepseek-ai/dsh-session': 'packages/core/session',
  '@deepseek-ai/dsh-scope': 'packages/core/scope',
  '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
}

const alias = []
for (const [name, rel] of Object.entries(IMPORTED_PACKAGES)) {
  const pkgDir = join(dshRoot, rel)
  const pkgJsonPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgJsonPath)) continue
  const manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  const main = manifest.exports?.['.']?.default ?? manifest.main ?? 'lib/index.js'
  alias.push({ find: name, replacement: join(pkgDir, main) })
}

export default {
  resolve: { alias },
  server: { fs: { allow: [dshRoot] } },
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    reporters: ['default'],
    // 沙箱内禁止 fork 子进程（EPERM）；worker_threads 不受影响。
    pool: 'threads',
    // 多个 spec 文件共享宿主 fixture（suite 本地 node_modules 连接），串行运行避免竞态。
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
}

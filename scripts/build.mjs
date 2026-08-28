#!/usr/bin/env node
/**
 * heart-health-dsh-suite 构建脚本（无网络、零安装依赖）：
 *
 * 1. 用 Harness checkout 自带的 tsc 把 src/*.ts 编译到 lib/（严格模式，NodeNext ESM）；
 * 2. 组装发布物 presets/heart-health/runtime/：拷贝 lib 里除激活入口以外的所有 .js，
 *    并写入 {"type":"module"}，使组合行 `./runtime/tools.js` 在任何目录上下文都是合法 ESM；
 * 3. 依赖注入路径：peer 包（@deepseek-ai/*）通过 DSH_CHECKOUT 环境变量指向的
 *    DeepSeek Harness 源码 checkout 解析类型与运行时（默认 D:\project\dsh\deepseek-harness）。
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const suiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(process.env.DSH_CHECKOUT ?? 'D:/project/dsh/deepseek-harness')

/** suite 的 peer 包 -> Harness checkout 内的包目录。 */
const PEER_PACKAGES = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/dsh-home-paths': 'packages/util/home-paths',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
}

function assertCheckout() {
  const marker = join(dshRoot, 'package.json')
  if (!existsSync(marker)) {
    console.error(`[heart-health-dsh-suite] 找不到 DeepSeek Harness checkout：${dshRoot}`)
    console.error('请设置 DSH_CHECKOUT 指向包含 packages/ 与 node_modules/ 的源码目录。')
    process.exit(1)
  }
}

function generateTsConfig() {
  const paths = {}
  for (const [name, rel] of Object.entries(PEER_PACKAGES)) {
    const target = join(dshRoot, rel).replace(/\\/g, '/')
    if (!existsSync(join(dshRoot, rel, 'package.json'))) {
      console.error(`[heart-health-dsh-suite] peer 包缺失：${target}`)
      process.exit(1)
    }
    // 映射到各包发布的类型入口文件（lib/types/index.d.ts），绕开 exports 解析差异。
    paths[name] = [join(target, 'lib', 'types', 'index.d.ts').replace(/\\/g, '/')]
  }
  const base = JSON.parse(readFileSync(join(suiteRoot, 'tsconfig.base.json'), 'utf8'))
  const config = {
    compilerOptions: {
      ...base.compilerOptions,
      // TS 6 弃用 baseUrl：这里的 paths 全是绝对路径，无需 baseUrl。
      outDir: 'lib',
      rootDir: 'src',
      types: ['node'],
      typeRoots: [join(dshRoot, 'node_modules', '@types').replace(/\\/g, '/')],
      paths,
    },
    include: ['src/**/*.ts'],
  }
  const generated = join(suiteRoot, '.generated.tsconfig.json')
  writeFileSync(generated, `${JSON.stringify(config, null, 2)}\n`)
  return generated
}

function runTsc(tsconfig) {
  const tsc = join(dshRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tsc)) {
    console.error(`[heart-health-dsh-suite] 未找到 tsc：${tsc}`)
    process.exit(1)
  }
  const result = spawnSync(process.execPath, [tsc, '-p', tsconfig], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error('[heart-health-dsh-suite] TypeScript 编译失败')
    process.exit(result.status ?? 1)
  }
}

function assembleRuntime() {
  const libDir = join(suiteRoot, 'lib')
  if (!existsSync(join(libDir, 'tools.js')) || !existsSync(join(libDir, 'policy.js'))) {
    console.error('[heart-health-dsh-suite] 编译产物缺少 tools.js/policy.js')
    process.exit(1)
  }
  // 运行时不做目录拷贝：preset 组合行通过包名子路径（heart-health-dsh-suite/tools 等）
  // 从宿主基座解析，代码始终跟随安装的包（与 @deepseek-ai/dsh-persona 同机制）。
  const staleRuntime = join(suiteRoot, 'presets', 'heart-health', 'runtime')
  rmSync(staleRuntime, { recursive: true, force: true })
}

function readdirJs(dir) {
  return readdirSync(dir).filter(name => name.endsWith('.js'))
}

assertCheckout()
const tsconfig = generateTsConfig()
runTsc(tsconfig)
assembleRuntime()

const emitted = readdirJs(join(suiteRoot, 'lib'))
console.log(`[heart-health-dsh-suite] build OK: ${emitted.length} js modules in lib/`)

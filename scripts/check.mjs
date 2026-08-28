/**
 * 发布前自检（不依赖任何安装）：
 * 1) 清单完整性：package.json / cordis.patch.yml / preset 两个 yaml 均存在；
 * 2) lib/ 已构建且 tools.js、policy.js 在其中；
 * 3) 组合行引用的包名子路径与 package.json exports 一致；
 * 4) 没有硬编码的共享密钥；环境变量旋钮拼写正确（HEART_HEALTH_*）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0

function check(ok, message) {
  if (!ok) {
    failures += 1
    console.error(`  ✗ ${message}`)
  } else {
    console.log(`  ✓ ${message}`)
  }
}

console.log('[heart-health-dsh-suite] manifest check')

const requiredFiles = [
  'package.json',
  'cordis.patch.yml',
  join('presets', 'heart-health', 'agent.cordis.yml'),
  join('presets', 'heart-health', 'preset.yml'),
]
for (const relative of requiredFiles) {
  check(existsSync(join(root, relative)), `发布物存在：${relative}`)
}

check(
  existsSync(join(root, 'lib', 'tools.js')) && existsSync(join(root, 'lib', 'policy.js')),
  'lib/ 已构建（tools.js 与 policy.js 就位）；请先运行 npm run build',
)

// ── exports 与组合行一致 ────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check(pkg?.exports?.['./tools'] === './lib/tools.js', 'exports["./tools"] 指向 ./lib/tools.js')
check(pkg?.exports?.['./policy'] === './lib/policy.js', 'exports["./policy"] 指向 ./lib/policy.js')

const composition = readFileSync(join(root, 'presets', 'heart-health', 'agent.cordis.yml'), 'utf8')
check(
  composition.includes('heart-health-dsh-suite/tools'),
  '组合行通过 heart-health-dsh-suite/tools 解析运行时（宿主基座解析）',
)
check(
  composition.includes('heart-health-dsh-suite/policy'),
  '组合行引用策略插件 heart-health-dsh-suite/policy',
)
check(!composition.includes('./runtime/'), '组合行不再引用已废弃的 ./runtime/ 相对路径')

// ── 秘密卫生与旋钮拼写（扫描发布物 + 源码配置） ─────────────────────────────
const scanFiles = [
  ...requiredFiles,
  join('src', 'config.ts'),
].map(relative => join(root, relative)).filter(existsSync)

const secretPattern = /(sk-[A-Za-z0-9]{16,}|BEGIN (RSA )?PRIVATE KEY|AKIA[0-9A-Z]{16})/
let secretsFound = false
for (const file of scanFiles) {
  if (secretPattern.test(readFileSync(file, 'utf8'))) {
    secretsFound = true
    console.error(`  ✗ 疑似硬编码密钥：${file}`)
  }
}
if (!secretsFound) console.log('  ✓ 未发现硬编码密钥样式')

const knobsSeen = new Set()
for (const file of scanFiles) {
  for (const match of readFileSync(file, 'utf8').matchAll(/HEART_HEALTH_[A-Z_]+/g)) {
    knobsSeen.add(match[0])
  }
}
const expectedKnobs = [
  'HEART_HEALTH_MCP_SERVER_NAME',
  'HEART_HEALTH_RAW_TOOL_SUBMIT',
  'HEART_HEALTH_RAW_TOOL_RESULT',
  'HEART_HEALTH_RAW_TOOL_VIEWS',
  'HEART_HEALTH_KEEP_PATIENT_INFO',
  'HEART_HEALTH_MAX_VISIBLE_ECG_PREDICTIONS',
  'HEART_HEALTH_REVIEW_REMINDER',
]
for (const knob of expectedKnobs) {
  check(knobsSeen.has(knob), `环境旋钮被引用：${knob}`)
}

if (failures > 0) {
  console.error(`[heart-health-dsh-suite] check 失败：${failures} 项`)
  process.exit(1)
}
console.log('[heart-health-dsh-suite] check 通过')

/**
 * heart-health-dsh-suite 入口 = 宿主激活插件。
 *
 * preset 领域能力（heart_* 包装工具、guidance、policy）由
 * presets/heart-health/agent.cordis.yml 组合行分别加载 runtime/tools.js 与
 * runtime/policy.js；本入口只负责把该组合幂等安装到用户 preset 根。
 */

export const name = 'heart-health-activator'

export {
  apply,
  assertCompletePreset,
  materializePreset,
  packageRoot,
  PRESET_ID,
  COMPOSITION_FILE,
  METADATA_FILE,
} from './activator.js'

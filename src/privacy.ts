/**
 * 模型可见数据最小化（PRD：禁止暴露文件路径、内部错误、Token 和未批准的扩展字段）。
 *
 * 两层防线：
 * 1. contract.ts 的白名单投影——canonical JSON 只包含显式批准的字段；
 * 2. 这里的通用净化器——对保留下来的结构做纵深检查：任何深度丢弃敏感键，
 *    并把字符串值中疑似路径/Token/stderr 的片段替换为占位符。
 *
 * 净化器必须稳定、纯函数、无环境依赖，保证相同输入产生逐字节相同的输出。
 */

/** 任何深度都会被丢弃的键（小写比较）。 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  // 凭据类
  'token', 'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
  'authorization', 'secret', 'password', 'passwd', 'api_key', 'apikey',
  'cookie', 'set-cookie', 'sessionid', 'session_id', 'credentials',
  // 内部细节类
  'stderr', 'stdout', 'stacktrace', 'stack_trace', 'traceback', 'traceback_text',
  'internal_path', 'internalpath', 'abs_path', 'abspath',
  // 原始文件路径类（契约字段是 dcm_id/ecg_id，不会出现 path 键）
  'path', 'filepath', 'file_path', 'dcm_path', 'dcmpath', 'ecg_path', 'ecgpath',
  'img_path', 'imgpath', 'image_path', 'workdir', 'cwd',
  // 未批准的患者标识类
  'patient_id', 'patientid', 'patient_name', 'patientname',
  'id_card', 'idcard', 'idnumber', 'id_number',
  'phone', 'mobile', 'telephone', 'ssn', 'email', 'home_address', 'address',
])

interface LeakRule {
  readonly name: string
  readonly pattern: RegExp
  /** 自定义替换（字符串或替换函数）；缺省统一替换为占位符。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly replacement?: string | ((...args: any[]) => string)
}

const PLACEHOLDER = '<已脱敏>'

/** 字符串值中的泄露签名。 */
const LEAK_RULES: readonly LeakRule[] = [
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi },
  { name: 'windows-path', pattern: /\b[A-Za-z]:\\[^\s"'`<>|*?\u4e00-\u9fff]*/g },
  { name: 'unc-path', pattern: /\\\\[^\s"'`]+/g },
  {
    // POSIX 绝对路径：前缀目录命中常见根，且不得紧跟字母/斜杠（排除 1/2、https:// 等）。
    name: 'unix-path',
    pattern:
      /(?<![\w@./\\])(\/(?:home|root|tmp|var|usr|etc|opt|srv|mnt|media|data|heart-data)\/[^\s"'`\u4e00-\u9fff)\]）]*)/g,
    replacement: PLACEHOLDER,
  },
  { name: 'stderr-marker', pattern: /\bstderr\b\s*[:=][^\n]*/gi, replacement: `stderr=${PLACEHOLDER}` },
  { name: 'env-secret', pattern: /\b(?:HEART_ALGO_MCP_TOKEN|MCP_SHARED_SECRET|DSH_[A-Z_]*TOKEN[A-Z_]*)=\S+/g },
]

/** 对单个字符串应用全部泄露规则，返回脱敏后的文本。 */
export function redactString(text: string): string {
  let result = text
  for (const rule of LEAK_RULES) {
    const replacement = rule.replacement
    if (replacement === undefined) {
      result = result.replace(rule.pattern, PLACEHOLDER)
    } else if (typeof replacement === 'string') {
      result = result.replace(rule.pattern, replacement)
    } else {
      result = result.replace(rule.pattern, replacement)
    }
  }
  return result
}

/**
 * 递归净化任意 JSON 值：
 * - 丢弃 FORBIDDEN_KEYS 命中的对象键；
 * - 字符串值过 redactString；
 * - 数组/对象保持其余结构与顺序不变。
 */
export function scrubValue<T>(value: T): T {
  return scrub(value) as T
}

function scrub(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map(item => scrub(item))
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(source)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue
      out[key] = scrub(item)
    }
    return out
  }
  return value
}

/**
 * ECG patient_info 投影：即使保留也只允许 age/sex，
 * 并额外丢掉一切其它键（patientId 等标识绝不进入模型上下文）。
 */
export function projectPatientInfo(
  info: unknown,
  keepPatientInfo: boolean,
): Record<string, unknown> | null {
  if (!keepPatientInfo || info === null || typeof info !== 'object' || Array.isArray(info)) return null
  const source = info as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const age = source['age']
  const sex = source['sex']
  if (age !== undefined) out['age'] = age
  if (sex !== undefined) out['sex'] = sex
  return Object.keys(out).length > 0 ? out : null
}

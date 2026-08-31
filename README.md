# heart-health-dsh-suite

适配心脏健康场景的 DeepSeek Harness 插件套件：在「心衰辅助诊断算法服务（heart-algo MCP）」之上，
为 DSH 会话提供一组**受控的领域包装工具**、**驻留临床指导**与**原始工具隐藏策略**。

它是三个插件包协作链路的最后一环：

```
heart-algo-mcp(算法服务) ──> heart-algo-dsh-plugin(MCP 桥) ──> heart-health-dsh-suite(本包)
```

## 能力总览

| 层 | 内容 | 说明 |
| --- | --- | --- |
| 包装工具 | 12 个领域包装工具（见下表）：核心三件套 + 扩展九件套 | 只接受已登记标识符；嵌套读取底层 MCP 的 structuredContent，投影为稳定 canonical JSON；不解析渲染文本 |
| 驻留指导 | 系统提示词「心脏健康分析工作方式」（order 150） | 调用状态机、三态解读边界、安全红线；随 preset 常驻，每轮生效 |
| 策略 | 对继承工具面按前缀隐藏 `mcp__<server>__*` 并安装单调 guard | 直接调用被拒绝并给出可操作原因；策略只收紧自身会话视图，不影响其它 preset 与全局层 |
| 数据最小化 | canonical value 构造时就地 `scrubValue` | 丢弃 path/token 类键、脱敏泄露签名、`patient_info` 仅保留 `age`/`sex`（可整体关闭） |

三态契约与上游 `mcp_server.py` 一致：`processing / completed / failed` 判别式负载，
逐资产 `error`/`skip_reason`，`inputs` SHA-256 追溯，`review_status`/`requires_clinician_review` 复核状态。

## 包装工具清单（12 个）

| 包装工具 | 对应底层 raw 工具 | 用途与输入要点 |
| --- | --- | --- |
| `heart_submit_diagnosis` | `diagnose_heart_failure` | 提交已登记病例的分析任务；只接受病例门户/HTTP API 返回的 `case_id` 与可选 `asset_ids`，立即返回 `task_id` |
| `heart_get_diagnosis_result` | `get_diagnosis_result` | 按 `task_id` 单次查询；只返回 processing / completed / failed 三种状态之一，不做等待循环 |
| `heart_list_supported_views` | `list_supported_views` | 支持的心超切面与指标目录，上传前核对 |
| `heart_analyze_case_files` | `analyze_case_files` | 一站式分析：`files[].path` 指**算法服务所在主机**上的本地 DICOM/XML 文件（唯一允许路径形态的工具）；心超必填 `dcm_type`，ECG 禁止设置；服务端建病例→登记资产→提交任务，`request_id` 可幂等 |
| `heart_interpret_diagnosis` | `interpret_diagnosis` | 已完成任务的规则解读：参考范围异常标注、LVEF 分型（HFrEF/HFmrEF/HFpEF）、E/A、E/e′ 组合指标；规则比对输出，不构成诊断 |
| `heart_generate_report` | `generate_report` | 报告草稿（markdown/json），`save_to_case` 可存回病例工件（`report-<task_id>.md/.json`） |
| `heart_compare_diagnoses` | `compare_diagnoses` | 同一病例两次已完成任务的纵向对比：同名指标绝对差/百分比/方向与 LVEF 分型迁移 |
| `heart_list_cases` | `list_cases` | 服务账号可见病例摘要（资产/任务计数、最近复核决定） |
| `heart_get_case_detail` | `get_case_detail` | 病例资产清单、分析任务实时状态、复核历史与报告工件（不含任何磁盘路径） |
| `heart_list_tasks` | `list_tasks` | 分析任务列表与实时状态，可用 `case_id` 过滤 |
| `heart_get_review_status` | `get_review_status` | 任务的临床复核状态与全部复核记录 |
| `heart_submit_review` | `submit_review` | 登记复核结论（approved/rejected）；结论必须由真实临床人员作出，复核人不能与病例所有者相同，Agent 只负责登记 |

## 安装

### 使用者（推荐：GitHub Release 分发包，内含预构建产物）

前置：已安装 DSH Desktop；有可用的 heart-algo MCP 后端（默认 `http://127.0.0.1:8000/mcp`，
可用 `HEART_ALGO_MCP_URL` 覆盖），并已安装 heart-algo-dsh-plugin 桥（Release：https://github.com/Liujie-harsh/heart-health-dsh-suite/releases/tag/heart-algo-dsh-plugin-v0.1.0 ）、设好 `HEART_ALGO_MCP_TOKEN`。

```powershell
# 1) 从 Release 页下载最新 tgz：
#    https://github.com/Liujie-harsh/heart-health-dsh-suite/releases
dsh plugin --profile <你的profile> add .\heart-health-dsh-suite-0.1.0.tgz

# 2) 重启 DSH Desktop。
#    本包是 bundle：每次 profile 引导时激活器自动把 preset 幂等写入
#    <DSH_HOME>\.agent-presets\heart-health\，无需手动 bundle apply。

# 3) 新建空白会话 → agent preset 选择器 → 选「心脏健康」。
```

卸载：

```powershell
dsh plugin --profile <你的profile> remove heart-health-dsh-suite
```

> 卸载说明：`dsh plugin remove` 会同时删除已复制到用户根目录的 preset 目录，
> 但已经启动的会话进程仍持有旧能力直到重启。`tools/change` 之后新会话即恢复干净工具面。

### 开发者（源码安装）

```powershell
git clone https://github.com/Liujie-harsh/heart-health-dsh-suite.git
$env:DSH_CHECKOUT = '<DeepSeek Harness checkout 路径>'   # 构建从这里取 typescript 与 peer 类型
cd heart-health-dsh-suite
npm run build   # 编译到 lib/（发布 tarball 内含预构建产物，使用者无需此步）
dsh plugin --profile <你的profile> add .\
```

## 配置旋钮（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HEART_HEALTH_MCP_SERVER_NAME` | `heart-algo` | 底层 MCP server 名（决定被隐藏的原始工具前缀） |
| `HEART_HEALTH_RAW_TOOL_SUBMIT` | `diagnose_heart_failure` | 提交任务的原始工具名 |
| `HEART_HEALTH_RAW_TOOL_RESULT` | `get_diagnosis_result` | 查询结果的原始工具名 |
| `HEART_HEALTH_RAW_TOOL_VIEWS` | `list_supported_views` | 支持切面目录的原始工具名 |
| `HEART_HEALTH_RAW_TOOL_ANALYZE` | `analyze_case_files` | 一站式分析的原始工具名 |
| `HEART_HEALTH_RAW_TOOL_INTERPRET` | `interpret_diagnosis` | 规则解读的原始工具名 |
| `HEART_HEALTH_RAW_TOOL_REPORT` | `generate_report` | 报告草稿的原始工具名 |
| `HEART_HEALTH_RAW_TOOL_COMPARE` | `compare_diagnoses` | 纵向对比的原始工具名 |
| `HEART_HEALTH_RAW_TOOL_LIST_CASES` | `list_cases` | 病例列表的原始工具名 |
| `HEART_HEALTH_RAW_TOOL_CASE_DETAIL` | `get_case_detail` | 病例详情的原始工具名 |
| `HEART_HEALTH_RAW_TOOL_LIST_TASKS` | `list_tasks` | 任务列表的原始工具名 |
| `HEART_HEALTH_RAW_TOOL_REVIEW_STATUS` | `get_review_status` | 复核状态的原始工具名 |
| `HEART_HEALTH_RAW_TOOL_SUBMIT_REVIEW` | `submit_review` | 复核登记的原始工具名 |
| `HEART_HEALTH_KEEP_PATIENT_INFO` | `true`(1) | 设为 `false`/`0` 时结果完全不含 `patient_info` |
| `HEART_HEALTH_MAX_VISIBLE_ECG_PREDICTIONS` | `8` | 文本投影展示 Top-K 条 ECG 预测；canonical value 保持全量 |
| `HEART_HEALTH_REVIEW_REMINDER` | `true`(1) | 设为 `false`/`0` 时关闭 completed 结果尾部的复核提示文案 |

变量必须在启动 dsh 的进程内存在；也可以直接改写 `<DSH_HOME>/.agent-presets/heart-health/agent.cordis.yml` 的字面量。

## 开发与验证

```bash
$env:DSH_CHECKOUT = 'D:\project\dsh\deepseek-harness'   # 指向 Harness checkout
npm run build   # tsc 编译到 lib/（零依赖安装，从 checkout 解析 peer 类型与 typescript）
npm run check   # 发布物清单 / exports 一致性 / 秘密卫生 / 旋钮拼写
npm test        # 47 个 vitest 用例（33 既有 + 14 扩展；真实 Loader + 真 Includer + 假 heart MCP）
```

测试要点（对应 PRD 验收）：

- **真实加载器组合**：AgentPresets 挂载真实解析 preset；原始 MCP 工具对会话不可见、guard 可拒绝；
- **三态契约**：canonical 判别式投影快照、Top-K 截断、未知状态拒绝、AbortSignal 传播；
- **扩展九件套**：投影与渲染文本、`files` 路径语义仅一站式工具放行、报告内容路径脱敏、复核结论只能登记不得代决；
- **数据最小化**：跨 content/meta/value 三面断言泄漏注入全部清除；
- **输入校验**：URL/路径/多余字段一律拒绝并指引病例门户上传（`heart_analyze_case_files` 的服务端路径除外）；
- **生命周期**：并发/顺序多会话挂载干净无重复注册。

## 已知残留风险

- 嵌套调用省略了 `agent` 参数（包装器内部委托底层 MCP 属同一受控插件域），因此**agent 作用域的监听器与审批门禁不会作用于这次委托**——这是执行机制的有意豁免；策略层 guard 仍覆盖模型直接发起的任何原始工具调用。
- preset 组合行以裸包名解析运行时（与 `@deepseek-ai/dsh-persona` 同机制）：若部署宿主的组合基座与 profile node_modules 不一致，挂载会在健康检查中**响亮失败**（不会静默降级）。
- Windows 下 `file:///D:/pkg/...` 形态已验证；POSIX 盘符缺失的 URL 形态不在支持范围。
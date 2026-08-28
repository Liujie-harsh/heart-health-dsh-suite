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
| 包装工具 | `heart_submit_diagnosis` / `heart_get_diagnosis_result` / `heart_list_supported_views` | 只接受已登记标识符；嵌套读取底层 MCP 的 `structuredContent`，投影为稳定 canonical JSON；不解析渲染文本 |
| 驻留指导 | 系统提示词 `心脏健康分析工作方式`（order 150） | 调用状态机、三态解读边界、安全红线；随 preset 常驻，每轮生效 |
| 策略 | 对继承工具面按前缀隐藏 `mcp__<server>__*` 并安装单调 guard | 直接调用被拒绝并给出可操作原因；策略只收紧自身会话视图，不影响其它 preset 与全局层 |
| 数据最小化 | canonical value 构造时就地 `scrubValue` | 丢弃 path/token 类键、脱敏泄露签名、`patient_info` 仅保留 `age`/`sex`（可整体关闭） |

三态契约与上游 `mcp_server.py` 一致：`processing / completed / failed` 判别式负载，
逐资产 `error`/`skip_reason`，`inputs` SHA-256 追溯，`review_status`/`requires_clinician_review` 复核状态。

## 安装

```bash
# 在 profile（web）全局层登记本包；裸行 heart-health-dsh-suite/tools 由宿主基座解析
dsh plugin --profile web add ./heart-health-dsh-suite

# 安装驻留 preset（把 presets/heart-health/ 两个 yaml 写入 <DSH_HOME>/.agent-presets/）
dsh bundle apply --profile web cordis.patch.yml
```

卸载：

```bash
dsh plugin --profile web remove heart-health-dsh-suite
```

> 卸载说明：`dsh plugin remove` 会同时删除已复制到用户根目录的 preset 目录，
> 但已经启动的会话进程仍持有旧能力直到重启。`tools/change` 之后新会话即恢复干净工具面。

## 配置旋钮（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HEART_HEALTH_MCP_SERVER_NAME` | `heart-algo` | 底层 MCP server 名（决定被隐藏的原始工具前缀） |
| `HEART_HEALTH_RAW_TOOL_SUBMIT` | `diagnose_heart_failure` | 提交任务的原始工具名 |
| `HEART_HEALTH_RAW_TOOL_RESULT` | `get_diagnosis_result` | 查询结果的原始工具名 |
| `HEART_HEALTH_RAW_TOOL_VIEWS` | `list_supported_views` | 支持切面目录的原始工具名 |
| `HEART_HEALTH_KEEP_PATIENT_INFO` | `true`(1) | 设为 `false`/`0` 时结果完全不含 `patient_info` |
| `HEART_HEALTH_MAX_VISIBLE_ECG_PREDICTIONS` | `8` | 文本投影展示 Top-K 条 ECG 预测；canonical value 保持全量 |
| `HEART_HEALTH_REVIEW_REMINDER` | `true`(1) | 设为 `false`/`0` 时关闭 completed 结果尾部的复核提示文案 |

变量必须在启动 dsh 的进程内存在；也可以直接改写 `<DSH_HOME>/.agent-presets/heart-health/agent.cordis.yml` 的字面量。

## 开发与验证

```bash
$env:DSH_CHECKOUT = 'D:\project\dsh\deepseek-harness'   # 指向 Harness checkout
npm run build   # tsc 编译到 lib/（零依赖安装，从 checkout 解析 peer 类型与 typescript）
npm run check   # 发布物清单 / exports 一致性 / 秘密卫生 / 旋钮拼写
npm test        # 33 个 vitest 用例（真实 Loader + 真 Includer + 假 heart MCP）
```

测试要点（对应 PRD 验收）：

- **真实加载器组合**：AgentPresets 挂载真实解析 preset；原始 MCP 工具对会话不可见、guard 可拒绝；
- **三态契约**：canonical 判别式投影快照、Top-K 截断、未知状态拒绝、AbortSignal 传播；
- **数据最小化**：跨 content/meta/value 三面断言泄漏注入全部清除；
- **输入校验**：URL/路径/多余字段一律拒绝并指引病例门户上传；
- **生命周期**：并发/顺序多会话挂载干净无重复注册。

## 已知残留风险

- 嵌套调用省略了 `agent` 参数（包装器内部委托底层 MCP 属同一受控插件域），因此**agent 作用域的监听器与审批门禁不会作用于这次委托**——这是执行机制的有意豁免；策略层 guard 仍覆盖模型直接发起的任何原始工具调用。
- preset 组合行以裸包名解析运行时（与 `@deepseek-ai/dsh-persona` 同机制）：若部署宿主的组合基座与 profile node_modules 不一致，挂载会在健康检查中**响亮失败**（不会静默降级）。
- Windows 下 `file:///D:/pkg/...` 形态已验证；POSIX 盘符缺失的 URL 形态不在支持范围。

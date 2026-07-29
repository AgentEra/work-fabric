# 本地 Debug Channel 长期联调指南

Debug Channel 是开发环境专用的 `channel` Citizen。它可以模拟外部消息通道，
把 `text`、`data`、`resource` 三类 WFPP 内容送入真实 Connector Ingress、
Handoff、Agent Runtime 和 Signal 路径，并保存最终规范事件和授权 Handoff
快照。它不是另一套 Core、测试捷径、Agent 大脑或业务回复生成器。

## 安全边界

- Work Fabric 必须配置 `development_mode: true`。
- 独立 HTTP 服务只允许监听字面量 `127.0.0.0/8` 或 `::1`；示例使用
  `127.0.0.1:8791`。`localhost`、通配地址和非回环 IP 都会失败关闭。
- 除 `GET /health` 外，所有接口都要求 Bearer Token。
- 调用方只能提交 `participant_ref`。可信配置决定它采用 `static` 绑定还是
  `admission` 策略，调用方不能注入 Actor、Endpoint 或代理授权。
- 日志、错误体和状态命令不输出消息正文、模型结果或 Token。

## 1. 环境配置

创建一个仅本机可读的 `.env` 文件：

```dotenv
WORK_FABRIC_CURSOR_SECRET=至少32字符的本地游标签名密钥
WORK_FABRIC_ADMIN_TOKEN=本地管理员令牌
WORK_FABRIC_DEBUG_TOKEN=本地调试用户与Debug-HTTP令牌
INTAKE_AGENT_ACCESS_TOKEN=日常助理Agent令牌
AGENTLY_MODEL_API_KEY=模型服务令牌
```

示例配置是
`examples/config/local-debug-assistant.bundle.yaml`。默认使用 SQLite，分别把
Work Fabric 和 Agent Runtime 状态写入 `var/`；重启后 Submission、Ingress、
Handoff 与 Capture 仍可查询。删除这些数据库才会清空本地历史。

```bash
export WORK_FABRIC_ENV_FILE="$PWD/debug.env"
export WORK_FABRIC_CONFIG="$PWD/examples/config/local-debug-assistant.bundle.yaml"
```

模型默认沿用本地助理配置中的 OpenAI-compatible Provider。发布门禁使用仓库
内的确定性假模型，不访问外网。

## 2. 启动与状态

```bash
npm run local:debug:start
npm run local:debug:status
```

前台 supervisor 依次启动 Work Fabric、等待主服务与 Debug Channel 健康、
Provision 日常助理 Endpoint，再启动 Agent Runtime。停止可以按 `Ctrl-C`，
也可以从另一个终端执行：

```bash
npm run local:debug:stop
```

状态判断以 `/health/ready`、Debug `/health` 和真实子进程为准，不把一个已经
退出的 npm 包装进程当成健康服务。

## 3. 发送任意格式

```bash
npm run local:debug:send -- \
  --file examples/debug-channel/requests/plain.json \
  --conversation local-trial-1 \
  --wait-ms 15000
```

长期样例包括：

- `plain.json`：`text/plain`。
- `markdown.json`：`text/markdown` 与链接语义。
- `data.json`：文本加带 `schema_ref` 的结构化 `data`。
- `resource.json`：文本加不可变或外部 `resource` 引用。

每个文件包含稳定 `idempotency_key`、可信配置中存在的 `participant_ref` 和
有序 `content`。相同会话、相同幂等键、相同内容返回原 Submission；内容
不同返回 `409 idempotency_conflict`，不会创建第二个 Ingress 或 Handoff。

## 4. HTTP 查询

```text
POST /v1/conversations/{conversation_id}/messages
GET  /v1/submissions/{submission_id}
GET  /v1/conversations/{conversation_id}/events?limit=25&cursor=...
GET  /v1/events/{capture_id}
GET  /health
```

Submission 查询只组合所有权模块的事实：Connector Ingress 状态、Handoff
版本与生命周期，不另造“处理成功”字段。事件列表返回原始 canonical Result
Event，并把授权读取的语义 Handoff Snapshot 放在独立字段中。

## 5. 身份模式

`static` 适合确定性的本地测试：配置直接绑定外部测试主体、Actor 和 Endpoint。
`admission` 适合验证动态接入：参与者只引用策略 ID，由全局 Admission 模块
产生绑定与短期 representation grant。两种模式只影响身份解析，不改变
Debug Channel、Connector、Handoff 或 Agent 的协议路径。

## 6. 完整 E2E

```bash
npm run local:debug:e2e
```

门禁使用真实 SQLite Adapter、Debug HTTP、Connector Worker、Handoff Core、
Python Agently Worker、Agent Runtime Host 和 Signal Dispatcher。只把模型
HTTP 边界替换成本地确定性 fixture，并验证 Markdown+typed data、Agent 语义
Result、Capture 和幂等重放。

## 7. 分层排障

| 层 | 观察方式 | 常见含义 |
|---|---|---|
| Transport | Debug `/health`、401/413 | 监听、Bearer 或请求上限问题 |
| Ingress | Submission 的 `ingress.state` | 校验、映射、身份或命令投递问题 |
| Handoff | Submission 的 `handoff.lifecycle_state` | Authority、目标 Endpoint 或责任接收问题 |
| Agent Runtime | Endpoint Provision、Runtime 进程与状态库 | Agent 未接收、未 Accept 或执行失败 |
| Model | fixture 请求数或 Provider 健康 | 模型协议、输出 Schema 或网络问题 |
| Signal | Result Event 与 Subscription delivery | 结果已生成但未路由到通道 |
| Capture | `/events` 与 `/events/{id}` | 路由、快照可见性、持久化或分页问题 |

排障必须沿这七层读取事实，不能用 Channel 拼业务答复、用 Fabric 生命周期码
代替 Agent 语义，也不能绕过 Handoff 直接调用模型。

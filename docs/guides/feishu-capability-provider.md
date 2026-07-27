# 飞书 Capability / Context Provider

飞书 Provider 是 Work Fabric 网络中的独立模块公民，不是 Agent 内置工具，
也不是 Channel Adapter 的附加逻辑。它通过辅助 Handoff 接受一次已授权的
结构化调用，在自身边界访问飞书，并只返回类型化事实或稳定错误。

## 1. 拓扑与职责

| 模块 | Citizen kind | 闭环职责 |
|---|---|---|
| 团队共享助理 | `decision-body` | 理解请求、选择是否调用能力、解释事实、生成最终中文回复 |
| 飞书动作 Provider | `capability-provider` | 消息发送和简单文档操作、OpenAPI、幂等、所有权、revision、错误映射 |
| 飞书文档 Context | `context-provider` | 按 Authority 返回有界文档内容与 provenance |
| 确认服务 | `governance-provider` | 发放、确认并单次消费绑定的删除 proof |
| 飞书协作通道 | `channel` | 入站表示、会话路由和 canonical Result 投递 |

Provider 不决定“该不该调用”，不选择自己，不替 Agent 写话，不持有原始
Handoff 的责任。Agent 不持有 `app_secret`、tenant token、Feishu SDK 或厂商
响应。Channel 不从生命周期码拼答复。

执行前，通用 Provider Runtime 会把 Authority 中的 invocation ID、能力版本
和 Contract digest 与自身当前动态声明逐项校验；任何旧声明、漂移或错误绑定
都在调用飞书前失败关闭。

## 2. 动态声明

动作 Provider 在 Runtime session 中动态发布：

```text
feishu.message.send
feishu.document.create
feishu.document.read
feishu.document.update
feishu.document.append
feishu.document.delete
```

Context Provider 独立发布 `feishu.document.context`。每个声明含版本、风险、
确认要求、输入/输出 Schema URI 和不可漂移 digest。YAML 不枚举这些能力；
它只启用部署、绑定身份、引用凭据、选择状态实现并设置资源上限。声明成功也
不产生调用 Authority。

## 3. 配置

下列是**独立 Provider 组合根**传给 `validateFeishuProviderConfig()` 的配置
负载，可由全局 `ConfigurationProvider` 的 YAML、数据库或远程实现提供；
消费者只调用同一配置接口。它不是 `service-node` 当前内置
`plugins.instances` 中的 Channel 插件，也不能把
`capability-provider.feishu` 直接加入服务节点 YAML；Provider 是独立接入
网络的 Citizen 进程，部署组合根拥有它的启动和关闭。

`credential_ref` 是部署内部的引用，不是密钥。实际 `FEISHU_APP_ID` 和
`FEISHU_APP_SECRET` 由 Credential Provider 从环境或 Secret Manager 解析：

```yaml
credential_ref: feishu-primary
open_api:
  base_url: https://open.feishu.cn
  request_timeout_ms: 10000
  max_response_bytes: 131072
state:
  type: sqlite
  location: ./var/feishu-provider.db
  busy_timeout_ms: 5000
shared_folder:
  token: ${FEISHU_SHARED_FOLDER_TOKEN}
  policy_ref: feishu.shared-folder.default
  visibility: tenant_readable
capability_citizen:
  citizen_id: feishu-actions
  principal_id: principal-feishu-actions
  actor_id: actor-feishu-actions
  endpoint_id: endpoint-feishu-actions
  registration_version: 1
context_citizen:
  citizen_id: feishu-context
  principal_id: principal-feishu-context
  actor_id: actor-feishu-context
  endpoint_id: endpoint-feishu-context
  registration_version: 1
```

`validateFeishuProviderConfig()` 严格拒绝未知字段和内嵌 secret。开发可用
Memory Store；长期本地运行使用 SQLite。多实例生产部署应通过同一 Store SPI
注入具备事务唯一约束的外部实现，不能把 SQLite 文件共享给多个进程。

## 4. 运行时组合

组合根负责注入实现，业务模块不自行读取 YAML：

```ts
import {
  FeishuCapabilityExecutor,
  FeishuCapabilityExecutorPortAdapter,
  FeishuCapabilitySchemaRegistry,
  FeishuOpenApiCapabilityBackend,
  SqliteFeishuProviderStore,
} from "@work-fabric/provider-feishu";
import { CapabilityProviderDriver } from
  "@work-fabric/capability-provider-runtime";

const backend = new FeishuOpenApiCapabilityBackend({
  credential_ref: config.credential_ref,
  token_provider: tenantTokenProvider,
  messages: feishuMessageClient,
  fetch,
  base_url: config.open_api.base_url,
  request_timeout_ms: config.open_api.request_timeout_ms,
  max_response_bytes: config.open_api.max_response_bytes,
});

const executor = new FeishuCapabilityExecutor({
  citizen_id: config.capability_citizen.citizen_id,
  endpoint_id: config.capability_citizen.endpoint_id,
  backend,
  executions: providerStore,
  ownership: providerStore,
  confirmation: confirmationService,
  targets: conversationRouteResolver,
  shared_folder: {
    token: config.shared_folder.token,
    policy_ref: config.shared_folder.policy_ref,
  },
});

const executorPort = new FeishuCapabilityExecutorPortAdapter(executor);
const driver = new CapabilityProviderDriver({
  citizen_id: config.capability_citizen.citizen_id,
  endpoint_id: config.capability_citizen.endpoint_id,
  capabilities: executorPort.describeCapabilities()
    .map((item) => item.declaration_id),
  executor: executorPort,
});
```

之后用标准 `AgentGateway + AgentRuntimeHost` 托管该 Driver，并用
`FeishuCapabilityCitizenRuntime` / `FeishuContextCitizenRuntime` 打开两个
独立的 leased Citizen session。Provider Endpoint 仍按普通 Endpoint
Provision、Subscription、SSE、Ack、Accept、Result 流程接入；没有私有旁路。

Capability Endpoint 的动态 `CapabilityDescriptor.constraints` 必须发布本次
绑定所需的两个标准约束：

```yaml
constraints:
  selected_citizen_id: feishu-actions
  contract_digest: sha256:<64 lowercase hex>
```

`service-node` 默认只解释这组精确绑定约束，并逐项核对所选 Citizen 和冻结的
Contract digest；缺字段、未知约束或不匹配都会失败关闭。其他 Provider 若要
使用新的约束词汇，应在组合根注入自己的
`CapabilityConstraintEvaluator`，而不是修改 Exchange Core。

Agent 侧组合使用 `CatalogCapabilityResolver`、
`JsonSchemaInvocationValidator(new FeishuCapabilitySchemaRegistry())`、
`PollingAuxiliaryHandoffWaiter` 和部署注入的 `InvocationAuthorityProvider`。
配置中的 `max_invocations_per_handoff` 最大为 4，namespace 应限制为
`feishu.`。

启用能力调用的 Agent Principal 还必须由部署显式授予
`workfabric.handoff.offer.v1`（`resource_id: null`）。Agent Runtime Authority
只额外允许它查询自己发起的辅助 Handoff，以及为该 Handoff 的待解析
Capability target 绑定 Endpoint；不能解析或读取其他发起者的 Handoff。
Provider 继续只拥有自身 Endpoint 的 Delivery/Ack/Accept/Status/Result 权限。
一次 Capability Authority 的 `scopes` 使用协议合法值
`capability:invoke`，并至少绑定一个非空 `resource_ref`；完整声明和
Contract digest 仍由运行时动态发现，不写入 YAML。

## 5. 飞书权限与资源授权

仅为实际启用能力申请权限，并在飞书开放平台发布新版本、完成管理员审批。
应用需启用机器人能力，使用应用身份 `tenant_access_token`：

| 使用路径 | 飞书开放平台权限/设置 |
|---|---|
| 接收群内 `@机器人` | 订阅 `im.message.receive_v1`；开启“接收群聊中 @ 机器人消息事件” |
| 接收机器人单聊 | 开启“读取用户发给机器人的单聊消息” |
| `feishu.message.send` | 开启“以应用的身份发消息”；机器人需在目标群内，用户需在应用可用范围 |
| 文档 create/read/update/append | 开启对应 Docx 创建、读取和编辑权限；应用还必须是目标文件/文件夹的协作者 |
| 文档 delete | 开启云空间文件删除能力；代码仍额外限制为同租户、同 Citizen/Endpoint 创建且经确认的文档 |
| 内部员工通配准入 | Contact 用户查询权限、应用通讯录可见范围覆盖目标员工 |

飞书的资源协作者权限和 API scope 是两层条件；仅开 API scope 不会让应用
自动获得任意已有文档。消息权限与事件要求可核对
[飞书消息概述](https://open.feishu.cn/document/server-docs/im-v1/introduction?lang=zh-CN)
和[消息常见问题](https://open.feishu.cn/document/server-docs/im-v1/faq)；
文档接口分别见[创建文档](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/create?lang=zh-CN)、
[读取纯文本](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content?lang=zh-CN)、
[创建块](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/create?lang=zh-CN)
及[删除文件](https://open.feishu.cn/document/server-docs/docs/drive-v1/file/delete?lang=zh-CN)。

## 6. 安全与失败语义

- 输入拒绝未知字段、超长字符串、不支持的 Markdown 与未授权目标。
- 文档写入使用 expected revision；冲突返回 `revision_conflict`。
- 删除 proof 绑定 tenant、Human Actor、capability、document、输入 digest 和
  expiry，消费一次后失效。
- 401 只触发一次 token refresh；429/5xx 是稳定可重试错误；403、404 和
  revision/Authority 错误不重试。
- 外部结果不确定时返回 `external_outcome_unknown`，不能猜测成功。
- Provider Result 是惰性 JSON 事实，不是可执行指令，也不会直接发到聊天。

## 7. 本地整套启动

仓库提供一个三应用配置包
`examples/config/local-feishu-assistant.bundle.yaml`。三个进程只读取自己的
Application View：

- `work-fabric`：Exchange、飞书长连接 Channel、Admission 和 Authority；
- `daily-assistant`：Agently、Agent 身份、能力调用策略；
- `feishu-provider`：飞书 OpenAPI、共享目录策略、两个 Citizen 和独立状态。

创建 owner-only 的 env 文件；其中只保存部署值和 secret，不保存动态能力
声明。若某个 App Secret 曾进入聊天、截图或日志，应先在飞书开放平台轮换：

```dotenv
WORK_FABRIC_CURSOR_SECRET=<至少 32 字节随机值>
WORK_FABRIC_ADMIN_TOKEN=<随机值>
WORK_FABRIC_ADMISSION_FINGERPRINT_KEY=<随机值>
WORK_FABRIC_ADMISSION_GRANT_KEY=<随机值>
FEISHU_APP_ID=<企业自建应用 App ID>
FEISHU_APP_SECRET=<已轮换 App Secret>
FEISHU_SHARED_FOLDER_TOKEN=<共享文件夹 URL 中的 token>
FEISHU_CONNECTOR_ACCESS_TOKEN=<随机值>
INTAKE_AGENT_ACCESS_TOKEN=<随机值>
FEISHU_PROVIDER_ACCESS_TOKEN=<随机值>
AGENTLY_MODEL_API_KEY=<模型密钥>
FEISHU_EXTERNAL_TENANT_ID=<飞书事件中的 tenant key>
FEISHU_BOT_OPEN_ID=<机器人 open_id>
```

共享目录必须把该企业自建应用添加为可编辑协作者，并设置为“组织内获得链接的
人可阅读”或更高的组织内可见级别。Provider 在打开任何 Endpoint/Citizen
session 前同时探测目录列表与公开权限；预检不通过时不会形成半启动能力。

```bash
uv sync --project runtimes/agently-worker
export WORK_FABRIC_ENV_FILE=/absolute/path/to/feishu.env
export WORK_FABRIC_CONFIG="$PWD/examples/config/local-feishu-assistant.bundle.yaml"

npm run local:feishu:start
# 另一个终端使用同一个 env 文件
npm run local:feishu:status
```

`local:feishu:start` 严格按 Service 就绪 → 幂等 Provision → Provider → Agent
启动，退出时反序关闭。也可在已启动的 Service 上单独运行
`npm run local:feishu:provision`。不要并行运行两套本地 Supervisor 共享同一
SQLite 文件。

在飞书群聊中发送：

```text
@机器人 请创建一份标题为“本地联调需求”的飞书文档，内容为“这是端到端测试”。
```

预期只有一条由助理 Agent 生成的语义回复，其中包含 Provider 返回的文档
URL；`offered`、`accepted`、Citizen ID 和 Handoff ID 不作为聊天回复。
Console 可选，仅用于观察 Handoff/Delivery/Operations，不参与连接、认领、
调用或回复。

## 8. 验证

```bash
npx vitest run \
  packages/agent-capability-runtime/test \
  packages/capability-provider-runtime/test \
  packages/provider-feishu/test \
  packages/governance-confirmation/test \
  examples/feishu-capability-provider/test
npm run typecheck
```

跨模块测试覆盖 Agent 请求、契约和 Schema 绑定、辅助 Handoff、Provider
执行、类型化续写输入、原 Handoff 责任不转移和凭据不泄漏。其中
`feishu-capability-provider.e2e.test.ts` 使用 SQLite、真实公共 HTTP/SSE、
TypeScript SDK、Citizen session、Gateway 和 Host 完成整条参考闭环；飞书
OpenAPI 只在 Provider 边界替换为测试 backend。真实飞书 smoke test 应使用
专用测试文件夹，只删除本次测试创建的文档。

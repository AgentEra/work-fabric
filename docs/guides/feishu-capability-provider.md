# 飞书 Capability / Context Provider

飞书 Provider 是 Work Fabric 网络中的独立模块公民，不是 Agent 内置工具，
也不是 Channel Adapter 的附加逻辑。它通过辅助 Handoff 接受一次已授权的
结构化调用，在自身边界访问飞书，并只返回类型化事实或稳定错误。

## 1. 拓扑与职责

| 模块 | Citizen kind | 闭环职责 |
|---|---|---|
| 团队共享助理 | `decision-body` | 理解请求、选择是否调用能力、解释事实、生成最终中文回复 |
| Feishu Message Provider | `capability-provider` | 消息发送、会话分页读取、来源、签名游标和稳定错误 |
| Feishu Document Provider | `capability-provider` | 简单文档操作、OpenAPI、幂等、所有权、revision、错误映射 |
| 飞书 Context Provider | `context-provider` | 按 Authority 返回有界文档内容或会话历史与 provenance |
| 确认服务 | `governance-provider` | 发放、确认并单次消费绑定的删除 proof |
| 飞书协作通道 | `channel` | 入站表示、会话路由和 canonical Result 投递 |

Provider 不决定“该不该调用”，不选择自己，不替 Agent 写话，不持有原始
Handoff 的责任。Agent 不持有 `app_secret`、tenant token、Feishu SDK 或厂商
响应。Channel 不从生命周期码拼答复。

执行前，通用 Provider Runtime 会把 Authority 中的 invocation ID、能力版本
和 Contract digest 与自身当前动态声明逐项校验；任何旧声明、漂移或错误绑定
都在调用飞书前失败关闭。

## 2. 动态声明

两个独立 Provider facet 在各自 Runtime session 中动态发布。Message facet：

```text
feishu.conversation.history.read  # query capability
feishu.message.send
```

Document facet：

```text
feishu.document.create
feishu.document.read
feishu.document.update
feishu.document.append
feishu.document.delete
```

Context Provider 独立发布 `feishu.document.context` 和
`feishu.conversation.context`。前者读取文档，后者读取并筛选触发消息之前的
有界 chat/thread 历史。每个声明含版本、风险、确认要求、输入/输出 Schema
URI 和不可漂移 digest。YAML 不枚举这些能力；
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
cursor_signing_key: ${WORK_FABRIC_FEISHU_CURSOR_SECRET}
open_api:
  base_url: https://open.feishu.cn
  request_timeout_ms: 10000
  max_response_bytes: 131072
state:
  type: sqlite
  location: ./var/feishu-provider.db
  busy_timeout_ms: 5000
message_citizen:
  enabled: true
  citizen_id: citizen-feishu-message
  principal_id: principal-feishu-provider
  actor_id: actor-feishu-provider
  endpoint_id: endpoint-feishu-provider
  registration_version: 1
document_citizen:
  enabled: true
  citizen_id: citizen-feishu-document
  principal_id: principal-feishu-provider
  actor_id: actor-feishu-provider
  endpoint_id: endpoint-feishu-provider
  registration_version: 1
context_citizen:
  citizen_id: citizen-feishu-context
  principal_id: principal-feishu-provider
  actor_id: actor-feishu-provider
  endpoint_id: endpoint-feishu-provider
  registration_version: 1
```

`message_citizen` 与 `document_citizen` 可独立启停、注册、续租、授权和扩缩；
一个进程可以共享底层 HTTP client，但这不会把它们合并成一个 Citizen。旧
`capability_citizen` 配置仍作为聚合兼容形式加载，不能和新 facet 配置混用。
`cursor_signing_key` 只通过 Secret Resolver 解析，不进入声明、健康状态或日志。

`validateFeishuProviderConfig()` 严格拒绝未知字段和内嵌 secret。开发可用
Memory Store；长期本地运行使用 SQLite。多实例生产部署应通过同一 Store SPI
注入具备事务唯一约束的外部实现，不能把 SQLite 文件共享给多个进程。

文档目录、知识空间、模板和内容结构不属于部署配置。调用方可以显式传入
`resource_uri`，也可以传入由使用侧 `DocumentPlacementResolver` 动态解释的
`policy_ref`。身份代理和原生 ACL 实现同样由组合根注入；未注入时文档操作
失败关闭。

## 4. 运行时组合

组合根负责注入实现，业务模块不自行读取 YAML：

```ts
import {
  BrokeredDocumentAccessAuthorizer,
} from "@work-fabric/document-provider-spi";
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

const documentAccess = new BrokeredDocumentAccessAuthorizer({
  subjects: nativeDocumentSubjectResolver,
  permissions: nativeDocumentPermissionGateway,
});

const executor = new FeishuCapabilityExecutor({
  citizen_id: config.capability_citizen.citizen_id,
  endpoint_id: config.capability_citizen.endpoint_id,
  backend,
  executions: providerStore,
  ownership: providerStore,
  confirmation: confirmationService,
  targets: conversationRouteResolver,
  document_access: documentAccess,
  placement: usageOwnedPlacementResolver,
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

## 5. 身份代理、飞书权限与资源授权

Work Fabric 不保存飞书文档 ACL。飞书消息入口只在 Handoff 上附带有界代理
范围，示例本地配置为：

```yaml
inbound:
  delegation:
    scopes:
      - work:read
      - document:read
      - document:write
      - document:delete
      - message:send
    may_redelegate: true
```

这不是文档授权，只表示接收任务的 Agent 可以向能力 Provider 发起对应类型的
代理请求。`InvocationAuthorityProvider` 会从已接受的原始 Handoff 派生更窄、
不可再次转授的子委托。Provider 再通过 `DocumentAccessAuthorizer` 把内部
`represented_actor_id` 解析成厂商侧身份，并用用户身份凭据或企业 ACL 服务
确认该用户对目标文档/容器的原生权限。

有效授权始终是：

```text
原始 Handoff 委托
∩ 子调用 operation scope
∩ 飞书文档/容器原生权限
∩ Provider 的幂等、revision、确认等安全约束
```

应用/机器人可以拥有覆盖较广的技术访问能力，但该能力只解决“能否连通”，
不能代替派发人的业务授权。生产模式下，无法解析派发人身份、用户授权过期、
ACL 服务不可用或飞书拒绝时，Provider 都在文档调用前失败关闭。

为了先跑通真实飞书文档链路，本地配置可临时选择开发期应用身份适配器：

```yaml
service:
  development_mode: true
  document_access:
    mode: development_app_identity
    # 仅表示默认创建位置，不是 ACL。
    default_resource_uri: feishu://drive/root
```

它还必须同时设置
`WORK_FABRIC_ALLOW_UNSAFE_DOCUMENT_ACCESS=true`，否则 Provider 在启动前
拒绝运行。`development_mode: false` 时该模式同样无法启用。这条路径只允许
create/read/update/append，保留 Handoff 委托与 operation scope 检查，并使用
不超过五分钟且不超过原委托期限的授权证据；delete 仍被拒绝。它是组合根中的
临时授权 Adapter，不进入 Core、Agent、Handoff、Contract 或飞书 Provider
业务模块。后续替换为 `BrokeredDocumentAccessAuthorizer` 时这些模块都不改。

仅为实际启用能力申请权限，并在飞书开放平台发布新版本、完成管理员审批。
应用需启用机器人能力，使用应用身份 `tenant_access_token`：

| 使用路径 | 飞书开放平台权限/设置 |
|---|---|
| 接收群内 `@机器人` | 订阅 `im.message.receive_v1`；开启“接收群聊中 @ 机器人消息事件” |
| 接收机器人单聊 | 开启“读取用户发给机器人的单聊消息” |
| 会话历史 Context | 开启 `im:message` 或 `im:message:readonly`；群历史另需 `im:message.group_msg`；机器人需在目标群内，应用可用范围需覆盖相关用户 |
| `feishu.message.send` | 开启“以应用的身份发消息”；机器人需在目标群内，用户需在应用可用范围 |
| 文档 create/read/update/append | 开启对应 Docx 创建、读取和编辑权限；技术调用身份必须能访问资源，同时代理用户必须通过原生 ACL 检查 |
| 文档 delete | 开启云空间文件删除能力；代码仍额外限制为同租户、同 Citizen/Endpoint 创建且经确认的文档 |
| 用户权限判断 | 开启“判断当前用户是否有云文档权限”；身份代理服务需维护或动态取得派发人的用户授权 |
| 内部员工通配准入 | Contact 用户查询权限、应用通讯录可见范围覆盖目标员工 |
| 群成员展开 | `im:chat.members:read`；机器人必须在目标群内 |
| 日历创建/注册 | `calendar:calendar:create`、`calendar:calendar:read` |
| 日程创建/读取/更新/删除 | `calendar:calendar.event:create`、`calendar:calendar.event:read`、`calendar:calendar.event:update`、`calendar:calendar.event:delete` |
| 忙闲查询 | `calendar:calendar.free_busy:read` |

飞书的资源协作者权限和 API scope 是两层条件；仅开 API scope 不会让应用
自动获得任意已有文档。消息权限与事件要求可核对
[飞书消息概述](https://open.feishu.cn/document/server-docs/im-v1/introduction?lang=zh-CN)
和[消息常见问题](https://open.feishu.cn/document/server-docs/im-v1/faq)；
文档接口分别见[创建文档](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/create?lang=zh-CN)、
[读取纯文本](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content?lang=zh-CN)、
[创建块](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/create?lang=zh-CN)
及[删除文件](https://open.feishu.cn/document/server-docs/docs/drive-v1/file/delete?lang=zh-CN)。

### 5.1 Calendar Facet、注册与权限

Calendar 是独立 Capability Provider Citizen，不是 Message 或 Channel 内部的
“日历工具”。YAML 只启用模块身份，不保存 calendar ID、日程或参与人。日历
绑定属于 Provider 动态状态，通过部署管理端口显式写入：

```bash
export WORK_FABRIC_ENV_FILE=/absolute/path/to/feishu.env
export WORK_FABRIC_CONFIG="$PWD/examples/config/local-feishu-assistant.bundle.yaml"
export WORK_FABRIC_ADMIN_PRINCIPAL_ID=principal-work-fabric-admin

npm run feishu-calendar:admin -- \
  create-and-bind --alias team --summary '团队协作日历' \
  --permissions show_only_free_busy --default

npm run feishu-calendar:admin -- \
  bind-existing --alias team \
  --calendar-id 'feishu.cn_x@group.calendar.feishu.cn' --default

npm run feishu-calendar:admin -- list
```

命令复用同一应用凭据，不要求域名或回调 URL，也不接受 secret CLI 参数。
应用身份必须对绑定日历拥有 `writer` 或 `owner`；角色和 API scope 缺一不可。
共享日历创建若出现网络结果未知，命令不会盲目重试，而会提示在飞书侧核对后
用 `bind-existing` 对账。

群成员由 Message Citizen 提供，Calendar Citizen 只处理日历事实；Daily
Assistant 根据动态声明依次调用两者并生成最终回复。参与人写入可能返回
`completion_state: partial`，事件 URI 仍会保留，Agent 必须如实说明未成功
参与人。删除只允许当前 Provider 代表同一发起 Actor 创建的事件，并要求一次性
确认 proof；本地应用身份组合没有确认签发/验证器，因此删除默认失败关闭。

本地阶段先用应用身份验证连通性，暂不要求用户 OAuth。以后接入用户 OAuth 或
企业身份代理时，只替换 Authority/凭据适配器，不改变 Calendar Capability、
Handoff 或 Agent 流程。飞书字段和公开范围可核对
[日历资源说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/calendar-v4/calendar/introduction)
与[应用权限列表](https://open.feishu.cn/document/server-docs/application-scope/scope-list?lang=zh-CN)。

### 5.2 Agent 排期提案与人工确认

日常助理不会因第一条“创建日程”消息直接写日历。参考流程是：

1. Agent 按需读取群成员、相关历史和忙闲事实；
2. 信息不足时通过当前 Handoff Result 在原群追问；
3. 信息完整时生成带版本的排期提案，并在飞书原群原生 `@` 最初发起人；
4. 后续飞书消息作为新的 Handoff 进入网络；
5. 只有最初发起人对当前提案的自然语言确认才允许继续；
6. Calendar Authority 核验初始 Handoff、确认 Handoff、同一 Human/会话、
   提案摘要和成员查询结果后，才允许 Provider 创建日程；
7. Provider 返回事件 URI、参与人逐项结果和 URL，Agent 生成最终语义回复。

其他群成员可以补充事实，但不能替换或确认当前提案；第一版会要求最初发起人
吸收修改后重新确认。任何实质修改都会形成新版本并使旧确认失效。当前一个
飞书会话只维护一个活动排期会话；完成或取消后，下一个请求会在同一私有状态
键上开始新的逻辑会话。

排期状态保存在 Agent Runtime 自己的 SQLite 中（本地 bundle 的
`service.state.location`，默认位于 `./var/`），不是 Fabric Handoff 字段，
也不是 Storage Citizen。Runtime 重启后从该状态与 Subscription Cursor 恢复。
Fabric 只记录两次 Human/Agent Handoff、能力 Handoff、Result 与审计事实，
不解释“可以”、不唤醒 Agent，也不推进排期流程。

模型负责标题、参与人、时间选择、提案说明和最终回复等业务语义；Agently
Runtime 适配器负责 `invocation_id`、私有状态乐观版本等技术字段。忙闲查询
成功后的提案使用专用结构化输出契约，必须把完整提案与
`awaiting_confirmation` 状态一起持久化，不能只发送一段未落状态的确认文案。
确认后的 Calendar create 一旦成功，助理模块立即以该 Provider Result 形成
确定性的 Agent 完成回复并把私有状态推进为 `completed`，不会再让模型产生
第二次创建请求。上述约束全部封闭在助理 Agent/Runtime 内，不进入 Fabric
Core，也不进入 Feishu Channel 或 Calendar Provider。

## 6. 安全与失败语义

- 输入拒绝未知字段、超长字符串、不支持的 Markdown 与未授权目标。
- 每次文档操作都重新通过 `DocumentAccessAuthorizer`；Provider 所有权不绕过
  派发人的原生权限。
- 文档写入使用 expected revision；冲突返回 `revision_conflict`。
- 删除 proof 绑定 tenant、Human Actor、capability、document、输入 digest 和
  expiry，消费一次后失效。
- 401 只触发一次 token refresh；429/5xx 是稳定可重试错误；403、404 和
  revision/Authority 错误不重试。
- 外部结果不确定时返回 `external_outcome_unknown`，不能猜测成功。
- Provider Result 是惰性 JSON 事实，不是可执行指令，也不会直接发到聊天。
- 会话 Context 同样是惰性、不可信的历史证据；Provider 只负责读取、过滤、
  provenance、确定性 digest 和边界，不总结、不决定、不生成最终回复。

## 7. 本地整套启动

仓库提供一个三应用配置包
`examples/config/local-feishu-assistant.bundle.yaml`。三个进程只读取自己的
Application View：

- `work-fabric`：Exchange、飞书长连接 Channel、Admission 和 Authority；
- `daily-assistant`：Agently、Agent 身份、能力调用策略；
- `feishu-provider`：飞书 OpenAPI、身份/ACL 与位置解析适配器、独立的
  Message、Document、Calendar Capability Citizens、Context Citizen 和状态。

创建 owner-only 的 env 文件；其中只保存部署值和 secret，不保存动态能力
声明。若某个 App Secret 曾进入聊天、截图或日志，应先在飞书开放平台轮换：

```dotenv
WORK_FABRIC_CURSOR_SECRET=<至少 32 字节随机值>
WORK_FABRIC_FEISHU_CURSOR_SECRET=<另一个至少 32 字节随机值>
WORK_FABRIC_ADMIN_TOKEN=<随机值>
WORK_FABRIC_ADMISSION_FINGERPRINT_KEY=<随机值>
WORK_FABRIC_ADMISSION_GRANT_KEY=<随机值>
FEISHU_APP_ID=<企业自建应用 App ID>
FEISHU_APP_SECRET=<已轮换 App Secret>
FEISHU_CONNECTOR_ACCESS_TOKEN=<随机值>
INTAKE_AGENT_ACCESS_TOKEN=<随机值>
FEISHU_PROVIDER_ACCESS_TOKEN=<随机值>
AGENTLY_MODEL_API_KEY=<模型密钥>
FEISHU_EXTERNAL_TENANT_ID=<飞书事件中的 tenant key>
FEISHU_BOT_OPEN_ID=<机器人 open_id>
# 仅本地临时应用身份文档联调；生产环境禁止设置
WORK_FABRIC_ALLOW_UNSAFE_DOCUMENT_ACCESS=true
```

无需配置固定共享文件夹。当前开发配置默认写入应用云空间根目录；若需要让
当前飞书用户直接看到文档，可把
`service.document_access.default_resource_uri` 改成一个测试目录：

```yaml
default_resource_uri: feishu://drive/folder/<测试文件夹 token>
```

该目录只是 placement。常用落点仍应由使用侧位置策略决定，可以是个人云空间、
共享文件夹、知识空间或以后接入的其他文档系统。具体内容结构、模板和默认目录
也由使用侧 Context/Skill/策略维护。

生产配置使用 `mode: brokered_native`，并由组合根注入身份代理、飞书原生
权限检查和位置解析实现。未注入时每次文档调用都会失败关闭。只有同时满足
开发模式、YAML 显式选择和环境危险确认时，仓库本地组合才使用应用身份；
它不会因原生适配器缺失而自动降级。

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

验证排期确认链路时发送：

```text
@机器人 根据群聊信息，找一个大家都有空的一小时，安排“EDA 方案评审”。
```

预期机器人先返回排期提案并 `@` 发起人，此时飞书日历中还没有新事件。发起人
确认内容无误后再发送：

```text
@机器人 可以，就按这个安排。
```

预期此时才创建一次日程，并返回可点击的日程链接。若要调整时间、时长或
参与人，先直接说明修改；Agent 会生成新提案并再次要求发起人确认。
如果返回 `calendar_not_registered`，先按 5.1 节用管理命令登记并绑定默认
日历；YAML 只启用 Calendar Citizen，不保存动态 calendar ID。

验证 Agent 按需查询与能力调用协同时，可以先发送两条普通消息，再发送：

```text
@机器人 总结上面的消息，并创建一份“本地联调需求”飞书文档
```

本地示例使用 `conversation_context.mode: agent_managed`。Channel 不预取
历史；Agent 先调用 `feishu.conversation.history.read`，依据 `has_more` 和
当前证据判断是否继续分页，再调用文档能力。当前触发消息、未来消息、删除
消息和跨会话消息不会进入 Provider 结果。预期 Agent 的唯一回复同时包含历史
摘要和创建后的文档 URL；摘要来自 Agent，事实来自两个独立 Provider facet，
Channel 只负责投递 canonical Result。

若创建失败，依次确认：

1. 飞书应用已发布含 Docx 创建、读取和编辑权限的新版本并完成管理员审批；
2. env 文件包含危险确认开关，YAML 仍处于开发适配器模式；
3. 如配置了测试文件夹，应用技术身份能够访问该文件夹；
4. 原始飞书 Handoff 含 `document:write` 且允许派生子委托；
5. `npm run local:feishu:status` 显示 Service、Provider、Agent 均存活。

## 8. 验证

```bash
npx vitest run \
  packages/agent-capability-runtime/test \
  packages/capability-provider-runtime/test \
  packages/provider-feishu/test \
  packages/governance-confirmation/test \
  examples/feishu-capability-provider/test
npx vitest run \
  examples/feishu-capability-provider/test/local-stack.e2e.test.ts \
  --testTimeout=30000
npm run typecheck
```

跨模块测试覆盖 Agent 请求、契约和 Schema 绑定、辅助 Handoff、Provider
执行、类型化续写输入、原 Handoff 责任不转移和凭据不泄漏。其中
`feishu-capability-provider.e2e.test.ts` 使用 SQLite、真实公共 HTTP/SSE、
TypeScript SDK、Citizen session、Gateway 和 Host 完成整条参考闭环；飞书
OpenAPI 只在 Provider 边界替换为测试 backend。
`local-stack.e2e.test.ts` 进一步启动真实 Agently Python Worker、飞书长连接
Channel 和 Calendar Provider，验证第一条消息只查询群成员/忙闲并返回一个
原生 `@` 发起人的提案，确认前不创建事件；第二条由原发起人发送的确认形成新
Handoff 后，才创建一次日程、邀请明确目标并返回可点击链接。测试同时证明
Agent 私有会话被带入第二轮，而 Handoff 状态码和内部引用不会成为聊天内容。
真实飞书
smoke test 应使用专用测试策略落点，只删除本次测试创建且仍由当前 Provider
管理的文档。

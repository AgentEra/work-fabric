# 飞书协作通道接入

飞书插件把飞书会话接入 Work Fabric 的交接网络。它不理解“创建需求”这句话，不调用模型，不选择 Agent，也不替 Agent 创建需求；它只把明确 `@机器人` 的文本可靠转换为一个目标已配置的 Intake Handoff，并把后续 Handoff 事件送回原会话。

## 1. 选择接入模式

一个插件实例只能选择一种入站模式：本地长连接或 Webhook。两种模式复用同一个 durable ingress、身份映射、Handoff、Subscription 和飞书 OpenAPI 出站链路；切换模式需要修改配置并重启服务。

长连接只支持飞书**企业自建应用**，不支持商店应用。它不需要公网 IP、域名或隧道，但运行 Work Fabric 的机器必须能出站访问飞书。卡片动作回调当前仍需要 Webhook 模式，或等待后续明确支持的长连接 binding。

## 2. 模式 A：本地长连接（无需域名）

1. 在飞书开放平台创建企业自建应用并启用机器人。
2. 在事件订阅中选择 `使用长连接接收事件`，订阅 `im.message.receive_v1`，并配置读取群消息事件与机器人发送消息所需的最小权限。
3. 打开 [service-feishu-long-connection.yaml](../../examples/config/service-feishu-long-connection.yaml)，替换插件与 Admission policy 中的 `external_tenant_id`、`bot_open_id` 以及可选固定通知 `receive_id`。把明确允许的用户 open_id 写入 `admission.policies.feishu-primary-participants.allow.external_subject_ids`，把明确禁止的用户写入同一策略的 `deny.external_subject_ids`；固定项目通知不是必需功能，不需要时应同时删除 `outbound.channels.project-notifications` 和引用它的 `outbound.subscriptions.project-results`。
4. 明确进入仓库根目录，创建 SQLite 父目录，再设置环境变量并启动：

```bash
REPOSITORY_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPOSITORY_ROOT"
mkdir -p "$PWD/var"
chmod 700 "$PWD/var"
export WORK_FABRIC_CONFIG="$PWD/examples/config/service-feishu-long-connection.yaml"
export WORK_FABRIC_CURSOR_SECRET="$(openssl rand -hex 32)"
export WORK_FABRIC_ADMISSION_FINGERPRINT_KEY="$(openssl rand -hex 32)"
export WORK_FABRIC_ADMISSION_GRANT_KEY="$(openssl rand -hex 32)"
export FEISHU_APP_ID="cli_..."
export FEISHU_APP_SECRET="..."
export FEISHU_CONNECTOR_ACCESS_TOKEN="use-a-long-random-token"
export INTAKE_AGENT_ACCESS_TOKEN="use-another-long-random-token"
# This is the separate admin identity used only by `npm run agent-runtime:provision`.
# It is not the Runtime bearer token and must not be supplied to `agent-runtime:start`.
export WORK_FABRIC_ADMIN_TOKEN="use-a-third-long-random-token"
npm run service:start
```

After Work Fabric is ready, provision the fixed Daily Assistant Endpoint once
with the admin token, then start the Runtime using only
`INTAKE_AGENT_ACCESS_TOKEN` and `AGENTLY_MODEL_API_KEY`:

```bash
npm run agent-runtime:provision
unset WORK_FABRIC_ADMIN_TOKEN
export WORK_FABRIC_AGENT_RUNTIME_CONFIG="$PWD/examples/config/agent-runtime-agently.yaml"
export AGENTLY_MODEL_API_KEY="..."
npm run agent-runtime:start
```

The Runtime treats the configured SQLite state directory (`./var` in the
sample) as its trusted filesystem boundary. System ancestors such as `/` and
`/Users` must be real directories and must not be symlinks, but they need not
be Runtime-owned or private. The boundary itself and every workspace path
component below it must be owned by the Runtime UID and have no group/world
permissions; missing components are created with mode `0700`.

5. 把企业自建应用机器人加入测试群。`/health/live` 表示进程存活；等待 SDK 建立连接后，`/health/ready` 必须返回 200：

```bash
curl -i http://127.0.0.1:8787/health/live
curl -i http://127.0.0.1:8787/health/ready
```

6. 由 YAML 中已映射的用户发送：

```text
@机器人 帮我创建一个需求
```

同一飞书应用同时运行多个进程时，飞书长连接采用竞争投递而不是广播；Work Fabric 的 durable ingress 去重保证重复事件只形成一个逻辑 Handoff，但不能把多个进程当作每个实例都收到事件的 fan-out。

## 3. 模式 B：Webhook

Webhook 适合已有 HTTPS 回调域名的部署，也是当前接收飞书卡片动作的模式。在飞书开放平台订阅 `im.message.receive_v1`，将事件回调地址配置为：

```text
https://<work-fabric-host>/v1/connectors/feishu/feishu-primary/events
```

复制并保留现有 [service-feishu.yaml](../../examples/config/service-feishu.yaml) 的 Webhook 字段，替换其中的 `*-example` 飞书标识，并设置：

```bash
export WORK_FABRIC_CONFIG="$PWD/examples/config/service-feishu.yaml"
export WORK_FABRIC_CURSOR_SECRET="$(openssl rand -hex 32)"
export FEISHU_APP_ID="cli_..."
export FEISHU_APP_SECRET="..."
export FEISHU_VERIFICATION_TOKEN="..."
export FEISHU_CONNECTOR_ACCESS_TOKEN="use-a-long-random-token"
export INTAKE_AGENT_ACCESS_TOKEN="use-another-long-random-token"
npm run service:start
```

当前 Webhook 示例保留兼容性的静态 `identities`，因此不读取 Admission key；按第 7 节迁移为 `identity_admission` 后，还需要像长连接示例一样导出 `WORK_FABRIC_ADMISSION_FINGERPRINT_KEY` 和 `WORK_FABRIC_ADMISSION_GRANT_KEY`。若启用飞书 Encrypt Key，把 `credentials.encrypt_key` 加入 Webhook YAML 并使用环境变量引用。`verification_token`、`encrypt_key` 和 `route_id` 都是 Webhook-only 字段，不得放入长连接配置。

## 4. Admission 策略与飞书目录权限

推荐的新部署使用 `identity_admission.policy_id`，不再用插件内的 `identities` 同时承担 allowlist 和身份绑定。策略的范围必须与插件实例的 Work Fabric tenant、connector、`source_system: feishu` 和飞书 `external_tenant_id` 完全一致，否则服务在插件启动前失败。

策略优先级固定为：

1. `deny.external_subject_ids` exact match：拒绝；
2. `allow.external_subject_ids` exact match：允许；
3. `allow.all_internal_members: true` 且目录证据为 active internal human：允许；
4. external、inactive、unknown 或无规则：拒绝；
5. 目录、存储或 grant 暂不可用：进入 Connector 有界重试，不降级为允许。

`deny` 可以与 exact allow 和 `all_internal_members` 同时存在，并始终优先。`all_internal_members` 不是裸 `"*"`，也不代表“群里所有人”；它只代表配置 external tenant 中被飞书 Contact API 确认的 active internal human。Agent 和 system 主体必须 exact allow。

启用 `all_internal_members` 时，企业自建应用必须为应用身份开通 Contact v3 批量获取用户信息接口所需的两个最小 scope：`contact:contact.base:readonly`（获取通讯录基本信息）和 `contact:user.employee:readonly`（获取用户受雇信息）。前者允许按 `open_id` 查询目录记录，后者使响应包含 `status.is_activated`、`status.is_exited` 等在职状态；只开通前者时，飞书会成功返回用户但裁剪 `status`，Work Fabric 会按 `evidence_unavailable` 失败关闭。权限变更必须完成发布和管理员审批，并把应用通讯录可见范围覆盖预期员工。

飞书接口只返回应用有权看到的目录记录；查询不到某个 `open_id` 时，Work Fabric 只能记录 `unknown`，不能可靠断言其是 external 或 guest，因此一律 fail closed。群成员身份、跨租户共享群关系和“能否 @ 机器人”都不能替代目录证据。

以下值只通过环境变量或其他 Secret Provider 注入，不写入 YAML 明文、Handoff、Decision、Console 或日志：

- `FEISHU_APP_SECRET`、Webhook 的 `FEISHU_VERIFICATION_TOKEN` 和可选 Encrypt Key；
- `WORK_FABRIC_ADMISSION_FINGERPRINT_KEY`，用于 tenant-scoped subject fingerprint；
- `WORK_FABRIC_ADMISSION_GRANT_KEY`，用于短时 representation grant 的签发/验证；
- `FEISHU_CONNECTOR_ACCESS_TOKEN` 与外部 Agent/运维身份 token。

`WORK_FABRIC_ADMIN_TOKEN` is a distinct administrative credential for the
fixed Endpoint provisioning route. It is never the Runtime's bearer token:
`agent-runtime:provision` reads it, while `agent-runtime:start` uses only the
Runtime identity token from its own configuration.

`service.admission.grant_active_key_id` 和 `grant_keys` 支持验证密钥轮换。v2 grant 同时绑定 `ingress_id` 和最终 command `idempotency_key`；HTTP Authority 要求 envelope 的 `correlation_id + idempotency_key` 与可信 grant tuple 完全一致。相同 tuple 可重试，任一分量变化都 fail closed。grant v1 缺少该完整 tuple，本版本不再接受。

v2 密钥的安全轮换顺序是：先把新 key 加入所有验证节点，确认所有节点均可验证后切换 `grant_active_key_id`，至少等待一个 `grant_ttl_seconds`，最后才移除旧 key。不要先删除旧 key，也不要在集群节点尚未同步验证 key 集时切换签发 key。策略 deny 或目录状态变化立即影响新的 Admission；已经签发的无状态 grant 最晚在 TTL 后失效，所以该 TTL 也是正常撤销的上界（配置范围 1–300 秒）。紧急撤销应同时移除相关验证 key 或停止 Connector。

飞书交互卡片 action reference 已从 `wfaf1` 升级为 `wfaf2`；旧 `wfaf1` 卡片按钮和旧 grant v1 都会失效。升级时应先暂停/排空 Admission-backed Connector，等待最长 grant TTL，部署所有 v2 issuer/verifier 与 `wfaf2` renderer，再恢复 ingress；用户需从新渲染的卡片继续操作。不要为了滚动兼容而重新放行缺少 tuple 的 grant v1。

## 5. 共同的身份、权限与职责边界

飞书 Integration 只是部署和文档中的虚拟分组，不是运行时 Citizen。Channel
负责入站/出站运输；Message Capability Citizen 负责群成员和历史消息事实；
Calendar Capability Citizen 负责日历/日程 OpenAPI、幂等和资源状态；Daily
Assistant 负责跨能力排序、信息充分性判断和最终语义回复。Calendar 不导入
Message，Message 也不导入 Calendar；二者只通过 Capability Handoff 和经验证
的结果证据协作。

`FEISHU_CONNECTOR_ACCESS_TOKEN` 是公共 TypeScript SDK 的部署 bootstrap 凭证，不是飞书 App Secret。Admission-backed 消息在单次 command 上使用短时 representation grant 覆盖 bootstrap 身份；HTTP Identity 将它解析为恰好一个 Actor/Endpoint claim，独立 Admission Authority 仅允许该 Connector 的 `workfabric.handoff.offer.v1`。grant 证明“代表谁”，不证明“可以做什么”，也不会绕过 HTTP、Identity、Authority 或 Exchange Core。

`outbound.channels` 声明固定通知目的地，`outbound.subscriptions` 把它们配置成 canonical Subscription。配置属于可信部署启动面；来自飞书的参与方命令仍必须经过 Identity、Representation 和 Authority。每个 Intake Handoff 的回聊 Subscription 是已授权 Offer 的机械后果，归属发起 Actor/Endpoint，并继续受事件 audience policy 约束。任何参与方经公共 API 修改 Subscription 时，仍必须拥有 `workfabric.subscription.manage.v1` 权限。

Console 只是可选呈现面，不参与入站、Handoff、Agent 或通知链路。外部 Intake Agent 才负责理解消息、接受并执行工作、调用需求系统，以及通过公共 API 回报状态和结果；Work Fabric 与飞书插件不解释或执行“创建需求”。

## 6. Intake Handoff 链路

已映射用户在群聊中发送：

```text
@机器人 帮我创建一个需求
```

链路为：

```text
Feishu transport trust -> durable ingress -> Admission -> representation grant
-> public TypeScript SDK -> HTTP Identity -> Authority -> Exchange Core -> Handoff
-> durable conversation route -> canonical Subscription -> original Feishu chat notification
```

普通聊天、未提及该机器人、非文本消息和 Admission 拒绝的用户都不会创建 Handoff。同一飞书事件重复投递只返回 duplicate，不会创建第二个 Decision、Binding 或 Handoff。目录暂不可用时 ingress 保持 durable 并进入有界重试，恢复后仍只产生一个逻辑结果。

外部 Intake Agent 使用正常 Work Fabric SDK/Agent Gateway 接受 Handoff，理解文本，向需求系统写入需求，并通过 `reportStatus`、`returnResult` 等公共操作回报状态。需求系统调用和 Agent 推理始终在 Work Fabric 外部。

### 6.1 兼容模式：Channel 启动时预取会话上下文

旧部署仍可用下面的 `enabled: true` 配置启用 bootstrap 预取；该写法会归一化
为 `mode: bootstrap`，用于迁移兼容，不是新部署的推荐模式：

```yaml
conversation_context:
  enabled: true
  lookback_seconds: 86400
  maximum_messages: 20
  maximum_bytes: 65536

inbound:
  delegation:
    scopes:
      - work:read
      - conversation:read
```

群聊使用触发消息之前的最近一段 chat history；飞书话题消息优先使用该
thread 的历史。当前触发消息、未来消息、已删除消息、跨会话记录、不支持的
消息类型和非法内容都不会进入 Context。结果按时间正序排列，并同时受时间、
条数、序列化字节数和原 Handoff 委托期限约束。配置项缺省时保持禁用，以兼容
已有部署；显式启用但省略三个上限时采用上面的默认值。

实现边界保持为三个独立职责：

```text
Feishu Channel -> ConversationContextMaterializer（中立端口）
               -> Feishu Context Provider（读取、筛选、来源和摘要事实）
               -> Exchange Context Bundle / Reference
               -> Agent Runtime（按引用、digest、Actor、Endpoint、期限读取）
               -> Decision Body（理解上下文并独占最终答复）
```

Channel 只请求 Context，不导入具体 Provider 实现；具体装配仅发生在
`service-node` 组合根。Context Provider 返回的是不可信历史证据，不是
Prompt、指令或长期记忆，不能改变 Agent 角色、Authority、可用能力、验收条件
或输出协议，也不能单独触发 capability 副作用。每次能力调用必须由当前
Handoff intent 明确要求；当前 intent 只是总结或提取时，历史中的旧命令只能
作为被总结的证据。Agent Runtime 无法按精确引用读取、digest 不一致、访问者不在
audience 中或 Context 已过期时，整个执行失败关闭，不会把引用当作内容。

飞书历史读取临时失败会让 durable ingress 进入原有有界重试；永久不可用会
生成明确的 `context_unavailable` 数据事实，Agent 可以据此向用户说明上下文
不可用，但 Channel 不代写语义答复。Context 内容通过统一
`GET /v1/contexts/{context_id}/versions/{version}?digest=...` 和 TypeScript
SDK `queries.getContextBundle(...)` 读取，不为 UI、Agent 或其他调用方设置
私有旁路。

除原有消息事件权限外，应用身份还必须开通 `im:message` 或
`im:message:readonly`；读取群聊历史还需要
`im:message.group_msg`。机器人必须在目标群中，应用可用范围必须覆盖相关
用户。权限变更后需要发布新应用版本并完成管理员审批。可以用下面的消息验证
语义：

```text
第一条：项目范围是飞书协作接入
第二条：交付日期定在本周五
@机器人 总结上面的消息
```

预期机器人只回复一条由助理 Agent 生成的摘要；聊天中不应出现 Context ID、
Handoff ID、`offered` 或 `accepted` 等内部状态。

### 6.2 推荐模式：Agent 按需读取

新部署使用：

```yaml
conversation_context:
  mode: agent_managed
```

`agent_managed` 下 Channel 不读取历史、不创建 Context Bundle，也不请求
`feishu.conversation_context_provider_factory`。它只把当前文本和可信
SourceReference 放入 Handoff。助理 Agent 判断证据不足时，再调用独立
Feishu Message Provider 暴露的 query capability
`feishu.conversation.history.read`；Provider 负责飞书分页、格式解码、来源和
边界，Agent 负责相关性、充分性、是否继续翻页以及最终措辞。

Capability 返回 `has_more` 和不透明 `next_cursor`。Agent 只有在缺失信息对
当前请求确实重要时才继续翻页；总调用次数、查询次数、累计结果字节数和原始
委托期限同时生效。游标以
`WORK_FABRIC_FEISHU_CURSOR_SECRET` 签名并绑定租户、触发消息与来源 URI，
不得记录游标内容或消息正文：

```bash
export WORK_FABRIC_FEISHU_CURSOR_SECRET="$(openssl rand -hex 32)"
```

应用仍需 `im:message:readonly`（或等价读权限）和群历史读取权限
`im:message.group_msg`。排障时只检查 Authority denial、查询次数、
`has_more`、结果字节数和 Provider 稳定错误码，不打印消息正文或原生
`page_token`。

这种边界同样支持“邮件/企业微信作为 Channel、飞书只作为文档系统”：
Channel 只提供自己的来源引用；Agent 可按 Authority 调用其他 Provider。
Provider facets do not depend on Channel facets。

## 7. 从 `identities` 迁移

现有 `identities` 仍是兼容 Adapter，适合小型、固定映射部署，但它把 allowlist 和 Actor/Endpoint 分配耦合在插件配置中。迁移步骤：

1. 配置 `service.admission` 的 fingerprint key、active grant key、1–300 秒 TTL 和 evidence cache 上限；
2. 在根级 `admission.policies` 创建与插件 scope 完全一致的策略，先把每个 `identities[].external_open_id` 原样放入 exact allowlist；
3. 如需内部员工通配，再配置 `all_internal_members`、`internal_membership` 和对应 `feishu.directory` evidence provider，并确认 Contact 权限与应用可见范围；
4. 保留独立 denylist，将插件的 `identities` 整体替换为 `identity_admission.policy_id`，两者不能同时存在；
5. 重启并验证 exact allow/deny、unknown、重复事件和目录故障恢复。Admission-backed Connector 不再需要静态飞书 Connector Actor 的 Offer authority rule；外部 Intake Agent 等正常身份配置仍保留。

Admission binding 中不会保存 raw open_id；它以部署密钥生成 fingerprint。若迁移前必须保持已有 Actor ID，请先制定显式的数据迁移/映射方案，不要假定由 fingerprint 生成的新 Actor ID 与旧静态 ID 相同。

## 8. 持久化与部署形态

- `memory-demo` 只用于测试和演示，进程退出后绑定与 Decision 丢失；
- `sqlite-local` 保存 Admission binding/decision，适合长期本地开发和单进程服务，不能作为多实例共享权威；
- `postgres` 通过部署注入的 Admission stores、事务唯一约束和 tenant RLS 支持多进程/集群并发；`service-node` 不读取或创建 PostgreSQL 凭据；
- 三种实现共享同一 SPI 和 conformance profile。YAML 只是首个 immutable Configuration Provider，后续数据库/远程 Provider 不改变 Admission runtime 或插件接口。

启用 Admission 的 `service-node` 会把基础 SQLite migrations 与 `005_admission` 一起自动应用；通用 `npm run sqlite:migrate` 当前只规划和应用基础 `SQLITE_MIGRATIONS`，不会单独加入 Admission adapter migration。首次升级前先停止单进程并备份数据库文件和 WAL。由于本功能仍在未发布分支中，`005_admission` 已直接加入 command idempotency 列；若本地预发布数据库已经执行过旧 checksum 的 `005_admission`，迁移器会按设计拒绝启动，请保留备份后重建该开发数据库，不要手工篡改 migration history。正式发布后只允许新增 forward migration。

## 9. 多实例与后续通道

`plugins.instances` 可配置多个飞书实例。每个实例拥有独立 connector scope、凭据、token cache、身份映射、worker、健康状态和会话路由。未来企业微信或其他通道实现新的可信 `PluginFactory` 和 channel adapter，复用相同 Connector、Handoff、Subscription 与 Signal 合约，不修改 WFPP 或 Exchange Core。

本地 `memory-demo` 与 `sqlite-local` 由 `service-node` 自动组合 Channel Route 和有界机械推进器；SQLite 重启会恢复 ingress、route、Subscription、projection 与 delivery position。PostgreSQL/集群部署必须注入部署自有的 `ChannelRouteStore`，并让集群 `SignalDispatcher` 与插件使用同一个 `ChannelSignalRouter`。数据库仍是权威状态，Broker 只可用作 wakeup 加速。

## 10. 故障语义

- Webhook 和长连接 handler 都只等待 durable accept；映射和 Offer 异步进行；
- Feishu 429、5xx、网络失败和路由暂不可用进入有界重试；
- Admission/Authority 拒绝和非法消息进入明确忽略或死信状态；目录、grant 或存储暂不可用进入有界重试；
- SQLite 保存 ingress、route、Subscription 和 delivery position；
- Feishu 不可用不会撤销已提交的 Work Fabric 事实；
- 密钥不会进入 Handoff、route、Protocol Event、Console、健康信息或指标标签。

Admission 只判断可信外部主体是否能进入协作网络。群组成员策略、消息内容分类、敏感词/Prompt 防护、Agent 推理、目标选择、业务审批、需求创建和专业工作执行都在它的职责之外。Work Fabric 是协作连接和责任交接 fabric，不是 automation brain，也不是企业通用防火墙。

删除或停用一个已经运行过的插件实例前，应先通过运维流程关闭它创建的固定 Subscription；仅把实例设为 `enabled: false` 不会删除历史 canonical 状态。运行时配置采用启动时不可变快照，变更 YAML 后需要重启服务；未来数据库或远程 Provider 可以替换 YAML，而插件消费者不需要改动。

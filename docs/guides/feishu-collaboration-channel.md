# 飞书协作通道接入

飞书插件把飞书会话接入 Work Fabric 的交接网络。它不理解“创建需求”这句话，不调用模型，不选择 Agent，也不替 Agent 创建需求；它只把明确 `@机器人` 的文本可靠转换为一个目标已配置的 Intake Handoff，并把后续 Handoff 事件送回原会话。

## 1. 选择接入模式

一个插件实例只能选择一种入站模式：本地长连接或 Webhook。两种模式复用同一个 durable ingress、身份映射、Handoff、Subscription 和飞书 OpenAPI 出站链路；切换模式需要修改配置并重启服务。

长连接只支持飞书**企业自建应用**，不支持商店应用。它不需要公网 IP、域名或隧道，但运行 Work Fabric 的机器必须能出站访问飞书。卡片动作回调当前仍需要 Webhook 模式，或等待后续明确支持的长连接 binding。

## 2. 模式 A：本地长连接（无需域名）

1. 在飞书开放平台创建企业自建应用并启用机器人。
2. 在事件订阅中选择 `使用长连接接收事件`，订阅 `im.message.receive_v1`，并配置读取群消息事件与机器人发送消息所需的最小权限。
3. 打开 [service-feishu-long-connection.yaml](../../examples/config/service-feishu-long-connection.yaml)，替换 `external_tenant_id`、`bot_open_id`、`identities[].external_open_id` 和 `outbound.channels.project-notifications.receive_id` 的 `*-example` 值（包括 `oc-project-example`）。`external_open_id` 必须是允许进入 Work Fabric 的映射用户 open_id；固定项目通知不是必需功能，不需要时应同时删除 `outbound.channels.project-notifications` 和引用它的 `outbound.subscriptions.project-results`。
4. 明确进入仓库根目录，创建 SQLite 父目录，再设置环境变量并启动：

```bash
REPOSITORY_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPOSITORY_ROOT"
mkdir -p "$PWD/var"
export WORK_FABRIC_CONFIG="$PWD/examples/config/service-feishu-long-connection.yaml"
export WORK_FABRIC_CURSOR_SECRET="$(openssl rand -hex 32)"
export FEISHU_APP_ID="cli_..."
export FEISHU_APP_SECRET="..."
export FEISHU_CONNECTOR_ACCESS_TOKEN="use-a-long-random-token"
export INTAKE_AGENT_ACCESS_TOKEN="use-another-long-random-token"
npm run service:start
```

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

若启用飞书 Encrypt Key，把 `credentials.encrypt_key` 加入 Webhook YAML 并使用环境变量引用。`verification_token`、`encrypt_key` 和 `route_id` 都是 Webhook-only 字段，不得放入长连接配置。

## 4. 共同的身份、权限与职责边界

`FEISHU_CONNECTOR_ACCESS_TOKEN` 是插件调用 Work Fabric 公共 HTTP/TypeScript SDK 的凭证，不是飞书 App Secret。它必须映射到收到消息的 Work Fabric Actor/Endpoint 表示，并由 Authority Policy 明确允许 `workfabric.handoff.offer.v1`。

`outbound.channels` 声明固定通知目的地，`outbound.subscriptions` 把它们配置成 canonical Subscription。配置属于可信部署启动面；来自飞书的参与方命令仍必须经过 Identity、Representation 和 Authority。每个 Intake Handoff 的回聊 Subscription 是已授权 Offer 的机械后果，归属发起 Actor/Endpoint，并继续受事件 audience policy 约束。任何参与方经公共 API 修改 Subscription 时，仍必须拥有 `workfabric.subscription.manage.v1` 权限。

Console 只是可选呈现面，不参与入站、Handoff、Agent 或通知链路。外部 Intake Agent 才负责理解消息、接受并执行工作、调用需求系统，以及通过公共 API 回报状态和结果；Work Fabric 与飞书插件不解释或执行“创建需求”。

## 5. Intake Handoff 链路

已映射用户在群聊中发送：

```text
@机器人 帮我创建一个需求
```

链路为：

```text
Feishu Webhook / long connection
  -> durable Connector ingress
  -> explicit mention/identity mapping
  -> public TypeScript SDK handoff.offer
  -> durable conversation route
  -> canonical Handoff Subscription
  -> original Feishu chat notification
```

普通聊天、未提及该机器人、非文本消息和未映射用户都不会创建 Handoff。同一飞书事件重复投递只返回 duplicate，不会创建第二个 Handoff。

外部 Intake Agent 使用正常 Work Fabric SDK/Agent Gateway 接受 Handoff，理解文本，向需求系统写入需求，并通过 `reportStatus`、`returnResult` 等公共操作回报状态。需求系统调用和 Agent 推理始终在 Work Fabric 外部。

## 6. 多实例与后续通道

`plugins.instances` 可配置多个飞书实例。每个实例拥有独立 connector scope、凭据、token cache、身份映射、worker、健康状态和会话路由。未来企业微信或其他通道实现新的可信 `PluginFactory` 和 channel adapter，复用相同 Connector、Handoff、Subscription 与 Signal 合约，不修改 WFPP 或 Exchange Core。

本地 `memory-demo` 与 `sqlite-local` 由 `service-node` 自动组合 Channel Route 和有界机械推进器；SQLite 重启会恢复 ingress、route、Subscription、projection 与 delivery position。PostgreSQL/集群部署必须注入部署自有的 `ChannelRouteStore`，并让集群 `SignalDispatcher` 与插件使用同一个 `ChannelSignalRouter`。数据库仍是权威状态，Broker 只可用作 wakeup 加速。

## 7. 故障语义

- Webhook 和长连接 handler 都只等待 durable accept；映射和 Offer 异步进行；
- Feishu 429、5xx、网络失败和路由暂不可用进入有界重试；
- Authority 拒绝、未映射身份和非法消息进入明确忽略或死信状态；
- SQLite 保存 ingress、route、Subscription 和 delivery position；
- Feishu 不可用不会撤销已提交的 Work Fabric 事实；
- 密钥不会进入 Handoff、route、Protocol Event、Console、健康信息或指标标签。

删除或停用一个已经运行过的插件实例前，应先通过运维流程关闭它创建的固定 Subscription；仅把实例设为 `enabled: false` 不会删除历史 canonical 状态。运行时配置采用启动时不可变快照，变更 YAML 后需要重启服务；未来数据库或远程 Provider 可以替换 YAML，而插件消费者不需要改动。

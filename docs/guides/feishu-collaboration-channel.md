# 飞书协作通道接入

飞书插件把飞书会话接入 Work Fabric 的交接网络。它不理解“创建需求”这句话，不调用模型，不选择 Agent，也不替 Agent 创建需求；它只把明确 `@机器人` 的文本可靠转换为一个目标已配置的 Intake Handoff，并把后续 Handoff 事件送回原会话。

## 1. 创建飞书自建应用

在飞书开放平台创建企业自建应用并启用机器人，订阅
`im.message.receive_v1`。事件回调地址为：

```text
http(s)://<work-fabric-host>/v1/connectors/feishu/feishu-primary/events
```

为应用配置读取群消息事件与机器人发送消息所需的最小权限。记录 App ID、App Secret、Verification Token、应用的 tenant key、机器人 open_id，以及允许进入 Work Fabric 的用户 open_id。若启用飞书 Encrypt Key，也把 `credentials.encrypt_key` 加入 YAML 并使用环境变量引用。

## 2. 准备配置与环境变量

复制 [service-feishu.yaml](../../examples/config/service-feishu.yaml)，替换其中的 `*-example` 飞书标识，并设置：

```bash
export WORK_FABRIC_CONFIG="$PWD/examples/config/service-feishu.yaml"
export WORK_FABRIC_CURSOR_SECRET="$(openssl rand -hex 32)"
export FEISHU_APP_ID="cli_..."
export FEISHU_APP_SECRET="..."
export FEISHU_VERIFICATION_TOKEN="..."
export FEISHU_CONNECTOR_ACCESS_TOKEN="use-a-long-random-token"
export INTAKE_AGENT_ACCESS_TOKEN="use-another-long-random-token"
```

`FEISHU_CONNECTOR_ACCESS_TOKEN` 是插件调用 Work Fabric 公共 HTTP/TypeScript SDK 的凭证，不是飞书 App Secret。它必须映射到收到消息的 Work Fabric Actor/Endpoint 表示，并由 Authority Policy 明确允许 `workfabric.handoff.offer.v1`。

`outbound.channels` 声明固定通知目的地，`outbound.subscriptions` 把它们配置成 canonical Subscription。配置属于可信部署启动面；来自飞书回调的参与方命令仍必须经过 Identity、Representation 和 Authority。每个 Intake Handoff 的回聊 Subscription 是已授权 Offer 的机械后果，归属发起 Actor/Endpoint，并继续受事件 audience policy 约束。任何参与方经公共 API 修改 Subscription 时，仍必须拥有 `workfabric.subscription.manage.v1` 权限。

## 3. 启动与检查

```bash
npm install
npm run service:start
```

服务默认监听 `http://127.0.0.1:8787`。检查：

```bash
curl http://127.0.0.1:8787/health/live
curl http://127.0.0.1:8787/health/ready
```

Console 仍只是可选的只读呈现面，不参与 webhook、Handoff、Agent 或通知链路。

## 4. 发起一次 Intake Handoff

已映射用户在群聊中发送：

```text
@机器人 帮我创建一个需求
```

链路为：

```text
Feishu callback
  -> durable Connector ingress
  -> explicit mention/identity mapping
  -> public TypeScript SDK handoff.offer
  -> durable conversation route
  -> canonical Handoff Subscription
  -> original Feishu chat notification
```

普通聊天、未提及该机器人、非文本消息和未映射用户都不会创建 Handoff。同一飞书事件重复投递只返回 duplicate，不会创建第二个 Handoff。

外部 Intake Agent 使用正常 Work Fabric SDK/Agent Gateway 接受 Handoff，理解文本，向需求系统写入需求，并通过 `reportStatus`、`returnResult` 等公共操作回报状态。需求系统调用和 Agent 推理始终在 Work Fabric 外部。

## 5. 多实例与后续通道

`plugins.instances` 可配置多个飞书实例。每个实例拥有独立 connector scope、凭据、token cache、身份映射、worker、健康状态和会话路由。未来企业微信或其他通道实现新的可信 `PluginFactory` 和 channel adapter，复用相同 Connector、Handoff、Subscription 与 Signal 合约，不修改 WFPP 或 Exchange Core。

本地 `memory-demo` 与 `sqlite-local` 由 `service-node` 自动组合 Channel Route 和有界机械推进器；SQLite 重启会恢复 ingress、route、Subscription、projection 与 delivery position。PostgreSQL/集群部署必须注入部署自有的 `ChannelRouteStore`，并让集群 `SignalDispatcher` 与插件使用同一个 `ChannelSignalRouter`。数据库仍是权威状态，Broker 只可用作 wakeup 加速。

## 6. 故障语义

- webhook 只等待 durable accept；映射和 Offer 异步进行；
- Feishu 429、5xx、网络失败和路由暂不可用进入有界重试；
- Authority 拒绝、未映射身份和非法消息进入明确忽略或死信状态；
- SQLite 保存 ingress、route、Subscription 和 delivery position；
- Feishu 不可用不会撤销已提交的 Work Fabric 事实；
- 密钥不会进入 Handoff、route、Protocol Event、Console、健康信息或指标标签。

删除或停用一个已经运行过的插件实例前，应先通过运维流程关闭它创建的固定 Subscription；仅把实例设为 `enabled: false` 不会删除历史 canonical 状态。运行时配置采用启动时不可变快照，变更 YAML 后需要重启服务；未来数据库或远程 Provider 可以替换 YAML，而插件消费者不需要改动。

# WFPP v1 Federation Profile

Federation Profile 定义两个独立 Authoritative Exchange 之间的签名交接请求与
回执。它是责任对接协议，不是状态复制、全局事务、Peer 发现或调度协议。

## 权威与边界

- Source Exchange MUST 明确指定 Target Exchange；Profile 不发现、评分或选择目标。
- 每个 Exchange MUST 只修改和解释自己的本地记录。远端签名声明是可验证的
  Peer Claim，不能直接覆盖本地 Handoff 状态。
- Target Bridge MUST 通过既有公共协议/API/SDK 幂等创建或关联本地 Handoff，
  幂等键为 `transfer_id`。
- Source Bridge MUST 只在验证 Target 的签名 Receipt、受众、Transfer ID、请求
  Message ID 与 Offer Digest 后应用本地回执。
- 人、Agent 和系统的专业执行 MUST 继续发生在 Exchange 之外。

## 消息

Profile 名为 `workfabric.federation.v1`，只包含：

- `transfer_offer`，sequence 1；
- `transfer_receipt`，sequence 2。

Envelope 是最多 65,536 字节的 canonical UTF-8 JSON 闭合对象；非 canonical wire、
重复成员和非配对 Unicode surrogate 都必须拒绝。所有字段（`signature` 除外）
使用确定性、按键排序的 canonical JSON 签名。签名算法为 Ed25519，编码
为无 padding 的 canonical base64url。TTL MUST 在 1–300 秒之间，实现允许的
时钟偏差 MUST 在 0–60 秒之间。

Offer 携带源 Handoff/Thread/版本、完整的公共 Handoff Offer，以及该 Offer 的
canonical SHA-256。它不能携带内部 `domain_data`、数据库游标、凭据或未签名
扩展。Target Bridge 在创建本地 Handoff 前仍 MUST 运行完整的公共 WFPP Schema、
Identity 与 Authority 校验。

Receipt 明确表示目标 Exchange 接受或拒绝本次联邦输入。接受时必须返回本地
Target Handoff ID 和版本；拒绝时必须返回稳定 `reason_code`。Receipt 本身不代表
目标 Actor 已经接受专业工作责任，除非其本地 Handoff 生命周期另有明确事实。

## 重试、重放与对账

重放身份是 `source_exchange_id × message_id`。记录同时保存请求 canonical digest：

- 相同身份、相同 digest 且已完成：MUST 返回逐字节相同的签名 Receipt；
- 相同身份、不同 digest：MUST 失败为 `federation_replay_conflict`；
- pending：MAY 重复调用以 `transfer_id` 幂等的 Bridge，然后完成记录；
- 过期、未来生效或错误受众：MUST 在调用 Bridge 前拒绝。

传输失败只能重发原始签名 Offer 字节，不能生成新的 Message ID。丢失 Receipt 的
对账方式同样是重发原始 Offer，并取得缓存 Receipt。v1 不提供全量状态同步、跨
Exchange 查询、两阶段提交或全局顺序。

## 信任

Trust Resolver 必须按 Source Exchange、Target Exchange 和 Key ID 显式配置公钥；
禁止 TOFU 或隐式全局信任。轮换时先加入新 Key ID，保留旧 Key 至最大 TTL 与重试
窗口结束，再移除旧 Key。HTTPS/mTLS、DNS、限流和网络身份属于 Transport Binding，
不能替代消息签名。

机器可读契约：

- `urn:work-fabric:schema:v1:federation-envelope`
- `urn:work-fabric:schema:v1:federation-transfer-offer`
- `urn:work-fabric:schema:v1:federation-transfer-receipt`

参考实现与部署说明见[跨 Exchange Federation](../../docs/federation.md)。

# WFPP v1 Subscriptions and Delivery

## 1. Filter

SubscriptionFilter 只允许 Event Type、Actor、Endpoint、Thread、Handoff、Work Reference URI、Capability 和 Lifecycle State 等声明式字段。

同一字段的多个值使用 OR，不同字段使用 AND，空数组不参与过滤。Exchange 在 Filter 后仍 MUST 执行 Tenant、Visibility 和 Authority 检查。v1 禁止脚本、任意表达式和可执行 Predicate。

## 2. Cursor Pull

所有 Exchange Core 实现 MUST 支持 Cursor Pull：Endpoint 使用 Subscription ID 和可选不透明 Cursor 拉取事件，Exchange 返回 Delivery ID、Events、Next Cursor 与 Visibility Expiry，Endpoint 再 Ack Delivery。

Cursor 由 Exchange 解释，客户端 MUST NOT 解析或合成。Exchange MUST 公开保留策略和最早可用位置。过期 Cursor 返回 `cursor_expired`，并提供可重放位置或 Snapshot 恢复指引。

## 3. 可选 Delivery Binding

SSE 与 Webhook 是可选 Binding。它们复用相同 Subscription、Cursor、Delivery 和 Ack 语义。HTTP 2xx 或流读取只表明投递成功，绝不表示 Handoff Responsibility Accepted。

## 4. At-Least-Once

Delivery 是 at-least-once。同一 CloudEvent 可以在 Visibility Timeout、断线恢复或重试时再次出现。Endpoint MUST 按 Event `id` 去重，并在持久化自身处理结果后 Ack。

Ack 只改变 Delivery 事实，不改变 Handoff 生命周期。责任变化必须通过 `handoff.accept`。

## 5. 失败与恢复

Exchange MAY 暂停持续失败的 Subscription，并发布 `workfabric.subscription.suspended.v1`。Delivery 重试、退避和死信策略由实现或 Binding 决定，但必须保留 Event Identity、Subscription Identity、Attempt 与 Cursor 相关性。

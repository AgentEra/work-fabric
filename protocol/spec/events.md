# WFPP v1 Events

## 1. 格式

领域事件 MUST 使用 CloudEvents 1.0 Structured JSON Format。标准字段包含 `specversion`、`id`、`source`、`type`、`subject`、`time`、`datacontenttype`、`dataschema` 与 `data`。

WFPP 扩展属性为 `wftenant`、`wfexchange`、`wfthread`、`wfhandoff`、`wfactor`、`wfendpoint`、`wfcorrelation`、`wfcausation`、`wfsequence` 和 `wfvisibility`。它们保持 CloudEvents 要求的小写命名。

## 2. Event Data

Event Data MUST 包含 Resource Version、最小 Change 和可空 Receipt Summary。它 MAY 包含权限过滤后的 Handoff 或 Endpoint Snapshot。

事件 MUST NOT 默认嵌入完整 ContextBundle、大型 Result、Credential 或内联二进制。消费者需要完整状态时，应按 Event 引用读取当前 Snapshot。

## 3. Event Types

Endpoint：

- `workfabric.endpoint.registered.v1`
- `workfabric.endpoint.renewed.v1`
- `workfabric.endpoint.withdrawn.v1`
- `workfabric.capability.changed.v1`

Handoff：

- `workfabric.handoff.offered.v1`
- `workfabric.handoff.accepted.v1`
- `workfabric.handoff.declined.v1`
- `workfabric.handoff.cancelled.v1`
- `workfabric.handoff.expired.v1`
- `workfabric.handoff.status_reported.v1`
- `workfabric.handoff.result_returned.v1`
- `workfabric.handoff.verified.v1`
- `workfabric.handoff.closed.v1`
- `workfabric.handoff.rework_requested.v1`
- `workfabric.handoff.transferred.v1`

Receipt 与 Delivery：

- `workfabric.receipt.recorded.v1`
- `workfabric.delivery.failed.v1`
- `workfabric.subscription.suspended.v1`

## 4. 顺序与不变性

Event 是不可变事实。Exchange MUST 为每个 Handoff 维护单调递增 `wfsequence`，并支持按 Sequence 重放单 Handoff 事件。v1 不承诺跨 Handoff 或跨 Thread 的全局顺序。

消费者 MUST 按 Event `id` 去重。发生时间相同或乱序时，以 `wfsequence` 和 Resource Version 为准。

## 5. 原子发布

权威状态修改和对应 Event MUST 在同一事务边界内记录，通常通过 Outbox 实现。Binding 投递可以延迟或重复，但不能丢失已提交事件或修改事件内容。

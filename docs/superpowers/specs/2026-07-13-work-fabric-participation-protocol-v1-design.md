# Work Fabric Participation Protocol v1 设计

- 日期：2026-07-13
- 状态：设计已确认，等待书面规范最终审阅

> 本文记录 WFPP v1 的详细协议设计。所有后续解释和实现必须服从
> [Work Fabric 项目章程](../../../PROJECT_CHARTER.md)；
> 协议状态只能表达和记录参与方协作事实，不能演变为 Fabric 内部业务编排。
- 工作名称：Work Fabric Participation Protocol（WFPP）
- 协议版本：`1.0`
- 定位：面向 Human、Agent 与 Work System 的开放参与和交接协议

## 1. 摘要

WFPP v1 定义人、Agent、Agent Runtime、传统工作系统和 AI-native 服务如何通过一个权威 Exchange 角色完成身份映射、能力声明、工作交接、Context 传递、状态报告、结果返回、验收以及事件订阅。

协议不执行参与方的工作。Agent 推理、人的专业工作、Codex 代码实施和外部系统业务流程都发生在 Work Fabric 之外。协议只定义参与边界上的共同语义与可验证状态。

WFPP 是独立开放协议；Work Fabric Server 是参考 Exchange 实现。协议不要求 Exchange 是一台中心服务器，只要求每个 Handoff 在任一时刻具有唯一权威 Exchange，用于持久化状态、裁决并发、签发 Receipt 和发布领域事件。

## 2. 目标与非目标

### 2.1 目标

WFPP v1 必须支持：

- Human Adapter、Agent Endpoint 和 System Connector 使用同一套交接语义。
- Endpoint 注册、租约续期、退出、Capability 声明和查询。
- 通过明确 Actor、Endpoint 或 Capability Requirement 发起 Handoff。
- Handoff 接受、拒绝、取消、状态报告、结果返回、验收、返工和再次转交。
- 引用优先、受限内联的 Context 与 Result 交换。
- 明确区分消息送达、消息接收、责任接受、结果接收和结果验收。
- 异步、长时间运行且可断线恢复的交互。
- 标准 EventEnvelope、Subscription、Cursor、Ack 和 Replay。
- 至少一次投递、幂等命令和乐观并发控制。
- 与 A2A、MCP 和既有工作系统建立 Adapter/Binding，而不依赖其内部实现。
- Canonical JSON Schema、HTTP/JSON 参考 Binding 和自动化一致性测试。

### 2.2 非目标

WFPP v1 不定义：

- Agent 自动匹配、评分、负载均衡、目标选择或智能路由算法；这些由可替换的外部 Target Resolver 实现。
- Workflow 编排或 Agent 内部 Task 执行。
- 模型推理、工具调用和知识检索实现。
- 文件上传协议或大体量二进制传输。
- 点对点权威状态或多 Exchange 联邦一致性。
- 任意表达式订阅语言。
- 自有认证、密钥签发或 Secret 管理体系。
- 跨所有外部系统的分布式事务。
- 客户业务对象的完整内容模型。

## 3. 规范语言与基础标准

本文中的 `MUST`、`MUST NOT`、`SHOULD`、`SHOULD NOT` 和 `MAY` 按 [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) 与 [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) 解释。

WFPP v1 复用：

- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12) 定义 Canonical Schema。
- [CloudEvents 1.0](https://github.com/cloudevents/spec) 作为领域事件信封基础。
- [OpenAPI 3.1](https://spec.openapis.org/oas/) 描述 HTTP/JSON 参考 Binding。
- [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) 表示时间。
- [W3C Trace Context](https://www.w3.org/TR/trace-context/) 传递分布式追踪上下文。

CloudEvents 的 Subscription 规范目前不是稳定发布，因此 WFPP v1 自行定义与 Handoff 语义绑定的 Subscription、Cursor 和 Ack。

## 4. 架构选择

### 4.1 被否决的方案

#### REST Resource API

仅定义资源 CRUD 容易把协议绑定到某个 Server API，无法充分表达异步交接、责任迁移、回执、因果和传输无关性，因此不作为协议核心。

#### A2A Extension Profile

A2A 已提供 Agent Card、能力发现、异步 Task、Message、Artifact 和多种 Binding，适合 Agent-to-Agent 执行交互。但 A2A 以 Client、Remote Agent 和 Agent-managed Task 为中心，不能完整表达 Human/System Actor、第三方 Exchange、责任 Receipt、独立 Verifier 和跨旧系统 Handoff，因此只作为 Agent Binding。

### 4.2 采用的方案

WFPP 使用“稳定协作语义 + 交互状态机 + 消息契约 + 可替换 Binding”四层结构：

```text
L3 Domain Semantics
   Actor / Endpoint / Capability / WorkReference / Handoff / Context / Receipt

L2 Interaction Protocols
   Register / Offer / Accept / Report / Return / Verify / Rework / Transfer

L1 Message Contracts
   Envelope / Version / Idempotency / Correlation / Causation / Error

L0 Bindings
   HTTP+JSON / SSE / Cursor Pull / Webhook / A2A / MCP
```

Domain Semantics 和 Interaction Protocols 是协议稳定核心。Binding 可以独立增加和演进，但不得改变责任迁移与 Receipt 语义。

## 5. 规范角色与权威模型

### 5.1 Initiator

Initiator 代表一个 Actor 发起 Handoff。它可以是 Human Adapter、Agent Endpoint 或 System Connector。

Initiator：

- MUST 使用经过认证的 Binding 连接 Exchange。
- MUST 声明它代表的 Actor 与 Endpoint。
- MUST 提供有效 Delegation，除非 Principal 与 Actor 是同一主体。
- MUST 为每个状态修改提供幂等键。
- MUST 对传入 Context 的来源和授权负责。

### 5.2 Authoritative Exchange

Exchange 是逻辑权威角色，而不是固定部署拓扑。

Exchange：

- MUST 验证 Principal、Actor、Endpoint、Tenant 和 Delegation 的映射。
- MUST 持久化 Handoff 权威状态和单调递增 Resource Version。
- MUST 裁决并发状态修改。
- MUST 在同一事务中提交状态变化与 Outbox Event。
- MUST 签发 Canonical Receipt。
- MUST 提供查询、事件订阅和断线恢复能力。
- MUST NOT 执行 Recipient 的专业工作。

单个 Exchange 可以由单进程、集群、托管服务或企业私有部署实现。v1 不定义多个 Exchange 之间的权威转移。

### 5.3 Recipient

Recipient 接受或拒绝 Handoff。接受后，它在 Work Fabric 之外执行工作，并通过协议报告状态和返回结果。

Recipient：

- MUST 在接受前验证它能够读取必要 Context 并理解 Acceptance Criteria。
- MUST 使用显式 `accept` 承担责任；接收 Notification 不代表接受责任。
- SHOULD 在长时间运行期间报告 Status。
- MUST 通过 `return_result` 返回结果引用、证据或结构化结果。
- MAY 创建子 Handoff 进行再次交接。

### 5.4 Verifier

Verifier 验收结果、请求返工或关闭 Handoff。Verifier 可以与 Initiator 相同，也可以是独立 Actor。

Verifier：

- MUST 被 Handoff 或授权策略明确指定。
- MUST 根据 Acceptance Criteria 验证 Result。
- MUST 使用 `verify`、`request_rework` 或后续 Handoff 表达处理结论。

## 6. 身份、认证与委托边界

WFPP 定义身份和委托语义，但不定义认证协议。

### 6.1 身份对象

| 对象 | 含义 |
|---|---|
| `Principal` | 由 Binding 完成认证的调用身份 |
| `Actor` | 承担协作责任的人、Agent 或系统主体 |
| `Endpoint` | Actor 收发协议消息的具体入口 |
| `RuntimeInstance` | Agent Endpoint 背后的在线运行实例 |
| `Delegation` | Principal 或 Actor 代表另一 Actor 行动的授权关系 |

`Principal` 不由客户端 Payload 自报。Binding 将认证结果传给 Exchange，Exchange 再验证 Payload 中的 `actor_id`、`endpoint_id` 和 `delegation_id`。

### 6.2 Binding 认证

Binding 可以使用 API Key、OAuth、OIDC、mTLS、本地进程凭据或企业网关身份。具体认证方式不影响协议领域对象。

### 6.3 AuthorityScope

`AuthorityScope` 包含：

```json
{
  "delegation_id": "dlg_01",
  "scopes": ["work:read", "artifact:write"],
  "resource_refs": ["urn:work:project:42"],
  "expires_at": "2026-07-14T08:00:00Z",
  "may_redelegate": false
}
```

规则：

- 长期 Credential MUST NOT 出现在 AuthorityScope、Context 或 Extension 中。
- Context 内容 MUST NOT 被解释为授权指令。
- Exchange MUST 对每次状态修改重新校验 AuthorityScope。
- 子 Handoff 的授权范围 MUST 是父 Handoff 授权范围的子集，除非新的独立 Delegation 明确扩大授权。

## 7. 标识、版本与命名规则

### 7.1 标识

协议 ID 是长度不超过 128 的非空不透明字符串。实现 MAY 使用 UUID 或其他全局唯一格式；消费者 MUST NOT 从 ID 格式推断时间、租户或对象类型。

### 7.2 时间

所有协议时间使用 RFC 3339 UTC 字符串，并以 `Z` 结尾。Exchange 记录：

- `occurred_at`：参与端声明的发生时间。
- `recorded_at`：Exchange 持久化时间。

权威顺序由 Resource Version 或 Event Sequence 决定，不由客户端时间决定。

### 7.3 协议版本

- `spec_version` 使用 `major.minor`，v1 固定为 `1.0`。
- 不兼容语义变更必须增加 Major Version。
- 新增向后兼容操作或可选字段可以增加 Minor Version。
- Schema 使用 `urn:work-fabric:schema:v1:<schema-name>` 作为 `$id`。
- Event Type 使用 `workfabric.<domain>.<event>.v1`。

### 7.4 JSON 命名

- Canonical JSON 字段使用 `snake_case`。
- 枚举值使用小写 `snake_case`。
- 稳定对象默认拒绝未知顶层字段。
- 所有扩展进入 `extensions` 对象。
- Extension Key MUST 使用反向域名或组织命名空间，例如 `com.example/risk_score`。
- Extension MUST NOT 改变核心状态机、责任或安全语义。

## 8. Canonical Message Contracts

### 8.1 CommandEnvelope

所有状态修改使用 CommandEnvelope：

```json
{
  "spec_version": "1.0",
  "message_id": "msg_01",
  "message_type": "workfabric.handoff.accept.v1",
  "sent_at": "2026-07-13T08:00:00Z",
  "tenant_id": "tenant_01",
  "exchange_id": "exchange_01",
  "actor_id": "actor_agent_01",
  "endpoint_id": "endpoint_runtime_01",
  "delegation_id": "dlg_01",
  "correlation_id": "corr_01",
  "causation_id": "evt_handoff_offered_01",
  "idempotency_key": "accept-handoff-42-attempt-1",
  "expected_version": 3,
  "trace_context": {
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
  },
  "payload": {},
  "extensions": {}
}
```

规则：

- `message_id` MUST 在发送方范围内唯一。
- `idempotency_key` MUST 出现在所有状态修改命令中。
- `expected_version` MUST 出现在修改既有 Handoff 的命令中。
- `causation_id` SHOULD 引用直接导致当前命令的 Event、Command 或 Receipt。
- Exchange MUST 验证认证 Principal 是否能代表 `actor_id` 和 `endpoint_id`。
- Exchange MUST NOT 将客户端提供的 `sent_at` 用作状态顺序依据。

### 8.2 OperationResult

```json
{
  "spec_version": "1.0",
  "request_message_id": "msg_01",
  "operation_status": "accepted",
  "resource": {
    "resource_type": "handoff",
    "resource_id": "handoff_42",
    "resource_version": 4
  },
  "receipt": {
    "receipt_id": "receipt_01",
    "receipt_type": "responsibility_accepted",
    "recorded_at": "2026-07-13T08:00:00Z"
  },
  "error": null,
  "extensions": {}
}
```

`operation_status` 取值：

- `accepted`：Exchange 已完成协议状态修改。
- `rejected`：请求不合法或无权限，不应原样重试。
- `conflict`：Resource Version 或状态前置条件不满足。
- `temporarily_unavailable`：Exchange 暂时无法处理，可以按 Retry Hint 重试。

同步 OperationResult 只描述 Exchange 是否接受协议操作，不表示外部工作已经完成。

### 8.3 ProtocolError

```json
{
  "code": "version_conflict",
  "message": "handoff version does not match expected_version",
  "retryable": true,
  "retry_after_seconds": null,
  "current_resource_version": 5,
  "field_violations": [],
  "details": {},
  "extensions": {}
}
```

v1 标准错误码：

| Code | 含义 | 默认可重试 |
|---|---|---:|
| `invalid_argument` | Schema 或字段校验失败 | 否 |
| `unauthenticated` | Binding 未建立可信 Principal | 否 |
| `permission_denied` | Principal、Actor 或 Delegation 无权限 | 否 |
| `not_found` | 对象不存在或调用者不可见 | 否 |
| `version_conflict` | `expected_version` 不匹配 | 是，刷新后重试 |
| `invalid_state_transition` | 当前状态不允许该操作 | 否 |
| `idempotency_key_reused` | 相同幂等键被用于不同 Payload | 否 |
| `precondition_failed` | Context、Capability 或其他前置条件未满足 | 视详情而定 |
| `expired` | Handoff、Delegation 或 Context 已过期 | 否 |
| `unsupported_version` | 协议、Schema 或 Capability 版本不支持 | 否 |
| `capability_unavailable` | 没有可接收端点 | 是 |
| `context_unavailable` | 必要 Context 不可读取或不完整 | 是 |
| `cursor_expired` | Subscription Cursor 已超出保留窗口 | 否，按恢复指引处理 |
| `rate_limited` | 达到 Tenant 或 Endpoint 限额 | 是 |
| `temporarily_unavailable` | Exchange 或 Adapter 临时不可用 | 是 |
| `internal` | 未分类内部失败 | 是 |

## 9. Canonical Domain Schemas

### 9.1 ActorRef 与 EndpointRef

```json
{
  "actor_id": "actor_01",
  "actor_type": "agent"
}
```

`actor_type` 取值为 `human`、`agent` 或 `system`。

```json
{
  "endpoint_id": "endpoint_01",
  "actor_id": "actor_01"
}
```

### 9.2 ResourceRef

```json
{
  "uri": "https://example.internal/docs/requirement-42",
  "name": "Requirement 42",
  "media_type": "text/markdown",
  "schema_ref": null,
  "version": "17",
  "digest": {
    "algorithm": "sha-256",
    "value": "base64url-digest"
  },
  "access_hint": "delegated",
  "extensions": {}
}
```

规则：

- `uri` MUST 是绝对 URI。
- `digest` SHOULD 用于需要稳定性或审计的资源。
- `access_hint` 只描述访问方式，不得包含 Credential。
- ResourceRef 不保证接收方可访问；Recipient 应在接受前验证必要引用。

### 9.3 ContentPart

v1 支持三种 ContentPart：

#### TextPart

```json
{
  "kind": "text",
  "media_type": "text/plain",
  "text": "Please implement the approved API contract.",
  "language": "en"
}
```

#### DataPart

```json
{
  "kind": "data",
  "schema_ref": "urn:example:schema:build-request:v1",
  "data": {
    "target": "api-server"
  }
}
```

#### ResourcePart

```json
{
  "kind": "resource",
  "resource": {
    "uri": "urn:git:repo:example:commit:abc123",
    "media_type": "application/vnd.git.commit",
    "version": "abc123",
    "digest": null,
    "extensions": {}
  }
}
```

v1 不支持内联二进制。Binding MAY 对 TextPart 和 DataPart 设置大小上限，并 MUST 在 EndpointDescriptor 中公开限制。

所有 ContentPart 都是不可信输入。Content 中的自然语言、代码或数据不能覆盖 AuthorityScope、协议状态机或 Exchange 策略。

### 9.4 ContextBundle

```json
{
  "context_id": "context_01",
  "version": 3,
  "created_at": "2026-07-13T07:50:00Z",
  "summary": "Approved requirement and implementation constraints",
  "items": [],
  "visibility_scope": {
    "actor_ids": ["actor_agent_01"],
    "endpoint_ids": [],
    "expires_at": "2026-07-14T08:00:00Z"
  },
  "digest": {
    "algorithm": "sha-256",
    "value": "base64url-digest"
  },
  "extensions": {}
}
```

Exchange MUST 保存交接时使用的 Context Version 与 Digest。Context 可以由外部服务组装，但其可见范围必须由 Exchange 验证。

### 9.5 CapabilityDescriptor

```json
{
  "capability_id": "software.implementation",
  "version": "1.0.0",
  "name": "Software implementation",
  "description": "Implements approved changes in a source repository",
  "input_media_types": ["application/json", "text/markdown"],
  "output_media_types": ["application/json", "text/markdown"],
  "input_schema_refs": ["urn:example:schema:implementation-request:v1"],
  "output_schema_refs": ["urn:example:schema:implementation-result:v1"],
  "interaction_modes": ["asynchronous", "status_updates"],
  "constraints": {
    "max_concurrent_handoffs": 4
  },
  "extensions": {}
}
```

Capability 表达可承担的协作能力，不定义其内部实现。Exchange MAY 查询并返回经过授权的候选 Endpoint 事实，但 MUST NOT 对候选进行排名、推荐或自动选择。人工、规则服务或 AI Brain 等外部 Target Resolver 可以使用相同协议读取候选事实并提交明确解析结果。

### 9.6 EndpointDescriptor

```json
{
  "endpoint_id": "endpoint_runtime_01",
  "actor": {
    "actor_id": "actor_agent_01",
    "actor_type": "agent"
  },
  "endpoint_type": "native_agent",
  "display_name": "Local Agent Runtime",
  "protocol_versions": ["1.0"],
  "bindings": [
    {
      "binding_type": "http_sse",
      "uri": "https://agent.example.internal/wfpp",
      "security_schemes": ["oauth2"]
    }
  ],
  "capabilities": [],
  "lease": {
    "expires_at": "2026-07-13T08:05:00Z",
    "renew_after": "2026-07-13T08:03:00Z"
  },
  "limits": {
    "max_inline_content_bytes": 65536
  },
  "extensions": {}
}
```

`endpoint_type` 取值为 `human_adapter`、`native_agent`、`system_connector` 或命名空间扩展值。

### 9.7 AcceptanceCriterion

```json
{
  "criterion_id": "tests-pass",
  "description": "The repository test suite passes",
  "required": true,
  "result_schema_ref": null,
  "required_evidence_types": ["test_report"],
  "extensions": {}
}
```

Acceptance Criterion 可以是人类可读描述、结构化 Result Schema 和 Evidence Requirement 的组合。

## 10. Handoff Model

### 10.1 Handoff Target

Offer MUST 使用以下目标之一：

- 明确 `actor_id`。
- 明确 `endpoint_id`。
- `CapabilityRequirement`。

如果使用 CapabilityRequirement，该 Target 表达尚未解析的能力需求，不授权 Exchange 自动选择接收端。Exchange MAY 返回候选端事实或 `capability_unavailable`；经过授权的外部 Target Resolver 负责提交明确 Actor/Endpoint 解析结果，Exchange 只校验目标满足声明能力、记录解析来源并执行后续 Handoff Dispatch。

直接 Actor/Endpoint Target 不依赖 Resolver。Capability Target 在解析前不产生接收方责任，也不得默认采用首个响应者、随机选择或内置负载均衡。Target Resolution 的规范消息和状态扩展必须在对外开放 Capability Target Binding 前完成；当前 Core Artifact 不能被解释为已经提供内置调度能力。

### 10.2 OfferHandoffCommand Payload

```json
{
  "thread_id": "thread_01",
  "work_reference": {
    "uri": "urn:work:item:requirement-42",
    "media_type": "application/vnd.work-item+json",
    "version": "12",
    "digest": null,
    "extensions": {}
  },
  "target": {
    "endpoint_id": "endpoint_runtime_01"
  },
  "intent": [
    {
      "kind": "text",
      "media_type": "text/plain",
      "text": "Implement the approved change and return code and test evidence",
      "language": "en"
    }
  ],
  "context_bundle": {
    "context_id": "context_01",
    "version": 3,
    "created_at": "2026-07-13T07:50:00Z",
    "summary": "Approved requirement and implementation constraints",
    "items": [
      {
        "kind": "resource",
        "resource": {
          "uri": "https://example.internal/docs/requirement-42",
          "media_type": "text/markdown",
          "version": "17",
          "digest": null,
          "extensions": {}
        }
      }
    ],
    "visibility_scope": {
      "actor_ids": ["actor_agent_01"],
      "endpoint_ids": ["endpoint_runtime_01"],
      "expires_at": "2026-07-14T08:00:00Z"
    },
    "digest": null,
    "extensions": {}
  },
  "authority_scope": {
    "delegation_id": "dlg_01",
    "scopes": ["work:read", "artifact:write"],
    "resource_refs": ["urn:work:item:requirement-42"],
    "expires_at": "2026-07-14T08:00:00Z",
    "may_redelegate": false
  },
  "acceptance_criteria": [
    {
      "criterion_id": "tests-pass",
      "description": "The repository test suite passes",
      "required": true,
      "result_schema_ref": null,
      "required_evidence_types": ["test_report"],
      "extensions": {}
    }
  ],
  "verifier": {
    "actor_id": "actor_pm_01",
    "actor_type": "human"
  },
  "priority": "normal",
  "accept_by": "2026-07-13T09:00:00Z",
  "result_due_at": "2026-07-14T08:00:00Z",
  "extensions": {}
}
```

如果 `thread_id` 省略，Exchange 创建新 CollaborationThread。成功 Offer 后，Exchange 分配 `handoff_id` 并使状态成为 `offered`。

### 10.3 HandoffSnapshot

查询 Handoff 返回当前 Snapshot：

```json
{
  "handoff_id": "handoff_42",
  "thread_id": "thread_01",
  "resource_version": 4,
  "lifecycle_state": "accepted",
  "current_responsible_actor": {
    "actor_id": "actor_agent_01",
    "actor_type": "agent"
  },
  "package": {
    "work_reference": {
      "uri": "urn:work:item:requirement-42",
      "media_type": "application/vnd.work-item+json",
      "version": "12",
      "digest": null,
      "extensions": {}
    },
    "target": {
      "endpoint_id": "endpoint_runtime_01"
    },
    "intent": [
      {
        "kind": "text",
        "media_type": "text/plain",
        "text": "Implement the approved change and return code and test evidence",
        "language": "en"
      }
    ],
    "context_bundle_id": "context_01",
    "context_bundle_version": 3,
    "authority_scope_id": "authority_01",
    "acceptance_criteria_ids": ["tests-pass"],
    "verifier_actor_id": "actor_pm_01",
    "accept_by": "2026-07-13T09:00:00Z",
    "result_due_at": "2026-07-14T08:00:00Z"
  },
  "latest_status": null,
  "result": null,
  "parent_handoff_id": null,
  "created_at": "2026-07-13T07:55:00Z",
  "updated_at": "2026-07-13T08:00:00Z",
  "extensions": {}
}
```

Snapshot 使用 Exchange 规范化后的不可变 Package 表示：Context、AuthorityScope 和 AcceptanceCriteria 可以按 ID 与 Version 引用其已持久化版本，避免在每次查询中复制完整内容。Canonical Schema 必须同时校验这些引用指向当前 Handoff 创建时保存的版本。

## 11. Handoff 生命周期

### 11.1 规范状态

```text
offered
  ├─ accept → accepted
  │             ├─ return_result → result_returned
  │             │                    ├─ verify → verified → close → closed
  │             │                    └─ request_rework → rework_requested
  │             │                                               └─ accept → accepted
  │             ├─ transfer → child offered
  │             │                    └─ child accepted → parent transferred
  │             └─ cancel → cancelled
  ├─ decline → declined
  ├─ expiry → expired
  └─ cancel → cancelled
```

`offered`、`accepted`、`result_returned`、`verified` 和 `rework_requested` 是非终态。

`closed`、`declined`、`expired`、`cancelled` 和 `transferred` 是终态。

`DRAFT` 不属于 v1 互操作状态。客户端或 Exchange 实现可以保存本地草稿，但草稿不产生权威 Handoff、责任或领域事件。

### 11.2 责任规则

- `offered` 被接受前，Initiator 仍承担责任。
- `accepted` 后，责任转移给 Recipient。
- `result_returned` 后，执行责任已经回传，Verifier 承担验收责任。
- `rework_requested` 后，Verifier 等待原 Recipient 重新接受返工。
- Recipient 对返工执行 `accept` 后，责任重新转回 Recipient。
- `transfer` 创建子 Handoff；父 Handoff 在子 Handoff 被接受前仍为 `accepted`，原 Recipient 仍承担责任。
- 子 Handoff 被接受后，父 Handoff 进入 `transferred`，责任由子 Handoff 表达。
- `verified` 后 Verifier 仍承担关闭责任；`closed` 后当前 Handoff 不再具有 Active Responsible Actor。
- `cancelled` 不自动撤销已经发生的外部副作用；调用者必须通过外部补偿或新的 Handoff 处理。
- 每次责任变化必须产生 Canonical Receipt 和领域事件。

### 11.3 外部执行状态

`StatusReport` 与生命周期分离：

```text
not_started
in_progress
waiting
blocked
completed
failed
```

Status 是 Recipient 的声明，不是 Exchange 执行状态。StatusReport 不自动改变 Handoff Lifecycle。

### 11.4 StatusReport

```json
{
  "status_report_id": "status_01",
  "execution_status": "in_progress",
  "progress": 0.4,
  "message": [],
  "observed_at": "2026-07-13T08:30:00Z",
  "next_update_at": "2026-07-13T09:00:00Z",
  "blocked_on": [],
  "extensions": {}
}
```

`progress` 是 `0` 到 `1` 的可选数值，不作为协议状态迁移条件。

## 12. Handoff Operations

### 12.1 Endpoint 与 Capability

| Operation | 作用 |
|---|---|
| `endpoint.register` | 注册或恢复 Endpoint |
| `endpoint.renew` | 续期 Lease 与 Availability |
| `endpoint.withdraw` | 主动退出或停止接收新 Handoff |
| `endpoint.get` | 查询可见 EndpointDescriptor |
| `capability.query` | 按 ID、Version、Media Type 或约束查找候选能力 |

### 12.2 Handoff Commands

| Operation | 合法前态 | 后态或结果 |
|---|---|---|
| `handoff.offer` | 无 | 创建 `offered` |
| `handoff.accept` | `offered`、`rework_requested` | `accepted` |
| `handoff.decline` | `offered` | `declined` |
| `handoff.cancel` | `offered`、`accepted` | `cancelled`，需策略允许 |
| `handoff.report_status` | `accepted` | 生命周期不变 |
| `handoff.return_result` | `accepted` | `result_returned` |
| `handoff.verify` | `result_returned` | `verified` |
| `handoff.close` | `verified` | `closed` |
| `handoff.request_rework` | `result_returned` | `rework_requested` |
| `handoff.transfer` | `accepted` | 创建子 `offered`；父暂不变化 |
| `handoff.get` | 任意可见状态 | 返回 Snapshot |
| `handoff.list` | 无 | 返回权限过滤后的分页 Snapshot |

### 12.3 Transfer 原子性

Transfer 不跨两个 Handoff 建立分布式事务：

1. `handoff.transfer` 原子创建带 `parent_handoff_id` 的子 Handoff。
2. 父 Handoff 保持 `accepted`。
3. 子 Handoff 接受时，Exchange 在同一事务中将子设为 `accepted`、父设为 `transferred`，并签发相关 Receipt。
4. 子 Handoff 拒绝、取消或过期时，父 Handoff 保持 `accepted`。

## 13. Receipt Model

Canonical Receipt 类型：

| Receipt Type | 签发条件 | 含义 |
|---|---|---|
| `delivered` | Delivery Binding 报告成功 | 消息已送达目标通道 |
| `received` | Endpoint 显式 Ack | 端点已经读取协议消息 |
| `responsibility_accepted` | `handoff.accept` 成功 | Actor 已承担责任 |
| `result_received` | `handoff.return_result` 成功 | Exchange 已持久化结果 |
| `result_verified` | `handoff.verify` 成功 | Verifier 已确认结果 |

```json
{
  "receipt_id": "receipt_01",
  "receipt_type": "responsibility_accepted",
  "handoff_id": "handoff_42",
  "actor_id": "actor_agent_01",
  "endpoint_id": "endpoint_runtime_01",
  "resource_version": 4,
  "recorded_at": "2026-07-13T08:00:00Z",
  "extensions": {}
}
```

只有 Exchange 可以签发 Canonical Receipt。Adapter 可以报告 Delivery Fact，但必须由 Exchange 验证并转换为 Receipt。

Subscription Delivery Ack 可以触发 `received` Receipt；它仍然只表示 Endpoint 已读取交接通知。责任变化只能由成功的 `handoff.accept` 触发。

## 14. Result、Artifact 与 Evidence

### 14.1 ReturnResult Payload

```json
{
  "summary": [
    {
      "kind": "text",
      "media_type": "text/plain",
      "text": "Implemented the change and verified the test suite",
      "language": "en"
    }
  ],
  "artifacts": [
    {
      "artifact_id": "artifact_commit_01",
      "artifact_type": "source_commit",
      "resource": {
        "uri": "urn:git:repo:example:commit:abc123",
        "media_type": "application/vnd.git.commit",
        "version": "abc123",
        "digest": null,
        "extensions": {}
      },
      "extensions": {}
    }
  ],
  "evidence": [
    {
      "evidence_id": "evidence_test_01",
      "evidence_type": "test_report",
      "content": {
        "kind": "data",
        "schema_ref": "urn:example:schema:test-report:v1",
        "data": {
          "passed": 42,
          "failed": 0
        }
      },
      "extensions": {}
    }
  ],
  "extensions": {}
}
```

Exchange MUST 验证 Result Schema 和 AuthorityScope，但不负责判断专业内容是否正确；该判断属于 Verifier。

## 15. Event Model

### 15.1 CloudEvents 映射

WFPP 领域事件使用 CloudEvents 1.0 Structured JSON Format。

标准属性：

```json
{
  "specversion": "1.0",
  "id": "evt_01",
  "source": "urn:work-fabric:exchange:exchange_01",
  "type": "workfabric.handoff.accepted.v1",
  "subject": "handoff_42",
  "time": "2026-07-13T08:00:00Z",
  "datacontenttype": "application/json",
  "dataschema": "urn:work-fabric:schema:v1:handoff-accepted-event",
  "data": {
    "resource_version": 4,
    "change": {
      "from_state": "offered",
      "to_state": "accepted"
    },
    "receipt": {
      "receipt_id": "receipt_01",
      "receipt_type": "responsibility_accepted"
    }
  }
}
```

WFPP Extension Attributes：

```text
wftenant
wfexchange
wfthread
wfhandoff
wfactor
wfendpoint
wfcorrelation
wfcausation
wfsequence
wfvisibility
```

Extension Attribute 使用 CloudEvents 要求的小写命名。

### 15.2 v1 Event Types

#### Endpoint

```text
workfabric.endpoint.registered.v1
workfabric.endpoint.renewed.v1
workfabric.endpoint.withdrawn.v1
workfabric.capability.changed.v1
```

#### Handoff

```text
workfabric.handoff.offered.v1
workfabric.handoff.accepted.v1
workfabric.handoff.declined.v1
workfabric.handoff.cancelled.v1
workfabric.handoff.expired.v1
workfabric.handoff.status_reported.v1
workfabric.handoff.result_returned.v1
workfabric.handoff.verified.v1
workfabric.handoff.closed.v1
workfabric.handoff.rework_requested.v1
workfabric.handoff.transferred.v1
```

#### Receipt 与 Delivery

```text
workfabric.receipt.recorded.v1
workfabric.delivery.failed.v1
workfabric.subscription.suspended.v1
```

### 15.3 Event 数据

Event Data MUST 包含：

- `resource_version`。
- `change`：最小状态变化信息。
- `receipt`：如果本次变化签发 Receipt。
- `snapshot`：可选、权限过滤后的当前 Snapshot。

Event Data MUST NOT 默认嵌入完整 Context 或大型 Result。

### 15.4 顺序与不可变性

- Event 是不可变事实。
- Exchange MUST 为每个 Handoff 维护单调递增 `wfsequence`。
- Exchange MUST 保证单 Handoff Event 按 Sequence 可重放。
- v1 不保证不同 Handoff 或 Thread 的全局顺序。
- `occurred_at` 相同或乱序时仍以 Sequence 和 Resource Version 为准。

## 16. Subscription 与 Delivery

### 16.1 SubscriptionFilter

```json
{
  "event_types": ["workfabric.handoff.offered.v1"],
  "actor_ids": ["actor_agent_01"],
  "endpoint_ids": [],
  "thread_ids": [],
  "handoff_ids": [],
  "work_reference_uris": [],
  "capability_ids": ["software.implementation"],
  "lifecycle_states": ["offered"],
  "extensions": {}
}
```

过滤语义：

- 同一字段内多个值使用 OR。
- 不同字段之间使用 AND。
- 空字段不参与过滤。
- Exchange MUST 在 Filter 之后继续执行 Visibility 与 Tenant 权限过滤。
- v1 不支持任意表达式和脚本过滤。

### 16.2 Delivery Modes

#### Cursor Pull

所有 v1 Exchange MUST 支持 Cursor Pull：

1. Endpoint 使用 Subscription ID 和可选 Cursor 拉取 Event。
2. Exchange 返回 `delivery_id`、Events 和不透明 `next_cursor`。
3. Endpoint 使用 `delivery_id` Ack。
4. Visibility Timeout 内未 Ack 的 Delivery 可以再次出现。

#### SSE Stream

HTTP 参考 Binding SHOULD 支持从 Cursor 开始的 SSE Stream。断线后 Endpoint 使用最后已 Ack Cursor 恢复。

#### Webhook Push

Webhook 是可选 Binding。HTTP 2xx 只表示 Delivery 成功，不表示 Responsibility Accepted。Webhook MUST 使用 Binding 级认证或签名。

### 16.3 投递保证

- Delivery 是 at-least-once。
- Endpoint MUST 按 CloudEvent `id` 去重。
- Ack 只确认 Event Delivery，不改变 Handoff Lifecycle。
- Cursor 是 Exchange 不透明值，客户端不得解析。
- Exchange 必须公开 Retention Policy 和最早可用 Cursor。
- 请求过期 Cursor 时返回 `cursor_expired`，并提供最早可重放位置或 Snapshot 恢复指引。

## 17. HTTP/JSON 参考 Binding

### 17.1 Required Endpoints

```text
POST   /v1/endpoints
POST   /v1/endpoints/{endpoint_id}:renew
POST   /v1/endpoints/{endpoint_id}:withdraw
GET    /v1/endpoints/{endpoint_id}
GET    /v1/capabilities

POST   /v1/handoffs
GET    /v1/handoffs/{handoff_id}
GET    /v1/handoffs
POST   /v1/handoffs/{handoff_id}:accept
POST   /v1/handoffs/{handoff_id}:decline
POST   /v1/handoffs/{handoff_id}:cancel
POST   /v1/handoffs/{handoff_id}:report-status
POST   /v1/handoffs/{handoff_id}:return-result
POST   /v1/handoffs/{handoff_id}:verify
POST   /v1/handoffs/{handoff_id}:close
POST   /v1/handoffs/{handoff_id}:request-rework
POST   /v1/handoffs/{handoff_id}:transfer

POST   /v1/subscriptions
GET    /v1/subscriptions/{subscription_id}
DELETE /v1/subscriptions/{subscription_id}
GET    /v1/subscriptions/{subscription_id}/events
GET    /v1/subscriptions/{subscription_id}/stream
POST   /v1/subscriptions/{subscription_id}:ack
```

### 17.2 Header 映射

| Protocol Semantics | HTTP Binding |
|---|---|
| Idempotency Key | `Idempotency-Key` Header，同时保留 Envelope 字段；二者 MUST 一致 |
| Expected Version | `If-Match` 与 Envelope `expected_version`；同时存在时 MUST 一致 |
| Trace Context | `traceparent` 与 `tracestate` |
| Authentication | `Authorization`、mTLS 或部署定义机制 |
| Protocol Version | `WFPP-Version: 1.0` |

### 17.3 HTTP Status

| HTTP | 含义 |
|---:|---|
| `200` | 查询或幂等重放成功 |
| `201` | Endpoint、Handoff 或 Subscription 创建成功 |
| `202` | 异步投递已被 Exchange 接受 |
| `400` | `invalid_argument` |
| `401` | `unauthenticated` |
| `403` | `permission_denied` |
| `404` | `not_found`，也用于隐藏不可见资源 |
| `409` | `version_conflict`、`invalid_state_transition` 或 `idempotency_key_reused` |
| `410` | `expired` 或 `cursor_expired` |
| `412` | `precondition_failed` |
| `429` | `rate_limited` |
| `503` | `temporarily_unavailable` |

HTTP Status 只表示当前协议操作结果，不表示 Recipient 工作完成。

## 18. 幂等、并发与恢复

### 18.1 幂等

- 状态修改 Command MUST 带 `idempotency_key`。
- 同一 `tenant_id`、`endpoint_id`、`message_type` 和 `idempotency_key` 下，相同语义 Payload MUST 返回原 OperationResult。
- 相同 Key 与不同 Payload MUST 返回 `idempotency_key_reused`。
- Exchange MUST 保留 Key 至少覆盖其公开的最大重试窗口。

### 18.2 乐观并发

- 修改既有 Handoff MUST 带 `expected_version`。
- 不匹配时返回 `version_conflict`、当前 Version 和可见 Snapshot。
- 客户端 MUST 刷新状态并重新判断，而不是盲目递增 Version 重试。

### 18.3 Endpoint Lease

- Native Agent Endpoint SHOULD 使用 Lease 表达在线和可接收状态。
- Lease 过期只改变 Endpoint Availability，不自动取消已接受 Handoff。
- Exchange MUST 发布 Endpoint 失联事件。
- 重新分派或人工接管由 Actor、策略或外部服务通过新 Handoff 表达。

### 18.4 状态恢复

Endpoint 重连后：

1. 恢复 Endpoint Lease。
2. 查询当前被分派和已接受 Handoff Snapshot。
3. 从最后 Ack Cursor 重放 Event。
4. 按 Event ID 去重。
5. 对本地状态和 Exchange Snapshot 执行对账。

## 19. A2A Binding Profile

[A2A](https://a2a-protocol.org/latest/specification/) 作为 Agent Endpoint 的可选 Binding，不是 WFPP Core 依赖。

### 19.1 映射

| A2A | WFPP |
|---|---|
| Agent Card | EndpointDescriptor + CapabilityDescriptor |
| Agent Interface | BindingDescriptor |
| Agent Skill | CapabilityDescriptor |
| Message Part | ContentPart |
| Task | External Execution Reference |
| Task Status | StatusReport 输入 |
| Artifact | ArtifactRef / EvidenceRef |
| Context ID | CollaborationThread 外部关联 |

### 19.2 关键边界

- WFPP Handoff MUST NOT 与 A2A Task 使用同一个生命周期对象。
- A2A Adapter 是 WFPP Recipient Endpoint。
- Adapter 接受 WFPP Handoff 后，可以创建 A2A Task，并把 Task ID 存为 External Execution Reference。
- A2A Task `working`、`input-required`、`auth-required`、`failed` 等状态映射为 WFPP StatusReport。
- A2A Task `completed` 不自动验证 WFPP Handoff；Adapter 必须执行 `return_result`，Verifier 再执行 `verify`。
- A2A Agent 身份和 WFPP Actor/Delegation 必须显式映射。

## 20. MCP Binding Profile

[MCP](https://modelcontextprotocol.io/specification/latest) 作为 Context 和 Tool 能力的可选 Binding。

### 20.1 映射

| MCP | WFPP |
|---|---|
| Resource | ResourceRef / ResourcePart |
| Resource Template | Context Resolver Hint |
| Tool | Capability 输入，但不是 Actor |
| Tool Result | ContentPart / ArtifactRef |
| Prompt | 可选 Context Content，不是 Authority |

### 20.2 关键边界

- MCP Tool 本身不承担责任，不能直接成为 Handoff Recipient。
- 只有包装 Tool 的 Actor/Endpoint 可以接受 Handoff。
- MCP Resource 访问权限仍由 Handoff AuthorityScope 和 Binding Authentication 共同约束。
- MCP Content 不得提升权限或改变 Handoff 状态。

## 21. 安全与隐私

- 生产远程 Binding MUST 使用加密传输。
- Exchange MUST 对每个对象执行 Tenant 与 Visibility 过滤。
- `not_found` 可以用于隐藏调用者无权知道是否存在的资源。
- Event 和 Context 的 Visibility MUST 分别校验。
- Webhook MUST 防重放并验证来源。
- ContentPart 必须视为不可信数据，特别是面向 Agent 的自然语言 Context。
- AuthorityScope、Verifier 和 Acceptance Criteria 只能来自协议结构与授权策略，不能从 TextPart 自动推断。
- 日志和 Event MUST 避免记录 Secret、完整 Credential 和不必要的敏感内容。
- ResourceRef SHOULD 使用短期、受限访问方式，并避免永久公开 URL。
- Extension 数据与核心字段接受相同的 Tenant、Visibility 和审计策略。

## 22. Conformance Profiles

### 22.1 Schema Conformance

所有实现都必须通过：

- Canonical JSON Schema 正例。
- 缺失 Required Field、错误 Type、未知顶层字段和非法 Enum 反例。
- Extension Namespace 验证。
- Protocol Version 与 Schema ID 验证。

### 22.2 Exchange Core Profile

合规 Exchange 必须支持：

- Endpoint Register/Renew/Withdraw。
- Capability Query。
- 全部规范 Handoff 状态迁移。
- Receipt 签发。
- 幂等与 Version Conflict。
- Outbox Event 与 Handoff 原子提交。
- Cursor Pull Subscription 和 Replay。
- Tenant、Actor、Delegation 与 Visibility 校验。

### 22.3 Endpoint Client Profile

合规 Endpoint 必须支持：

- 注册、版本和 Capability 声明。
- Event 去重和 Cursor 恢复。
- 明确 Accept/Decline。
- StatusReport 和 Result 返回。
- ProtocolError 和 Version Conflict 处理。
- Context 可访问性前置检查。

### 22.4 Optional Profiles

- HTTP+SSE Profile。
- Webhook Delivery Profile。
- Human Channel Adapter Profile。
- System Connector Profile。
- A2A Agent Binding Profile。
- MCP Context/Tool Binding Profile。

## 23. Conformance Golden Scenarios

v1 一致性套件至少覆盖：

1. **幂等 Offer**：相同 Key 和 Payload 返回同一 Handoff；不同 Payload 返回错误。
2. **并发 Accept**：两个 Endpoint 使用同一 Version 接受，只有一个成功。
3. **Delivery 不等于责任**：`delivered` 和 `received` 不改变 `offered`。
4. **责任接受**：`accept` 签发 `responsibility_accepted` 并改变 Current Responsible Actor。
5. **外部状态报告**：StatusReport 不改变 Lifecycle。
6. **结果与验收分离**：`return_result` 不等于 `verify`。
7. **返工**：`request_rework` 后原 Recipient 重新 `accept`。
8. **Transfer**：子 Handoff 接受前父责任不变；接受后父进入 `transferred`。
9. **Context 不可访问**：Recipient 返回前置条件错误，不承担责任。
10. **越权 Actor**：认证 Principal 无法代表 Payload Actor 时被拒绝。
11. **断线重放**：Endpoint 从 Ack Cursor 恢复并对重复 Event 去重。
12. **外部状态对账**：Connector 报告冲突时形成显式 Reconciliation Event，而不静默覆盖。
13. **A2A Adapter**：A2A Task Completed 只产生 Result Return，不自动 Verify。
14. **MCP Tool**：Tool 只能作为 Endpoint 能力，不能直接成为 Responsible Actor。

## 24. 规范产物与仓库结构

Protocol v1 实施阶段产物：

```text
protocol/
├── README.md
├── spec/
│   ├── core.md
│   ├── roles.md
│   ├── interactions.md
│   ├── events.md
│   ├── subscriptions.md
│   ├── security.md
│   └── versioning.md
├── schemas/
│   └── v1/
│       ├── common/
│       ├── identity/
│       ├── endpoint/
│       ├── handoff/
│       ├── content/
│       ├── events/
│       └── subscriptions/
├── bindings/
│   ├── http-openapi.yaml
│   ├── http.md
│   ├── sse.md
│   ├── webhook.md
│   ├── a2a.md
│   └── mcp.md
├── examples/
│   ├── human-to-agent/
│   ├── agent-to-agent/
│   └── system-agent-system/
└── conformance/
    ├── manifest.yaml
    ├── positive/
    ├── negative/
    └── scenarios/
```

Schema 是数据契约的机器可读 Source of Truth；文字规范定义 Schema 无法完整表达的角色、状态机、责任和安全要求。两者冲突时实现必须报告规范缺陷，不得自行选择语义。

## 25. 实施顺序

Protocol v1 设计是总体规范，实施必须拆分为三个顺序子项目，不能在一个实施计划中同时完成协议、服务和所有 Adapter：

1. **Core Protocol Artifacts**：文字规范、Canonical Schema、状态机、Event Catalog、Subscription Schema、Golden Fixtures 和 Schema Conformance Runner。
2. **Reference Bindings**：HTTP/OpenAPI、Cursor Pull、SSE、Webhook 以及 Binding Conformance。
3. **Ecosystem Profiles**：A2A、MCP、Human Adapter 和 System Connector Profile。

第一个实施计划只覆盖 Core Protocol Artifacts，并按以下顺序执行：

1. 规范目录、术语、版本与命名规则。
2. Common、Identity、Content 和 Endpoint Schema。
3. HandoffPackage、Snapshot、Status、Result 和 Receipt Schema。
4. CommandEnvelope、OperationResult、ProtocolError。
5. Handoff 状态机和 Golden Scenarios。
6. CloudEvents Event Data Schema 与 Event Catalog。
7. Subscription、Cursor、Delivery 与 Ack Schema。
8. Schema Validator、Conformance Runner 和 Reference Examples。

HTTP、Event Delivery Binding 与生态 Adapter 分别在后续计划中实施。

## 26. 设计验收标准

Protocol v1 设计在以下条件全部满足时成立：

- 协议可以脱离 Work Fabric Server 被第三方独立实现。
- Exchange 是逻辑权威角色，而非固定中心部署要求。
- Human、Agent 和 System 使用同一套责任交接语义。
- Agent 与外部系统的实际执行状态不与 Handoff Lifecycle 混合。
- 消息送达、责任接受、结果返回和结果验收具有独立 Receipt。
- 所有状态修改具备幂等和乐观并发语义。
- Context 与 Result 引用优先，且不携带长期 Credential。
- Event、Subscription、Cursor、Ack 和 Replay 具有明确至少一次语义。
- A2A Task 和 MCP Tool 可以接入，但不替代 Handoff、Actor 和 AuthorityScope。
- Canonical Schema、文字规范、OpenAPI Binding 和 Conformance Scenario 边界清晰。
- 删除所有可选 Adapter 后，Core Handoff Protocol 仍可独立工作。

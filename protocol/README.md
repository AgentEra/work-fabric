# Work Fabric Participation Protocol v1

WFPP v1 是 Work Fabric 的语言无关核心协议。它定义人、Agent 与工作系统如何声明身份与能力，如何提出、接受和转移 Handoff，如何传递受限 Context，如何报告外部执行状态、返回结果、验收结果，以及如何订阅可重放的协作事件。

协议管理协作边界，不执行专业工作。推理、编码、文档编辑、业务处理和部署始终发生在参与方或外部系统内部。

## 规范结构

- [核心语义](spec/core.md)
- [角色与责任](spec/roles.md)
- [交互与生命周期](spec/interactions.md)
- [事件](spec/events.md)
- [订阅与投递](spec/subscriptions.md)
- [安全与授权](spec/security.md)
- [版本与兼容](spec/versioning.md)
- [机器可读 Handoff 生命周期](spec/handoff-lifecycle.json)
- [机器可读交互 Payload 映射](spec/interaction-payloads.json)
- [一致性用例](conformance/)
- [参考序列](examples/)

关键词 MUST、MUST NOT、REQUIRED、SHOULD、SHOULD NOT 和 MAY 按 RFC 2119 与 RFC 8174 解释。

## 分层与边界

WFPP Core 包含领域语义、交互语义、Canonical Message、Schema、事件和订阅语义。HTTP、SSE、Webhook、A2A、MCP、本地 IPC 与 SDK 属于 Binding 或 Adapter；它们可以承载 WFPP，但不能重定义 Handoff、责任、Receipt、AuthorityScope 或生命周期。

Authoritative Exchange 是逻辑角色，不限制单体、集群、嵌入式或联邦部署。Work Fabric Server 将作为参考实现，但不属于本协议包。

## Schema 索引

所有 Schema 使用 JSON Schema Draft 2020-12，稳定对象默认拒绝未知字段。扩展只能进入命名空间化 `extensions`。

### 身份与基础

- `urn:work-fabric:schema:v1:trace-context`
- `urn:work-fabric:schema:v1:actor-ref`
- `urn:work-fabric:schema:v1:endpoint-ref`
- `urn:work-fabric:schema:v1:authority-scope`

### 内容与上下文

- `urn:work-fabric:schema:v1:resource-ref`
- `urn:work-fabric:schema:v1:content-part`
- `urn:work-fabric:schema:v1:context-bundle`

### Endpoint 与能力发现

- `urn:work-fabric:schema:v1:binding-descriptor`
- `urn:work-fabric:schema:v1:capability-descriptor`
- `urn:work-fabric:schema:v1:endpoint-descriptor`

### Handoff、状态、结果与回执

- `urn:work-fabric:schema:v1:acceptance-criterion`
- `urn:work-fabric:schema:v1:capability-requirement`
- `urn:work-fabric:schema:v1:handoff-target`
- `urn:work-fabric:schema:v1:handoff-offer`
- `urn:work-fabric:schema:v1:handoff-reference`
- `urn:work-fabric:schema:v1:handoff-cancel-command`
- `urn:work-fabric:schema:v1:handoff-status-command`
- `urn:work-fabric:schema:v1:handoff-result-command`
- `urn:work-fabric:schema:v1:handoff-verification-command`
- `urn:work-fabric:schema:v1:handoff-rework-command`
- `urn:work-fabric:schema:v1:handoff-transfer-command`
- `urn:work-fabric:schema:v1:handoff-snapshot`
- `urn:work-fabric:schema:v1:status-update`
- `urn:work-fabric:schema:v1:artifact`
- `urn:work-fabric:schema:v1:evidence`
- `urn:work-fabric:schema:v1:result-submission`
- `urn:work-fabric:schema:v1:operation-receipt`

### 消息与错误

- `urn:work-fabric:schema:v1:resource-version-ref`
- `urn:work-fabric:schema:v1:command-envelope`
- `urn:work-fabric:schema:v1:operation-result`
- `urn:work-fabric:schema:v1:protocol-error`

### 事件与订阅

- `urn:work-fabric:schema:v1:event-data`
- `urn:work-fabric:schema:v1:protocol-event`
- `urn:work-fabric:schema:v1:subscription-filter`
- `urn:work-fabric:schema:v1:subscription`
- `urn:work-fabric:schema:v1:event-delivery`
- `urn:work-fabric:schema:v1:delivery-ack`

`definitions` 是内部共享 Schema，不作为独立消息声明兼容性。

## 一致性验证

```bash
npm ci
npm run verify
```

`npm run conformance` 会加载全部 Schema，运行正负 Golden Fixtures、生命周期场景、Exchange Core 行为清单和覆盖检查。实现只有在全部用例通过后，才可以声明兼容对应的 WFPP v1 Profile。

## 参考序列

- [Human → Agent](examples/human-to-agent/sequence.json)
- [Agent → Agent](examples/agent-to-agent/sequence.json)
- [System → Agent → System](examples/system-agent-system/sequence.json)

三个序列中的消息与状态迁移会在测试中使用本目录的 Canonical Schema 和状态机直接验证。

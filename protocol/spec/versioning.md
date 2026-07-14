# WFPP v1 Versioning and Conformance

## 1. 版本

`spec_version` 使用 `major.minor`。v1 Core 固定为 `1.0`。不兼容字段、状态或责任语义变更必须增加 Major；新增可选字段或向后兼容交互可以增加 Minor。

Schema ID 使用 `urn:work-fabric:schema:v1:<schema-name>`。Event Type 使用 `workfabric.<domain>.<event>.v1`。Capability 使用自身语义版本，并与协议版本独立协商。

## 2. 未知字段与扩展

稳定对象默认 `additionalProperties: false`。实现 MUST NOT 静默赋予未知字段业务语义。扩展进入命名空间化 `extensions`，并且旧实现可以安全忽略不影响核心语义的扩展。

## 3. Conformance Profiles

Schema Profile 要求实现正确验证并生成 Canonical JSON。Exchange Core Profile 额外要求生命周期、幂等、并发、Receipt、Event、Subscription 和恢复语义。Endpoint Client Profile 要求身份呈现、发现、命令、去重、Cursor 与 Ack 行为。

HTTP、SSE、Webhook、A2A、MCP 或其他 Binding Profile 会在独立规范中定义，不能替代 Core Profile。

## 4. 一致性证据

本仓库的 Golden Fixture、Lifecycle Scenario 与 Exchange Contract 是 v1 的可执行基线。声明兼容的实现 SHOULD 在 CI 中运行相同用例，并记录协议版本、实现版本和测试结果。

`npm run conformance` 成功只证明 Core Artifact 自洽；它不证明某个远程 Server 已通过网络、故障恢复、持久化或安全测试。Server Profile 将增加对应测试套件。

## 5. 兼容策略

消费者 SHOULD 忽略已知兼容版本中的可选 Extension，但 MUST 拒绝不支持的 Major Version。Endpoint 注册时声明支持的协议版本。Exchange 不得把不兼容版本自动降级为看似成功的 Handoff。

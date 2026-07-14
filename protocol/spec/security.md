# WFPP v1 Security and Authority

## 1. 认证边界

WFPP 定义身份和授权语义，不定义认证协议。Binding 可以采用 OAuth、OIDC、mTLS、API Key、本地进程身份或企业网关身份。长期 Credential MUST 留在 Binding 边界，不得进入 Command、Context、AuthorityScope、Event、Result 或 Extension。

## 2. Delegation

Exchange MUST 校验已认证 Principal 是否可以代表 Command 中的 Actor 与 Endpoint。Delegation 有明确 ID、Scope、Resource、Expiry 和 Redelegation 标志。

每次状态修改都必须重新验证 Authority。子 Handoff 的 Authority MUST 是父范围的子集，除非新的独立 Delegation 明确扩大授权。

## 3. Context 与提示注入

Context、Content、Result 和外部资源均是不可信输入。自然语言、代码或结构化 Data 不得修改协议状态机、AuthorityScope、Verifier、Acceptance Criteria 或 Exchange 策略。

Agent Runtime SHOULD 将协议控制字段与工作内容放在不同信任通道中，并对工具调用执行独立授权。

## 4. 最小披露

Exchange MUST 在返回 Snapshot、Event 和 Subscription Delivery 前执行 Tenant、Visibility 和 Authority 过滤。ResourceRef SHOULD 使用短期、受限访问方式，避免永久公开 URL。

ContextBundle 的 Visibility Scope 和 Expiry 必须在读取时检查，而不是只在 Offer 时检查。审计记录可以保留引用与 Digest，但不应无条件复制敏感正文。

## 5. 重放与并发

Idempotency Key、Resource Version、Event ID 和 `wfsequence` 共同防止重复副作用、陈旧写入与事件乱序。实现 MUST 比较规范化 Payload；同一 Idempotency Key 绑定不同 Payload 时拒绝处理。

## 6. Extension

Extension Key MUST 使用反向域名或组织命名空间。Extension 不能改变核心责任、生命周期或安全语义，也不能承载 Credential、私钥或访问令牌。

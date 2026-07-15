# WFPP v1 Core

## 1. 目的

WFPP 统一异构参与方之间的协作对接和责任交接。协议的最小稳定抽象是 Actor、Endpoint、Work Reference、Handoff、Context、Authority、Status、Result、Receipt、Event 与 Subscription。

执行主体在外部完成工作。Exchange MUST NOT 把内部推理、工具调用或业务流程步骤虚构为权威 Handoff 状态。

## 2. 标识与时间

协议 ID MUST 是 1 到 128 字符的不透明字符串。消费者 MUST NOT 从格式推断时间、租户或类型。

协议时间 MUST 是 RFC 3339 UTC 字符串并以 `Z` 结尾。客户端发生时间不决定权威顺序；Resource Version 和 `wfsequence` 决定顺序。

`spec_version` 在 v1 固定为 `1.0`。Canonical JSON 字段使用 `snake_case`，枚举使用小写 `snake_case`。

## 3. 内容模型

`ContentPart` 仅允许 Text、Data 和 Resource 三类。Core 不支持内联二进制。Content 一律是不可信输入，不能覆盖 AuthorityScope、生命周期、Verifier 或 Exchange 策略。

`ResourceRef` 指向外部权威内容。引用本身不保证接收方可访问；Recipient SHOULD 在接受责任前验证必要资源。

`ContextBundle` 固定版本、可见范围、有效期和 Digest。Exchange MUST 保存交接采用的 Context 版本。Context 组装可以发生在独立 Workspace/Context 服务中，也可以由 Exchange 持久化；两种方式必须保持相同可见性和版本语义。

## 4. Handoff Package

Offer 描述工作引用、唯一目标、Intent、可选 Context、AuthorityScope、Acceptance Criteria、Verifier、优先级和时限。目标可以是 Actor、Endpoint 或 Capability Requirement，三者必须且只能选择一个。

Actor/Endpoint Target 是明确地址。Capability Requirement Target 表达尚未解析的能力需求，不授权 Exchange 内置选择接收方；人工、规则服务或 AI Brain 等外部 Target Resolver 通过 `handoff.resolve_target` 提交明确解析结果，或通过 `handoff.report_target_unavailable` 记录无法解析的透明结果。Exchange 负责候选事实、目标资格校验、权威记录和后续可靠派发，不负责匹配、排名、推荐或执行计划。

Capability Offer 创建 `target_resolution_pending` Handoff。成功解析后，原始 Capability Requirement 保持不可变，明确 Actor/Endpoint 作为独立 Target Binding 被记录，Handoff 才进入 `offered`。`target_unavailable` 是透明终态；并发解析只允许一个权威 Binding 被提交，这一存储不变量不构成业务调度策略。

成功 Offer 后 Exchange 分配 `handoff_id`，持久化不可变 Package，并建立初始 `offered` 状态。Package 的 Context、Authority 和 Criteria 可以按已保存版本引用，避免重复大型内容。

## 5. 外部状态与结果

`StatusUpdate` 是 Recipient 对外部执行的声明，MUST NOT 直接改变 Handoff 生命周期。`progress` 只用于透明度，不是迁移条件。

`ResultSubmission` 包含摘要、Artifact Reference 与 Evidence。Exchange MUST 验证结构、引用和 Authority；专业正确性由 Verifier 判断。

## 6. Receipt

Canonical Receipt 只能由 Authoritative Exchange 签发。`delivered`、`received`、`responsibility_accepted`、`result_received` 与 `result_verified` 是不同事实。

成功的 Operation Result 必须返回 Resource Version；只有生命周期明确签发 Receipt 的交互才返回非空 `receipt`。当前 Handoff Core 仅在 Accept、Return Result 与 Verify 成功时签发对应 Receipt，Offer、Status、Close、Cancel 等成功交互必须显式返回 `receipt: null`，不得虚构 Receipt。

消息送达或 Delivery Ack MUST NOT 被解释为责任接受。责任只由成功的 `handoff.accept` 迁移。

## 7. 可靠性

所有状态修改命令 MUST 携带 Idempotency Key。修改既有资源的命令 MUST 携带期望 Resource Version。相同 Key 与相同 Payload 返回原结果；相同 Key 与不同 Payload 返回 `idempotency_key_reused`。

事件投递采用 at-least-once。Endpoint MUST 按 CloudEvent `id` 去重，并用 `wfsequence` 与 Resource Version 处理单 Handoff 顺序。

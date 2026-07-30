# Work Fabric 架构执行规则

本仓库中的所有方案、计划、实现、测试和文档变更都必须先遵守
[Work Fabric 项目章程](PROJECT_CHARTER.md)。
局部功能需求、交付压力、厂商限制和实现便利不能覆盖这些规则。

## 开始任何设计或实现前

必须先完成并写出 `Architecture Boundary Check`：

1. 本次新增的每一份状态分别归 Fabric、Agent、Channel、Provider 还是外部
   系统所有？
2. 每一个动作由哪个 Citizen 主动发起？
3. Fabric 是否只做协议校验、可靠传播、浅层状态记录和审计？
4. 是否出现 Fabric 根据业务内容、等待条件、时间或结果主动调用 Citizen、
   选择下一步或创建下游业务任务？
5. 模块之间是否只通过 Handoff、Event、Subscription、Receipt 或稳定 SPI
   交换事实？
6. 删除新增模块后，Exchange Core 和无关 Citizen 是否仍能正常工作？
7. 是否为了单一厂商或业务场景向 Core 增加了条件分支、状态或字段？

第 4、5、6 或 7 项不满足时，必须停止实现并重新划分模块边界。业务决策、
流程推进、等待与恢复策略应移动到外部 Decision Body、Agent Runtime、
Capability Provider 或其他独立 Citizen，而不是进入 Fabric。

## 永久禁止

- 把 Work Fabric 设计成 Workflow Engine、Agent Brain、业务调度器或自动化
  执行器。
- 在 Fabric 中增加根据业务条件主动推进流程的 Wait、Resume、Scheduler、
  Planner、Coordinator 或类似模块。
- 让 Fabric 理解消息正文、推断业务意图、选择参与人、判断信息是否充分或
  生成语义结果。
- 让一个 Citizen 导入另一个 Citizen 的实现、读取其私有 Store，或依赖其
  进程内对象。
- 为飞书、日历、文档或其他单一集成在 Exchange Core 中增加特殊路径。
- 把数据库、Broker、缓存、YAML、SDK 或内部 State Store 注册为网络公民。

## Fabric 允许的机械行为

Fabric 可以验证 Authority 和协议状态、持久化 Handoff 与参与方声明的浅层
Status、可靠投递、按既有 Subscription 扇出、重放相同事实、执行幂等去重、
维护 Lease/Fencing、构建投影并记录审计。机械重试不得生成新的业务意图、
改变接收方、解释内容或决定下一业务步骤。

如果用户请求与这些规则冲突，必须明确指出冲突并停在设计阶段；只有项目
Owner 明确批准修改 canonical 架构不变量后，才能先更新架构文档，再开始
实现。

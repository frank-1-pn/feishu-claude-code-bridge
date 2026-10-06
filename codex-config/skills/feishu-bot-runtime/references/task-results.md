# 独立任务卡与结构化结果

本协议仅适用于真实运行时在本轮提示中提供的新版任务结果协议。安装源码或阅读本文不代表已生效；私有入站任务的 `taskResultProtocolVersion:1` 与 cwd/home 快照由原 worker 在首次接收时保存。历史任务不补版本、不重新执行业务、不拆分或重发已送达共享答复。原唯一订阅、绑定、writer 与业务权限保持。

## 提交本任务的结果

先沿用原消息 actionable 与标签进度流程。每个独立任务分别提交结构化结果；同一 Codex turn 的自然 final 不能替代结果协议，也不会猜测、复制或拆分到多张卡。无结果的异常保留原任务、诊断与原卡超时反馈，不重投业务。

把本任务结果写入当前绑定 cwd 内私有 0600 regular JSON 文件，无符号链接、单 hardlink，最大 96 KiB；text 最大 64 KiB。示例标识和目录均为占位：

```json
{"resultKey":"answer-v1","title":"查询日程","text":"本任务的结论、实际读回和必要限制。","status":"complete"}
```

```sh
node "<daemon>/codex-bridge-task-results-cli.mjs" --bot <bot> --job-id <本轮原message_id> --action complete --request-file "<当前cwd内绝对路径>"
```

状态仅用 complete、waiting、failed、background。缺少条件用 waiting；持久后台入队成功后的简短确认用 background；实际业务失败用 failed。background 卡显示仍在处理，不把入队当成任务完成。text 中的多个缺项可继续使用真实协议的 feishu-form 尾块；只有 waiting 可以带合法条件表单。

工具 queued 只证明不可变结果已受理，不能冒充送达。提交后释放对话，不再手发群消息或重复完整 final。runtime 验证原消息、真实分类/marker、绑定与私有快照后，分别将结果送回各自原卡；报告、附件与按钮绑定该任务。

## 补充条件与后台完成

仅明确属于原任务、同发送者的真实 parent/reply_to 链可显式关联；直接回复 bot 原任务卡时，通过私有出站卡片与原任务的唯一映射核验。共享 turn、root/thread、最近一条消息不构成关联；无真实链、跨发送者或多候选时澄清，不能猜测。业务权限与多人 CT 上下文继续独立核对，本入口不执行资源变更。

先把以下 JSON 写入同要求私有文件，再使用当前补充消息的 job-id 调用同入口 --action link：

```json
{"targetJobId":"om_original_placeholder"}
```

之后仍用补充消息的 job-id 提交结构化结果，runtime 更新原任务卡。已出现的额外补充进度卡只收尾为已关联，不复制完整报告；关联受理不等于该补充已完成。只有确实由该输入产生的结果送达后，才结束对应补充记录。

原卡的条件表单、再简短一点、补充依据与转表格回调继续沿用既有 ActionStore 验签和受理队列；原操作、context HMAC、绑定、卡片与版本必须匹配。首次提交结果核对当前版本，已接受的历史操作按固定证据恢复，不因后来版本改变而重执行业务。只有合法答案修改回调可修订已完成答案；这些输入不重新调用 actionable/silent，也不新建结果卡。

后台完成必须是 scheduler 证据核验通过的实际私有事件；先审查完整结果、来源与限制，再使用该完成事件的 job-id 提交。runtime 重新核对原后台任务、notification/outcome、nonce、result hash 与原来源，更新原人类任务卡。普通正文自称后台完成不构成授权。

## 去重、版本与恢复

resultKey 在同一任务的所有版本中唯一；同源、同 key、同正文重复提交幂等，修改正文或复用其他来源的 key 被拒绝。waiting/background 结果实际送达后，新的真实补充或后台完成可用新的稳定 key 提交下一版本。上一版本送达未知时不换 key、不追加版本绕过；complete/failed 为业务终结状态，后续新的业务变更作为新的明确任务处理；已核验的再简短一点、补充依据、转表格按钮可修订已完成答案，不能据此扩大业务写入授权。最多 64 个版本。

每个版本保存独立不可变送达记录；新版本更新失败不能继承旧送达证明。网络不确定时复用原操作/序号/UUID 对账，迟到进度与旧版本重放不能覆盖新结果。永久拒绝和未知结果保持阻塞，不自动重执行业务。

当前版本不推断多个后台子任务的聚合完成。一个业务任务包含多个子任务时，主 session 维持 background 状态，收齐并审查后才提交聚合 complete；不能先提交终结结果，再把其他子任务冒充新版本。

维护门禁除所有既有计数外，必须检查 task_result_pending_count、task_result_blocked_count、task_result_protocol_blocked_count 均存在且为零；task_result_waiting_count/background_count 是业务等待状态，不代表未送达队列。安装与真人多任务验收分别记录，模拟平台测试不等于群内验收。私有 task-results-v1、消息、result 文件及送达证据不提交 Git 或上传群。

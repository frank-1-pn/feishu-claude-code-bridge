# 多人业务任务上下文

这个可选模块仅维护私有协作上下文，不执行日历、订单、付款、消息或其他平台操作。任务负责人不等于平台资源权限；记录变更不等于业务写入或验收。所有原人类消息继续进入原 session；这个模块不分类反馈、不注入消息、不改变 disposition。

## 启用与私有状态

缺少 policy 时默认关闭，不创建任务状态。维护者按实际当前运行绑定生成私有文件 `state/collaboration-v1/<bot>/policy.json`，目录权限 0700、文件权限 0600。示例仅说明 schema，不能直接用占位 scope 启用：

```json
{"schema":1,"enabled":true,"scope":{"bot":"<bot>","profile":"<profile>","chat_id":"<chat>","allowed_sender_id":"<owner>","codex_thread_id":"<thread>","group_access":"all_group_humans","bot_open_id":"<bot-open-id>","cwd":"<workspace>","codexHome":"<codex-home>"}}
```

`scope` 必须完整等于 `opsScope(binding,codexHome)` 的实际结果，不自行删减或猜字段；该接口复用 ops scope，但 policy 是独立文件，不改 ops-v1 policy。绑定须为 `all_group_humans`。scope hash 隔离重绑定、工作目录和 Codex home。禁止把实际 policy、任务 catalog、claim、源消息或日志提交 Git。

## 主 session 调用

先按本轮原协议让原消息可见并 actionable，再使用唯一原 `message_id`。注册、提案、记录与裁决都会重新读取私有 inbox，核对真实人类群、完整绑定、marker 与 actionable。不能通过消息上的 `collaboration_*` 等字段证明受理。

私有 request JSON 必须放在当前 binding.cwd 内 canonical 本地路径的当前 owner 0600 regular 文件中（无 symlink、单 hardlink），最大 16 KiB；以下路径和标识均为占位：

```sh
node <daemon>/codex-bridge-collaboration-cli.mjs --bot <bot> --job-id <om_original> --action register --request-file <absolute-private-request.json>
node <daemon>/codex-bridge-collaboration-cli.mjs --bot <bot> --job-id <om_reply> --action resolve
```

注册 request：

```json
{"operationKey":"register-v1","taskKey":"supplier-analysis","title":"供应商方案","waitingFields":["出发日期","人数"],"resourceKey":"calendar:local-resource-alias"}
```

注册返回 `CT-<12位大写hash>`、负责人、版本与待补字段。默认负责人为 binding.allowed_sender_id（项目默认业务归属），真实原提交者 sourceSenderId 独立保留；指定其他人需 `responsibleSenderId` 和同 scope 已可见 actionable 人类消息 `responsibleJobId`，维护 owner 可以是实际 binding owner。之后只有维护 owner 可重新指派，仍须真实成员证据。`resourceKey` 是明确选定的本地同资源别名；不会查找平台资源、授予访问权或自动猜相同业务资源。

解析顺序：正文中的唯一明确 CT 编号；精确 parent/reply_to 链；同原发送者唯一待补任务的短补充。不因“最近任务”、群里另一人的待补任务或单独 root/thread ID 猜测。多个编号、多个待补或同短 hash 冲突均不猜。缺失、循环或超过 32 层回复链返回未知或拒绝，不回退到最近任务。一般新请求与长文本不走同发送者短补充捷径。

提案/记录 request：

```json
{"operationKey":"date-change-v1","taskId":"CT-012345ABCDEF","expectedVersion":1,"expectedResourceVersion":0,"patch":{"waitingFields":[],"note":"补充日期已确认"}}
```

`--action propose` 总是产生待负责人决定的提案。`--action record` 仅当前任务负责人或维护 owner 且版本匹配时记录本地上下文；其他人仍形成提案。输入 CT 不能代替原消息明确关联：跨发送者需要原正文编号或精确回复链；同发送者也必须满足实际解析规则。patch 仅接受 `title`、`waitingFields`、`state`（active/closed 是上下文生命周期）、`note`、维护 owner 的 `responsibleSenderId/responsibleJobId`。负责人、note 与内部源标识只供主 session 审查，不直接照搬到群内。

有 resourceKey 的任务必须同时给出最新 `expectedResourceVersion`；无资源任务不传该字段。所有任务与资源版本由一个 immutable catalog CAS 同时提交。版本过期形成持久 conflict 提案；不能先执行业务写入再把 CAS 冲突当成无事发生。负责人需要先核对具体业务权限和当前资源，再明确裁决。

裁决 request 与 `--action decide`：

```json
{"operationKey":"decide-date-v1","proposalId":"<64hex-private-proposal-id>","decision":"accept","expectedVersion":1,"expectedResourceVersion":1}
```

只有当前任务负责人或维护 owner 可 accept/reject。裁决重新核对提案原人类源和当前 task/resource 版本；版本变更后不能用旧裁决重试。返回 `businessExecuted:false` 始终表示仅本地上下文；真实业务写入继续遵循原权限、查重、单 writer 与读回协议。

## 运行时接入

```js
const collaboration = new CollaborationContext({root,inboxRoot,completionRoot,binding,codexHome});
const protocol = collaboration.promptProtocol(job); // prepare(job) 为同一只读接口
const counters = collaboration.stats();
```

`promptProtocol(job/event)` 可以在 queued 原消息尚未 marker/actionable 时使用，严格比较传入 event 与私有 inbox 原 event 的身份、正文、附件与回复关系，只有已有任务的注册源已核验才提供提示。结果 `readOnly:true`，只给当前候选/唯一关联与无业务授权的指令；不改原 event、不自动注册、不产生 mutation claim。disabled/unlinked 返回 null；无法核验返回安全 unknown。主 session 提交前再次读取提示；最终写入仍由 CLI 最新核验与 CAS 控制。

`stripExternalCollaborationFields(event)` 只清除 collaboration/collab/task_context/business_task/cooperation 字段的副本；应与既有 prompt 入站清理组合，不替换原 background/ops 清理。private protocol 不信任这些外部字段。

严格部署门禁：`collaboration_operation_pending_count`、`collaboration_operation_blocked_count`、`collaboration_policy_blocked_count`。业务等待单独为 `collaboration_decision_waiting_count`、`collaboration_waiting_task_count`，不把普通待补或待裁决当作永远无法清空的 bridge delivery queue。

## 恢复与边界

同 scope + 原 source + operationKey 是唯一请求身份。同 key 修改输入、改 action 或复用到不同变更会拒绝。确定 catalog CAS 失败会保留不可重放结果；claim 后崩溃、分类撤销或异常但未有权威结果时永久 unknown，占 pending/blocked，重启不会重复应用。不要用换 operationKey 自动绕过未知操作；由维护者只读核对 claim、完整 catalog 与实际源后处理恢复。这个模块没有自动 reset/重放未知事务的入口。

只读查询不要求模型等待业务队列；主 session 仍可处理普通消息。策略关闭后保留同 scope 的未知门禁统计，不新写入。损坏权限、symlink、源身份变化或 catalog 不完整保守阻挡。本地上限：128 任务、512 operation claims/catalog 提交、256 唯一源核验、每任务 32 个已关联源、32 层回复链、16 个待补字段（每个 64 字）、200 字 title、512 字 note、80 字 operation/task key、2 MiB catalog。达到上限应由维护者规划归档，不自动删除历史或忽略未知。

离线测试不等于真实平台验收；集成者需按授权在实际原 session 验证合法人类补充可见及正确关联，且无新增 subscriber 或自动业务副作用。

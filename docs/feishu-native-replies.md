# 原生引用回复与话题路由

本模块把 bridge 已授权的入站消息与最终答复关联起来。普通消息默认使用原生引用回复；已有飞书话题内的消息继续在该话题回复，仍进入原来绑定的 Codex 会话。飞书话题不自动创建新的 Codex session。

## 路由规则

- 路由只读取持久 inbox 的可信 job，逐项校验 bot/profile、chat、允许 sender 和 Codex thread；模型正文不能指定收件人或引用目标。
- `thread_id` 表示飞书原生话题。`root_id` 和 `parent_id` 也可能出现在普通引用中，不能仅凭它们创建话题。
- 按钮回调先追溯原 job 并核验同一绑定，再引用由 ActionStore 记录的源卡片。缺少原 job、循环引用或绑定变化均停止发送。
- 一个 Codex turn 消费多条连续输入时仍只有一次最终答复。引用最早一条，显示“本次合并答复对应 N 条连续消息”。跨话题合并时在当前绑定主聊展示，并明确提示涉及不同话题。
- `binding.native_reply_mode` 默认 `quote`；`thread` 可明确要求对普通消息也创建话题；`off` 退回主聊消息。不会改变既有 Codex 绑定。

## 重试与降级

每个既有 outbox key 对应不可变的发送意图，先持久化引用目标、内容、UUID，再请求飞书。收到成功响应后持久保存消息 ID，重启和重复调用直接复用结果。并发同 key 操作串行执行。

飞书的 UUID 去重期限为一小时。网络超时、响应丢失或无有效消息 ID 时，只允许原目标、原内容、原 UUID 重试；55 分钟后停止自动发送并保留待核验状态，不能以重新生成 UUID、普通消息降级或重新执行模型来“恢复”。

明确首次拒绝时才允许以下降级：

| 官方错误码 | 处理 |
|---|---|
| `230011` 原消息撤回、`230019` 话题不存在 | 发回原绑定主聊，记录 `source_unavailable` |
| `230071` 群不支持话题、`230072` 聚合消息不支持话题 | 保持原引用对象，去掉话题发送要求 |
| 权限不足、机器人不在群、不可见、禁言等 | 停止当前意图，不改变发送位置来绕过限制 |
| `230020` 限频 | 由既有出站退避循环稍后重试 |
| `230049` 发送中、超时或未知错误 | 视为结果不确定，保留原请求 |

曾有不确定请求时，即使后续收到“原消息已撤回”，也不能据此断定前一次未发送。错误对象的 `deliveryUncertain` 用于阻止上层生成另一条文本兜底消息。

## 集成接口

```js
const route = selectReplyRoute(binding, context.jobs, { allJobs: inbox.jobs.values() });
const result = await router.send({
  key: `card:${streamKey}`, route, msgType: 'interactive',
  content: { type: 'card', data: { card_id: cardId } },
});
```

根集成人负责以下共享模块集成：

1. `DurableInbox.watch()` 的 progress 回调追加 `job`/同 streamKey 的 jobs；最终回调已包含 `context.jobs`。worker 从可信 jobs 调用 `selectReplyRoute`，把结果存入对应 outbox/card 状态。
2. CardKit 首次消息发布、普通卡片首次发布、文本分片和附件的最终消息发送使用同一个 `DurableReplyRouter`；卡片后续更新仍直接按已存 message/card ID 执行。分片/附件继续使用各自稳定 key，不新增模型任务。
3. final 卡片失败后，若 `error.deliveryUncertain` 为真，禁止另发文本；让 inbox 保留待回复状态或阻塞状态供核验。不能仅看 `permanent` 就认为远端未发出。
4. `replyRouteNotice(route)` 加入公开卡片/文本，诚实说明合并输入的对应关系。
5. 在入站 prepare 前调用 `hydrateNativeContext(binding,event,request)`，把返回 event 持久保存。它先使用只读 `im +messages-mget`。该 CLI 会把普通引用转换为 `reply_to` 并省略原始 parent/root；遇到引用或话题时，再用官方 GET 单条消息接口读取原始 `thread_id/root_id/parent_id`。两次都只接受相同原消息 ID、chat 和 sender 的响应，不替换正文或附件。已完整验证的元数据绑定当前 scope 摘要，重启不会重复读。原始读取失败时保留已核对的 compact thread，不声称根节点已经验证；身份冲突则停止处理。
6. `router.stats()` 提供待发送/阻塞数量；不要把文档状态当端到端验收。

## 验证状态

2026-09-27：路由单元与持久化故障注入测试 12 项通过，覆盖来源授权、回调追溯、合并输入、原生话题与引用区别、多个内容类型、重启、并发、丢响应、过期、撤回来源、权限与跨绑定拒绝。真实客户端引用/话题效果由部署后的端到端验收确认；本模块开发过程没有启动订阅、发送真实消息或修改运行时。

官方依据：[回复消息 API](https://open.feishu.cn/document/server-docs/im-v1/message/reply)。字段、错误码与 UUID 一小时去重期限按 2026-09-27 的官方 Markdown 文档核对；本机 `lark-cli im +messages-reply --help` 同时确认 CLI 支持引用、话题和幂等参数。

## 附件沿用来源引用

`FileOutbox` 接受可选 `getRoute(jobId)`，由 worker 从可信 inbox 取原 job 并生成 route。新附件在第一次网络操作前保存路由、原 UUID、不可变快照摘要和当前 bot/profile/chat/sender/Codex thread scope；文件、图片、音频和视频通过 `+messages-reply` 使用相同引用，视频封面原样保留。没有 `getRoute` 时保持原有主聊发送接口。

升级前的旧请求不能判断是否已经开始发送，因此保留原 `+messages-send` 端点和 UUID，不改成引用；旧记录首次 IO 时间缺失时，以创建时间作保守上界。不确定发送超过 55 分钟停止自动重试，附件和状态保留，通知明确“送达状态尚未确认”。只有明确首次拒绝，才按上表处理撤回来源或不支持话题的降级；超时后的拒绝不能使系统换目标再发一次。

新队列的附件字节与封面均在发送前再次校验；模型文本不能扩大可读取文件根目录。CLI 重试可能重新上传相同快照产生未引用资源，但可见消息继续使用同一个 UUID。`notify(text,key,jobId)` 让错误通知也能对应来源，并沿用原有按文件/报告去重机制。

元数据补全 6 项、原生附件 9 项测试通过，覆盖数据边界、断线、重启、已送达 checkpoint、中途启用引用仍保持原发送端点、旧请求兼容、权限、超时及文件篡改。

2026-09-27 的 Bot1 当前绑定单聊完成真实 API 验收：发送一条引用测试、一条话题测试和一个小 TXT 文件，原始 GET 回读确认三者均属于绑定 chat；引用与附件的 parent/root 对应原消息；原生话题创建成功，话题回复和附件的 thread 一致。没有开启新订阅或写生产 inbox，发送状态和真实 ID 只存在独立 TEMP 验收目录。该结果证明 API 关联和投递，不替代手机客户端视觉确认，也不声称自动 worker 整条链路已经验收。

原始读取接口依据：[获取指定消息的内容](https://open.feishu.cn/document/server-docs/im-v1/message/get)。

## 原生操作的本地确认队列

`NativeActionStore` 为 `task_open`、`task_create` 和 `voice_confirm` 提供独立本地队列；这些按钮不通过模型猜测下一步动作。根集成人先从可信 inbox 取来源 job，再注册上下文，发送不带可用控件的卡片，持久绑定实际 message ID，最后更新成可点击卡片。

- `register({key,kind,sourceJobId,data,form})` 返回不含正文的 opaque context 描述；同 key 的意图变化或绑定变化不会覆盖已发布卡片。
- `acceptCallback` 严格检查当前 bot/profile/chat/sender/Codex thread、实际卡片消息 ID、有效期、字段白名单和事件重放。一次表单只接受一份内容，相同重放返回幂等结果，修改过的重放拒绝。
- 回调处理只落盘；`drain({handlers})` 由既有 worker 循环执行。handler 接收 `(operation,context)`，使用稳定 `operation.id` 作为自身幂等依据。外部效果完成到队列 checkpoint 之间可能崩溃，handler 必须可按同 ID 安全恢复；队列不声称能替外部 API 提供无限期 exactly-once。handler 返回 `pending` 状态时按退避继续，返回 `blocked`/`uncertain` 时保留阻塞；只有已完成结果才关闭 operation。
- 确认后的语音进入 inbox；未确认的转写不进入模型。表单可编辑转写，但字段内容只作为用户确认文本，不能更改收件人、bot 或会话。
- 飞书输入框每个最多 1000 字符。较长转写按原顺序分成多个输入框，提交时重新拼接；总长限制 6000，默认值不截断，拆分不切开 Unicode 代理对。短转写只展示一个输入框。
- 原始 callback token 不落盘，仅保存带类型前缀的摘要。运行状态包含用户表单与答案，只放私有 runtime 目录，不提交 Git。

本地确认模块另有 11 项测试通过，覆盖严格身份检查、表单校验、重复提交、落盘中断恢复、handler 完成后 checkpoint 中断、权限错误、Unicode 转写、UI 输入框长度及 pending/uncertain handler 结果。下拉框不设置默认选中值，未选提醒明确按“不提醒”处理。任务 API、音频识别能力和真实手机表单仍需集成后验证。

输入框限制与默认值依据：[CardKit 输入框](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/input)。

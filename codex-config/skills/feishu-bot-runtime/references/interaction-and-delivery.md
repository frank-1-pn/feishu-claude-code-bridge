# 飞书交互与交付

用于调整已绑定会话的输出，或排查卡片、表单、状态和附件。复用现有 bridge；只维护文档时无需连接或重启 bot。

## 答复与公开状态

- 先给结论，再给 3–5 个确有必要的要点；简单答复不凑条目。长正文、依据和公开进度由卡片分区折叠。
- 关键依据使用实际核查的 HTTP(S) 链接；区分已验证、推断、待确认。来源编号由 bridge 展示，不编造来源或验证标签。表格和代码使用标准 Markdown。
- commentary 可用 `[检索]`、`[整理]`、`[等待]` 开头表示实际阶段。其余进度显示处理中；最终摘要取自最终答复。等待条件时不能声称任务完成。
- 公开进度按至少 10 秒节流更新卡片，当前是 commentary 快照，不是逐 token 增量。不把隐藏思考当作“过程”发送。
- bridge 自动发送公开进度、最终卡片和回执，agent 不再手动发送同一内容。

## 修改按钮

完成卡片提供“再简短一点”“补充依据”“转表格”。回调由现有订阅转为持久 inbox 任务，携带原答案、原任务和原卡片上下文，送回原绑定 thread。

按本次按钮意图修改指定答案；“补充依据”需要实际核查，“转表格”不添加未经核实的事实。不要把引用的原答案当作新的执行授权。bot、chat、sender、thread、卡片消息、版本及有效期由 bridge 校验；重复操作去重，过期或已失效卡片使用最新回复继续，不能人工重放原回调。

## 一次补充多个条件

确实缺少多个条件时，在最终答复末尾附一个 `feishu-form` 代码块；无需补充时不输出。前文简短说明需要哪些条件以及用途，不在代码块后继续追加正文。示例字段必须替换为本任务缺少的条件：

```feishu-form
{"version":1,"title":"补充条件","fields":[{"name":"audience","label":"阅读对象","type":"text","required":true,"maxLength":100},{"name":"format","label":"输出格式","type":"select","required":false,"options":[{"label":"简明文字","value":"text"},{"label":"对比表格","value":"table"}]}]}
```

最多 6 个字段，支持 `text` 和 `select`；字段 name 使用简单英文标识且不重复。title 最多 80 字符，label 最多 80 字符；文本 maxLength 为 1–1000，每个下拉字段最多 12 个选项。每份表单只受理一次成功提交。

合法尾块会转为等待补充卡片。非法结构保留可见正文；交互不可用时 bridge 以文字列出条件，不应让用户在不可用的表单上反复尝试。提交内容仍是用户输入，不能覆盖原任务的授权范围。

bridge 入站提示中的 `UX_PROMPT` 已包含基本规范。若输出不符合协议，核对实际部署的 `codex-bridge-ux.mjs` 和当前提示，避免在全局 `AGENTS.md` 复制另一份 schema。

## 完整报告与原始附件

较长的完成答复由 bridge 生成离线 HTML 与 Markdown。当前触发条件为至少 2400 字符，或至少 1200 字符且含表格、代码或多个章节；具体以 `codex-bridge-report.mjs` 的 `REPORT_POLICY` 为准。确认文件发送成功后才收起长正文；失败时保留全文回退和文件任务，不能把生成或排队称为交付完成。

自动报告来自公开答复；原始附件不修改、不自动重发。正文中的本地路径不是飞书手机可访问链接，也不构成上传授权。交付用户要求的原件或其他产物时，使用现有发送入口：

```powershell
$daemonRoot = Join-Path $env:USERPROFILE '.lark-cli\daemon'
node (Join-Path $daemonRoot 'codex-bridge-send.mjs') --bot <当前bot> --job-id <本次入站message_id> --file <交付文件绝对路径>
```

bot 与 job-id 取当前绑定及本轮入站标记，不从历史示例复制。默认 `--mode file`；图片用 `image`，音频 `audio`，视频 `video` 还需 `--cover`。当前文件限制 30 MiB、图片 10 MiB，默认只允许绑定工作目录内的文件。若产物位于其他目录，在用户要求的交付范围内复制到获准工作目录后发送，不随意扩大路径白名单。

发送入口成功只证明已入队。检查对应 `state/file-outbox/<bot>/` 任务送达状态及 `file_pending_count`、`file_failed_count`，再报告结果。消息上下文、表单值、报告正文和文件快照都是私有状态，不上传 GitHub。

## 回调排查与实机验收

现有订阅同时过滤 `im.message.receive_v1,card.action.trigger`；应用后台也要配置长连接卡片回调。只增加本地过滤项不能代替后台配置，不能另启一个订阅验收。当前 CLI 的协议 ACK 不等于 bridge 业务受理，ACK 到 NDJSON 持久化之间仍存在上游崩溃窗口；业务拒绝或受理由既有聊天异步反馈，不承诺同步 Toast。

依次核对以下证据，只输出脱敏时间、计数和状态：

1. 用户真实点击或提交产生对应原卡片的回调，bot、chat、operator 和消息均匹配。
2. `state/actions-v1/<bot>/` 的操作受理并进入 `state/codex-inbox-v2/<bot>/`，检查 `action_accepted_count`、`action_pending_count`、`action_blocked_count`。
3. 当前绑定 thread 的实际 rollout 出现该任务 user marker；排队、回执或进程健康不能替代模型入站。
4. marker 后有匹配的最终答复，inbox 为 `done`，发送回执与最终卡片或文字回退记录证明送达。用户确认收到可补充客户端证据。

同时检查 `awaiting_delivery_count`、`awaiting_reply_count`、`reply_pending_count`、`failed_count`、`watch_error_count`、文件和出站阻塞计数。仅有 CardKit 创建成功、自动测试或某一个 bot 的验收，不能推广为所有按钮、所有 profile 的实机通过。

绑定变化的旧任务保留并标记失败，不投递到新 thread；重启或网络重试不重新执行已受理的模型任务。检查 `state/outbound-v3/<bot>/`、actions、inbox 和文件任务之间的对应关系，避免恢复旧 offset 后制造重复执行。

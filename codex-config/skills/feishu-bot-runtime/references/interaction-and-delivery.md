# 飞书交互与交付

用于调整已绑定会话的输出，或排查卡片、表单、状态和附件。复用现有 bridge；只维护文档时无需连接或重启 bot。

## 答复与公开状态

- 先给结论，再给 3–5 个确有必要的要点；简单答复不凑条目。长正文、依据和公开进度由卡片分区折叠。
- 关键依据使用实际核查的 HTTP(S) 链接；区分已验证、推断、待确认。来源编号由 bridge 展示，不编造来源或验证标签。表格和代码使用标准 Markdown。
- commentary 可用 `[检索]`、`[整理]`、`[等待]` 开头表示实际阶段。其余进度显示处理中；最终摘要取自最终答复。等待条件时不能声称任务完成。
- 公开进度按至少 2 秒节流，布局相同时更新变化的 Markdown 元素；仍是 commentary 快照，不是逐 token 增量。追加文本才可能显示原生打字机效果，不把隐藏思考当作“过程”发送。
- bridge 自动发送公开进度、最终卡片和异常提示；常规消息、按钮及表单受理成功后不发“已保存／正在投递”回执，agent 不手动补发。
- “公开进度”最近 6 条记录逐条显示原始北京时间，重启保留时间和顺序。没有原始时间的新增事件标注接收时间，旧记录缺少两者时显示“时间未记录”。卡片流式关闭后沿用同一卡片切换整卡更新；若画面停滞，核对出站记录的 `revision` / `sentRevision`，不能仅凭连接健康断言进度已显示。
- 已入站的长任务仅在连续 30 分钟（或当前配置时限）没有公开进度、工具调用或工具返回时提醒；有持续执行活动时继续等待最终结果。该判断只使用事件类型与时间，不对外发布工具输出或隐藏思考。

## 全群可见与静默完成

`all_group_humans` 策略先将绑定群所有合法人类消息持久入队并注入同一运营 thread。发送者、原消息时间和回复链随原 message_id 提供；去重与绑定快照保留。无需回复的判断由运营 session 作出，不能在后台按关键词丢弃闲聊。此策略不自动外发未分类 commentary、表情或消息的超时/准备失败占位；私有 stalled/failed 健康诊断保留，不能将静默故障误记为成功；需要处理/回复的消息先分类 actionable，再按既有 final 回传。

全群策略的音频也携带经过验证的下载引用进入 session，不自动转写、发语音确认卡或先发 ASR 关闭占位。没有已确认文字时不能把音频当作已理解的指令。附件准备失败时只注入原正文与安全错误分类，不能使用被拒绝的路径；运营 session 再按相关性决定是否澄清。其他策略保留原语音确认与附件错误处理流程。

运营事务开始执行前，使用本轮注入提供的工具：

```sh
node "<运行目录>/codex-bridge-feedback.mjs" --bot <本轮bot> --job-id <本轮原message_id> --state actionable
```

工具只持久保存请求，返回 queued 不等于生效。worker 在确认该 job 的原消息 rollout marker 后写入 `feedbackDisposition=actionable`。`reaction_feedback=true` 时仅此 job 可显示 Typing、等待/失败及答复真实送达后的 DONE，入队不加 OnIt，不补标历史已完成任务。进度 commentary 必须以 `[飞书进度｜原message_id]` 开头；标签会被移除，正文通过独立任务进度卡回到该条原消息/话题。同 turn 两个任务使用独立 streamKey；未标记及 silent 消息不进入 progress route 或 final peers。无标签普通 commentary 只在 session 可见。最终回包收尾本轮各任务进度卡，完整结果只发送一次。

silent 和 actionable 共用 `completions-v1` 下唯一不可变 disposition，原子硬链接发布防止并发两工具都成功；重复同分类幂等，不同分类拒绝。旧 silent 请求兼容读取。无需回复时使用本轮注入提供的专用工具路径：

```sh
node "<运行目录>/codex-bridge-complete.mjs" --bot <本轮bot> --job-id <本轮原message_id> --disposition silent
```

工具只写独立持久结构化请求，不并发修改 worker 的 job。仅允许当前全群绑定内已 submitted/delivered 的普通消息；worker 独立核实原 thread 的 user marker 后将该 job 记为 `done`、`completionDisposition=silent`，清除待回包、待进度和旧超时通知。不发送群消息、不创建答复送达记录，`silent_completed_count` 单独计数。排入完成请求不等于 worker 已确认完成。多个同 turn 消息需要逐条完成；未标记的消息继续等待正常答复。普通 final 文本不是静默协议，不支持魔法字符串。静默请求和消息本身同样跨重启去重；绑定变化或篡改请求拒绝，不重新执行业务动作。

## 原消息的表情状态

bridge 自动给真实入站消息添加原生表情：`OnIt` 表示已持久入队；确认原 thread 的 rollout 入站标记后切换为 `Typing`；最终回包送达并写入 checkpoint 后切换为 `DONE`。`DONE` 表示本轮回复已送达，不保证业务任务成功。失败或回包永久阻塞用 `ERROR`，等待超时或 rollout 读取异常用 `OneSecond`。按钮、表单的合成回调不添加表情；不批量补标历史已完成消息。

反应状态保存在私有 `state/reactions-v1/<bot>/`，重启先对账不确定请求，只移除机器人自己创建的表情，不通过重复添加维持“心跳”。过期的活动状态会清理。表情失败不阻塞正文、不重复执行模型；权限不足时按 bot 暂停五分钟后重试。检查 `reaction_pending_count`、`reaction_blocked_count`、`reaction_error_count`、`reaction_last_error` 和独立的 `feedback_healthy`，不要把表情权限错误当成 WebSocket 故障。

所需专用权限为 `im:message.reactions:read` 和 `im:message.reactions:write_only`，更宽的对应 IM 权限也可能满足。以实际 bot API 返回为准，不执行 user 登录来修复 bot 权限。私有 binding 的 `reaction_feedback=false` 可停止新增表情并清理活动标记；修改后使用原有 bridge 重载流程。

## 修改按钮

### 原生回复、待办与语音

正文、卡片和新附件默认引用原消息；已核实属于话题的输入继续在原话题回复。不同话题被同一 Codex turn 合并时，最终答复回到主聊天并标明合并范围。飞书话题不会自动创建独立 Codex 会话。引用源失效只在首次明确拒绝时允许降级，发送结果不确定时保留原端点和去重键；超过去重窗口停止自动重发。

完成卡片增加“转待办”，点开表单确认事项、截止时间和提醒后才创建；截止日期和时间使用原生选择器，可不选，无需手填格式。负责人固定为当前绑定用户，所选时间按北京时间计算；选择控件不直接执行，只有“确认创建”按钮提交。该回调在本地持久队列执行，不为表单值另开模型任务。检查 `native_action_pending_count`、`native_action_blocked_count` 与实际任务回读；任务成功后结果通知失败只补发通知，不重复创建。

语音入口保留，当前用户选择暂不开通，`voice_enabled` 默认关闭。接收音频仍保留原文件并提示改发文字，不自动猜测语音内容。将来启用还需 ASR 权限和租户资格；转写必须由本人在表单确认，确认前 inbox 为 `waiting_input`、表情为等待，确认后才继续原消息对应的 Codex 任务。

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

同样的长报告还进入独立云文档队列：限制链接与外部分享，只给绑定用户查看权限，验证正文和访问链接后更新原最终卡片；文件和正文不等待云文档队列。默认使用 bot 私有根目录，配置目标目录需核对权限；原始附件、HTML、Markdown 继续保留。云文档失败时明确回退附件，不把“创建空文档”当作交付。检查 `cloud_doc_pending_count`、`cloud_doc_failed_count` 和真实文档回读；手机打开效果仍需客户端检查。

云文档在官方 Markdown 转换后应用原生报告排版：保留标题层级，突出明确结论和原有要点，强调表头并调整列宽，代码自动换行。只改变展示，不自动编写摘要或补来源；无歧义表格的行间空白可在转换前修复，原始附件不变。新样式只应用于尚未转换的报告，旧的已完成文档需按用户指定范围更新；验收必须回读实际表格、代码、链接和样式，不能以创建接口成功代替视觉检查。

自动报告来自公开答复；原始附件不修改、不自动重发。正文中的本地路径不是飞书手机可访问链接，也不构成上传授权。交付用户要求的原件或其他产物时，使用现有发送入口：

```powershell
$daemonRoot = Join-Path $env:USERPROFILE '.lark-cli\daemon'
node (Join-Path $daemonRoot 'codex-bridge-send.mjs') --bot <当前bot> --job-id <本次入站message_id> --file <交付文件绝对路径>
```

bot 与 job-id 取当前绑定及本轮入站标记，不从历史示例复制。默认 `--mode file`；图片用 `image`，音频 `audio`，视频 `video` 还需 `--cover`。当前文件限制 30 MiB、图片 10 MiB，默认只允许绑定工作目录内的文件。若产物位于其他目录，在用户要求的交付范围内复制到获准工作目录后发送，不随意扩大路径白名单。

发送入口成功只证明已入队。检查对应 `state/file-outbox/<bot>/` 任务送达状态及 `file_pending_count`、`file_failed_count`，再报告结果。消息上下文、表单值、报告正文和文件快照都是私有状态，不上传 GitHub。

## 回调排查与实机验收

现有订阅同时过滤 `im.message.receive_v1,card.action.trigger`；应用后台也要配置长连接卡片回调。只增加本地过滤项不能代替后台配置，不能另启一个订阅验收。当前 CLI 的协议 ACK 不等于 bridge 业务受理，ACK 到 NDJSON 持久化之间仍存在上游崩溃窗口；业务拒绝通过既有聊天异步反馈，受理成功不额外发回执，不承诺同步 Toast。

依次核对以下证据，只输出脱敏时间、计数和状态：

1. 用户真实点击或提交产生对应原卡片的回调，bot、chat、operator 和消息均匹配。
2. `state/actions-v1/<bot>/` 的操作受理并进入 `state/codex-inbox-v2/<bot>/`，检查 `action_accepted_count`、`action_pending_count`、`action_blocked_count`。
3. 当前绑定 thread 的实际 rollout 出现该任务 user marker；排队、回执或进程健康不能替代模型入站。
4. marker 后有匹配的最终答复，inbox 为 `done`，发送回执与最终卡片或文字回退记录证明送达。用户确认收到可补充客户端证据。

同时检查 `awaiting_delivery_count`、`awaiting_reply_count`、`reply_pending_count`、`failed_count`、`watch_error_count`、文件和出站阻塞计数。仅有 CardKit 创建成功、自动测试或某一个 bot 的验收，不能推广为所有按钮、所有 profile 的实机通过。

绑定变化的旧任务保留并标记失败，不投递到新 thread；重启或网络重试不重新执行已受理的模型任务。检查 `state/outbound-v3/<bot>/`、actions、inbox 和文件任务之间的对应关系，避免恢复旧 offset 后制造重复执行。

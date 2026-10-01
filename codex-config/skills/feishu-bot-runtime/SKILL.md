---
name: feishu-bot-runtime
description: 连接、排查现有飞书 bot 与 Codex bridge，处理绑定会话的消息、卡片按钮、条件表单、文件交付，以及按 Bot 场景整理文档和归类文件。复用现有 daemon，不另启订阅。
---

# 飞书 bot 运行时

这套体系从 Claude Code 迁移而来，现已支持 Claude/Codex 共存。以现有文件为权威，不重新设计第二套长连接：

- 运行目录：`~/.lark-cli/daemon/`；Windows PowerShell 可用 `Join-Path $env:USERPROFILE '.lark-cli\daemon'` 定位
- registry：运行目录下的 `bot-registry.json`
- daemon 自检：`ensure-bot.ps1`
- 飞书事件源：`%TEMP%\lark-<bot>-events.ndjson`
- Codex bridge：`start-codex-bridge.ps1` / `codex-bridge-worker.mjs`
- 同线程 PTY 注入：`resolve-codex-pty.ps1` / `orca-pty-rpc.mjs`
- 当前 bot、profile、chat、sender、cwd 与 thread 映射：`codex-thread-bindings.json`
- 状态检查：`status-codex-bridge.ps1`

## 核心约束

1. **按 bot 粒度判冲突。** CommandLine 有 `--profile <name>` 就属于该 profile；无 profile 才是 Bot1。同一 bot 只允许一个 `event +subscribe`，不同 bot 可并存。
2. **不要另起 subscribe。** 先只读检查状态，确认 daemon 不健康后才用现有 `ensure-bot.ps1` 恢复；共享 bridge 消费既有 NDJSON。不要用 `lark-cli event +subscribe --force` 抢占现有 daemon。
3. **一条 thread 只绑定一个 bot。** 缺省入站事件必须同时匹配配置中的 `chat_id` 和 `allowed_sender_id`；显式群策略允许绑定群内合法人类成员（精确 @ 或全群），不扩大其他群、私聊、机器人或卡片回调权限。拒绝事件只记录元数据，不把正文写进运行日志。
4. **真实 profile 名不改。** 编程助手仍使用 `coding-assistant-claude`；这是飞书应用配置标识，不因运行时换成 Codex 而重命名。
5. **不输出密钥。** 不打印或提交 app secret、访问令牌、回调 token、WebSocket access_key/ticket、真实绑定或私有消息状态。subscriber stderr 可能包含连接凭据，只读取脱敏字段。daemon 使用 `LARK_CLI_NO_PROXY=1`。

## 当前绑定与按需路由

以当前 registry 和 `codex-thread-bindings.json` 为准，按 bot 核对 profile、chat、允许的 sender、cwd 与 Codex thread；文档不保存固定会话 ID。不要根据历史会话名称、归档记录或旧 PID 重新绑定。

- 连接、断连恢复、入站或回包故障：读下面的连接与判活、常见故障。
- 新 Codex 会话接手、配置字段、安装依赖或核对 GitHub 与运行版本：先读 [references/configuration-and-handoff.md](references/configuration-and-handoff.md)。本机复用和新机器安装是不同流程；不自动改绑或重启。
- 卡片排版、修改按钮、批量条件表单、状态显示、报告和附件：读 [references/interaction-and-delivery.md](references/interaction-and-delivery.md)。bridge 的入站提示已携带基本输出协议；无需在每轮重复加载无关操作流程。
- 收到文件后的文档整理、主题归类、本地知识库/项目附件/飞书云空间归档：读 [references/document-organization.md](references/document-organization.md)。默认去向从当前 bot 私有配置读取；收到或备份文件不等于已整理完成。
- 仅检查文档或调整输出规范时，不启动、重启或重新绑定运行时。

## 连接与判活

连接用户指定的重点会话时：

1. 运行 `status-codex-bridge.ps1` 查看两个 daemon 与共享 bridge worker。
2. daemon 不健康时，用 `ensure-bot.ps1 -Bot bot1 -SkipSessionBinding`，或 `ensure-bot.ps1 -Bot coding -Profile coding-assistant-claude -SkipSessionBinding` 自愈。
3. bridge 不健康时，用 `start-codex-bridge.ps1` 幂等启动。每个 bot 独立运行持久入队、投递、rollout 观察、回包、回执循环；已打开的 Orca 会话投递不等待上一条最终答复。无桌面 terminal 时 headless resume 仍保持单 writer，后续消息持久排队。
4. 判活必须同时看：正确 bot 的 subscribe PID、bridge PID、worker 最近处理状态。出站 `messages-send ok=true` 只能证明发送能力，不能单独证明入站链路。
5. 实际收到匹配 `chat_id + sender_id` 的新事件并成功推进目标 Codex thread，是最强的端到端正向信号。

安装 `subscriber-runtime.json` 对应的固定版本 CLI 后，`socket_verified` 来自真实 SDK pong，并校验 PID、profile 与进程创建时间；`pong_age_seconds`、`socket_signal`、`socket_needs_restart` 用于排查静默断连。未应答 ping 超过 30 秒、pong 超过服务端心跳间隔的两倍加 30 秒、SDK 重连超过 60 秒时，由原有 watchdog 调用 `ensure-bot.ps1` 恢复对应 bot；一分钟巡检还会增加最多约一分钟延迟，任务延迟或退避可进一步延长。不要以聊天室没有新消息作为断连依据，也不要手工更新心跳文件制造健康状态。

`FeishuBotWatchdog` 应通过 `wscript.exe //B //NoLogo run-watchdog-hidden.vbs` 启动；由该无控制台入口隐藏启动 PowerShell 并等待退出码。直接以 PowerShell 为计划任务入口即使带 `-WindowStyle Hidden` 仍可能闪窗。重新配置用运行目录的 `configure-feishu-watchdog.ps1`，保留每分钟检查。

bridge 的线程推进有两条互斥路径：目标 thread 已被 Orca/Codex 桌面端持有时，通过 writer lock 的 PID 动态定位现有 Orca terminal，再调用公开的 `orca terminal send --text ... --enter --json` agent-prompt 接口，并从 rollout 等待对应的 `final_answer`；目标 thread 没有活跃 writer 时，才使用 `codex exec resume`。不要在已有 writer 时另起第二个 Codex 进程抢锁。本机 Codex app-server 虽有 `turn/steer`，但另一个 app-server 进程不能附着到已被 Orca TUI 持有的 thread，会被 active-writer lock 拒绝。

不要直接用 terminal daemon 的 raw `write` 模拟正文 + 回车：它没有 key-event 语义，连续写入可能把消息留在 composer。普通消息统一走 Orca 的 agent-prompt 接口；它在后台 daemon 内完成 bracketed paste、Windows ConPTY 1500ms settle delay 和提交，不依赖窗口焦点或屏幕点亮。超过 Windows argv 安全长度的消息才允许 raw bracketed paste，但最终 Enter 仍走 `orca terminal send --enter`。这条路径是 Codex 当前的兼容实现，不得描述成 Claude 官方 `claude/channel`：Codex 尚无能把 MCP notification 原生推进既有会话的 channel capability。

Orca CLI 在目标 Codex turn 正忙时可能先以非零状态退出，但 runtime 已经接受并排队 agent prompt。此时不能立刻向飞书发失败提示；以 rollout 中带 `message_id` 的 user marker 为入站权威，并等待对应最终答复。marker 等待超时表示尚未确认入站；已有 marker 后按最近公开进度或工具调用/返回的事件时间判断无活动时长，默认连续 30 分钟无活动才提醒，不能倒推成注入失败或重投任务。token 计数、文件更新时间和隐藏思考不用于延后提醒。

匹配 chat 与 sender 白名单的事件先保存到 `daemon/state/codex-inbox-v2/<bot>/` 再推进 codex offset。常规消息、按钮和表单受理成功后不发“已保存／正在投递”回执，保留公开进度、最终答复与异常提示。每条记录区分 queued、submitted、delivered、reply_pending、done、failed。投递前记录 submitted；CLI 超时先核对 rollout，不自动重投。重启按记录继续。原始正文与附件目录属于私有运行状态，不可提交 Git。

状态检查同时看 `transport_healthy`、`delivery_healthy` 和各 bot 的 queued_count、awaiting_delivery_count、awaiting_reply_count、failed_count、last_delivered_at。`healthy` 为兼容 supervisor 允许有界的启动和重连宽限期；`transport_healthy` 还要求所有连接的真实 pong 新鲜有效，offset 追平也不能单独证明送达。会话压缩时 Orca 可显示 Messages to be submitted after next tool call，这是 terminal 已排队，仍需 rollout marker 证明模型入站；不要盲目重发或打断业务任务。

`all_group_humans` 时自动 commentary 与新表情关闭；无需回复的已可见消息按[结构化静默完成协议](references/interaction-and-delivery.md#全群可见与静默完成)终结，不用普通 final 占位。其他策略的 rollout 观察只转发显式 commentary 与 final/final_answer 或 task_complete 的最终文本，reasoning 永不外发。公开进度卡片按至少 2 秒节流更新，布局不变时只更新变化的文本元素；仍是公开快照，不是逐 token 流式输出。同一轮消费的多条输入共享一次最终回包；不同轮分别回包。出站分片使用稳定 Feishu idempotency key，网络重试不重新执行模型任务。投递或答复超时明确提示并继续观察迟到结果。

不要把旧 Claude Monitor task ID、`TaskList` 或 `binding-<claude_pid>` 当作 Codex bridge 的判活依据。旧 binding 仍为 hooks 路由保留；bridge 使用自己的 thread mapping 与 offset。

公开进度的最近记录显示事件原始北京时间；缺少事件时间但有接收时间时明确标注“接收时间”，历史两者均缺失则标注“时间未记录”。CardKit 返回 `300309` 或 `200850` 时，在同一张卡片上持久切换为普通整卡更新，保留严格递增序号和重试去重；不重新创建消息，也不反复重试已关闭的流式文本接口。

## 收发规范

- 只处理绑定 chat 的消息；回复也只发回该 chat，并使用绑定 bot/profile。
- 长消息末尾出现 `...(truncated)` 时，用 `lark-cli im +messages-mget --message-ids <om_xxx> --as bot` 取全文，不让用户重贴。带 profile 的 bot 在命令最前加 `--profile <name>`。
- 自动 bridge 支持文本、图片、文件及 post 中的资源 key，并尝试下载 audio/video/media/sticker 资源；能下载不代表当前模型能直接理解音视频。通过绑定 bot/profile 下载到 `~/lark-downloads/codex-inbox/<bot>/<消息哈希>/`，校验实际路径和文件大小（接受上限 50 MiB）。图片提示 Codex 调用 view_image；文件提示按格式读取，不执行附件程序。未知类型、缺资源 key 或下载失败必须明确反馈，不可静默丢弃。
- bridge 用持久 inbox 去重入站；回包分片同时用稳定的 Feishu idempotency key。不要恢复旧 offset 就直接回滚 V1：V2 offset 表示持久入队，已不表示答复完成，必须先对账所有 pending/已投递任务。
- 需要人工直接发消息时，同时遵循 `lark-im` skill 的收件人、正文和身份确认规则。

## 授权与高风险操作

用户在当前会话已明确授权的同范围操作继续完成，不因来自飞书再次要求确认。卡片按钮只表达修改原答案的要求；表单值和引用的原答案内容不自动扩大执行、收件人或发布权限。

删除、不可恢复覆盖、force push、数据库破坏或向他人发送内容等动作，若现有授权未覆盖具体目标和影响，先完成可独立执行的准备与验证，再说明待执行动作、影响和缺少的授权。通过当前可用确认机制取得清晰答复；飞书确认必须来自同一绑定 chat 与允许的 sender。不要把普通可逆编辑或已授权的共享文件更新一律变成二次审批。

headless `codex exec resume` 路径使用 `workspace-write`；Orca 已打开的会话遵循该会话当前权限。不要用 `--dangerously-bypass-approvals-and-sandbox` 绕过权限；若动作被权限机制拒绝，说明具体卡点并使用允许的替代方式。

## 常见故障

| 症状 | 处理 |
|---|---|
| `another event +subscribe instance is already running` | 不再启动第二个；检查现有 daemon PID/profile。不要杀其他 bot |
| daemon 在、bridge 不在 | 幂等运行 `start-codex-bridge.ps1`，不要重启 subscribe |
| bridge 在但消息没推进 | 核对独立 codex offset、chat/sender 白名单和 worker error log |
| 一个 bot 忙时另一个 bot 不收消息 | 检查 `bot_states` 是否独立；新版 worker 必须是 per-bot processing loop，不能退回全局串行队列 |
| 飞书无保存回执 | 正常行为，成功受理不另发消息。`receiptSuppressed=true` 表示回执已静默处理；`receipted` 和 `receipt_offset` 均不能证明模型已读或用户收到答复，应核对持久 inbox、rollout marker 和最终投递 |
| 按钮或表单点击后无答复 | 按引用文档逐段核对订阅过滤、后台回调配置、action 队列、原 thread marker 与最终投递；不以卡片创建成功替代实机点击 |
| 消息在 composer 停留 | 检查 bridge 是否调用公开的 Orca agent-prompt 接口及 terminal handle 是否匹配 PTY；禁止回退为 raw 正文 + `\r` 两次 write |
| `thread-store conflict` / `already has an active writer` | 正常情况下 bridge 应自动走 Orca PTY 注入；若仍出现，检查 `resolve-codex-pty.ps1` 能否由 writer PID 唯一定位 PTY，不要放宽沙箱 |
| `pty_injection_error` | 检查 Orca terminal daemon、writer lock、PTY session 映射和 rollout；保留当前 thread，不回退到另建会话 |
| `permission_violations` | bot 身份禁止 `auth login`；把错误的 console URL / 缺失 scope 告知用户 |
| `file must be a relative path` | 先切到下载目录，再传 `./filename` |
| Codex resume 失败 | 保留目标 thread，不新造会话；检查 managed `CODEX_HOME`、thread ID 与最后一段 bridge error |

# 飞书 Codex bridge：配置与新会话接手

本指南适用于 Windows + Orca/Codex 的现有 bridge。只有用户要求连接、排查或配置，或当前会话已获授权绑定时，才操作运行时。新会话仅阅读文档不需要连接、改绑或启动服务。

## 代码与运行目录

- 仓库：[frank-1-pn/feishu-claude-code-bridge](https://github.com/frank-1-pn/feishu-claude-code-bridge/tree/feat/feishu-ux-20260927)。当前 Codex 维护分支是 `feat/feishu-ux-20260927`；`main` 保留旧 Claude 实现，不能照旧 Monitor/PID 流程配置 Codex。
- 运行目录：`Join-Path $env:USERPROFILE '.lark-cli\daemon'`。worker 从这里加载模块与私有配置，不直接运行任意 Git worktree 里的新代码。
- 技能安装目录：**当前生效的** Codex home 下的 `skills/feishu-bot-runtime/`。先核对 `$env:CODEX_HOME`、当前 Orca 运行环境和绑定配置的 `runtime.codex_home`；托管安装不一定使用 `~/.codex`。有冲突时先核对目标会话，不能换一个 home 来绕过 writer lock。
- 代码版本、文档版本和运行进程版本分别核对。2026-09-30 的核对记录见[版本记录](https://github.com/frank-1-pn/feishu-claude-code-bridge/blob/feat/feishu-ux-20260927/docs/feishu-runtime-sync-20260930.md)；它是历史快照，之后使用仍需现场复核。

## 本机另一 Codex session 如何接手

1. 先读[主技能](../SKILL.md)与本指南；仅维护代码或文档时保持现有 bot/thread 映射。
2. 在本机私下读取 `bot-registry.json` 和 `codex-thread-bindings.json`。后者才是 Codex 的 bot/profile/chat/sender/cwd/thread 权威映射，前者还服务旧 hooks。不要把配置全文贴到聊天或提交 Git。
3. 用下面的只读命令检查配置和状态。保留完整对象在本机，只展示安全字段；不要直接粘贴完整 status JSON、stderr 或事件流。
4. 已健康则复用原 subscriber 与 worker。只有对应组件不健康时，才按主技能恢复；不因新 session 出现而重新订阅。
5. 用户明确要求把某 bot 接到另一 thread 时，先确认真实目标 thread 与工作目录、现有业务是否已结束。不同 bot 必须使用不同 thread/profile；不能仅凭会话标题或旧记录推断。

```powershell
$daemonRoot = Join-Path $env:USERPROFILE '.lark-cli\daemon'
$bindingsPath = Join-Path $daemonRoot 'codex-thread-bindings.json'
node (Join-Path $daemonRoot 'codex-bridge-worker.mjs') --bindings $bindingsPath --check-config
if ($LASTEXITCODE -ne 0) { throw 'Bridge configuration validation failed.' }
$bridgeStatus = & (Join-Path $daemonRoot 'status-codex-bridge.ps1') | ConvertFrom-Json
$bridgeStatus | Select-Object healthy, transport_healthy, delivery_healthy, checked_at
$bridgeStatus.bridge | Select-Object exact_identity, heartbeat_fresh, state
$bridgeStatus.bots | Select-Object bot, daemon_healthy, socket_verified,
    pong_age_seconds, queued_count, awaiting_delivery_count, awaiting_reply_count,
    reply_pending_count, file_pending_count, action_pending_count,
    native_reply_pending_count, native_action_pending_count, cloud_doc_pending_count,
    reaction_pending_count, waiting_input_count, failed_count, watch_error_count
```

`--check-config` 不启动订阅、不推进 offset，仅验证结构、路径和绑定约束；不能证明权限、回调或真实收发成功。`healthy` 允许有界重连宽限，真实 pong 看 `transport_healthy`；最终仍需原 thread 的入站 marker 和答复送达。

## 配置文件与字段

| 文件或配置 | 用途 | 是否上传 Git |
|---|---|---|
| CLI 本机应用配置与凭据 | Bot 身份、profile、应用密钥与令牌 | 否 |
| `daemon/bot-registry.json` | daemon/旧 hooks 的 bot 与 profile 路由 | 否，只上传 example |
| `daemon/codex-thread-bindings.json` | Codex 运行路径、白名单、thread 与行为 | 否，只上传 example |
| `daemon/state/`、TEMP 事件/offset/状态 | 持久消息队列、回包、回调、部署证据 | 否 |
| `daemon/bin/lark-cli.exe`、`subscriber-runtime.json` | 固定版本心跳订阅程序与校验清单 | 否，使用源码构建 |
| `codex-config/` | 可发布的全局指令与技能源码 | 是；安装时保留无关指令 |

脱敏模板见 [codex-thread-bindings.example.json](https://github.com/frank-1-pn/feishu-claude-code-bridge/blob/feat/feishu-ux-20260927/daemon/codex-thread-bindings.example.json)。模板没有可用账号或 thread；占位符必须在本机替换，不能直接启动。已有环境先备份并只修改目标字段，**不能用模板覆盖现有配置**。

`version` 固定为 `1`，至少配置一个 bot。只使用一个 bot 时删除另一个示例项。

| 字段 | 填写与校验 |
|---|---|
| `runtime.codex_home` | 目标会话实际使用的、已存在的 Codex home 目录 |
| `runtime.codex_cli_js` | 实际 Codex CLI JavaScript 入口文件 |
| `runtime.orca_cli_exe` | 实际 Orca CLI 可执行文件 |
| `runtime.lark_send_script` | 已存在的本机发送辅助脚本；当前启动校验仍要求它，仓库未提供该文件 |
| `bindings.<bot>.codex_thread_id` | 既有目标 thread 的真实 UUID，同一配置不可重复 |
| `cwd` | 已存在的目标 workspace 绝对路径，决定附件及项目规则归属 |
| `chat_id` / `allowed_sender_id` | 真实 chat ID / 发送者 open ID；两项同时匹配才接受入站 |
| `profile` | Bot1 是空字符串；现存 coding 是 `coding-assistant-claude`，不要机械改名；同一配置不可重复 |

`runtime` 五个数值均为整数：`poll_interval_ms >= 250`、`heartbeat_interval_ms >= 1000`、`pty_turn_timeout_ms >= 60000`、`max_inbound_bytes >= 1024`、`max_event_age_ms >= 60000`。模板值分别为 1000、15000、1800000、262144、86400000。`pty_turn_timeout_ms` 用于入站后的无活动提醒；公开进度和工具事件继续时延后提醒，不按任务总时长强行超时。

| 可选绑定字段 | 默认与使用边界 |
|---|---|
| `group_access` | 缺省为单一绑定发送者；`all_members_mentions` 允许绑定群全体人类成员精确 @ 本 bot；`all_group_humans` 接收绑定群全体人类消息（含不 @）；仍拒绝其他群、私聊及机器人，且要求合法 `bot_open_id`。危险回调仍只允许 `allowed_sender_id` |
| `native_reply_mode` | 默认 `quote`；另可选 `thread`、`off`。话题不会自动创建独立 Codex 会话 |
| `cardkit_enabled` | 缺省启用；公开进度快照至少间隔 2 秒，非逐 token 输出；已关闭流式卡片自动转同卡整卡更新 |
| `reaction_feedback` | 缺省启用；`all_group_humans` 未分类消息无表情，只有已确认 actionable 且 marker 可见的任务有 Typing/DONE；启用需 `reaction_feedback=true`；原消息表情表示已接收、处理中、答复送达，不等于任务业务验收 |
| `initial_feedback_card` | 缺省关闭；全群策略原消息marker及actionable均核实后，由runtime排入首卡并沿用同一任务卡片，不等待首条模型进度；不对历史完成任务补发 |
| `fast_actionable_classification` | 缺省关闭；仅识别窄范围明确运营动作，沿用不可变分类机制及marker门禁；全部合法消息仍进入原thread，未知交给session，禁止据此执行业务 |
| `voice_enabled` | 只有显式 `true` 才启用；当前用户选择保留入口但不开通 ASR，保持 `false` |
| `cloud_docs.enabled` | 缺省启用报告云文档能力；设 `false` 关闭。权限或创建失败需按交付状态反馈 |
| `document_organization` | 模板显式设 `version:1, enabled:true, bare_file_action:"organize"`。Bot1 默认 `vault`，coding 默认 `project`；单次明确去向优先 |

云报告与**上传收到的原文件**是独立行为：报告能力开启不代表所有附件自动上传。coding 原件默认留项目附件区；明确要求时才归飞书。归类/原件保留/知识库入库的边界见[文档整理](document-organization.md)。卡片、按钮、表单、日期选择器、任务、云报告与真实回调验收见[交互与交付](interaction-and-delivery.md)。

## 修改配置与安全重载

1. 在运行目录之外、Git 之外备份当前配置和计划替换文件，记录固定源码 ref。只编辑指定 bot；保留其他 bot 及未知字段。先校验候选 JSON，成功后通过临时文件加原子替换落盘，不能先删掉旧配置。
2. 配置完成后再次执行 `--check-config`。worker 是常驻进程，写文件或运行幂等 `start-codex-bridge.ps1` 不会让健康 worker 自动重新读配置。
3. 重载必须等待业务 turn 已完成、两个 bot 健康、bridge idle、事件 offset 追平，并逐 bot 检查 `queued`、`awaiting_delivery`、`awaiting_reply`、`reply_pending`、`file_pending`、`action_pending`、`native_reply_pending`、`native_action_pending`、`cloud_doc_pending`、`reaction_pending` 的计数为零；`waiting_input`、blocked、failed、watch error 也要核对处理。缺失字段不能当作零。
4. 本机可能有 `reload-codex-bridge-when-idle.ps1`，但它**不在仓库内，且自身仅检查 idle 与 offset**。不能把它单独当完整安全门禁，也不要用 `AfterSeenMessageId`/`AfterReplyMessageId` 绕过队列检查。必须由唯一部署者在最终动作前重新核对上述条件和实际业务状态；等待过程中继续接消息就继续等，不强制停止 coding。
5. 只重载核验了 PID、命令行、instance 的 worker，保留 subscriber、所有 offset、inbox 和映射。完成后核对新进程、实际文件与固定 ref、健康及队列，再做目标 thread 的消息验收。不要以进程启动成功替代双向验收。

仅更新本指南或 skill：备份后将已提交、已推送版本的 skill 文件复制到**生效 home**，逐文件核对哈希；无需重启 bridge 或 subscriber。全局 `AGENTS.md` 只合并所需规则，不覆盖整个现有文件。

## 在新机器准备环境

这是依赖清单，仓库目前没有经过整体验收的一键 Windows 安装器；同机接手不需要重做这些步骤。

1. 从正确分支克隆并选择经过验证的固定 ref；准备 Node、PowerShell、Orca 和目标 Codex 环境。先正常建立目标会话，确认 CLI 与实际 workspace 路径。不要照仓库旧 Claude/macOS 安装流程替代 Windows Codex 配置。
2. 按 `lark-shared` 配置本机应用身份与 profile，按所需功能配置消息/资源、卡片回调、表情、文档、任务等权限；使用仓库现有订阅过滤，不能另启测试订阅。具体 scopes 与验收以主技能、功能文档和官方当前接口为准；结构校验不会检查这些权限。
3. 将该固定 ref 的 daemon 模块及所需启动/状态/守护脚本安装到本机运行目录，保留模块相对位置。`orca-pty-rpc.mjs`、`resolve-codex-pty.ps1` 必须与 worker 同目录。先解决模板中全部实际路径；`lark_send_script` 需另行提供并核验，本仓库缺此依赖，不可用空文件冒充。
4. 从 example 创建私有 registry/bindings，填写自己的账号白名单与 thread；不要复制原机器的私有状态。按[连接恢复文档](https://github.com/frank-1-pn/feishu-claude-code-bridge/blob/feat/feishu-ux-20260927/docs/feishu-connection-recovery.md)构建固定版心跳 CLI，安装到 `daemon/bin/lark-cli.exe` 并保留 manifest。通用 npm CLI 与此订阅专用程序可以不同；不能用通用 CLI 的哈希判断 subscriber 是否被替换。
5. 将技能装到生效 Codex home，按需合并全局指令，执行只读配置校验。确认没有对应订阅后才让既有 `ensure-bot.ps1 ... -SkipSessionBinding` 启动所需 bot，再用 `start-codex-bridge.ps1` 启动唯一 worker。
6. `configure-feishu-watchdog.ps1` 调整**已有** `FeishuBotWatchdog`，不负责新建任务。新机器需先配置合适的本机任务身份和权限；入口使用 `wscript.exe //B //NoLogo run-watchdog-hidden.vbs`，每分钟检查。仅给 PowerShell 加 `-WindowStyle Hidden` 仍可能闪窗。
7. 进行实际验收：绑定聊天发唯一标记 → 白名单入站 → 正确 thread 的 rollout marker → 最终回复送达。按钮/表单需真实点击并进入原 thread；文件必须核对下载/读取/实际交付，排队不是完成。未完成部分明确保留为待验收。

## 可直接交给另一 session 的说明

> 请从 `feat/feishu-ux-20260927` 的 `AGENTS.md`、`feishu-bot-runtime` skill 与本指南接手。先区分代码 checkout、已安装文件和常驻进程版本。当前 bot/thread/profile 从本机私有配置读取，复用已有 daemon，不另开订阅；仅维护文档不改绑、不重启。需要配置时先确认目标 thread、备份和校验，等 coding 及各投递队列完成再由唯一部署者重载。保留 Bot1 知识库、coding 项目附件、ASR 关闭的当前选择；配置、密钥、私有消息和原始附件不上传 Git。完成报告区分已提交、已推送、已安装与真实收发验收。

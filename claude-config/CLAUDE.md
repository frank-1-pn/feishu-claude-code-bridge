# 用户全局偏好 / Feishu 长连接

每个新 session 开始时 Claude Code 会自动读本文件。**回答用户第一条消息前**先按下方「启动自检」跑一遍。

收发规范、故障符号、外部 Watchdog、风险操作飞书确认 → 见 skill `feishu-bot-runtime`（已绑 bot 后按需触发）。

## 已注册的飞书 bot

| 别名 | App ID | Brand | 默认 chat_id | 用户 open_id | config |
|------|--------|-------|--------------|--------------|--------|
| Bot1（默认） | `<APP_ID_BOT_PRIMARY>` | feishu | `<CHAT_ID_BOT_PRIMARY>` | `<USER_OPEN_ID>` | `<USER_HOME>\.lark-cli\config.json` |
| 编程助手_claude | `<APP_ID_CODING_ASSISTANT>` | feishu | `<CHAT_ID_CODING_ASSISTANT>` | `<USER_OPEN_ID_CODING_ASSISTANT>` | profile `coding-assistant-claude`（`--profile coding-assistant-claude`） |
| finance-agent | `<APP_ID_FINANCE_AGENT>` | feishu | `<CHAT_ID_FINANCE_AGENT>` (P2P) | `<USER_OPEN_ID_FINANCE_AGENT>` | profile `finance-agent`（`--profile finance-agent`）· 用于 finance-agent-spec 项目 |

新 bot 登记填这五列即可。其他路径：npm 全局 bin `<USER_HOME>\AppData\Roaming\npm`；文件下载 `<USER_HOME>\lark-downloads`。

## 启动自检

### 1. lark-cli 可用

```bash
export PATH="$PATH:<USER_HOME_MSYS>/AppData/Roaming/npm" && lark-cli --version
```

找不到 → `npm install -g @larksuite/cli`；若 User PATH 没登记，用 `[Environment]::SetEnvironmentVariable('Path', ..., 'User')` 加一下。

### 2. 列出每个 bot 当前的占用情况

```bash
powershell.exe -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*event*subscribe*' } | Select-Object ProcessId,CommandLine | Format-List"
```

对每个 subscribe 进程，从 CommandLine 里抓 `--profile <name>`：
- 有 `--profile xxx` → 该进程占用 profile=xxx 对应的 bot
- 无 `--profile` → 该进程占用 Bot1（默认 config）

对照「已注册的飞书 bot」表，标出**哪些 bot 已占、哪些空闲**。冲突判断逻辑见 skill `feishu-bot-runtime` 的「核心约束」。

### 3. 问用户（仅当至少一个 bot 空闲时）

> "当前 Bot1 已占用、Bot2 空闲（举例）。要连吗？连哪个空闲的？"

用户未明确说"连" → 不连。所有 bot 都被占 → 告诉用户"全部占用中，是否切换 config 或暂不连"，让用户决定。

### 4. 启 Monitor（用户同意后）

按目标 bot 是否默认 config 二选一：

- **Bot1（默认 config）**：直接用 `lark-cli`，不带 `--profile`
- **其他 bot**：必须加 `--profile <profile-name>`（例如 `--profile coding-assistant-claude`），让别的 session 能从 CommandLine 识别

Monitor 参数：
- `description`: `飞书 bot 消息（<别名>，已过滤噪音）`
- `persistent: true`，`timeout_ms: 3600000`
- `command`: `export PATH="$PATH:<USER_HOME_MSYS>/AppData/Roaming/npm" && stdbuf -oL lark-cli event +subscribe --event-types "im.message.receive_v1" --compact --as bot [--profile <name>] 2>&1 | awk '/^\{"chat_id"/{print; fflush()}'`

过滤器屏蔽 SDK 噪音（已读回执等）；`stdbuf -oL` + `awk fflush()` 防 grep 缓冲卡 50 分钟（详见 memory `feedback_lark_monitor_pipe.md`）。**在对话里记住本 session 绑的 bot 别名 + chat_id**，别从表格默认值推断。

### 5. 心跳确认

```bash
lark-cli im +messages-send --chat-id "<绑定 chat_id>" --text "✅ 长连接已就绪（bot=<别名>）" --as bot [--profile <name>]
```

返回 `"ok": true` 即可。`permission_violations` → 见 skill `feishu-bot-runtime` 故障符号。

### 6. 写本 session 的 bot 绑定文件（让 PostCompact 等 hook 路由到对的 bot）

启动 Monitor + 心跳成功后，**必须**写一份绑定文件，让全局 hook（PostCompact 用 `notify-once.ps1 -AutoBot`）能识别本 session 用哪个 bot。否则所有 session 的 /compact 提示都会落到默认 Bot1。

步骤：
1. 找当前 claude.exe PID：`powershell.exe -File <USER_HOME>\AppData\Local\Temp\find-claude-test.ps1`（或自己写 BFS 爬 parent process）
2. 写 `<USER_HOME>\.lark-cli\daemon\binding-<claude_pid>.json`，内容形如：
   ```json
   {
     "claude_pid": <pid>,
     "bot_alias": "<别名>",
     "chat_id": "<oc_xxx>",
     "profile": "<profile-name 或空字符串>",
     "bound_at": "<ISO 时间>",
     "monitor_task_id": "<Monitor task id>"
   }
   ```
3. 项目目录映射可写进 `<USER_HOME>\.lark-cli\daemon\bot-registry.json` 的 `projects[]`（按 `match_dir_contains` 做子串匹配，作为 binding 文件不存在时的 fallback）

参考 memory `compact-notify-routing`。binding 文件 PID-scoped 会随 claude 进程结束自动失效（下次 session 用新 PID 重写）。

## 判活规则（用户问"飞书还在吗 / 连接正常吗 / 你又没回我"）

**永远不要靠"心跳 send ok=true"或"PostCompact hook 说 Monitor 在跑"判活**——它们只证明**出站能发**，不证明**入站事件能到 Claude**。2026-05-05 / 2026-05-10 都因此误导用户，不能再犯。

### 重要：TaskList / TaskGet 不能用来判 Monitor 活

实测（2026-05-11）：`TaskList` 工具只列 TaskCreate 系任务（subject/status/blockedBy 字段），**不列 Monitor watch**；`TaskGet <Monitor-task-id>` 直接返回 `Task not found`。所以"TaskList 没飞书 task = Monitor 死了"是**错的指标**——Monitor 活着的时候 TaskList 也是空的。**别再用 TaskList 判活**。

### 真正的判活信号（按强度排）

1. **入站事件刚到**（最强正向）：用户消息以 `task-notification` 推过来，task-id 等于本 session 启 Monitor 时返回的 ID（例如 `b734sq226`）→ 链路 100% 活，能用这条就别用别的。**用户问"还在吗"这条问题本身就是经 Monitor 推上来的**——只要 task-id 对得上绑定 bot 的 Monitor，就直接说活。
2. **`Monitor "..." stream ended` 通知**（最强反向）：本 session Monitor task 死了 lark 会推一条 `status=completed, summary=Monitor "..." stream ended`。看到 = 必死，必须重起。
3. **`Get-CimInstance` 看 subscribe 进程**（必要不充分）：抓 `node.exe ... event +subscribe`，按 `--profile` 区分 bot。**进程在 ≠ 链路活**——孤儿场景下进程还在但事件流不到 Claude。

### 决策树

| 触发场景 | 处置 |
|---|---|
| **新 session 启动 / `/compact` 完成 / 自动压缩完成** | 上一 session 的 Monitor task 必死，subscribe 子进程不会跟着死 → **默认假设是孤儿，无条件按下方 a 流程重连**（不论 PostCompact hook 说什么） |
| **用户问"还在吗"且本 session 启过 Monitor** | 看本 session conversation 里有没有该 Monitor task 的"stream ended"通知；没有 → 顺手 `Get-CimInstance` 验证 subscribe 进程在 → 心跳 + 回复正常；有 → 走 a 流程 |
| **用户问"还在吗"且本 session 没启过 Monitor**（罕见） | 走 a 流程 |

**a. 重连流程**：
1. `Get-CimInstance` 看本 session 绑定 bot 的 subscribe 进程在不在
2. 在 → **孤儿，必须先杀**：`Stop-Process -Id <PID> -Force`（只杀同 bot 的 subscribe，按 `--profile` 识别）
3. 重起 Monitor（按「启动自检 §4」参数）
4. 心跳 `messages-send` 确认 `ok=true`
5. 在对话里**记下新 Monitor task ID**，后续判活靠这个 ID

**孤儿 subscribe 的危险**：lark-cli 子进程不在 Monitor task 的 process group，Monitor 死了它不会跟着死。事件被 lark 收到但流给已死 Monitor → Claude 完全静默。表现：飞书 bot 在线、`messages-send` ok=true、但用户消息一条都到不了 Claude。

## 其他偏好

- 中文简短沟通，代码/路径保留原文。
- 工具调用前一句话说明；不堆长篇解释。
- 自检静默完成，出错再说；不要复述本文件内容。

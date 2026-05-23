---
type: source
title: "Feishu CLI ↔ Claude Code 完整集成与复刻指南（v4 / 2026-05-22）"
author: "Frank（v1 2026-04-14） + Claude Code（v2 重写 2026-05-03 / v3 重写 2026-05-16 / v4 增补 2026-05-22）"
created: 2026-04-14
updated: 2026-05-22
status: evergreen
tags:
  - feishu
  - lark-cli
  - claude-code
  - websocket
  - bot
  - integration
  - replication-guide
  - infrastructure
  - hooks
  - scheduled-task
  - powershell
  - multi-bot
  - liveness
  - orphan-handling
related:
  - "[[Omi AI 第二大脑平台研究笔记]]"
  - "[[Anthropic Prompt Caching 是构建 Claude Code 的一切 7 条工程经验]]"
  - "[[Claude Agent SDK 用 Claude Code 内核做 AI Agent 库 架构与全套能力]]"
  - "[[claude-mem 持久记忆压缩系统 71K Star 架构与分层]]"
---

# Feishu CLI ↔ Claude Code 完整集成与复刻指南

> [!abstract] 摘要
> **目标**：在 Windows 主机的 Claude Code session 内，通过 `lark-cli` 与飞书企业账号建立**双向实时通信** —— 用户从手机 / PC 飞书发指令，Claude 在 session 内执行后回复；session 长时间运行不掉线（外部 Watchdog 守护）；多 session 不互抢 bot；session compact / end 自动通知用户。
>
> **本指南是「复刻级」文档** —— 另一个 AI 读完后能在新机器上从零搭建一套等价系统，**不需要再问任何问题**。覆盖：
> - 飞书开发者后台一次性配置（创建自建应用 / 拿 App ID & Secret / 开 scope / 配置事件订阅 v2）
> - 本机 lark-cli 安装与 keychain 凭据存储
> - 多 bot 注册（default + named profile）+ session-level 隔离机制（lock 文件 + CommandLine profile 识别）
> - Claude Code 全局 `CLAUDE.md` 启动自检规则（5 步）+ `settings.json` hooks（PostCompact / SessionEnd）
> - **判活规则**（按强度排的 3 类信号 + 决策树）★ v3 新增
> - **/compact 后孤儿处理流程**（subscribe 子进程残留 + Monitor task 已死的清理-重起） ★ v3 新增
> - 外部 Watchdog（PowerShell + Task Scheduler PT30M）
> - 完整故障树 + 安全加固 + 风险操作确认流程
> - **从零复刻 Checklist**（50+ 条）让另一个 AI 一条条核对
>
> **v3 主要更新（2026-05-16）**：① Monitor 管道 `grep` → `awk + stdbuf + fflush()`（防 50 分钟缓冲卡死）② 新增 §6.5「判活规则」③ 新增 §9「/compact 孤儿处理流程」④ §7 Hooks 重写——PostCompact `additionalContext` 注入已被 schema 拒绝（实测报错），改用「依赖 Claude 默认按孤儿处理」策略 ⑤ 标注哪些运行时规则迁入了 skill `feishu-bot-runtime`（CLAUDE.md 主文件只留「自检 + 判活」骨干）。
>
> **v4 主要更新（2026-05-22）⭐ 架构性重构**：① **Daemon 模式上线**——lark-cli 从「Monitor 子进程」升级为「PowerShell Start-Process 独立 daemon」，**事件流 (NDJSON log) 与 Monitor 解耦** ② **去 keepalive 污染**——v3 必须每 2-4 分钟跳 `__KEEPALIVE__` 保活 Monitor（每跳 1 个 task notification 污染 Claude context）；v4 改 `tail -F + offset` 模式，无消息时 0 通知 ③ **Offset 跟踪**——Monitor stream-ended 后重启从精确字节位置接续，**不漏消息**（v3 stream-ended 期间消息会丢）④ **ensure-bot1.ps1 自愈**——session 启动 / /compact / stream-ended 时一行命令做 health check + 必要时重启 daemon + log >50MB 自动 rotate ⑤ **新增 §19 v3↔v4 对照与迁移说明** ⑥ **新增 §20「飞书触发 /compact」**——v4.2 加 `/compact!` 触发器（awk pattern + sender 白名单）+ 3 个 helper 脚本（find-claude / screenshot-window / send-keys）+ Claude 编排两阶段人工批准（提议 → 输入预览 → 执行）⑦ Memory `feedback_compact_via_feishu.md` 落地详细编排逻辑。
>
> 适合：① 在新机器复刻同样工作流 ② 帮其他人搭建类似系统 ③ 故障时回头查每个组件的设计意图 ④ 看「为什么从 v2 演化到 v4」反推 production lessons ⑤ **想了解「真触发 /compact」物理边界与键盘宏加固方案**。

---

## 一、整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│  飞书企业账号（cloud）                                          │
│  - 自建应用 1: <APP_ID_BOT_PRIMARY>（Bot1，默认）               │
│  - 自建应用 2: <APP_ID_CODING_ASSISTANT>（编程助手_claude）          │
│    每个应用有独立 App ID + Secret + 开通的 scope                │
│    每个应用收到的事件走自己的 WebSocket 长连接                  │
└────────────────────────┬─────────────────────────────────────────┘
                         │ WebSocket (im.message.receive_v1)
                         │ HTTPS (messages-send / download)
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│  Windows 11 主机                                                  │
│                                                                    │
│  ~/.lark-cli/                                                     │
│  ├─ config.json     # 注册的 bot 列表 + appSecret keychain 引用 │
│  ├─ locks/          # subscribe_<appId>.lock（运行时排他）      │
│  └─ logs/                                                         │
│                                                                    │
│  ~/.claude/                                                       │
│  ├─ CLAUDE.md       # 全局规则：启动自检 + 多 bot + 判活规则★ │
│  ├─ skills/         # feishu-bot-runtime skill（运行时规则）★  │
│  ├─ settings.json   # hooks: PostCompact / SessionEnd 通知      │
│  └─ scripts/                                                      │
│      └─ feishu-watchdog.ps1   # PT30M 计划任务每 30 分钟巡检   │
│                                                                    │
│  Claude Code session（每次启动）                                  │
│  ├─ 跑启动自检（5 步，按 bot 粒度判冲突）                       │
│  ├─ 启 Monitor 跑 lark-cli event +subscribe（长连接）           │
│  │   命令用 awk + stdbuf -oL（v3 新；旧 grep 卡 50 分钟）★    │
│  ├─ 收 NDJSON 事件 → 处理 → 用 messages-send 回复               │
│  ├─ /compact 完成 → 默认按孤儿处理：杀残留 → 重起 Monitor★    │
│  └─ session 结束 → SessionEnd hook 自动通知用户                 │
│                                                                    │
│  Task Scheduler                                                   │
│  └─ FeishuBotWatchdog（PT30M）→ feishu-watchdog.ps1            │
│                ↓                                                  │
│      检查 node.exe 跑 *event*subscribe* 进程是否存在            │
│                ↓                                                  │
│      不存在 → 发飞书告警 "bot 长连接已断"                       │
└──────────────────────────────────────────────────────────────────┘
```

**关键设计选择**：
1. **bot 粒度判冲突**（不是 session 粒度）—— 同一 bot 只能被一个 subscribe 占用，但**不同 bot 可以并行**
2. **Profile 区分**（lark-cli `--profile`）—— 多 bot 共存的核心机制；CommandLine 里能解析出来
3. **AppSecret 不落盘明文** —— lark-cli 用系统 keychain（macOS Keychain / Windows Credential Manager）
4. **外部 Watchdog 而非自心跳** —— 减少噪音，只在断连时告警
5. **判活靠 task-notification ID 匹配，不靠心跳 ok=true**（v3 新规则） —— 心跳只证明出站能发，不证明入站事件能到 Claude
6. **/compact 后默认按孤儿处理**（v3 新规则） —— 上一 session 的 Monitor task 必死、subscribe 子进程不会跟着死，所以无条件清理-重起
7. **运行时规则迁入 skill `feishu-bot-runtime`** —— CLAUDE.md 主文件保留「启动自检 + 判活」骨干，详细收发 / 长消息 / 风险操作确认在 skill 里按需触发（降低每个新 session 的固定 token 开销）

> 类比（§10 实践）：bot 之于 Claude session = 电话号码之于电话——同一个号码同一时刻只能接一通电话（lark-cli 服务端 lock），但不同号码可以分别接（profile 隔离）。

---

## 二、前置条件（一次性）

| 项 | 要求 | 验证 |
|---|---|---|
| OS | Windows 10/11（macOS / Linux 大部分步骤通用，Watchdog 需改 cron） | `ver` |
| Node.js | ≥ 18.0.0 | `node --version` |
| npm 全局 bin in PATH | `<USER_HOME>\AppData\Roaming\npm`（Win）或 `~/.npm/bin`（Unix） | `where npm` / `which npm` |
| 飞书企业账号 | 有管理员权限（创建自建应用） | 登录 https://open.feishu.cn/ |
| Claude Code | 已安装、能跑 session | `claude --version` |
| PowerShell | 5.1+（Win 自带） | `powershell.exe -Command "$PSVersionTable.PSVersion"` |
| 网络 | 能直连 `open.feishu.cn` / `wss://...feishu.cn`（中国大陆需企业网络或国际代理） | `curl -v https://open.feishu.cn/health` |
| **awk + stdbuf** | Git Bash / WSL 自带（v3 新依赖：Monitor 管道用） | `awk --version && stdbuf --version` |

---

## 三、第一步：飞书开发者后台一次性配置（每个 bot 一遍）

### 3.1 创建自建应用

1. 登录 https://open.feishu.cn/app
2. **创建企业自建应用**（不是商店应用） → 填名称（如 "Claude Code Bot"）+ 描述 + 头像
3. 获得：
   - **App ID**：`cli_xxxxxxxxxxxxxxxx`（17 字符）
   - **App Secret**：`xxxxxxxxxxxxxxxxxxxxxxxxxx`（敏感！只显示一次）
4. 立即把 App Secret 抄下，**不要截屏发群**（PII 视同密码）

### 3.2 开权限（最小集）

进 **「权限管理」→「权限配置」**，开通以下 scope（按"机器人 IM"分类）：

| Scope | 作用 | 必需性 |
|---|---|---|
| `im:message:send_as_bot` | 以 bot 身份发消息到群/单聊 | **必需** |
| `im:message` | 接收消息事件 | **必需** |
| `im:message.p2p_msg:readonly` | 读单聊消息历史 | 推荐（取截断消息全文） |
| `im:message.group_at_msg:readonly` | 群里 @bot 消息 | 群场景需要 |
| `im:resource` | 下载消息附件（文件 / 图片） | 文件交互需要 |
| `im:chat:readonly` | 读 chat 元信息（拿 chat_id） | 推荐 |
| `contact:contact.base:readonly` | 读联系人（拿 open_id） | 推荐 |

开完点 **"申请发布"** → 等管理员审批（自己是管理员就立刻通过）。

### 3.3 配置事件订阅（V2 长连接）

进 **「事件与回调」→「事件订阅」**：

1. 选 **「订阅方式」=「长连接」**（不是 Webhook）—— 这是 lark-cli 用的模式
2. 添加事件 → 搜 **`im.message.receive_v1`**（接收消息 v2）→ 添加
3. （可选）添加 `im.message.message_read_v1` 等

**完成后这个 bot 就准备好被 lark-cli 订阅了**。

### 3.4 把 bot 加到目标群 / 单聊

- **单聊**：在飞书 PC 端搜 bot 名 → 发起单聊；记下右键群/会话 → 复制 chat_id（`oc_xxx`）
- **群聊**：群设置 → 群机器人 → 添加 → 选你的应用；用 lark-cli `chat-list` 拿 chat_id

> ⚠️ chat_id 是 PII，**不要泄露到公网 / 截图**。

### 3.5 拿 user open_id（自己的）

`lark-cli` 安装后用：

```bash
lark-cli auth login --domain im   # 用户授权
lark-cli contact +user-info-batch-get --user-id-list "<your-mobile>" --user-id-type mobile
```

返回里有 `open_id: ou_xxxxxxxxxxxxx` —— 这是你自己在该 bot 下的身份 ID（不同 bot 不同）。

---

## 四、第二步：本机安装 lark-cli

### 4.1 全局安装

```bash
npm install -g @larksuite/cli
```

验证：

```bash
lark-cli --version    # 期望：lark-cli version 1.0.11+
```

GitHub: https://github.com/larksuite/cli

> v3 备注（2026-05-16）：实测系统在跑 1.0.11，官方最新 1.0.32。**1.0.11 已稳定**，本指南所有命令在 1.0.11 验证过；升级到 1.0.32 不强制，仅在遇到 1.0.11 已知 bug 时考虑。

### 4.2 PATH 配置（Windows）

如果 `lark-cli: command not found`，把 npm 全局 bin 加到 User PATH：

```powershell
[Environment]::SetEnvironmentVariable(
  'Path',
  [Environment]::GetEnvironmentVariable('Path','User') + ';<USER_HOME>\AppData\Roaming\npm',
  'User'
)
```

或者每次手动 `export PATH="$PATH:<USER_HOME_MSYS>/AppData/Roaming/npm"`。

### 4.3 准备文件下载目录

```bash
mkdir -p <USER_HOME_MSYS>/lark-downloads
```

lark-cli 下载文件**强制要求相对路径**（安全限制），所以约定**每次下文件先 cd 进这个目录**。

---

## 五、第三步：注册 bot 到 lark-cli（多 bot 关键）

### 5.1 注册第一个 bot（默认 profile）

```bash
echo "<App Secret>" | lark-cli config init \
  --app-id "cli_xxxxxxxxxxxxxxxx" \
  --app-secret-stdin \
  --brand feishu
```

- `--app-secret-stdin` 通过 stdin 传 secret，**不出现在命令行历史 / ps 列表**
- secret 会**存到系统 keychain**（macOS Keychain / Windows Credential Manager），`config.json` 只存引用

```bash
lark-cli auth login --domain im
```

会输出一个授权 URL，浏览器打开 → 同意 → lark-cli 自动拿到 user token。

### 5.2 注册第二个 bot（named profile，关键！）

```bash
echo "<App Secret 2>" | lark-cli config init \
  --app-id "cli_yyyyyyyyyyyyyyyy" \
  --app-secret-stdin \
  --brand feishu \
  --profile coding-assistant-claude
```

`--profile <name>` 是**多 bot 隔离的核心机制**：
- 之后用 `--profile coding-assistant-claude` 调本 bot
- 启 subscribe 时 CommandLine 里会带 `--profile coding-assistant-claude`，让其他 session 能识别"哪个 bot 已被占"

### 5.3 验证 config.json

```bash
cat ~/.lark-cli/config.json
```

期望结构：

```json
{
  "apps": [
    {
      "appId": "<APP_ID_BOT_PRIMARY>",
      "appSecret": {
        "source": "keychain",
        "id": "appsecret:<APP_ID_BOT_PRIMARY>"
      },
      "brand": "feishu",
      "lang": "zh",
      "users": []
    },
    {
      "name": "coding-assistant-claude",
      "appId": "<APP_ID_CODING_ASSISTANT>",
      "appSecret": {
        "source": "keychain",
        "id": "appsecret:<APP_ID_CODING_ASSISTANT>"
      },
      "brand": "feishu",
      "lang": "zh",
      "users": []
    }
  ]
}
```

**关键检查**：
- `appSecret.source == "keychain"`（**不是** `"plain"`）—— 否则 secret 落盘明文
- 第二个 app 有 `name` 字段 = profile 名

### 5.4 已注册 bot 元信息表

每个 bot 至少记录这 5 列（在 vault `~/.claude/CLAUDE.md` 维护，**不要扩散到其他笔记**）：

| 列 | 说明 | 示例 |
|---|---|---|
| 别名 | 人话名字 | Bot1（默认） |
| App ID | `cli_xxx` | `<APP_ID_BOT_PRIMARY>` |
| Brand | feishu / lark | feishu |
| 默认 chat_id | 与你单聊的 chat | `oc_xxx` |
| 用户 open_id | 你在该 bot 下的 ID | `ou_xxx` |
| Config | 路径或 profile 名 | `~/.lark-cli/config.json`（默认）/ `--profile coding-assistant-claude` |

### 5.5 用户口语约定（v3 新增）

> 类比：bot 别名像同事昵称——用户喊"那个 claude code bot"指的就是 Bot1，不指 App ID。

- 用户口语**「claude code bot」= Bot1**（默认 profile）
- **主力 session**（cwd=`<USER_HOME>`）默认绑 Bot1
- **编程助手_claude** 留给另一 session（一般是 cwd 在某个项目目录的 coding session）

这条约定写在全局 CLAUDE.md，避免新 session 抢错 bot。

---

## 六、第四步：Claude Code 全局规则（启动自检 5 步 + 判活规则）

### 6.1 写入 `~/.claude/CLAUDE.md`

把下方完整规则块写入 `~/.claude/CLAUDE.md`（这个文件每次新 session 自动加载）。**注意：v3 起 Monitor 命令用 `awk + stdbuf -oL`，不是 grep**。

```markdown
# 用户全局偏好 / Feishu 长连接

每个新 session 开始时 Claude Code 会自动读本文件。**回答用户第一条消息前**先按下方「启动自检」跑一遍。

收发规范、故障符号、外部 Watchdog、风险操作飞书确认 → 见 skill `feishu-bot-runtime`（已绑 bot 后按需触发）。

## 已注册的飞书 bot

| 别名 | App ID | Brand | 默认 chat_id | 用户 open_id | config |
|------|--------|-------|--------------|--------------|--------|
| Bot1（默认） | <APP_ID_BOT_PRIMARY> | feishu | oc_xxx | ou_xxx | ~/.lark-cli/config.json |
| 编程助手_claude | <APP_ID_CODING_ASSISTANT> | feishu | oc_yyy | ou_yyy | profile coding-assistant-claude |

## 启动自检

### 1. lark-cli 可用
\`\`\`bash
export PATH="$PATH:<USER_HOME_MSYS>/AppData/Roaming/npm" && lark-cli --version
\`\`\`
找不到 → `npm install -g @larksuite/cli`。

### 2. 列出每个 bot 当前的占用情况
\`\`\`bash
powershell.exe -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { \\$_.CommandLine -like '*event*subscribe*' } | Select-Object ProcessId,CommandLine | Format-List"
\`\`\`
对每个 subscribe 进程，从 CommandLine 抓 `--profile <name>`：
- 有 `--profile xxx` → 该进程占用 profile=xxx 对应的 bot
- 无 `--profile` → 该进程占用 Bot1（默认 config）

### 3. 问用户（仅当至少一个 bot 空闲时）
> "当前 Bot1 已占用、Bot2 空闲（举例）。要连吗？连哪个空闲的？"

用户未明确说"连" → 不连。

### 4. 启 Monitor（用户同意后）

按目标 bot 是否默认 config 二选一：
- **Bot1（默认）**：直接 `lark-cli`，不带 `--profile`
- **其他 bot**：必须加 `--profile <name>`

Monitor 参数：
- `description`: `飞书 bot 消息（<别名>，已过滤噪音）`
- `persistent: true`，`timeout_ms: 3600000`
- `command`（v3 新——awk + stdbuf 防 50 分钟缓冲卡死）：
  \`\`\`
  export PATH="$PATH:<USER_HOME_MSYS>/AppData/Roaming/npm" && stdbuf -oL lark-cli event +subscribe --event-types "im.message.receive_v1" --compact --as bot [--profile <name>] 2>&1 | awk '/^\{"chat_id"/{print; fflush()}'
  \`\`\`

**在对话里记住本 session 绑的 bot 别名 + chat_id + Monitor task ID**，别从表格默认值推断。

### 5. 心跳确认
\`\`\`bash
lark-cli im +messages-send --chat-id "<绑定 chat_id>" --text "✅ 长连接已就绪（bot=<别名>，task=<task-id>）" --as bot
\`\`\`
返回 `"ok": true` 即可（**注意：ok=true 不证明入站事件能到 Claude，只证明出站能发；判活看 §判活规则**）。

## 判活规则（用户问"飞书还在吗 / 连接正常吗 / 你又没回我"）

**永远不要靠"心跳 send ok=true"或"PostCompact hook 说 Monitor 在跑"判活**——它们只证明**出站能发**，不证明**入站事件能到 Claude**。

### 重要：TaskList / TaskGet 不能用来判 Monitor 活

实测（2026-05-11）：`TaskList` 只列 TaskCreate 系任务，**不列 Monitor watch**；`TaskGet <Monitor-task-id>` 直接返回 `Task not found`。Monitor 活着的时候 TaskList 也是空的。

### 真正的判活信号（按强度排）

1. **入站事件刚到**（最强正向）：用户消息以 `task-notification` 推过来，task-id 等于本 session 启 Monitor 时返回的 ID → 链路 100% 活。**用户问"还在吗"这条问题本身就是经 Monitor 推上来的**——只要 task-id 对得上，直接说活。
2. **`Monitor "..." stream ended` 通知**（最强反向）：本 session Monitor task 死了 lark 会推一条。看到 = 必死，必须重起。
3. **`Get-CimInstance` 看 subscribe 进程**（必要不充分）：抓 `node.exe ... event +subscribe`。**进程在 ≠ 链路活**——孤儿场景下进程还在但事件流不到 Claude。

### 决策树

| 触发场景 | 处置 |
|---|---|
| 新 session 启动 / /compact 完成 / 自动压缩完成 | 上一 session Monitor 必死，子进程不会跟着死 → **默认假设孤儿，无条件按下方 a 流程重连** |
| 用户问"还在吗"且本 session 启过 Monitor | 看本 session 有没有该 Monitor task 的"stream ended"通知；没有 → 顺手 `Get-CimInstance` 验证 subscribe 进程在 → 心跳 + 回复正常；有 → 走 a 流程 |
| 用户问"还在吗"且本 session 没启过 Monitor | 走 a 流程 |

**a. 重连流程**：
1. `Get-CimInstance` 看本 session 绑定 bot 的 subscribe 进程在不在
2. 在 → **孤儿，必须先杀**：`Stop-Process -Id <PID> -Force`（只杀同 bot 的）
3. 重起 Monitor（按「启动自检 §4」参数）
4. 心跳 `messages-send` 确认 `ok=true`
5. 在对话里**记下新 Monitor task ID**，后续判活靠这个 ID
```

### 6.2 为什么是 5 步而不是 1 步

| 步 | 作用 | 不能省的原因 |
|---|---|---|
| 1. CLI 可用 | 验证安装 | 重启电脑 / 卸载 / PATH 丢失会让步 2 直接报"command not found" |
| 2. 列占用 | 看哪个 bot 空闲 | **核心**——避免抢另一 session 的 bot |
| 3. 问用户 | 让用户决定连哪个 | 默认行为 = 不连；强制问避免假设 |
| 4. 启 Monitor | 长连接 | 用 `persistent: true` + awk 关键（v3） |
| 5. 心跳 | 验证 scope 没坏 | 配置错 / scope 没开会在第 5 步显形 |

### 6.3 为什么 Monitor 命令必须 `awk + stdbuf -oL`（v3 新增）

> 类比：grep 默认是「装满整桶水才递给你」，awk + fflush 是「每滴水都立刻递」。

memory `feedback_lark_monitor_pipe.md` 记录了 2026-05 教训：v2 的 `grep --line-buffered` 命令在某些 bash 版本下**实际不是行缓冲**，最长卡 50 分钟 user 才看到第一条事件——飞书消息明明到了，Claude 不知道。

修正方案（v3 已 mainstream）：

```bash
stdbuf -oL lark-cli event +subscribe --event-types "im.message.receive_v1" --compact --as bot [--profile <name>] 2>&1 \
  | awk '/^\{"chat_id"/{print; fflush()}'
```

- `stdbuf -oL` 强制 lark-cli 进程 stdout 行缓冲
- `awk '... {print; fflush()}'` 每打印一行就 flush，绝不积攒
- 过滤器 `^\{"chat_id"` 只放行真正的事件，屏蔽 SDK 噪音（已读回执 / heartbeat / 调试日志）

**踩坑标志**：飞书 bot 显示在线、`messages-send ok=true`、但用户消息一条都到不了 Claude → 99% 是这个缓冲问题，看 Monitor 命令是不是用了 grep。

### 6.4 判活规则的「自检静默」原则

> 反面举例：旧版 v2 习惯启 Monitor 后马上发"❤️ heartbeat"——结果用户飞书叮叮叮，最后屏蔽 bot。

启动自检 5 步**全部静默完成**，只在出错时报告。用户体验 = "我开了个 session，飞书没动静，但我发消息就立刻有人接"。

---

## 六★、第 4.5 步：判活规则（v3 新增，对应全局 CLAUDE.md「判活规则」节）

判活规则在 §6.1 已写进全局 CLAUDE.md，这里讲**为什么这么设计**（v3 新章）。

### 6.5.1 v2 时代的错觉与 2026-05 教训

v2 时代的判活逻辑：

1. 用户问"还在吗" → Claude 跑 `lark-cli im +messages-send` 心跳 → 看到 `ok=true` → 回"在"
2. /compact 完成 → PostCompact hook 注入"Monitor 仍在跑"提示 → Claude 不重启 Monitor

**两个都错了**。2026-05-05 + 2026-05-10 用户两次遇到"飞书显示在线但消息到不了 Claude"，原因：

| 错觉 | 实际 |
|---|---|
| `messages-send ok=true` = 链路活 | 只证明**出站 HTTPS 能发**，不证明**WebSocket 入站能到 Claude** |
| PostCompact hook 说"Monitor 在跑" | hook 检查的是上一 session 的 Monitor task，**新 session 看不到那个 task** |
| `Get-CimInstance` 抓到 subscribe 进程 = 链路活 | subscribe 子进程不在 Monitor task 的 process group，Monitor 死了它不会跟着死 → 事件被 lark 收到但流给已死 Monitor → **Claude 完全静默** |

### 6.5.2 真正可靠的判活信号

**唯一最强正向信号**：用户的消息以 `task-notification` 推过来，且 `task-id` 等于本 session 启 Monitor 时返回的 ID。

这意味着：用户问"还在吗" → 如果这条问题本身是经 Monitor 推上来的 → **链路 100% 活**。可以直接回"还在"，不用再发心跳。

**唯一最强反向信号**：lark 推送的 `Monitor "..." stream ended, status=completed, summary=...` 通知。看到 = 必死，必须重起。

### 6.5.3 决策树（与 §6.1 重复，方便回头查）

| 触发场景 | 处置 |
|---|---|
| 新 session 启动 / /compact 完成 / 自动压缩完成 | 上一 session Monitor 必死，subscribe 子进程不会跟着死 → **默认假设孤儿**，无条件按 §9 重连流程 |
| 用户问"还在吗"且本 session 启过 Monitor | 看本 session 有没有该 Monitor task 的"stream ended"通知；没有 → 顺手 `Get-CimInstance` 验证 subscribe 进程在 → 心跳 + 回复正常；有 → 走 §9 重连流程 |
| 用户问"还在吗"且本 session 没启过 Monitor | 走 §9 重连流程 |

### 6.5.4 为什么不放过期的「TaskList 法」

v2 隐含假设：用 `TaskList` 看 Monitor task 在不在。**2026-05-11 实测：`TaskList` 只列 TaskCreate 系任务，不列 Monitor watch；`TaskGet <Monitor-task-id>` 直接返回 `Task not found`**。

所以"TaskList 没飞书 task = Monitor 死了"是**错的指标**——Monitor 活着的时候 TaskList 也是空的。已从 v3 决策树里彻底删除。

---

## 七、第五步：Claude Code Hooks（session lifecycle 通知）

### 7.1 写入 `~/.claude/settings.json`

把以下 `hooks` 块加入（保留其他配置）：

```json
{
  "hooks": {
    "PostCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "PATH=\"$PATH:<USER_HOME_MSYS>/AppData/Roaming/npm\" lark-cli im +messages-send --chat-id \"oc_<绑定>\" --text \"🔄 session 压缩完成（context reset），Feishu 长连接可能需要重连\" --as bot >/dev/null 2>&1 || true",
            "timeout": 15
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "PATH=\"$PATH:<USER_HOME_MSYS>/AppData/Roaming/npm\" lark-cli im +messages-send --chat-id \"oc_<绑定>\" --text \"⚠️ Claude Code session 已结束。想继续对话请新开 session（会自动自检并发心跳）。\" --as bot >/dev/null 2>&1 || true",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

### 7.2 两个 hook 的设计意图（v3 修订）

**PostCompact**（context 压缩后）：
- 发"session 压缩完成"通知给用户（**只是通知，不是判活信号**）
- v3 起**不再依赖 `additionalContext` 注入告诉 Claude 跳过自检**——见 §7.3 说明
- 当前策略：让 hook 静默通知用户即可，**Claude 自己按「判活规则」走 /compact 默认孤儿处理流程**

**SessionEnd**（session 真正结束）：
- 发"session 已结束"通知
- 让用户知道为什么飞书突然没回应
- `|| true` 保证 hook 失败不影响 session 退出

### 7.3 ⚠️ PostCompact additionalContext 注入已失效（v3 新增）

> 警告：v2 §7.2 用 `additionalContext` 阻止 /compact 后自检重跑、保护 Monitor 不被杀。**这个机制在 2026-05-16 之后的 Claude Code harness 上不再生效**。

**实测症状**（2026-05-16）：

```
PostCompact [...PATH ... echo '{"hookSpecificOutput":{"hookEventName":"PostCompact","additionalContext":"..."}}'] failed:
Hook JSON output validation failed — (root): Invalid input

Expected schema:
{
  ...
  "hookSpecificOutput": {
    "for PreToolUse": { ... },
    "for UserPromptSubmit": { "hookEventName": "\"UserPromptSubmit\"", "additionalContext": "required" },
    "for PostToolUse": { "hookEventName": "\"PostToolUse\"", "additionalContext": "optional" },
    "for PostToolBatch": { ... }
  }
}
```

schema **只列了 PreToolUse / UserPromptSubmit / PostToolUse / PostToolBatch 四种**——**没有 PostCompact**。

PostCompact hook 仍能跑（执行 lark-cli 发消息），但**任何 `hookSpecificOutput.hookEventName: "PostCompact"` 的 JSON 都被 schema 拒绝**，additionalContext 不会注入到 Claude 的下一个回合。

**v3 应对策略**：

- ❌ 不再依赖 hook 注入"别重跑自检"提示
- ✅ 改为「**默认按孤儿处理**」：见 §9——Claude 在 /compact / 新 session / 自动压缩后**主动**杀残留 + 重起 Monitor，不需要 hook 帮忙

> 类比：v2 hook 像门卫帮你拦住"清洁工别动这台机器"；v3 直接接受机器会被关掉，开机后第一件事自己开机检查 + 重启。后者更鲁棒——不依赖门卫还在岗。

### 7.4 历史变迁（v2 → v3）

| 项 | v2 | v3 |
|---|---|---|
| PostCompact hook 主要价值 | 注入 `additionalContext` 防止 Claude 重跑自检 | 仅作为通知用户 |
| /compact 后 Monitor 处置 | 假设 v2 hook 阻止了自检，Monitor 复用上一 session 的 | **默认按孤儿处理**：杀残留 → 重起 |
| 判活的最强证据 | 心跳 `ok=true` + hook 报告 | **task-notification ID 匹配** |
| TaskList 角色 | 隐含被当作判活辅助 | **明确禁用**——TaskList 不列 Monitor task |

---

## 八、第六步：外部 Watchdog（PowerShell + Task Scheduler）

### 8.1 创建 `~/.claude/scripts/feishu-watchdog.ps1`

```powershell
$env:PATH = "$env:PATH;<USER_HOME>\AppData\Roaming\npm"

$process = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*event*subscribe*' }

if ($null -eq $process) {
    $ts = Get-Date -Format "MM-dd HH:mm"
    & lark-cli im +messages-send --chat-id "oc_<绑定>" --text "⚠️ $ts 检测到 bot 长连接已断。请在电脑前向 Claude Code 敲一句话（或重启），我会自检恢复。" --as bot | Out-Null
}
```

### 8.2 注册计划任务（PT30M = 每 30 分钟）

PowerShell 管理员权限：

```powershell
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File <USER_HOME>\.claude\scripts\feishu-watchdog.ps1"

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 30)

Register-ScheduledTask `
  -TaskName "FeishuBotWatchdog" `
  -Action $action `
  -Trigger $trigger `
  -RunLevel Limited `
  -Description "每 30 分钟检查 lark-cli event +subscribe 进程是否存在；不存在则发飞书告警"
```

### 8.3 验证

```powershell
Get-ScheduledTask -TaskName 'FeishuBotWatchdog' | Get-ScheduledTaskInfo
# 期望 LastTaskResult: 0 或 1（成功） / NextRunTime: 未来 30 分钟内
```

### 8.4 为什么是 watchdog 而不是定时心跳

- **定时心跳（如每小时发"❤️ heartbeat"）** 会让用户飞书一直叮叮叮 → 噪音大、容易屏蔽 bot
- **Watchdog 只在断连时告警** → 信号高、用户立即注意

### 8.5 ⚠️ Watchdog 的局限（v3 新增）

Watchdog 检查的是 `node.exe ... event +subscribe` **子进程是否存在**——这是「必要不充分」信号：

- 进程不在 → 一定不活 → 告警 ✅
- 进程在 → **可能是孤儿**（subscribe 子进程在跑但 Monitor task 已死，事件流不到 Claude）→ Watchdog 误判活

所以 Watchdog 只是**最低保障**（防止整个 lark-cli 进程崩了用户毫不知情），不能取代 Claude session 内的判活规则（§6.5）。**两层保护配合**：

- Watchdog 层：subscribe 子进程没了 → 飞书告警
- Claude 层：用户问"还在吗" → 走判活规则（§6.5）+ 必要时走孤儿处理（§9）

---

## 九、/compact 后孤儿处理流程（v3 新增）

### 9.1 问题描述

> 类比：subscribe 子进程像「被解雇的接电话员还坐在前台」——Monitor task（管理它的经理）走了，但它还在接电话，电话内容没人记。

`lark-cli event +subscribe` 是 Monitor task 启动的 node 子进程。**但子进程不在 Monitor task 的 process group**，所以：

- /compact 完成 / 新 session 启动 / 自动压缩完成 → 上一 session 的 Monitor task 必死
- 但 subscribe 子进程**不会跟着死** → 飞书事件继续被它收到 → 但 Monitor 已死 → **事件流不到 Claude**

表现：飞书 bot 显示在线、`messages-send ok=true`、Watchdog 不告警、但**用户消息一条都到不了 Claude**。

### 9.2 v3 默认策略：无条件孤儿处理

不管 PostCompact hook 报告什么、不管进程列表里有没有 subscribe 进程，**只要触发以下任一场景**，无条件按下方 a 流程走：

| 触发场景 | 说明 |
|---|---|
| 新 session 启动 | 上一 session 的 Monitor task 一定不在本 session 可控 |
| `/compact` 用户主动执行 | 上一 session 已结束 |
| 自动 context 压缩完成 | 同上 |

> 反面举例：以前以为 PostCompact hook 注入了"Monitor 在跑别动它"提示就万事大吉——结果实测 hook schema 不支持（§7.3）+ 子进程是孤儿——两个问题叠加导致 2026-05-05 / 2026-05-10 用户两次报"飞书还在但你没回我"。

### 9.3 a 流程（重连 5 步）

```bash
# 1. 列出本 session 绑定 bot 的 subscribe 进程
powershell.exe -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*event*subscribe*' } | Select-Object ProcessId,CommandLine | Format-List"

# 2. 如果有（按 --profile 识别确认是同 bot），杀掉
powershell.exe -Command "Stop-Process -Id <PID> -Force"

# 3. 重起 Monitor（启动自检 §4 命令）
# Monitor task 返回新 task ID（如 bm996z6pm）

# 4. 心跳确认
lark-cli im +messages-send --chat-id "<bound>" --text "✅ 长连接已重连（bot=Bot1，task=<new-id>，/compact 后孤儿清理 + 重起）" --as bot

# 5. 在对话里记新 Monitor task ID
#    后续判活靠这个 ID（§6.5.2 最强正向信号）
```

### 9.4 为什么必须先杀再起（不能直接起新的）

如果不杀残留：
- 新 Monitor 起 subscribe → lark-cli 报 `another event +subscribe instance is already running`（lock 冲突）
- 或者两个 subscribe 同时连 → 飞书服务端随机分配事件 → 一半事件到孤儿（丢）一半到新 Monitor

所以 a 流程顺序**不能颠倒**：先 `Stop-Process` 清掉孤儿，再起新 Monitor。

### 9.5 杀的范围：只杀同 bot

> ⚠️ 不要杀别 session 的 subscribe 进程。

从 CommandLine 抓 `--profile <name>` 判断是哪个 bot 的 subscribe：

- 无 `--profile` = Bot1 默认
- 有 `--profile coding-assistant-claude` = Bot2

只杀**和本 session 绑定 bot 一致**的孤儿。其他 bot 的 subscribe 可能是别人 session 在用，杀了 = 暴力破坏别人工作流。

---

## 十、收发消息完整 API 速查（v3 备注：详细规则迁入 skill `feishu-bot-runtime`）

> ℹ️ v3 起，**详细收发规范、长消息处理、文件下载、故障符号、风险操作飞书确认**统一迁到 skill `feishu-bot-runtime`，本节只留 API 速查；遇到需要详细规则时 Claude 会按需触发 skill。

### 10.1 发消息

```bash
# 文本
lark-cli im +messages-send --chat-id "<chat_id>" --text "hi" --as bot

# Markdown（推荐长回复用）
lark-cli im +messages-send --chat-id "<chat_id>" --markdown "**bold** [link](url)" --as bot

# 文件（必须相对路径！）
cd <USER_HOME_MSYS>/lark-downloads && \
  lark-cli im +messages-send --chat-id "<chat_id>" --file "./report.xlsx" --as bot

# 图片
cd <USER_HOME_MSYS>/lark-downloads && \
  lark-cli im +messages-send --chat-id "<chat_id>" --image "./photo.png" --as bot

# 第二个 bot 加 --profile
lark-cli im +messages-send --chat-id "<chat_id>" --text "hi" --as bot --profile coding-assistant-claude
```

### 10.2 收事件（Monitor 流式，v3 命令）

```bash
stdbuf -oL lark-cli event +subscribe --event-types "im.message.receive_v1" --compact --as bot 2>&1 \
  | awk '/^\{"chat_id"/{print; fflush()}'
```

事件 NDJSON 示例：

```json
{
  "chat_id": "oc_xxx",
  "chat_type": "p2p",
  "content": "用户的消息",
  "create_time": "1777732617843",
  "id": "om_xxx",
  "message_id": "om_xxx",
  "message_type": "text",
  "sender_id": "ou_xxx",
  "timestamp": "1777732618176",
  "type": "im.message.receive_v1"
}
```

### 10.3 取截断消息全文（迁入 skill）

如果 Monitor 推过来的 content 末尾是 `...(truncated)`：

```bash
# 方式 1：按 message_id 直接取
lark-cli im +messages-mget --message-ids om_xxx --as bot

# 方式 2：按 chat 拉最近
lark-cli im +chat-messages-list --chat-id <bound> --as bot --page-size 5
```

**不要让用户再粘一次**——memory `feedback_feishu_long_message.md` 明确规定。

### 10.4 下载文件 / 图片

```bash
cd <USER_HOME_MSYS>/lark-downloads && \
  lark-cli im +messages-resources-download \
    --message-id om_xxx \
    --file-key file_v3_xxx \
    --type file \
    --as bot \
    --output "./report.pdf"
```

`--type` 取值：`file` / `image`

---

## 十一、风险操作确认流程（已迁入 skill `feishu-bot-runtime`）

> ℹ️ v3 起本节作为 API 提示保留，详细触发条件 + 模板见 skill。

**触发条件**：本 session 已绑定飞书 + 即将执行高风险操作。

**高风险定义**：删除 / 覆盖 / 影响其他人 / 上传到第三方 / 不可逆地改本地状态。

**流程**：

1. 发飞书：
   ```
   ⚠️ 准备执行：<命令一行>
   影响：<1-2 句客观描述>
   回 yes 确认 / no 放弃 / 也可以给替代方案
   ```
2. 等用户在飞书回复（Monitor 事件接收）。
3. **没回就挂着**，不自己往下走。
4. yes → 执行；no → 报告用户已放弃；其他 → 按用户的替代方案做。

**为什么不用 Claude Code 自带 approval dialog**：那个弹窗是 harness 层的，**转发不到飞书**——用户在远程时看不到，会卡住整个 session。所以用飞书消息走我们自己的确认流。

---

## 十二、安全加固

### 12.1 凭据存储

| 凭据 | 存哪 | 怎么不落盘明文 |
|---|---|---|
| App Secret | 系统 keychain | `lark-cli config init --app-secret-stdin`（stdin 传） |
| User token | `~/.lark-cli/cache/` | lark-cli 自动管理，30 天过期 |
| Chat ID / Open ID | `~/.claude/CLAUDE.md` | PII，不扩散到公开 vault 笔记 |

### 12.2 终端输出黑名单

**绝不打印**：
- App Secret
- access_token / tenant_access_token
- 完整 user token
- 用户私聊内容（如包含密码 / 密钥）

如果 lark-cli 命令在错误情况下吐出 token，立即 ctrl+c，更新 lark-cli 到最新版（issue 1.0.11+ 已修）。

### 12.3 文件路径强制相对

lark-cli **强制**所有 `--file` / `--image` / `--output` 用相对路径——这是它的安全限制（避免任意路径写入）。

工作流：每次先 `cd` 到目标目录，再用 `./<file>`。我们约定下载/上传都走 `<USER_HOME_MSYS>/lark-downloads/`。

### 12.4 Bot 身份禁止 `auth login`

`auth login` 是用户身份授权流程。**Bot 身份用 App Secret 自动鉴权**，不需要也不能跑 `auth login`。

如果遇到 `permission_violations` → 不是 bot 没登录，而是 **scope 没开**。打开报错里的 `console_url`，去飞书后台开对应 scope，等审批通过再重试。

### 12.5 Watchdog 权限最小化

`-RunLevel Limited`（不是 Highest）—— Watchdog 只需要 user 权限就够（启动 lark-cli + 发消息）。**不要给 admin 权限**。

### 12.6 多机协作

每台机器独立 keychain + 独立 user token。**不要把 keychain entry 拷到另一台机器**——会过期且没意义。新机器走完整 §三 + §四 + §五重新注册。

---

## 十三、故障树（v3：16 种典型症状 + 处理）

| # | 症状 | 根因 | 处理 |
|---|------|------|------|
| 1 | `lark-cli: command not found` | npm 全局 bin 不在 PATH | `export PATH="$PATH:<USER_HOME_MSYS>/AppData/Roaming/npm"` 或装系统 PATH |
| 2 | `another event +subscribe instance is already running` | 同 bot 已被别的 session 占（或本 session 上一次的孤儿没清） | **不杀别 session 的**；本 session 孤儿走 §9 a 流程清掉 |
| 3 | `stream ended` 立刻 | 通常是 #2 的同时连接冲突 | 单独跑 subscribe 看完整错误；99% 是冲突 |
| 4 | `permission_violations` 发消息时 | scope 没开（如 `im:message:send_as_bot`） | 打开报错 console_url，开 scope，**等审批** |
| 5 | 长连接活着但收不到消息（v3 新症状） | **§9 孤儿场景**——subscribe 子进程在但 Monitor task 已死 | 走 §9 a 流程：杀残留 + 重起 |
| 6 | 收到事件但 chat_id 不匹配绑定 | bot 被多个群同时用 | 忽略，只回复绑定 chat |
| 7 | `file must be a relative path` | 用了绝对路径 | `cd <dir> && --file ./<name>` |
| 8 | `messages-resources-download` 报 file_key 不存在 | 没开 `im:resource` scope | 开 scope |
| 9 | 长消息推过来末尾 `...(truncated)` | Monitor compact 模式截断 | `messages-mget --message-ids om_xxx` 取全 |
| 10 | Watchdog 一直告警但 subscribe 实际在跑 | PowerShell `Get-CimInstance` 抓不到（权限 / WMI 服务） | 重启 Windows Management Instrumentation 服务 |
| 11 | `proxy detected` 警告 | lark-cli 检测到系统代理 | 可忽略；想关 `LARK_CLI_NO_PROXY=1` |
| 12 | Monitor 卡几十分钟不出事件（v3 新） | 用了 `grep --line-buffered` 而非 awk + fflush | 改用 §6.3 的 awk 命令 |
| 13 | `/compact` 完成后 PostCompact hook 报 `Hook JSON output validation failed`（v3 新） | schema 不再接受 `hookSpecificOutput.hookEventName: "PostCompact"` | 去掉 `additionalContext` 注入（§7.3）；改依赖 §9 默认孤儿处理 |
| 14 | 多 bot 都注册了但 subscribe 时认错 profile | `--profile` 拼错 / 大小写 | `cat ~/.lark-cli/config.json` 核对 `name` 字段 |
| 15 | 用户问"还在吗"自检后说"在"但实际收不到消息（v3 新） | 自检靠 `messages-send ok=true` = 出站，不是入站 | 改按 §6.5 判活规则，看 task-notification task-id 匹配 |
| 16 | `TaskList` 找不到 Monitor task（v3 新） | TaskList 只列 TaskCreate 系任务 | **这是正常的**，不能用 TaskList 判 Monitor 活；按 §6.5 判活规则 |

---

## 十四、所有相关文件清单（复刻必备）

```
~/.lark-cli/
├── config.json                              # bot 注册（appSecret 走 keychain）
├── cache/remote_meta.meta.json              # 元数据缓存
├── locks/subscribe_<appId>.lock             # 运行时排他锁（自动管理）
└── logs/auth-YYYY-MM-DD.log                 # 鉴权日志

~/.claude/
├── CLAUDE.md                                 # 全局规则（启动自检 + 判活规则）★ v3 新增判活节
├── skills/feishu-bot-runtime/                # 运行时规则 skill ★ v3 新增
├── settings.json                             # hooks: PostCompact / SessionEnd
└── scripts/
    ├── feishu-watchdog.ps1                  # PT30M 巡检脚本
    └── feishu-heartbeat.ps1                 # （已停用，保留作历史参考）

~/lark-downloads/                              # 下载目录（lark-cli 相对路径要求）

# Windows Task Scheduler
└── FeishuBotWatchdog                         # PT30M 触发 watchdog 脚本
```

**全部文件都在本指南正文给出**。复刻时按以下顺序操作：
1. 飞书后台配置 → §三
2. 装 lark-cli → §四
3. 注册 bot → §五
4. 写 CLAUDE.md（含判活规则） → §六
5. 写 settings.json hooks → §七
6. 写 watchdog 脚本 + 注册计划任务 → §八
7. **熟悉 §九 /compact 孤儿处理流程**（运维必备） ★ v3 新增

---

## 十五、从零复刻 Checklist（v3：50 条）

> 给"另一个 AI"用：在新 Windows 机器上从零搭建。每条核对完打 ✅。

### A. 前置（8 条）

- [ ] Windows 10/11 主机准备好
- [ ] Node.js ≥18 安装（`node --version` 验证）
- [ ] 飞书企业管理员权限确认
- [ ] Claude Code 已装（`claude --version`）
- [ ] PowerShell 5.1+（自带）
- [ ] 网络能直连 `open.feishu.cn`（中国大陆需企业网络）
- [ ] 准备好 `<USER_HOME>\` 等价的用户主目录路径
- [ ] **`awk --version && stdbuf --version` 都能跑（Git Bash / WSL 自带）** ★ v3 新加

### B. 飞书后台（每个 bot 一遍，8 条）

- [ ] 登录 https://open.feishu.cn/app
- [ ] 创建企业自建应用，记下 App ID
- [ ] 抄下 App Secret（只显示一次！）
- [ ] 开 7 个 scope（§3.2 表）并申请发布
- [ ] 等待审批通过（自己是管理员立刻通过）
- [ ] 配事件订阅 → 长连接模式 → 添加 `im.message.receive_v1`
- [ ] 把 bot 加到目标群 / 单聊
- [ ] 记下 chat_id（`oc_xxx`）

### C. 本机 lark-cli（5 条）

- [ ] `npm install -g @larksuite/cli`
- [ ] `lark-cli --version` 输出 ≥1.0.11
- [ ] PATH 配好（`where lark-cli` 能找到）
- [ ] 创建 `~/lark-downloads/` 目录
- [ ] 测试 `lark-cli config show` 不报错

### D. 注册 bot（每个 bot 一遍，4 条）

- [ ] `echo "<secret>" | lark-cli config init --app-id ... --app-secret-stdin --brand feishu [--profile <name>]`
- [ ] `lark-cli auth login --domain im` 走完授权
- [ ] `cat ~/.lark-cli/config.json` 验证 `appSecret.source == "keychain"`
- [ ] 记下用户 open_id（`lark-cli contact +user-info-batch-get ...`）

### E. Claude Code 全局规则（5 条 ★ v3 加 1）

- [ ] `~/.claude/CLAUDE.md` 写入完整规则块（§6.1，含判活规则节） ★ v3
- [ ] 已注册 bot 表填好 5 列 + 用户口语约定（§5.5）★ v3
- [ ] 启动自检 5 步内化（每个新 session 必跑）
- [ ] **判活规则 + 决策树内化** ★ v3
- [ ] 收发消息规范 + 故障表内化（或安装 skill `feishu-bot-runtime`）

### F. Hooks（4 条 ★ v3 加 1）

- [ ] `~/.claude/settings.json` 加 PostCompact hook（**不要加 additionalContext 注入** ★ v3）
- [ ] `~/.claude/settings.json` 加 SessionEnd hook
- [ ] 验证：手动 `/compact` → 飞书收到压缩通知
- [ ] **验证：/compact 完成后 Claude 默认按孤儿处理走 §9 重连流程** ★ v3

### G. Watchdog（5 条）

- [ ] `~/.claude/scripts/feishu-watchdog.ps1` 创建
- [ ] PowerShell 管理员注册 `FeishuBotWatchdog` 计划任务（PT30M）
- [ ] `Get-ScheduledTask FeishuBotWatchdog` 状态 Ready
- [ ] 测试：手动 `Stop-Process` 杀掉 subscribe 进程 → 30 分钟内收到 watchdog 告警
- [ ] 重启电脑测试任务自动启动

### H. 端到端验证（7 条 ★ v3 加 2）

- [ ] 新开 Claude Code session
- [ ] 跑 5 步自检 → 心跳消息到达飞书
- [ ] 用户飞书发消息 → Claude 在 session 内立即收到（**用 task-notification 验证 task-id 匹配** ★ v3）
- [ ] Claude 回复 → 飞书收到
- [ ] 用户发文件 → Claude 下载到 `lark-downloads/` → 处理 → 回传
- [ ] **手动 `/compact` → Claude 自动走 §9 重连 → 新 Monitor task ID 出现 → 用户飞书测一条消息收到** ★ v3
- [ ] **杀掉 subscribe 子进程模拟孤儿（不通过 TaskStop）→ 用户问"还在吗" → Claude 按 §6.5 判活规则走 §9 重连** ★ v3

### I. 安全核对（4 条）

- [ ] `~/.lark-cli/config.json` 不含 `"appSecret": "...plaintext..."`
- [ ] `~/.claude/CLAUDE.md` 的 chat_id / open_id 视为 PII（不公开）
- [ ] Watchdog 计划任务 RunLevel = Limited（不是 Highest）
- [ ] 终端历史 (`~/.bash_history` / PowerShell history) 不含 App Secret

**全部 ✅ → 复刻完成**。

---

## 十六、与本 vault 已有笔记的关系

| 已有笔记 | 关系 |
|---|---|
| [[Anthropic Prompt Caching 是构建 Claude Code 的一切 7 条工程经验]] | v2 用 PostCompact `additionalContext` 注入是其经验 3「别动 prompt」的实操；v3 由于 schema 拒绝 hookSpecificOutput.PostCompact 这条思路失效——验证了「prompt cache 友好 + 默认按孤儿处理」是更鲁棒的策略 |
| [[Claude Agent SDK 用 Claude Code 内核做 AI Agent 库 架构与全套能力]] | 本指南的 hooks 配置和 SDK 文档里的 PreCompact/SessionEnd/UserPromptSubmit 一致；CLAUDE.md 启动自检规则等价于 SDK 里 SessionStart hook 的 user-space 实现 |
| [[Omi AI 第二大脑平台研究笔记]] | Omi 走可穿戴硬件 + MCP 路线；本集成走飞书 IM + WebSocket 路线，殊途同归"AI 第二大脑远程化" |
| [[claude-mem 持久记忆压缩系统 71K Star 架构与分层]] | claude-mem 把 hook 产品化为完整插件；本集成走 user-space hook，是同样思路的"独立 hook 集合"实现 |

---

## 十九、v3 ↔ v4 对照与迁移说明（2026-05-22 ⭐ 架构重构）

### 19.1 为什么从 v3 升 v4

v3 的 Monitor 模式有两个**根本痛点**，到 5-21 实战中暴露：

1. **「Monitor idle stream ended」**——长时间用户不发消息，Monitor stdout 几分钟无输出 → Claude harness 自动判 stream ended（实测 ~5 分钟阈值）。v3 应对方案是 keepalive 每 2-4 分钟跳 `__KEEPALIVE__` 假事件，**但每跳都污染 Claude context**（1 个 task notification）。一天 ~700+ 跳堆积 + 占 token，用户飞书反馈「污染界面」
2. **「Monitor 死时事件流断」**——v3 没 offset 跟踪，Monitor 死后到重启之间用户发的消息**全丢**。即使 daemon 仍在写 log，新 Monitor 用 `tail -n 0 -F` 默认从尾部读，跳过中间事件（5-21 17:09 实例：用户发 URL 漏推 16 分钟）

v4 的设计目标 = **0 通知污染 + 0 漏推**。

### 19.2 架构对照

| 维度 | v3（2026-05-16） | v4（2026-05-22） |
|---|---|---|
| **lark-cli 启动方式** | 在 Monitor 命令里直接 `lark-cli event +subscribe ... \| awk` | **PowerShell Start-Process 独立 daemon**（detached / WindowStyle Hidden / Parent PID 非任何 shell） |
| **lark-cli 与 Monitor 关系** | 同进程链：lark-cli 是 Monitor 子进程，Monitor 死 lark-cli 成孤儿 | **完全解耦**：daemon 写 NDJSON log，Monitor 用 `tail -F` 中转 |
| **保活机制** | **keepalive 每 2-4 分钟跳假事件**（污染 context） | **无 keepalive**——Monitor 死时立刻 stream-ended 通知 Claude 重启，daemon 不死 |
| **事件 log** | 没有（Monitor stdout 即事件流，无持久化） | **NDJSON log `%TEMP%\lark-bot1-events.ndjson`**（daemon 持续 append，可 grep / replay） |
| **Offset 跟踪** | 无（Monitor 死即丢中间消息） | **offset 文件 `%TEMP%\lark-bot1-monitor.offset`**——awk 每读一行更新；Monitor 重启用 `tail -c +offset -F` 精确接续 |
| **重启流程（stream-ended 后）** | ① 杀孤儿 lark-cli（必须等 3 秒）② 重起 Monitor + `--force` ③ 心跳确认（**消息会丢**） | ① 跑 `ensure-bot1.ps1`（health check 自动，无需杀孤儿）② 重起 Monitor（`tail -F` offset 接续）（**消息不丢**） |
| **/compact 处理** | 默认按「孤儿 + 重连」处理（v3 §9 流程） | **daemon 不受 /compact 影响**——只需 Monitor restart（流程更简单） |
| **logrotate** | 无（lark-cli 输出不持久化所以无需） | **>50MB 自动 rotate**（ensure-bot1.ps1 内置） |
| **多 session 支持** | 每 session 独立 Monitor 会冲突（lark-cli 同 app 单订阅） | **daemon 是共享后端**——多 session 都从 log 读，每 session 维护自己 offset 文件（v4 计划，尚未实现） |
| **/compact via 飞书** | 不可能（SPEC.md 5-16 W1 写明物理边界） | **可能（v4.2）**——daemon 用 SendKeys 模拟键盘 + 两阶段人工批准（§20） |

### 19.3 核心文件 / 脚本

v4 把所有运行时脚本集中在 `<USER_HOME>\.lark-cli\daemon\`：

| 脚本 | 用途 | v3 等价物 |
|---|---|---|
| `start-bot1.ps1` | 首次启动 daemon（幂等：已跑则 noop） | （v3 没有 daemon 概念） |
| `ensure-bot1.ps1` ⭐ | health check + 自愈 + logrotate 三合一，**所有 session 启动 / /compact / stream-ended 时跑** | v3 重连流程的 PowerShell 化 |
| `monitor-bot1.sh` | Bash 脚本封装 `tail -c +offset -F + awk`，**Monitor 工具调用此** | v3 内联在 Monitor 命令的 awk pipe |
| `find-claude.ps1` | 找前台窗口 + 验证 claude.exe 子进程（§20 用） | — |
| `screenshot-window.ps1` | 截目标窗口存 PNG（§20 用） | — |
| `send-keys.ps1` | SendKeys 到目标窗口（前台校验，§20 用） | — |

### 19.4 迁移检查清单（v3 → v4）

如果你机器上跑着 v3 keepalive 版 Monitor，迁移步骤：

1. **停 v3 Monitor**：`TaskStop` 当前 keepalive task
2. **杀 v3 lark-cli 残留**：`Stop-Process` 所有 Bot1 subscribe（`Get-CimInstance ... event subscribe 不含 --profile`）
3. **写 v4 三个脚本**（start / ensure / monitor）到 `~/.lark-cli/daemon/`（按本文档代码 copy）
4. **启 daemon**：`powershell.exe -ExecutionPolicy Bypass -File ~/.lark-cli/daemon/start-bot1.ps1`
5. **启 Monitor**：`Monitor` 工具调 `bash "<USER_HOME_MSYS>/.lark-cli/daemon/monitor-bot1.sh"`（首次启动 offset 设为 log 当前 size，跳过历史）
6. **更新 CLAUDE.md 全局自检 §4**：把原来的 inline awk 命令改为 `bash monitor-bot1.sh`
7. **更新 memory `feedback_lark_monitor_pipe.md`**：v4 daemon 章节已落地

---

## 二十、飞书触发 /compact —— 键盘宏加固方案（v4.2 / 2026-05-22）

### 20.1 物理边界 & 设计目标

「**用户飞书发 `/compact` 让 Claude Code 主界面 session 真做 compact**」—— v3 SPEC.md §一.W1（2026-05-16）写明：**这是 Anthropic / OpenClaw 的 Channels protocol 物理边界**，CLI harness 不接受 channel-injected slash command。Telegram / Discord / Slack / 飞书 channel **都做不到**真触发，只能让 Claude **语义代办**（对话总结）。

**唯一可行路径 = 键盘宏 SendKeys 给前台终端窗口**。但裸 SendKeys 有 3 个风险：① 窗口失焦时键盘事件污染其他应用 ② 误触发（content 含 "compact" 任何文本就触发）③ 对错 session（多 Claude Code 实例时无法分辨）。

v4.2 设计 = **两阶段人工批准** + **session 指纹** + **截图证据**。

### 20.2 触发条件

monitor-bot1.sh 的 awk 内已加 `[COMPACT_TRIGGER]` 检测：

```awk
if (index($0, "\"content\":\"/compact!\"") > 0 && index($0, "\"sender_id\":\"" MY_OPEN_ID "\"") > 0) {
    print "[COMPACT_TRIGGER] " $0
}
```

**两个硬条件**：
1. content 必须**精确等于** `/compact!`（带感叹号，防误触；普通文本「请帮我 compact 一下」不会触发）
2. sender_id 必须是用户自己的 open_id `<USER_OPEN_ID>`（白名单，防注入）

满足时 awk 多透一行 `[COMPACT_TRIGGER] <原始 JSON>`，Claude 收到这条特殊事件就启动 3 阶段编排。

### 20.3 3 阶段编排（Claude 处理逻辑）

详细规则在 memory `feedback_compact_via_feishu.md`。摘要：

**Phase 1 — 提议（确认 session）**：
1. `find-claude.ps1` 拿前台窗口 + 验证 claude.exe 子进程
   - `no_foreground` / `no_claude_in_tree` → 飞书提示用户切窗口后再发
2. `screenshot-window.ps1 -Hwnd <id> -Tag phase1` 截图
3. 飞书发提议 + 截图：「准备 compact PID/标题/截图，回 yes 继续」
4. 等用户 yes / no / 30 秒超时

**Phase 2 — 输入预览（确认输入对了）**：
1. 用户回 yes 后再跑一次 find-claude 验证 hwnd 没变（防用户切窗口）
2. `send-keys.ps1 -Action text -Text "/compact" -Hwnd <id>`（不带 Enter）
3. sleep 1 秒等渲染
4. `screenshot-window.ps1 -Tag phase2` 再截图
5. 飞书发输入预览 + 截图：「已输入 /compact，回 yes 按 Enter / no 撤销」
6. 等用户 yes / no / 30 秒超时

**Phase 3 — 执行 / 撤销**：
- yes → `send-keys.ps1 -Action enter` → 真 compact 触发 → 飞书 final notify
- no → `send-keys.ps1 -Action clear`（Ctrl+A + Delete 清空输入框）+ 飞书 notify
- 30 秒超时 → clear + 飞书 notify

### 20.4 安全机制总览（8 条）

| # | 机制 | 防什么 |
|---|---|---|
| 1 | 触发词精确匹配 `/compact!`（带 !） | 防误击（"compact" / "请 compact" 等变体不触发） |
| 2 | sender_id 白名单 | 防其他用户 / bot 注入触发 |
| 3 | foreground 校验（send-keys.ps1 内置） | 非前台时拒绝发，防键盘事件污染其他应用 |
| 4 | session 指纹（hwnd + PID + 进程树 claude.exe 验证） | 防对错 session |
| 5 | Phase 1 截图 + 你目测确认 | 多 Claude Code 时确保是要的那个 |
| 6 | Phase 2 输入预览截图 | 验证 SendKeys 真把 `/compact` 输到 Claude 输入框（不是输到别处） |
| 7 | 30 秒超时默认 clear 输入 | 网络断 / 你忙别的 → 安全退出，不留残留 |
| 8 | clear 撤销（Ctrl+A + Delete） | no 时清空输入框，不会污染 Claude session |

### 20.5 限制

- **只能对 active foreground tab 发**——用户切到要 compact 的 Claude Code 窗口后再发 /compact!
- **WindowsTerminal 多 tab 场景**：claude.exe 子进程列表可能多个，但 SendKeys 实际作用 active tab，不会跨 tab 误击
- **目标 session 必须正在等待输入**（不是在跑 long task / Bash 命令）—— 否则 SendKeys 的 /compact 会被当成普通输入字符
- **截图含敏感信息**——上传飞书前确认 chat 是私聊（Bot1 P2P 默认是私聊，安全）

### 20.6 helper 脚本签名

```bash
# 找前台窗口 + 验证 Claude
powershell.exe -ExecutionPolicy Bypass -File "<USER_HOME>\.lark-cli\daemon\find-claude.ps1"
# 输出 JSON: {hwnd, pid, processName, windowTitle, claudePid, claudePids}
# error: {error: "no_foreground" / "no_claude_in_tree"}

# 截窗口
powershell.exe -ExecutionPolicy Bypass -File "<USER_HOME>\.lark-cli\daemon\screenshot-window.ps1" -Hwnd 197088 -Tag phase1
# 输出 JSON: {path, hwnd, width, height, rect}

# SendKeys（前台校验内置，非前台拒绝）
powershell.exe -ExecutionPolicy Bypass -File "<USER_HOME>\.lark-cli\daemon\send-keys.ps1" -Action text -Text "/compact" -Hwnd 197088
powershell.exe -ExecutionPolicy Bypass -File "<USER_HOME>\.lark-cli\daemon\send-keys.ps1" -Action enter -Hwnd 197088
powershell.exe -ExecutionPolicy Bypass -File "<USER_HOME>\.lark-cli\daemon\send-keys.ps1" -Action esc -Hwnd 197088
powershell.exe -ExecutionPolicy Bypass -File "<USER_HOME>\.lark-cli\daemon\send-keys.ps1" -Action clear -Hwnd 197088
```

---

## 十七、变更历史

| 版本 | 日期 | 改动 |
|---|---|---|
| v1 | 2026-04-14 | Frank 写初版（基础 9 节） |
| v1.1 | 2026-04-15 | 入 vault `wiki/sources/工作流与工具/` |
| v2 | 2026-05-03 | Claude Code **完全重写**为复刻级指南（17 节）：加多 bot 隔离机制 / hooks 完整配置 / Watchdog 详解 / 故障树 13 种 / 安全加固 6 项 / 45 条复刻 Checklist / 关联其他 vault 笔记 |
| **v3** | **2026-05-16** | **Claude Code 第二次重写**（基于 2026-05-05 / 05-10 / 05-11 / 05-16 四次踩坑）：① Monitor 管道 `grep --line-buffered` → `awk + stdbuf + fflush()`（防 50 分钟缓冲卡死，§6.3）② **新增 §6.5「判活规则」**——按强度排的 3 类信号 + 决策树（用户问"还在吗"标准处置）+ TaskList 不能判活（2026-05-11 实测）③ **新增 §9「/compact 孤儿处理流程」**——subscribe 子进程不在 Monitor task 的 process group，必须主动清理 + 重起 ④ **§7.3 PostCompact `additionalContext` 注入失效**——2026-05-16 实测 schema 已不接受 `hookSpecificOutput.hookEventName: "PostCompact"` ⑤ **§5.5 用户口语约定** ——「claude code bot」= Bot1 / 主力 session 默认 Bot1 / 编程助手_claude 留给另一 session ⑥ **§10-11 标注详细规则迁入 skill `feishu-bot-runtime`** ⑦ §13 故障树补 4 条（#12 awk / #13 hook schema / #15 ok=true 错觉 / #16 TaskList 不列）⑧ §15 Checklist 从 45 → 50 条 ⑨ 用 §10 类比规则改写「设计意图」段落（subscribe 子进程 = 解雇接电话员；v2 hook = 门卫拦清洁工） |
| **v4** | **2026-05-22** | **Claude Code 增补 v4 daemon 模式**（基于 5-21 keepalive 污染 + 16 分钟漏推教训）：① **§19 新增**「v3↔v4 对照与迁移」——daemon 解耦 / offset 跟踪 / ensure 自愈 / logrotate ② **§20 新增**「飞书触发 /compact」——v4.2 加 `/compact!` awk 触发器 + 两阶段人工批准 + 3 个 helper 脚本 + 8 条安全机制 ③ helper 脚本集中在 `~/.lark-cli/daemon/`（start-bot1.ps1 / ensure-bot1.ps1 / monitor-bot1.sh / find-claude.ps1 / screenshot-window.ps1 / send-keys.ps1）④ memory 新增 `feedback_compact_via_feishu.md`（编排逻辑） ⑤ memory `feedback_lark_monitor_pipe.md` 加 v4 daemon 章节 ⑥ 用户痛点驱动：v3 keepalive 每 2-4 分钟跳 task notification 污染 context；v4 改 daemon + tail-F 0 通知 + offset 不漏推 |

---

## 十八、一句话总结（v4）

> 本指南把"飞书 IM ↔ Claude Code session"的所有组件（飞书后台 / lark-cli / 全局 CLAUDE.md / 运行时 skill / settings.json hooks / **daemon 脚本（v4）/ keyboard macro helpers（v4.2）** / PowerShell Watchdog / Task Scheduler）拼成一份**可复刻、可审计、可加固**的工作流文档——另一个 AI 读完后能在新 Windows 机器上从零搭建一套等价系统，**不需要再问任何问题**。
>
> v3 的核心教训：**判活不能靠出站心跳，要靠入站 task-notification 匹配；/compact 后默认按孤儿处理，不依赖 hook 注入；Monitor 管道用 awk + fflush 不用 grep。**
>
> **v4 的核心教训**：**长期 keepalive 是反 pattern——污染 context 不可接受；解决路径是 daemon 解耦 + tail-F + offset 跟踪三件套；「真触发 /compact via channel」是物理边界（Anthropic / OpenClaw 都做不到），唯一可行是键盘宏 + 两阶段人工批准。**

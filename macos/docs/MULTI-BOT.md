# MULTI-BOT · 多 bot 管理

这套桥接天生支持 **N 个 bot**:N 条独立长连接、N 份独立日志、N 个 launchd 看门狗。
多个 Claude session 各连各的 bot,消息不交叉。本文讲日常管理:注册表、加/删/上线/下线、
出站路由、按项目把 session 绑到某 bot、以及排错。

---

## 1. 注册表 `~/.lark-cli/daemon/bot-registry.json`

唯一的 bot 身份来源(**不进 git;密钥不在这里,在 keychain**)。schema:

```jsonc
{
  "bots": {
    "<名字>": {
      "app_id":  "cli_...",            // 飞书 app id
      "profile": "cli_...",            // lark-cli profile 名(约定 == app_id)
      "chat_id": "oc_...",             // 默认收发的会话(与你的 p2p 单聊)
      "alias":   "人类可读别名",
      "as": "bot",                     // tenant token(app secret),无需 user 登录
      "event_types": "im.message.receive_v1",
      "enabled": true,                 // false = 下线(看门狗不再起、不被路由解析)
      "notify_on_restart": true        // launchd 重启时给该 bot chat 发一条提示
    }
  },
  "projects": [                        // 按项目目录把 session 绑到某 bot(出站路由用)
    { "match_dir_contains": "some-project", "bot": "<名字>" }
  ],
  "default": null                      // 永远 null:没有"默认 bot"兜底(见 §3)
}
```

改注册表后:**加/删 bot 要配合装/卸看门狗**(下面的脚本会做);只改 `enabled`/`chat_id` 等
字段不需要重装,但 `enabled` 的变化要手动起/停看门狗。

---

## 2. 收发方向:两套独立的路由

| 方向 | 路由方式 | 谁决定 |
|---|---|---|
| **收**(inbound) | **物理路由**:session `tail` 哪个 bot 的日志,就收哪个 bot。每 bot 日志独立 → **不会事件分裂** | 你 arm Monitor 时选 |
| **发**(outbound) | **注册表路由**:`feishu-notify.sh` 解析该用哪个 bot | `--bot` 显式 / `--auto-bot` 自动 |

**回消息回来源那个 bot**:消息从哪个 bot 来,回复就用 `--bot <那个 bot>` 发回它的 `chat_id`。

---

## 3. 出站路由:`feishu_resolve_bot` 的优先级

`feishu-notify.sh --auto-bot`(以及 `feishu-ensure.sh` 解析本 session bot)按此顺序:

1. **`FEISHU_BOT` 环境变量** —— 指定且该 bot `enabled` → 用它。
2. **`projects` 目录匹配** —— `CLAUDE_PROJECT_DIR`(或 `$PWD`)包含某条 `match_dir_contains`
   子串、且对应 bot `enabled` → 用它。
3. **都没有 → 解析失败,绝不发**(退出码 3)。**没有"默认 bot"兜底。**

> 第 3 条是刻意的安全设计:与其用某个 bot 把消息发错地方,不如不发、改为问用户连哪个 bot。
> 显式 `--bot <名字>` 永远优先于上面的自动解析。

---

## 4. 加一个 bot

```bash
# ① 录密钥进 keychain(stdin)
printf '%s' '<APP_SECRET>' | lark-cli profile add --app-id cli_xxx --name cli_xxx --app-secret-stdin --brand feishu
# ② 登记 + 装看门狗(一步到位)
~/.claude/bin/feishu/feishu-add-bot.sh <名字> cli_xxx <chat_id> "别名"
# ③ 体检
~/.claude/bin/feishu/feishu-ensure.sh
# ④ 在需要它的 session arm:  tail -n 0 -F ~/Library/Logs/feishu/<名字>.log
# ⑤ (可选)记忆 tailer:      feishu-mem-install.sh <名字>
```

`feishu-add-bot.sh` 幂等地:校验 app_id 格式、防 app_id 撞车、原子写注册表、确认 profile 已登录、
装看门狗。chat_id 暂缺可先占位,后从日志抓到回填。

---

## 5. 下线 / 删除一个 bot

```bash
# ① 停看门狗 + 删 plist(不动注册表)
~/.claude/bin/feishu/feishu-uninstall-agent.sh <名字>
# ② 标记下线(看门狗不再被起、不被路由解析)
#    用 jq 把该 bot 的 enabled 改成 false(或整条删掉):
jq '.bots["<名字>"].enabled = false' ~/.lark-cli/daemon/bot-registry.json | sponge ~/.lark-cli/daemon/bot-registry.json
# ③ (可选)停记忆 tailer
launchctl bootout gui/$(id -u)/com.frank.feishu-mem.<名字> 2>/dev/null
```

> 没装 `sponge`(moreutils)就用临时文件:`jq '…' reg.json > reg.tmp && mv reg.tmp reg.json`。
> 想彻底移除该 bot 的 keychain 凭据,再用 `lark-cli` 删该 profile —— 但**别**动其它 bot 的
> active profile(本桥接一律用 per-command `--profile <app_id>`,从不 `profile use`)。

重新上线:把 `enabled` 改回 `true`,再 `feishu-install-agent.sh <名字>`。

---

## 6. 把一个 session 绑到某个 bot

两种办法,**FEISHU_BOT 环境变量优先**:

**A. 临时 / per-session**(最直接):启动该 session 前
```bash
export FEISHU_BOT=<名字>
```

**B. 按项目目录持久绑定**:在注册表 `projects` 加一条
```json
{ "match_dir_contains": "finance-agent-spec", "bot": "de-dev" }
```
凡是 `CLAUDE_PROJECT_DIR` 含 `finance-agent-spec` 的 session,自动解析到 `de-dev`。

> **多 session / 多 bot 不串线**:每个 bot 是独立的 app / 独立长连接 / 独立日志 / 独立
> launchd agent。session A `tail` bot-X 的日志、session B `tail` bot-Y 的日志,物理上就分开。
> 同一个 app 绝不开两条 subscribe(launchd 单实例 + 绝不 `--force`),所以不会事件分裂。
> 唯一要注意:两个 session 若都在同一目录、都没设 `FEISHU_BOT`,`feishu-ensure.sh` 无法靠目录
> 区分它们 → 会提示"未绑定";这时用 `FEISHU_BOT` 或 `projects` 明确各自的 bot。

---

## 7. 发消息

```bash
# 显式指定 bot(最稳;回消息一律用这个)
feishu-notify.sh --bot <名字> --text "msg"
feishu-notify.sh --bot <名字> --markdown "**多行**/表格/列表优先 markdown"
# 自动解析(env→项目→无则不发,退出码 3)
feishu-notify.sh --auto-bot --text "msg"
# 覆盖默认会话 / 去重控制
feishu-notify.sh --bot <名字> --chat-id oc_other --tag deploy --window 60 --text "msg"
```

`feishu-notify.sh` 自带 30s 去重(同 chat+tag 窗口内只发一次),防重复打扰。
解析不到 bot 时**退出码 3 且不发** —— 这是预期行为,不是 bug。

直接用 lark-cli(发文件等):
```bash
lark-cli im +messages-send --profile cli_xxx --chat-id oc_xxx --text "msg" --as bot
cd /dir && lark-cli im +messages-send --profile cli_xxx --chat-id oc_xxx --file "./x.xlsx" --as bot
```

---

## 8. 排错(把 `<bot>` 换成具体名)

```bash
# 总览所有 enabled bot 的看门狗状态 + 本 session 解析
~/.claude/bin/feishu/feishu-ensure.sh

# 单个 bot 的 launchd 状态
launchctl print gui/$(id -u)/com.frank.feishu.<bot> 2>&1 | grep -E "state|pid|last exit"
# 订阅进程(应为「一条逻辑订阅」= node 父 + exec 子 两个进程,同一 --profile)
ps aux | grep -v grep | grep "event +subscribe" | grep -- "--profile <app_id>"
```

| 症状 | 处理 |
|---|---|
| `Could not find service` / plist 没加载 | `feishu-install-agent.sh <bot>`(重写 plist + bootstrap,幂等) |
| `state=running` 但 `ps` 看不到 subscribe | throttle 重启中(30s 内),等下个窗口;别手动暴力 kickstart |
| 反复崩 | 看 `~/Library/Logs/feishu/<bot>.err`:登录失效 / 权限 / 该 app 未开通长连接事件 |
| 用户发了消息但 session 没反应 | 多半是 session 的 `tail` Monitor 死了(被 kill / session 重启 / compact)。**连接没断、消息没丢**(都在持久日志)。重 arm `tail -n 0 -F ~/Library/Logs/feishu/<bot>.log` + `tail -n 50` 补看 gap |
| 想手动重启某 bot 连接 | `launchctl kickstart -k gui/$(id -u)/com.frank.feishu.<bot>` |

更深的机制、生命周期、绝对禁令见 **[ARCHITECTURE.md](ARCHITECTURE.md)**。

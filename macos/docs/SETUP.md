# SETUP · 在一台新 Mac 上无缝配置

目标:把这套桥接从 git 拉下来,在新 Mac 上跑起来,接上你的 Feishu bot。
全程**不需要**把任何密钥写进文件 —— app secret 只经 stdin 进 keychain。

---

## 0. Prerequisites

| 依赖 | 检查 | 装法 |
|---|---|---|
| macOS | `uname` → `Darwin` | — |
| `lark-cli` | `lark-cli --version` | `npm i -g @larksuite/cli`(或你惯用的装法) |
| `jq` | `jq --version` | `brew install jq` |
| `git` / `gh` | — | Xcode CLT / `brew install gh` |

> `lark-cli` 用 nvm / homebrew / `/usr/local` 装都行 —— `feishu-lib.sh` 会自动定位含
> `lark-cli` 的 bin 目录并写进 launchd plist 的 `PATH`,**不依赖**用户名或 node 版本。
> 装在非常规位置时可用 `export FEISHU_NODE_BIN=/path/to/bin` 显式覆盖。

每个要接的 bot,需在**飞书开发者后台**开通:
- **长连接(WebSocket)事件订阅** + 事件 `im.message.receive_v1`
- 权限 `im:message`(收) / `im:message:send_as_bot`(发)等
- `--as bot` 用 tenant token(app secret),一般**不需要** user 登录授权。

---

## 1. 拉仓库 + 装框架

```bash
git clone https://github.com/frank-1-pn/feishu-claude-code-bridge.git
cd feishu-claude-code-bridge
macos/install.sh
```

`install.sh` 是幂等的,只做机械安装:
- 把 `macos/bin/*` 拷到 `~/.claude/bin/feishu/`
- 建 `~/Library/Logs/feishu/`(持久日志)和 `~/.lark-cli/daemon/`
- 若无注册表则种子化一个空的 `~/.lark-cli/daemon/bot-registry.json`
- 体检 prereqs,打印加 bot 的下一步

它**不会**替你录密钥、不替你加 bot、不动 launchd —— 这些下面手动来。

---

## 2. 录密钥进 keychain

每个 bot 一次。secret 只走 stdin(不进文件、不进 argv、不进 shell history):

```bash
printf '%s' '<APP_SECRET>' | lark-cli profile add \
    --app-id cli_xxxxxxxxxxxxxxxx \
    --name   cli_xxxxxxxxxxxxxxxx \
    --app-secret-stdin --brand feishu
```

约定:**profile 名 = app_id**(脚本默认按这个找 profile)。

验证 profile 在:
```bash
lark-cli profile list
```

---

## 3. 拿 chat_id

bot 要发消息到哪个会话,就需要那个会话的 `chat_id`(`oc_...`)。两个办法:
- **(推荐)** 先把 bot 上线(下一步装看门狗),让 bot 给你发一条私聊消息,从
  `~/Library/Logs/feishu/<bot>.log` 里抓事件 JSON 的 `chat_id`;
- 或在飞书后台 / 用 `lark-cli` 查。

> 入站事件里同时有 `sender_id`(本 app 下你的 open_id)和 `chat_id`。回消息回 `chat_id`。

---

## 4. 登记 bot + 装看门狗

profile 已登录时,一步到位:

```bash
~/.claude/bin/feishu/feishu-add-bot.sh <名字> cli_xxxxxxxxxxxxxxxx <chat_id> "别名"
# 例:
~/.claude/bin/feishu/feishu-add-bot.sh primary cli_aa94...fb "oc_d8e8...b3" "我的维护 bot"
```

它会:写注册表 → 确认 profile 已登录 → 生成 `com.frank.feishu.<名字>.plist` →
`launchctl bootstrap` 上线(KeepAlive 看门狗)。

chat_id 暂时拿不到?先 `feishu-add-bot.sh <名字> cli_xxx __PENDING__ "别名"`,等首条消息抓到
真实 chat_id 后回填 `~/.lark-cli/daemon/bot-registry.json` 即可。

---

## 5. 体检

```bash
~/.claude/bin/feishu/feishu-ensure.sh
```

应看到每个 enabled bot `launchd=running pid=… plist✓`,并解析出本 session 该用哪个 bot
(按 `FEISHU_BOT` 环境变量 → 注册表 `projects` 目录匹配;都没有则提示"未绑定,需要时问用户")。

手动确认连接已建立:
```bash
grep -a "Connected" ~/Library/Logs/feishu/<名字>.err
```

---

## 6. 在 Claude Code 会话里 arm 事件桥接(**必需**)

launchd 只负责"连接 + 写日志"。要让消息进当前 Claude 对话,**每个 session** 都要 arm 一个
`tail` Monitor(session-local,换 session/compact 后要重 arm):

```
Monitor({ command: "tail -n 0 -F ~/Library/Logs/feishu/<名字>.log",
          description: "飞书事件桥接 <名字>", persistent: true, timeout_ms: 3600000 })
```

- `-n 0`:从末尾开始,不回放历史(避免重触发旧消息)。
- 没 arm 这层 → 消息进日志但 Claude 收不到(用户感觉"石沉大海")。

测试闭环:用手机给 bot 发一条 → Claude 应收到 → 回复经
`feishu-notify.sh --bot <名字> --text "..."` 发回同一会话。

---

## 7. (可选)记忆 tailer:把入站消息进 claude-mem

仅当本机已装并运行 [claude-mem](https://www.npmjs.com/package/claude-mem)(默认 HTTP `127.0.0.1:37701`):

```bash
~/.claude/bin/feishu/feishu-mem-install.sh <名字>
```

装一个独立 launchd `com.frank.feishu-mem.<名字>`,`tail -F` 该 bot 的持久日志 →
`feishu-mem-poster.py` → claude-mem(project=`feishu-<名字>`)。**只读日志,绝不碰订阅连接。**
没装 claude-mem 就跳过,不影响核心桥接。

---

## 8. 接入你的全局 CLAUDE.md(让每个 session 自动体检 + arm)

把下面这段(或等价物)放进 `~/.claude/CLAUDE.md`,让每个新 session 启动时体检并 arm 本 session 的 bot:

```markdown
## 飞书多 bot 桥接(launchd 托管)
每个新 session:
1. 跑 `~/.claude/bin/feishu/feishu-ensure.sh`(体检 + 解析本 session 该连哪个 bot)
2. 解析到某 bot → arm Monitor: `tail -n 0 -F ~/Library/Logs/feishu/<bot>.log`(persistent)
3. 没解析到 → 不擅自连、不擅自发,需要时先问用户连哪个 bot
铁律:绝不 --force;绝不在 session 内起 +subscribe;Monitor 只能 tail 日志;无默认 bot 不擅自发。
```

多 bot 的日常管理(再加 bot、下线、路由、排错)见 **[MULTI-BOT.md](MULTI-BOT.md)**。

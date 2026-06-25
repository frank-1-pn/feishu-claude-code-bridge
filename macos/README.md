# feishu-claude-code-bridge · macOS port

A **multi-bot** bridge between Feishu (Lark) chats and long-running Claude Code
sessions on **macOS**. Drive a desktop Claude Code instance from your phone —
receive messages, reply, kick off work — with the connection owned by a
per-bot **launchd** watchdog that survives logout/reboot and never pollutes
Claude's context with heartbeats.

This is the macOS sibling of the Windows bridge in the repo root. Same idea
(per-session bot routing, "no default bot — ask first"), re-implemented on
macOS primitives: `launchd` + `bash` + the `lark-cli` keychain.

> **Secrets never leave the machine.** App secrets live only in the `lark-cli`
> keychain. The bot registry (app IDs / chat IDs) is host-local and git-ignored;
> only a placeholder `examples/bot-registry.example.json` is committed.

---

## 它解决什么

- **连接稳**:每个 bot 一个独立 launchd 看门狗 `com.frank.feishu.<bot>`(`KeepAlive=true`),Claude 开不开都在跑、崩了自动重启、登录后自启。
- **不串线**:N 个 bot = N 条独立长连接 + N 份独立日志;多个 Claude session 各连各的 bot,消息不交叉。
- **不丢消息**:事件日志放持久目录 `~/Library/Logs/feishu/`(不在 `/tmp`,杜绝"空闲 bot 日志被清→幽灵 inode 丢消息",见 ARCHITECTURE.md)。
- **不擅自发**:出站没有"默认 bot";解析不到该用哪个 bot 时**不发**,改为问用户。

## 两层架构(一句话)

```
飞书  ──ws──►  launchd 看门狗(每 bot 一个,常驻)  ──写──►  ~/Library/Logs/feishu/<bot>.log
                                                                    │
Claude session  ──arm Monitor: tail -n 0 -F <该 bot 的 log>──────────┘  ← 把事件送进当前对话
```

- **launchd 层**:保证连接(跨 session、KeepAlive、零上下文)。session 不建连。
- **session 层**:`tail` 日志把事件送进当前 Claude。少这层 → 事件进日志但没人看。

## Quickstart(新机)

```bash
# 0) 装好 lark-cli + jq,且 `lark-cli --version` 可用
# 1) 装框架(拷脚本、建目录、种子注册表)
macos/install.sh
# 2) 录密钥进 keychain(只走 stdin)
printf '%s' '<APP_SECRET>' | lark-cli profile add --app-id cli_xxx --name cli_xxx --app-secret-stdin --brand feishu
# 3) 登记 bot + 装看门狗(profile 已登录时一步到位)
~/.claude/bin/feishu/feishu-add-bot.sh primary cli_xxx <chat_id> "我的维护 bot"
# 4) 体检
~/.claude/bin/feishu/feishu-ensure.sh
# 5) 在 Claude Code session 里 arm 事件桥接
#    Monitor:  tail -n 0 -F ~/Library/Logs/feishu/primary.log
```

详细步骤见 **[docs/SETUP.md](docs/SETUP.md)**。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | 新 Mac 从零配置(prereqs → 安装 → 加 bot → 验证 → claude-mem 可选 → 接入 CLAUDE.md) |
| [docs/MULTI-BOT.md](docs/MULTI-BOT.md) | **多 bot 管理**:注册表 schema、加/删/上线/下线、出站路由、按项目绑定、排错 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 机制 + 组件 + 生命周期 + 绝对禁令 + 持久日志教训 + 排错手册 |

## 脚本一览(`bin/`,装到 `~/.claude/bin/feishu/`)

| 脚本 | 作用 |
|---|---|
| `feishu-lib.sh` | 共享库:可移植的 node/lark-cli 定位、注册表读取、出站路由 `feishu_resolve_bot` |
| `feishu-add-bot.sh` | 登记一个 bot + 装看门狗 |
| `feishu-install-agent.sh` / `feishu-uninstall-agent.sh` | 单个 bot 看门狗的装/卸(launchd plist) |
| `feishu-ensure.sh` | session 启动体检 + 解析本 session 该用哪个 bot |
| `feishu-notify.sh` | 出站发消息(带 30s 去重);解析不到 bot 不发(退出码 3) |
| `feishu-keepalive.sh` | launchd 入口 wrapper(读注册表 → 重连)。**勿手动跑** |
| `feishu-mem-*.{sh,py}` | (可选)记忆 tailer 子系统:把入站消息捕获进 claude-mem |

## 三条铁律

1. **绝不** `--force`(服务器会把事件随机拆到多条连接 → 各只收一部分)。
2. **绝不**在 session 内手动跑 `lark-cli event +subscribe`(launchd 独占;并行 = 事件分裂)。session 的 Monitor **只能 tail 日志**。
3. **绝不**用"默认 bot"擅自发消息;解析不到就问用户。

---

*Single-operator setup. Personal-use. No warranty.*

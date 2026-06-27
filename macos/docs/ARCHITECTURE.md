# ARCHITECTURE · 机制 / 生命周期 / 禁令 / 排错

飞书 WebSocket 长连接由 macOS **launchd** 托管,**每个 bot 一个独立看门狗**,独立于任何
Claude session 存在(Claude 关掉也不断)。本文讲组件、两层分工、持久日志、生命周期、绝对禁令、排错。

> 移植自同仓 Windows 版的 per-session 路由思路,换成 macOS 的 `launchd` + `bash` + `lark-cli` profile。

---

## 1. 组件一览

| 位置 | 作用 |
|---|---|
| `~/.lark-cli/daemon/bot-registry.json` | **注册表**:每个 bot 的 app_id/profile/chat_id/alias/enabled/notify_on_restart。**不进 git;`default:null`**。secret 不在这里 —— 在 lark-cli keychain。 |
| `~/.claude/bin/feishu/feishu-lib.sh` | 共享库:可移植 node/lark-cli 定位、读注册表、出站路由 `feishu_resolve_bot`(env→项目→无) |
| `…/feishu-keepalive.sh <bot>` | launchd 启动的 per-bot wrapper:读注册表 → 重启通知 → 重建 /tmp 兼容软链 → `exec lark-cli event +subscribe --as bot` |
| `…/feishu-install-agent.sh` / `…-uninstall-agent.sh` | 生成/删除 `com.frank.feishu.<bot>.plist` 并 bootstrap/bootout(幂等) |
| `…/feishu-notify.sh` | 出站发消息 + 30s 去重;解析不到 bot 不发(退出码 3) |
| `…/feishu-ensure.sh` | session 启动体检 + 解析本 session 的 bot + housekeeping(清 >7 天去重锁) |
| `…/feishu-add-bot.sh <名> <app_id> <chat_id> [别名]` | 登记新 bot + 装看门狗 |
| `~/Library/Logs/feishu/<bot>.log` / `.err` | 该 bot subscribe 进程的事件 stdout / 状态 stderr。**持久目录,不在 /tmp**(见 §3)。`/tmp/feishu-<bot>.{log,err}` 是 keepalive 每次启动重建的**兼容软链** |
| `/tmp/feishu-<bot>.started.marker` | 首启标记,避免首次加载发"重启"消息。**故意留 /tmp**:reboot 清空→首启静默 |
| `~/Library/Logs/feishu/mem-<bot>.log` / `.err` + `com.frank.feishu-mem.<bot>` | (**独立可选子系统**)记忆 tailer:`tail -n 0 -F` 持久日志 → claude-mem。**只读日志,绝不碰订阅连接** |

**keepalive 逻辑**:① 有 marker 且 `notify_on_restart=true` 且有 chat_id → 发"launchd 自动重启";否则静默。
② `touch` marker;`mkdir -p` 持久日志目录 + 重建 `/tmp/feishu-<bot>.{log,err}` 兼容软链。
③ `exec lark-cli event +subscribe --profile <p> --event-types <e> --compact --as <as>`。

**launchd 侧**:`RunAtLoad=true`(加载即启)、`KeepAlive=true`(退出自动重启)、`ThrottleInterval=30`
(≥30s 一次重启,防连接失败打爆飞书)、env 里 `LARK_CLI_NO_PROXY=1`(直连,绕过本机代理)、
`PATH` 在装的时候由 `feishu-lib.sh` 动态定位的 node/lark-cli bin 目录拼出(故无需硬编码用户名/版本)。

---

## 2. 两层分工:launchd 保连接,session 把事件送进 Claude

```
飞书 ──ws──► [launchd 看门狗 com.frank.feishu.<bot>] ──写──► ~/Library/Logs/feishu/<bot>.log
   (KeepAlive,跨 session,零上下文)                                      │
[Claude session: Monitor tail -n 0 -F <log>] ◄───────────────────────────┘  把事件送进当前对话
```

- **launchd 层**:连接稳定性。Claude 开不开都在跑;崩了 KeepAlive 拉起;登录后自启。session **不建连**。
- **session 层**:`tail` 日志,把事件送进当前 Claude。这层是 **session-local 的、脆弱的**:被 kill /
  换 session / compact 后就没了 → 必须重 arm。少这层 → 事件进日志但没人看,用户感觉"石沉大海"。

**收发方向**:收 = 物理路由(tail 哪个 bot 的 log 收哪个,日志独立不分裂);
发 = 注册表路由(`--bot` 或 `--auto-bot`,无默认 bot 不擅自发)。详见 [MULTI-BOT.md](MULTI-BOT.md)。

---

## 3. 为什么日志在 `~/Library/Logs/feishu/` 而不在 `/tmp`(踩坑教训)

`/tmp` 是易失的:被系统周期清理、reboot 清空。**空闲 bot** 的日志一旦被 unlink,subscribe 进程仍
攥着那个被删的 inode 继续写 —— 新消息在**路径上看不到**了(写进了"幽灵 inode"),`tail` 也跟丢 =
**真的会漏消息**(一台机器上的 idle bot 实际踩过,靠 `lsof` 看到 fd 还指着被删的 inode 才定位)。

修法:`.log`/`.err` 放 **`~/Library/Logs/feishu/`**(系统永不自动清、文件永不被 unlink),从根上消除。
- `/tmp/feishu-<bot>.{log,err}` 保留为 keepalive **每次启动重建的兼容软链**(给旧 session/旧文档的
  `tail /tmp/...` 用);软链被清也不丢消息 —— 真实数据始终在持久目录。
- `started.marker` 和 notify 去重锁仍留 `/tmp`(故意):reboot 清空 marker → 首启静默;去重锁被清只是
  重置去重窗口,不丢消息。

排错口诀:连接没断时,消息**一定**在 `~/Library/Logs/feishu/<bot>.log` 里。用户说"漏消息"先查
session 的 `tail` Monitor 是否还活着,重 arm + `tail -n 50` 补 gap(`-n 0` 重 arm 不回放历史)。

---

## 4. 会话内该做什么

每个 session **不建连**,但要:

**(a) 体检 + 解析本 session 的 bot**
```bash
~/.claude/bin/feishu/feishu-ensure.sh
```
按 `FEISHU_BOT 环境变量 → 注册表 projects 目录匹配 → 无` 解析。

**(b) 对解析到的 bot,arm 事件桥接 Monitor(必需)**
```
Monitor({ command: "~/.claude/bin/feishu/feishu-tail.sh <bot>",
          description: "飞书事件桥接 <bot>", persistent: true, timeout_ms: 3600000 })
```
- `feishu-tail.sh` = `tail -n 0 -F` + 两层防护(仍只读 tail):**message_id 去重**(seed 现有 id,
  根治"日志被 launchd 重连重写/截断后 tail 从头重放历史"造成的【重复消息刷屏】)+ **卡键乱码过滤**
  (丢 `A#`/`A #`/`A\` 等短串,防手机长按刷屏把 Monitor 冲到 auto-stop)。
- `-n 0`:从末尾开始,跳过历史行(不重触发旧消息)。
- 没解析到 bot → **不 arm、不发,问用户**要不要连、连哪个。
- (裸 `tail -n 0 -F ~/Library/Logs/feishu/<bot>.log` 仍可用,但遇重写重放/卡键刷屏会刷屏或漏消息。)

---

## 5. 绝对禁令

- **绝不**在 session 内用 Monitor 跑 `lark-cli event +subscribe`(launchd 独占;并行会让服务器把事件
  随机拆到多条连接 → 各只收一部分,用户感到"说着说着消失")。session 的 Monitor **只能 tail 日志**。
- **绝不** arm `*/5 * * * *` 之类巡检 cron(KeepAlive 已是唯一 watchdog;cron 只会把上下文塞满)。
- **绝不**用 `--force`(`+subscribe --force` 强抢连接 = 事件分裂)。
- **绝不**切换/删除别的 bot 的 lark-cli active profile(`profile use` / `profile remove`);选 bot 一律
  per-command `--profile <app_id>`。
- **绝不**用"默认 bot"擅自发消息;解析不到就问用户。

---

## 6. 生命周期

- launchd agent 跑在**用户登录会话**里:macOS 重启 / 登出会停,重新登录自动起(`RunAtLoad=true`)。
  每个 enabled bot 一个 agent。
- 不依赖任何 Claude session,Claude 关掉连接照常。
- `started.marker` 在 `/tmp`,reboot 清掉 → reboot 后首启视为"首次",不发重启消息(预期)。
- 持久日志在 `~/Library/Logs/feishu/`,跨 reboot 保留(不会因 reboot 丢历史)。

加 / 删 / 上线 / 下线 bot、出站路由、按项目绑定 session → 见 **[MULTI-BOT.md](MULTI-BOT.md)**。

---

## 7. 排错手册

```bash
launchctl print gui/$(id -u)/com.frank.feishu.<bot> 2>&1 | grep -E "state|pid|last exit"
ps aux | grep -v grep | grep "event +subscribe" | grep -- "--profile <app_id>"
tail -n 20 ~/Library/Logs/feishu/<bot>.err     # 连接/报错
```

- **plist 没加载 / `Could not find service`** → `feishu-install-agent.sh <bot>`(重写 plist + bootstrap,幂等)。
- **进程起不来 / 反复崩** → 看 `~/Library/Logs/feishu/<bot>.err`:
  - `command not found: lark-cli` → node bin 没定位到;`export FEISHU_NODE_BIN=/path/to/bin` 后重装 agent。
  - 登录 / 权限 / 事件未开通 → 该 app 要在飞书后台开通**长连接(WebSocket)事件订阅** + `im:message` 等;
    `--as bot` 用 tenant token(app secret),一般不需要 user 登录。
  - 节流期 30s,别手动暴力 kickstart;改完等下个 throttle 窗口自动重试。
- **手动重启 / 停 / 起**
  ```bash
  launchctl kickstart -k gui/$(id -u)/com.frank.feishu.<bot>   # 重启
  launchctl bootout    gui/$(id -u)/com.frank.feishu.<bot>     # 停(再起用 install-agent.sh)
  ```
- **桥接静默(用户发了消息但 session 没反应)** → 多半是 session 的 `tail` Monitor 死了。连接没断、
  消息没丢(在持久日志里)。重 arm `tail -n 0 -F ~/Library/Logs/feishu/<bot>.log` + `tail -n 50` 补 gap。

---

## 8. 安全姿态

- **密钥**只在 lark-cli keychain;经 `--app-secret-stdin` 录入,绝不进文件 / argv / shell history。
- **注册表**(app_id/chat_id/open_id)host-local、git-ignored;仓库只放占位模板。
- `LARK_CLI_NO_PROXY=1` 直连飞书,避免凭据 / WebSocket 走本机代理。

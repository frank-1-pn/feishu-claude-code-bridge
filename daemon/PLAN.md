# 2026-05-23 7-fix 实施 plan

## 顺序（按依赖）

1. **B1 参数化 daemon** （基础重构，其他都依赖它）
   - 新 `start-bot.ps1` / `ensure-bot.ps1` / `monitor-bot.sh` 接 `-Bot <name>` + `-Profile <profile>`
   - 文件路径含 bot：`lark-{bot}-events.ndjson` / `.pid` / `.err.log` / `-monitor.offset`
   - 老 `*-bot1.ps1` / `monitor-bot1.sh` 改为 shim：直接调新脚本传 `-Bot bot1`
   - **回滚**：保留老脚本 shim → 老调用方不会断
2. **B5 daemon LARK_CLI_NO_PROXY** — start-bot.ps1 顶部加 `$env:LARK_CLI_NO_PROXY = '1'`
3. **B2 err log rotation** — ensure-bot.ps1 加 `Invoke-ErrLogRotate`（>10MB 直接 truncate-in-place，不 kill daemon）
4. **B6 + B7 prune** — ensure-bot.ps1 加 `Invoke-StalePrune`：
   - 扫 `binding-*.json`，PID 不存在的删
   - 扫 `lark-notify-once/*.last`，mtime >7 天的删
5. **B4 write-binding.ps1** — 独立小脚本，参数 `-Bot <name>`；爬 claude PID + 查 registry（或 daemon-config）+ 落 `binding-<pid>.json`
6. **CLAUDE.md §4 + §6 改命令** — §4 推 `ensure-bot.ps1 -Bot <name>` + `monitor-bot.sh <name>`；§6 改 `write-binding.ps1 -Bot <name>`
7. **B3 升级 lark-cli** — `npm i -g @larksuite/cli@latest` → 停 Bot1 daemon → 启新 daemon → 心跳确认 → 看 err log SDK 噪音是否还在（决定 awk filter 要不要保留）
8. **自测**（见下）
9. **sync + push**

## 不动的东西

- finance-agent (PID 59192) + coding-assistant-claude (PID 21952) 当前 subscribe 进程**不杀**——是其他 session 的，他们下次启动用新 daemon 流程即可
- 现有 binding-27820.json（本 session）不动
- bot-registry.json 现有结构不变（用于 AutoBot routing），但加可选 `bots` map 给 daemon 用

## 自测验收清单（7 项）

| 项 | 操作 | 期望 |
|---|---|---|
| ① | `ensure-bot.ps1 -Bot bot1` | 输出 `daemon healthy PID=<旧 PID>`，不重启 |
| ② | 杀 daemon → `ensure-bot.ps1 -Bot bot1` | 输出 `(re)starting`，新 PID，pid 文件更新 |
| ③ | `monitor-bot.sh bot1` | tail 上行；用户发飞书消息 → 推 Claude（offset 接续） |
| ④ | `write-binding.ps1 -Bot bot1` | 文件 `binding-<live-pid>.json` 生成，内容含 chat_id/profile/alias |
| ⑤ | 删 binding-27820 → `notify-once.ps1 -AutoBot -Text test -Tag t1` | log resolved via `binding-<new-pid>` |
| ⑥ | 造 binding-99999.json (假 PID) → `ensure-bot.ps1 -Bot bot1` | 文件被 prune |
| ⑦ | 造 8天前 *.last → ensure-bot.ps1 | 被 prune |

加分项：
- err log >10MB 模拟（写 11MB 假数据）→ ensure → 被 truncate
- lark-cli 升级后心跳仍 ok=true

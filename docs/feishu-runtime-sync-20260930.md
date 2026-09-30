# 2026-09-30 运行版本与 GitHub 核对

这是本机现场核对的脱敏快照，不是永久的“最新版本”声明。后续会话的配置步骤见[接手指南](../codex-config/skills/feishu-bot-runtime/references/configuration-and-handoff.md)。

## 版本对应

| 项目 | 本次核实结果 |
|---|---|
| 仓库 | `frank-1-pn/feishu-claude-code-bridge` |
| Codex 维护分支 | `feat/feishu-ux-20260927` |
| 本次文档更新前的远端 revision | `26ed0deeed754d582a35feb227c0e6967ab779b2` |
| 当前部署的代码 revision | `aa1c7ccb21eec74243e5cf41b3242c46a2e7e091` |
| 部署完成时间 | 2026-09-28 23:06 北京时间；本机部署证据与 worker 创建时间相符 |
| 默认 main 的代码基线 | `4806de66e1ccaf9f8493c59e1b80432cd735db25`，旧 Claude 实现；不是当前 Codex 发布线 |
| 固定版订阅程序 | `1.0.39-bridge-heartbeat.1`，运行路径为 `daemon/bin/lark-cli.exe` |

`aa1c7cc` 到 `26ed0de` 没有 daemon 代码差异，后者记录部署结果。本次新增配置指南不改变上述已部署代码 revision；文档提交号应从本文件的 Git 历史读取，不能把新文档 commit 当作重启后的进程版本。

## 对比方法与边界

已现场读取远端 refs、安装文件、当前进程路径/创建时间、私有部署结果和只读健康状态。比较范围是仓库已跟踪、且安装存在的 daemon 脚本/模块（不含测试），以及已安装 skill 文件。

- 共比较 51 个文件：27 个字节完全一致；仅规范化 UTF-8 BOM、CRLF 和结尾换行后，49 个一致。规范化一致不等于字节哈希相同。
- 当前 Codex 主桥接模块及相关启动、状态、心跳/守护脚本匹配维护分支。两处实际差异是 `notify-once.ps1` 和 `write-binding.ps1`：本机有旧 hooks 的 Codex/PID 兼容扩展，未作为本次改动上传或覆盖。
- 上述两个旧辅助脚本不承担当前 Codex 持久 inbox/thread 路由；watchdog 使用 `-SkipSessionBinding`。因此结论是**当前主桥接代码已同步**，不能声称整个本机目录逐字节镜像 GitHub。
- `ensure-bot1.shim.ps1` 与 `start-bot1.shim.ps1` 两个仓库旧 shim 未在本机安装；不影响当前统一启动路径。
- 两个实际 subscriber 的可执行文件哈希均匹配本机 `subscriber-runtime.json`。通用 npm CLI 与此固定版不同，不应混为同一个程序。
- 本机另有发送/重载辅助脚本等外部依赖；上述计数不是对所有未跟踪本机文件的完整审计。换机安装仍需补齐依赖。

## 运行状态

核对时 Bot1 与 coding 的 `socket_verified`、`transport_healthy`、`delivery_healthy` 为真；bridge idle，无待入站、待回复、文件或云报告队列。`FeishuBotWatchdog` 入口是 `wscript.exe`，周期一分钟。ASR 保持关闭。

本次没有重启 worker、改绑 thread 或重新发送验收消息。健康与文件对比证明当时运行状态及版本对应，不冒充一次新的手机端完整验收。此前进度卡修复的 291 项测试与实卡验收属于原发布记录，详见[长任务进度与部署记录](feishu-native-streaming.md)。

## 本次文档交付

新增仓库 `AGENTS.md` 入口、中文接手指南和占位配置模板；技能与 README 链接到指南，并忽略真实 `daemon/codex-thread-bindings.json`。本次仅涉及文档、模板与私有文件排除规则，按 JSON/链接/编码/Git 路径及私有数据检查验收，不宣称重新运行全部业务测试。

不会上传真实 registry/bindings、应用凭据、会话标识、消息记录、下载附件、二进制或私有部署备份。两个旧 hooks 本机差异保持原样，后续如需统一，必须另行审查具体差异及使用方。

# Windows 托管 Codex 桥接发布

本机 Windows 托管传输的统一发布入口是 `stable/windows-codex`。它从已验收的 `492c3e4` 延续，保留 Orca/Codex 会话路由、一个 bridge worker 和每个 Bot 一个现有订阅。已有 `stable/codex` 分支使用另一套桌面传输实现，仍供对应环境维护。部署时使用固定提交，分支更新本身不会改动任何机器。

## 2026-11-23 交付和验收范围

| 能力 | 预期行为与验收 |
|---|---|
| 本地任务查询 | `/status`、`/files`、`/last` 和对应中文短语使用已授权绑定任务的持久状态。验证在模型投递繁忙时还能查询，多个任务时要求引用，回复成功后记录本地回执 |
| 旧卡跳转 | 有同一绑定会话的新卡回读链接时，给已关闭旧卡补上“打开最新卡片”。用新卡和旧卡的实际消息回执检查顺序，验证链接失败只影响跳转 |
| 独立报告交付 | 最终答复送达后才上传新报告附件。用文件消息回执和更新后的同张卡片确认。独立附件保持原路由和去重键。历史不确定失败单独统计 |
| 重连补漏 | 用守护程序确认的订阅进程、实际 pong 和新连接代次触发。最多回查 5 分钟、四页。实时队列追平后，仅补入精确绑定用户、未修改、未撤回、尚未入队的近期独立纯文本。其他消息留在审计边界内 |
| 发布 | 固定 commit、可重复哈希清单、当前 worker 身份、订阅与绑定完整性、真人入站与回包证据分别报告 |

`history_recovery_mode` 支持 `audit`（默认，只核对）、`replay` 和 `off`。单 Bot 验证后可开 `replay`。新安装或切换模式先记录当前连接基线。有同一绑定的较新实时消息进入时，较旧遗漏只留核对记录，避免改变指令顺序。连续缺少可靠身份或完整分页时，保持保守状态。

## 核对固定版本

在干净的源码 checkout 使用完整 40 字符提交。以下示例的路径和 SHA 由本机操作员填写。

```powershell
$source = (Get-Location).Path
$revision = (git rev-parse HEAD).Trim()
$manifest = Join-Path $env:TEMP 'feishu-windows-release.json'
$json = & node scripts/bridge-release.mjs generate --repo $source --ref $revision
if ($LASTEXITCODE -ne 0) { throw 'Manifest generation failed' }
[IO.File]::WriteAllText($manifest, ($json -join [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
node scripts/bridge-release.mjs verify --repo $source --ref $revision --manifest $manifest
```

清单覆盖 Windows 使用的模块、控制脚本、技能，以及心跳订阅器的源码和构建依赖。源码工具只读校验显式文件。现有订阅器二进制按本机 `subscriber-runtime.json` 和实际进程单独核对。通用出站 CLI 另行测试，保留已验证版本。

## 本机安装与回滚

对照已推送版本，先验证当前版本和私有配置。保存受影响文件原件及运行进程证据，等两个 Bot 的消息、附件、卡片动作、报告状态和重连补漏都没有进行中任务，再只更换精确确认的 bridge worker。保留原来的订阅进程、配置、绑定、事件游标和持久队列。出现故障时用备份恢复被替换的文件并通过唯一启动器恢复 worker。

安装后核对清单和运行状态，沿用上文的 `$source`、`$revision` 和 `$manifest`：

```powershell
$runtimeRoot = Join-Path $env:USERPROFILE '.lark-cli\daemon'
$skillRoot = Join-Path $env:CODEX_HOME 'skills\feishu-bot-runtime'
node scripts/bridge-release.mjs check-installed --repo $source --ref $revision --manifest $manifest --platform win32 --runtime-root $runtimeRoot --skill-root $skillRoot
if ($LASTEXITCODE -ne 0) { throw 'Installed release did not match the manifest' }
```

套件测试、API 回读与真人点击各自记录。真实配置、文件快照、消息、日志、凭证、本机备份均留在本机。

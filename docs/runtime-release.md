# Codex 固定版本发布与安装核对

Codex 的统一发布入口是 `stable/codex`，`main` 继续保留旧 Claude 实现。
历史 feature 分支不再作为安装入口。唯一发布者只把通过必要源码测试的精确
commit 推到该入口，并读回远端完整 ref；如尚无对应发布记录，状态是待发布。
分支前移不自动升级任何机器。

发布必须分别给出四项证据：

| 项目 | 最低证据 | 不能据此推断 |
|---|---|---|
| published | 远端 `stable/codex`/固定 release tag 读回的完整 commit，及与其绑定的外部 manifest | 测试或部署已通过 |
| tested | 在该 commit 执行的必要测试命令、结果、时间及平台 | 另一台机器已安装或真人闭环成功 |
| installed | 指定平台/生效技能目录的逐文件 SHA256 检查，及独立核对的运行进程身份 | 有真实人类消息通过 |
| real human acceptance | 原群真实新消息 → 目标 thread marker → 原任务最终答复实际送达 | 其他 bot/功能/权限同时通过 |

生成工具不把 tested/published/真人验收状态写成成功。相应证明由发布者另存；
待验收项保持 pending，不用进程存在、ACK 或排队替代。

## 安全模型与文件范围

跟踪的 `releases/codex-runtime-v1.json` 只包含显式安装路径白名单及 Windows/macOS
订阅器依赖约束；不包含自己的 commit/tree hash。**先提交，再从完整 commit
生成外部 manifest**，避免 manifest 自引用提交。输出带固定 commit/tree、profile
SHA256、每个 runtime/skill 文件的字节数与 SHA256，以及 subscriber 构建脚本和补丁
源码 hash。没有时间戳或本机路径，同一精确 ref 可重复生成相同内容。

工具仅使用 Node 标准库和本机 Git，不联网、不 import daemon、不调用业务 API。
它拒绝脏 source（含未跟踪文件）、非完整 commit、漏列可安装模块/技能、重复路径、
路径穿越、符号链接、非 regular 源文件、二进制源码及私有/非白名单路径。
配置、绑定、registry、state、日志、二进制、下载与备份不进入清单；构建出的
subscriber binary 和 host-local build manifest 继续留在本机 Git 外。

发布白名单覆盖当前 `daemon/` 的非测试 Codex/macOS 模块、指定 Windows 控制脚本
及 `codex-config/skills/feishu-bot-runtime/` 的技能文件。新增模块/技能时同步白名单，
遗漏会使生成失败。旧 Claude 工具和 example 配置不是可覆盖安装文件。

`check-installed` 先从可信完整 ref 重新生成并比对整个 manifest，再读取指定
scope 的已声明文件。不会遍历未知安装文件；安装根或文件链上的 symlink 拒绝。
传入物理绝对目录（macOS 的别名路径先在本机解析），未知运行文件一律保留。
它不安装、不覆盖、不删除，不读取私有配置、state 或日志；不验证 subscriber
binary、运行进程、配置、权限、队列、锁或实际收发。不同文件系统上的读取可能
更新访问时间，内容与修改时间不受工具改写。清单 hash 取 Git blob 原始字节；
Windows 安装源码建议从固定 ref 的 `git archive` 提取，避免 checkout 自动 CRLF
转换导致 hash 不符，不能为通过检查而改写 manifest。

## 发布者流程

1. 在隔离 worktree 完成修改；指定拥有路径。按变更执行必要测试并审查敏感数据。
   当前发布工具的回归命令为 `node --test scripts/bridge-release.test.mjs`；runtime
   改动仍要运行对应 daemon 测试，不能只运行清单测试。
2. 定向提交变更，记录完整 tested commit。最终提交后源树必须干净；生成文件和
   测试证明存放仓库外的**持久**发布目录，不依赖临时目录恢复。
3. 从这个完整 ref 生成 manifest，然后 `verify`。推送该固定提交，更新
   `stable/codex` 并读回远端 ref；发布记录固定该 commit，必要时打固定 Codex tag，
   例如 `codex-vYYYY.MM.DD.N`。manifest 作为外部发布附件或私有发布记录交付，
   不回填进它描述的同一提交。内容 hash 是完整性证明，不能代替可信发布渠道。
4. 单独记录测试/远端读回证明。发布后在授权主机逐项审核安装计划；只复制清单中
   该平台的实际需要文件，备份并保留原绑定、配置、未知文件和全局其他规则。
5. 由唯一部署者等待原业务 turn、完整队列及新鲜身份/真实 pong 门禁后按现有恢复
   流程处理 worker。清单工具不承担部署门禁，也不会自动安装最新 branch、启动服务
   或制造 model turn。原 subscriber 保持固定版本，不因新通用 CLI 而升级。
6. 读回安装 hash 与进程身份。只有实际人类新消息完成原 thread 入站与最终送达后，
   才记录相应真人验收成功。

不要把尚未推送的 candidate 写成 published。旧发布记录继续保留作回滚证据，
回滚也要选择固定已验证 commit，并遵守当前业务与队列门禁。

## macOS 命令入口

下列环境变量是本机显式填写的占位输入；`RELEASE_REF` 必须是从可信发布记录
取得的完整 40 位 commit，不能传 `HEAD`、tag 或分支名。`RELEASE_DIR` 在仓库外。
`RUNTIME_ROOT` 和 `SKILL_ROOT` 分别是实际运行目录与生效 home 的该技能目录。

```sh
node scripts/bridge-release.mjs generate --repo "$SOURCE_REPO" --ref "$RELEASE_REF" > "$RELEASE_DIR/manifest.json"
node scripts/bridge-release.mjs verify --repo "$SOURCE_REPO" --ref "$RELEASE_REF" --manifest "$RELEASE_DIR/manifest.json"
node scripts/bridge-release.mjs check-installed --repo "$SOURCE_REPO" --ref "$RELEASE_REF" --manifest "$RELEASE_DIR/manifest.json" --platform darwin --runtime-root "$RUNTIME_ROOT" --skill-root "$SKILL_ROOT"
```

每步检查退出码，失败停止，不能把只读核对当安装命令。当前 Codex macOS 运行入口
是 `daemon/macos-service.mjs`、`macos-watchdog.mjs`、`macos-subscriber.mjs`；
仓库 `macos/install.sh` 是旧 Claude port，不用于新 Codex 发布。既有 launchd、writer、
subscriber、注册信息和 thread 以本机私有状态为准；阅读版本指南不启动任何组件。

macOS subscriber 固定 CLI `7beffb086d7fa3c5b843d8affa7c089f49cfc65e`、
SDK `efd7ae4c25f7187100b04b6018469aba2bfac99d`；必要构建入口
`scripts/build-lark-heartbeat-macos.py`。不能把通用 CLI 安装状态当它的 binary 证明。

## Windows PowerShell 命令入口

`$sourceRepo`、`$releaseRef`、`$releaseDir`、`$daemonRoot`、`$skillRoot` 是同样的本机
占位输入。下例使用无 BOM UTF-8 保存标准 JSON；不要使用可能产生 UTF-16 的
旧版 PowerShell `>` 重定向。

```powershell
$manifest = & node scripts/bridge-release.mjs generate --repo $sourceRepo --ref $releaseRef
if ($LASTEXITCODE -ne 0) { throw 'Release generation failed' }
[System.IO.File]::WriteAllText((Join-Path $releaseDir 'manifest.json'), ($manifest -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
node scripts/bridge-release.mjs verify --repo $sourceRepo --ref $releaseRef --manifest (Join-Path $releaseDir 'manifest.json')
if ($LASTEXITCODE -ne 0) { throw 'Release manifest verification failed' }
node scripts/bridge-release.mjs check-installed --repo $sourceRepo --ref $releaseRef --manifest (Join-Path $releaseDir 'manifest.json') --platform win32 --runtime-root $daemonRoot --skill-root $skillRoot
if ($LASTEXITCODE -ne 0) { throw 'Installed files did not verify' }
```

当前 Windows Codex 使用 `start-codex-bridge.ps1`、`status-codex-bridge.ps1` 和既有
`FeishuBotWatchdog`；隐藏入口 `run-watchdog-hidden.vbs`。它们不是此核对工具自动
执行的命令。完整配置和重载门禁见[接手指南](../codex-config/skills/feishu-bot-runtime/references/configuration-and-handoff.md)。

Windows subscriber 固定 CLI `ce5b4f24e1746b83b060a795ef21e28dc2c46e4d`、
SDK `63a9f9f4133a6789981bb87c9a440bf4cdfe5b1e`；必要构建入口
`scripts/build-lark-heartbeat.py`。两个平台的 subscriber 构建 manifest/binary hash
必须另行在私有主机核对，清单工具不会打开或替换它们。

## CLI contract

- `generate --repo REPO --ref COMMIT`：stdout 为确定性完整 manifest；退出 0 仅表示
  source/profile/依赖约束检查通过。
- `verify --repo REPO --ref COMMIT --manifest FILE`：重新从独立指定的 ref 生成；
  manifest 任意字段不符均失败。stdout 只含安全摘要。
- `check-installed --repo REPO --ref COMMIT --manifest FILE --platform darwin|win32
  [--area runtime|skill|all] [--runtime-root ROOT] [--skill-root ROOT]`：默认 all；
  被选 scope 必须提供对应根目录。skill-only 不要求 runtime 存在；runtime-only
  不读取技能目录。stdout 给 checked_files 与仅含公开声明相对路径的 issues。
- 成功退出 0；输入、source、manifest、安装文件问题退出 1。错误 stdout 为
  `{ "ok": false, "error": "safe_code" }`，不输出本机路径、Git stderr 或私有文件
  内容。逐文件失败给 `missing`、`hash_mismatch`、`symlink`、`non_regular` 等原因。
- 三个命令都要求干净 source；`check-installed` 返回 `subscriber_checked:false`、
  `process_checked:false`、`real_human_acceptance:"not_checked"`，防止把静态校验
  混同上线验收。它们不能代替远端发布证明。

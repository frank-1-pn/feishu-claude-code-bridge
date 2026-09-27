# 飞书连接优化候选版

核查日期：2026-09-27。基线：`f7b66132790ccd16e6a3935407e77f2447a535d1`。
分支：`feat/feishu-deep-opt-20260927`。本文件描述尚未启用的候选实现，不是生产验收证明。

## 项目比较与采用方式

| 项目 | 本次查看的证据 | 适用判断与采用方式 |
| --- | --- | --- |
| [CowAgent](https://github.com/zhayujie/CowAgent/tree/b8f450606df90b4feda38cb53c0a60835506e47a) | `app.py` 的 `ChannelManager`，`common/channel_registry.py`，`channel/chat_channel.py`，`channel/feishu/feishu_channel.py` 及进度卡片测试；MIT，2026-09-26 仍有提交 | 长期维护的多通道 agent 项目。参考按实例管理连接、隔离队列、替换前先停止旧实例，以及 CardKit 最新快照合并、串行更新和最终化。实现适配器，不整体迁移 Python 运行时。 |
| [cc-connect](https://github.com/chenhg5/cc-connect/tree/a5c93d9ce1993f7ce136ef454e3f80324758cc1a) | `platform/feishu/ws_shared.go`、`feishu.go`、资源/重试相关测试；2026-09-26 仍有提交 | 与编码助手场景最接近。参考单 app 共用连接、资源处理和流式预览的设计；不替换 Orca 当前会话。此快照未找到许可证，未复制其源码。 |
| [飞书官方 Channel SDK](https://github.com/larksuite/channel-sdk-node/tree/ecdec28389a96b2cf668766b6d110fb24c8610f5) | `src/keepalive.ts`、`src/outbound/retry.ts`、`src/outbound/streaming/card-stream.ts`；MIT | 与 Node 运行时契合，提供串行卡片更新、重连和媒体封装；仓库历史尚短，不把官方身份当成熟度证明。参考设计，用现有 CLI 实现兼容适配。 |
| [OpenClaw 飞书通道](https://github.com/openclaw/openclaw/tree/4c88390c72d79ff11e1b450c697d473e8a2ebf5a/extensions/feishu/src) | `monitor.transport.ts` 的重连耗尽处理与有界退避，`streaming-card.ts` 的卡片序号与最终化 | 可借鉴连接生命周期和卡片终态处理；完整引入会增加网关及会话迁移成本。本次未复制源码或安装整个网关。 |
| [飞书官方 Node SDK](https://github.com/larksuite/node-sdk) | GitHub 当前仓库元数据：MIT，最近推送 2026-09-14 | 是更底层的 SDK；如后续整体替换 CLI 订阅，可用其结构化连接状态。本次保留 CLI 单订阅。 |

本次代码为面向现有 bridge 的原生实现。没有新增事件订阅，没有引入上述项目依赖，也没有把不同项目接到同一个 app 上竞争入站事件。

## CowAgent 如何管理飞书连接

`ChannelManager` 以 `instance_id` 注册通道对象和运行线程，把凭据、agent 绑定与实例对应起来；替换前停止旧实例，初始化失败按实例隔离。`common/channel_registry.py` 统一保存活动管理器，避免 Python 的 `__main__` 和再次 import 产生两份注册表。`ChatChannel` 为实例保留会话状态、队列和并发信号量。

飞书通道使用官方 `lark_oapi` WebSocket 客户端，正常自动重连主要依赖 SDK。为绕开 SDK 模块级 asyncio loop 的多线程问题，它隔离每个连接线程使用的客户端模块。卡片把最新完整快照放入异步队列，创建中不重复建卡，按序列更新，并在终态前排空旧更新。参见 [飞书实现](https://github.com/zhayujie/CowAgent/blob/b8f450606df90b4feda38cb53c0a60835506e47a/channel/feishu/feishu_channel.py) 和 [配置说明](https://docs.cowagent.ai/channels/feishu)。

没有照搬的行为：当前快照会过滤启动前或超过 600 秒的消息；证书校验失败后的第二次连接会关闭证书检查；关闭线程使用强制异常；卡片还可展示 reasoning。本候选版保留 TLS 校验、已有持久 inbox，只转发公开 commentary/final。worker 同时拒绝重复 profile 绑定，防止一个 profile 被两个队列重复接管。现有 24 小时入站时间窗保持不变：已入队任务不因重启过期，但尚未入队且超过此窗的事件仍会被原时间策略过滤。

## 五项需求与改造

| 需求 | 已实现的候选行为 | 验证边界 |
| --- | --- | --- |
| 连接稳定性 | 订阅进程直接使用追加文件描述符；重启保留未消费事件与所有 offset；有活跃订阅时按准确 profile 接管；保留 CLI 单实例锁，移除 `--force` | 隔离子进程实测连续两次启动，旧事件字节仍完整。未对真实飞书主动断网。 |
| 多消息 | bot 之间独立；单 bot 的暂时性附件错误按顺序重试；并发调用防重复投递；同一轮答复共用发送记录和退避；文本分片完成后立即落盘 | 100 条连发、重复到达、重启顺序、两个 bot 独立、同轮断网退避均有故障注入测试。永久失败会明确通知并放行后续消息。 |
| 断连自愈 | 沿用现有 watchdog；识别 SDK 明确的重连耗尽信号；只重启已核实身份的对应进程树；出站指数退避和抖动持久化，权限/参数错误停止自动重试 | CLI 没有结构化 ping/pong；静默半断连尚不能被可靠检测。状态明确 `socket_verified=false`。网络错误恢复后继续投递；永久权限错误需修复权限并人工解除对应记录的 blocked 状态。 |
| 流式回复 | 优先 CardKit 2.0，持久化 card_id/message_id、更新序号、UUID 与未确认操作；串行排空旧更新后最终化；缺少权限时退回普通卡片；每卡至少 10 秒更新间隔；卡片失败或超长时回退完整文本 | 当前 Orca rollout 按消息提供 commentary/final，属于消息级增量卡片。未取得逐 token 事件，不宣称 token streaming。真实卡片展示及平台重复 UUID 行为待启用后验收。 |
| 各种文件收发 | 保留入站图片/文件/post/audio/video/media/sticker 下载；增加缓存 SHA-256 校验；出站文件先快照入持久队列，按固定 bot/chat 发送；支持通用文件、图片、音频、带封面视频 | 10 类扩展名测试使用模拟字节，证明队列和发送契约，不证明文件解析或飞书平台接受所有格式。真实 Office/PDF/压缩包/音视频待样本验收。 |

## 文件交付

只有用户要求交付的文件才能入队；不会自动上传正文里出现的本地路径。命令只接受已由白名单验证的入站 job，不接受另指定收件人。

```powershell
node "$env:USERPROFILE/.lark-cli/daemon/codex-bridge-send.mjs" --bot <已绑定bot> --job-id <入站om_id> --file "<交付文件绝对路径>"
```

默认 `--mode file`；可选 `image`、`audio`、`video`，视频还需 `--cover`。返回 `queued` 只代表持久入队，`file-outbox/*/*/request.json` 的 `done` 才代表发送调用成功。运行状态显示 pending/failed 计数。默认路径范围为绑定 cwd，可通过绑定的 `outbound_roots` 明确扩展。

根据飞书当前[文件上传规范](https://open.feishu.cn/document/server-docs/im-v1/file/create.md)，通用文件最大 30 MB。图片上限 10 MB，依据本机 CLI 的 `schema im.images.create`；超限与空文件在发送前拒绝。无法播放的音视频仍可按通用文件交付。传输成功不证明模型已理解音视频。

CardKit 使用官方[创建实体](https://open.feishu.cn/document/cardkit-v1/card/create.md)、[更新元素内容](https://open.feishu.cn/document/cardkit-v1/card-element/content.md)、[全量更新实体](https://open.feishu.cn/document/cardkit-v1/card/update.md)接口，需要 `cardkit:card:write`。同一操作的 sequence、UUID 和正文在发送前落盘，不确定结果先重试原操作。序号/UUID 冲突停止自动重试，最终正文改用文本发送，不把冲突冒充成功。没有权限且尚未创建实体时退回[普通消息卡片](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch.md)，发送前后均设置 `update_multi=true`；已创建的实体不会换成第二张进度卡。绑定可设置 `cardkit_enabled: false` 明确使用普通卡片。

现有 CLI 未注册完整卡片快捷方法，因此按 `lark-openapi-explorer` 工作流核对官方索引和 API 后使用通用 API。JSON 经 stdin 传递，避免 Windows argv 限制；所有新传输调用强制 `LARK_CLI_NO_PROXY=1`。

## 隔离验证与剩余风险

运行 `node --test daemon/*.test.mjs`，另做 Node / PowerShell 语法检查及 `git diff --check`。结果保存到同目录 `feishu-deep-verification.json`。原有测试中两项期望随行为调整：附件暂时失败要保持 FIFO，发送失败要等到 retryAt。新增测试覆盖这些行为而不是删除失败断言。

实机只做状态/API 只读检查与 CLI `--dry-run`，没有发送测试聊天，没有停止在线进程。一次只读 bot 信息探测继承了本机代理设置；发现警告后使用禁代理设置重验，成功返回 code=0。新代码始终禁代理。CLI 当前为 1.0.39，提示 1.0.96 可用，未自动升级以免干扰两条在线会话。

本地分片检查点和稳定 UUID 缩小重复窗口，但不能提供跨 Feishu、文件系统的事务性 exactly-once；网络接受后、写检查点前的进程崩溃仍依赖平台幂等窗口。未模拟断电。追加日志不自动删除，长期运行需另做带游标协调的归档策略；不能恢复旧的截断式轮转。

CardKit 创建实体接口没有幂等字段：崩溃可能遗留未发送的实体。最终卡片更新失败时保证完整文本走持久队列，旧卡片可能仍显示处理中；其失败状态保留在 card 记录。永久错误不会无限重试，修复权限或数据后应对账再解除 blocked，不能直接删队列。

## 切换清单

1. 取得“同步并启用”授权后，只提交本次列明路径并推送对应分支；记录完整发布 SHA，确认远端一致，再执行测试。
2. 根据 `feishu-deep-release-plan.json` 核对在线脚本的 SHA-256。如出现新漂移，暂停覆盖，合并本次以后新增的修复。
3. 备份清单中的在线脚本。绑定配置、inbox、出站状态、下载目录和所有 offset 必须保留，不进入 Git。
4. 等两个 bot 的工作进入安全切换窗口，核对 bridge PID/instance；短暂停止 watchdog 的恢复动作后切换清单文件。现有订阅无需为了本次更新立即重启；新的追加启动器在下次合法重启时生效。
5. 启动 bridge，恢复 watchdog，核对文件哈希、语法与 transport/delivery 状态。新状态目录和 V2 inbox 并存，无破坏式迁移。
6. 在绑定聊天做真实验收：连发文本/图片/文件；观察模型 marker；卡片增量/最终化；PDF/Office/ZIP 往返；音视频附件；网络中断恢复。逐项记录，不以 healthy 或单向 ok 替代双向验收。
7. 如需回退，先对账已发送与 pending 记录，再恢复脚本备份；保留全部 V2/V3 状态，不能仅恢复旧 offset。

本次候选代码没有修改知识库正文、索引、日志、机器人绑定或线上运行目录。部署前尚未完成真实平台验收的部分保持未验收状态。

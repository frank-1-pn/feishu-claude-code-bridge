# 飞书卡片元素更新

公开进度继续使用同一张 CardKit 卡片。当排版和状态不变时，bridge 只更新实际变化的 Markdown 元素，例如正文和折叠的公开进度；新增来源区、状态变化或发送最终答复时才更新整张卡片。未变化的元素不请求接口，完全相同的显示结果不发送更新。

## 用户看到什么

集成配置把公开快照更新间隔从 10 秒缩短到至少 2 秒。更短的间隔只影响已从模型获得的公开进度，不保证模型每 2 秒都会产生新文字。界面保留状态、首屏正文、折叠内容、来源及原有操作按钮。

按 2026-09-27 核对的[飞书流式更新文本文档](https://open.feishu.cn/document/cardkit-v1/card-element/content)：

- `PUT /open-apis/cardkit/v1/cards/{card_id}/elements/{element_id}/content` 接收元素的新全量文本。
- 旧文字是新文字的前缀时，追加部分显示打字机效果；如果修改了前文，新文本直接刷新。因此不能承诺所有更新都有逐字动画。
- 卡片必须启用 `streaming_mode` 和 `update_multi`，使用 Card JSON 2.0；应用需有 `cardkit:card:write`，且应为创建该卡片的应用。
- `sequence` 必须严格递增，`uuid` 用于重试幂等。最终整卡更新关闭 `streaming_mode`。

这不是逐 token 输出。本次集成检查的现有 Codex rollout 未发现可消费的答案 delta 事件；Orca 现有入口也不能据此假定已有持续的模型增量流。因此实现使用 2 秒节流的公开快照和飞书原生元素更新效果。后续要逐 token 流式，仍需可用且经过验证的上游公开输出事件源；不能用 reasoning 内容冒充公开进度。

2 秒表示发送已有公开快照的最小间隔，也不表示桥接把一段完整答复人为切成字符后就拥有了模型增量流。正文没有新增公开内容时不额外发请求；语音 ASR 当前按用户选择禁用，与卡片更新是否可用无关。

## 实现与恢复

`planCardUpdate(previous, next, {final})` 比较实际生成的卡片 JSON。仅当两个卡片的结构、配置、标题与其他属性相同时，才把可定位且内容发生变化的 Markdown 元素列为独立更新。状态、总结、来源区插入、元素数量变化、控制组件变化和最终答复均使用完整卡片更新；没有历史快照的旧记录也先完整更新以建立基线。旧无 presentation 的正文更新路径保持兼容。

每张卡的私有出站记录新增：

- `lastAppliedCard`：已确认应用到服务器的卡片快照；每个元素成功后同步该元素，不把尚未完成的目标快照当作现状。
- `cardBatch`：同一个 revision 的全部待发送操作、下一项索引与最终目标快照。
- `cardPending`：正在发送或结果不确定的操作，保存固定 endpoint、body、sequence、uuid。

发送前先持久化批次，再持久化当前操作。请求失败或重启后，先用原 sequence/uuid/body 重放不确定操作，完成批次余下元素，再推进更新的公开快照或最终答复。只有整批完成才更新 `sentRevision`，不会把部分正文更新误报成整个 revision 已送达。

最终答复沿用 `DurableOutbound` 的串行输出队列：等待正在进行的元素更新及遗留批次，随后完整更新并关闭流式模式。已关闭的卡片拒绝迟到进度。原有操作按钮绑定、卡片权限回退和最终正文降级逻辑保留。

本地快照、批次和 UUID 属于私有运行状态，不提交 Git，也不另建事件订阅。

## 集成与验证

worker 创建出站队列时配置 `minIntervalMs: 2000`；本模块不自行启动定时器、重连 bot 或修改运行实例。2 秒是最小更新间隔，原有失败退避和串行队列仍然生效。

运行以下测试，46 项通过，0 失败、0 跳过：

```text
node --test daemon/codex-bridge-streaming.test.mjs daemon/codex-bridge-deep.test.mjs daemon/codex-bridge-presentation.test.mjs daemon/codex-bridge-delivery.test.mjs
```

其中 8 项新增测试覆盖实际变化元素筛选、嵌套折叠进度、相同内容不发请求、状态切换整卡、批次中途失败、原序号与 UUID 恢复、旧日志兼容、最终答复串行关闭和迟到进度不回退。测试未创建或修改真实飞书消息；客户端动画以及真实元素更新接口由集成人在部署后使用授权样本验收。

2026-09-27 追加 Bot1 真实 API 验收：创建未发送的验收实体，分别更新正文和折叠进度两个 Markdown 元素，再整卡关闭流式，所有请求成功。未发送聊天；仅证明真实接口可用，手机动画仍未验证。私有 proof 保存端点、sequence、UUID 和实体标识，不提交 Git。

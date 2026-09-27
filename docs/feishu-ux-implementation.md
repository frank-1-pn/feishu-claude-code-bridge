# 飞书 AI 答复交互优化

基线：`e7dba568c72db163aa2e47a37c8d1446632f9fab`。本轮在独立工作树集成三位 worker 的卡片、报告、回调模块，唯一集成人修改 Inbox、Outbound 和 Worker。

## 最终行为

| 场景 | 行为 |
| --- | --- |
| 普通答复 | 首屏呈现原文结论和至多五个要点；较长全文、来源、公开进度分区折叠 |
| 来源、表格与代码 | HTTP(S) 来源编号可点击；不伪造验证标签，不把本地路径伪装为移动端链接；保留代码及表格 |
| 长答复 | 至少 2400 字符，或至少 1200 字符且包含表格、代码或多章节时，生成完整 HTML 与 Markdown 附件；确认文件发送成功后收起长正文 |
| 修改当前答案 | 三个按钮：再简短一点、补充依据、转表格；输入带原任务、原卡片及公开答案上下文，进入原有持久任务队列 |
| 缺少多个条件 | 模型显式输出 `feishu-form` 尾块后，呈现最多六项文本或下拉条件表单；一次提交一个任务 |
| 工作状态 | 独立状态区支持处理、检索、整理、等待补充及完成；完成摘要来自原文；等待条件不显示已完成 |

自动报告仅使用本轮公开答复，原始附件不修改；正文里出现本地文件链接不会触发上传。报告失败时保留全文回退与文件队列，不能把排队称为送达。HTML 无外部资源，支持手机与打印；Markdown 保留经原有 sanitizer 去除内部标记并 trim 后的完整答复。脚本、原始 HTML 与危险链接不能在报告内执行。

普通完成卡片仅展示三个按钮；补充条件的表单仅在确有缺失条件时出现。模型输出格式如下，字段标签和选项由本次任务决定：

```feishu-form
{"version":1,"title":"补充条件","fields":[{"name":"audience","label":"阅读对象","type":"text","required":true},{"name":"format","label":"格式","type":"select","options":[{"label":"表格","value":"table"},{"label":"文字","value":"prose"}]}]}
```

表单非法或只是普通示例时不静默吞掉正文；交互不可用时以可见文字列出需要补充的字段。

## 持久性与边界

- 复用原有 `event +subscribe`，同一连接过滤 `im.message.receive_v1,card.action.trigger`。不启用第二个订阅，不使用 `--force`。
- 当前 CLI v1.0.39 的 GenericProcessor 能保留嵌套 action/operator/context。SDK 协议 ACK 与 bridge 业务受理分开；当前 CLI 不能同步转发业务 Toast，拒绝原因和受理回执由既有聊天异步反馈。ACK 到文件持久化之间仍有上游崩溃窗口。
- 卡片绑定实际消息 ID 后才暴露按钮；一个答案上下文只能绑定一张确定的主卡。多消息合并、最终覆盖进度、sequence/UUID 重试沿用原有保护。
- 动作绑定 bot、chat、sender、thread、卡片、版本与 24 小时有效期；事件 ID、token、逻辑操作去重，表单只能成功提交一次。重复点击不重跑模型任务。
- 新入站任务保存绑定快照。重启时旧任务必须符合当前 chat/sender/thread，变更绑定的待办保留并标记失败，不投向新会话。
- 文件发送的周期循环与最终回复共用整个 flush 过程，避免读取相同旧队列记录；报告和文件快照有来源、路径及哈希校验。
- 公开进度仍按至少 10 秒节流，是 commentary 快照更新；上游尚未提供逐 token 增量。
- 不转发 reasoning/analysis；上下文和附件留在私有 `daemon/state/`，禁止提交 Git。

## 验收与运行

运行 `node --test daemon/*.test.mjs`。覆盖并发消息、网络失败、权限失败、重启、重复点击、伪造身份、表单回放、报告篡改、HTML 注入及绑定变化。`scripts/verify-feishu-ux-cardkit.mjs --live-unsent-entities` 只创建不发送到聊天的卡片实体，用真实 CardKit 接口验证完成与等待表单结构；结果见 `feishu-ux-api-verification.json`。

HTML 示例见 `feishu-generated-report-example.html`，手机 390px 与桌面 1280px 均做了渲染和交互检查。真实客户端按钮点击、表单提交、模型入站、最终投递必须另有实际事件与 rollout marker 证明，不能用接口创建成功或 healthy 替代。

应用后台必须配置使用长连接接收 `card.action.trigger`。本地订阅增加过滤项不能自动代替后台配置；CLI 无该配置的预检接口。`status-codex-bridge.ps1` 新增 action accepted/pending/blocked 数量，判活仍以真实入站到目标 thread 为准。

来源：[飞书卡片组件](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/component-json-v2-overview)、[卡片回调](https://open.feishu.cn/document/feishu-cards/card-callback-communication)、[CLI v1.0.39 订阅源码](https://github.com/larksuite/cli/blob/v1.0.39/shortcuts/event/subscribe.go)、[SDK v3.5.4 分派器](https://github.com/larksuite/oapi-sdk-go/blob/v3.5.4/event/dispatcher/dispatcher.go)。核查日期 2026-09-27。

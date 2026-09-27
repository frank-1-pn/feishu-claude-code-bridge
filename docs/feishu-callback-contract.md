# 飞书卡片操作与条件表单

本模块把当前答案的三个快捷操作和一次性条件表单接入已有 DurableInbox。`再简短一点`、`补充依据`、`转表格`分别生成固定的修改指令；表单只接受本地注册过的字段和选项。它不启动事件订阅、不调用模型、不发送聊天消息。

## 调用约定

```js
const actions = new ActionStore({ root: privateActionRoot, bot: binding.bot });
const context = actions.registerContext({
  key: replyKey,                       // 同一最终回复重试必须稳定
  sourceJobId: sourceJob.id,
  codexThreadId: binding.codex_thread_id,
  chatId: binding.chat_id,
  allowedSenderId: binding.allowed_sender_id,
  answer: finalPublicAnswer,           // 仅公开答案，不能传入推理或工具日志
  version: 1,
  mode: 'complete',                    // 等待条件的卡片用 waiting
  // form: { title, fields },          // waiting 时传明确的缺失条件
});
actions.bindMessage(context.contextId, actualFeishuMessageId);
const interactions = buildActionElements(context, { includeForm: context.mode === 'waiting' });
// outbound 在绑定真实消息 ID 后把 interactions 写入最终卡片。

const result = actions.acceptCallback(callback, {
  binding,                            // 本次从运行时读到的现行绑定
  authenticatedBot: binding.bot,       // 只能来自已认证订阅进程，不能取自回调正文
  appId: registeredAppId,              // 官方 envelope 有 app_id 时核对
});
// result = { accepted, duplicate, reason, eventId?, response: { toast } }
// storage_unavailable: 不推进输入游标，稍后重试。
// 其余拒绝: 无模型任务；可记录 reason 元数据，不能记录表单/答案/token。
actions.drain({ binding, inbox });
// -> { enqueued, blocked, pending }; stats() -> { accepted_count, pending_count }
```

先创建无按钮卡片并取得消息 ID，再绑定并更新操作区，避免未知消息 ID 的按钮被接受。已有进度卡片则直接使用已知消息 ID。`registerContext` 使用每个 bot 的本地随机秘密派生不透明标识；相同 `key + version` 重试返回同一标识。相同版本更换答案、来源任务、绑定或表单会拒绝，必须提高版本。新版本使旧版本失效，默认操作期限为 24 小时（不超过平台 14 天的交互期限）。

`mode: waiting` 仅展示条件表单，不展示改写按钮；卡片标题和消息摘要由呈现层标为“等待补充”，不能把等待条件显示成已完成。普通完成答案只展示三个快捷按钮。`DEFAULT_FORM` 提供用途、篇幅、格式、其他要求四个选填项，供显式输出偏好流程使用，不在每条回复下强行展开。

自定义表单最多 6 项，每项包括：

- `name`：`^[a-z][a-z0-9_]{0,23}$`，同一表单内唯一，避开内部保留名。
- `label`：1–80 字符，`type` 为 `text` 或 `select`。
- `required`：是否必填；服务端再次校验。
- 文本项 `maxLength`：1–1000，默认 1000。
- 选择项 `options`：1–12 个 `{ label, value }`，值必须唯一且只含字母、数字、下划线或连字符。

表单至少填写一项。一次成功提交后，同值重试返回已保存；不同值重提拒绝为 `stale_form`，用户应在新回复中修改。这样不会把手机端旧表单覆盖成另一个尚未看见的任务。

## 身份、重放与故障边界

回调必须同时匹配订阅所属 bot、现行绑定的 thread、chat、操作者 open_id、实际卡片消息 ID、本地动作上下文、版本和期限。`action.value` 只允许 `{context_id, version, action}`，拒绝额外的 prompt、thread 或路由字段。点击行为只允许 `shorter`、`sources`、`table`、`conditions`；原答案以带边界的 JSON 字符串提供上下文，不被当作新的授权。

去重有两层：事件 ID / 回调 token 各自映射到同一个操作；`context + version + action + 规范化表单值` 决定稳定的 `om_cb_<sha256>` 入站 ID。对同一卡片反复点击相同按钮只产生一个任务，跨重启仍成立。回调 token 只用于计算私有索引文件名，不写入队列或日志。

接受时先 fsync 完整意图，再写入操作记录，返回的“已保存”只表示本地持久接受，不表示模型已读。重启可以从完整意图恢复缺失操作记录。进入 DurableInbox 后再写入转交标记；进程若在两步之间退出，重复 enqueue 会被 Inbox 的稳定 ID 去重。转交时再次验证当前绑定，绑定变化的任务保留为 blocked，不路由到其他 thread。入站 marker 和最终投递仍遵循现有 bridge 验收规则。

每个 bot 必须只有一个回调接受进程，复用当前事件消费者；`acceptCallback` 完全同步，没有网络或模型请求。私有上下文保留完整公开答案，传入模型的上下文超过 16,000 字符时保留开头和结尾并明确标注中段省略。状态目录包含用户正文、表单值和答案，禁止提交 Git。生产 Windows 部署应继承当前用户私有目录 ACL。

## 已确认的传输限制

支持两种输入格式：官方 `schema: 2.0 / header / event`，以及当前 lark-cli v1.0.39 GenericProcessor 的 `{type:'card.action.trigger',event_id,operator,context,action,token}`。不猜测其他嵌套格式。紧凑格式没有 app_id，因此认证来源依赖已建立的对应 bot 订阅进程。

官方卡片协议支持 3 秒内返回 Toast；本模块的 `response.toast` 可直接用于具有同步返回通道的适配器。目前 CLI 通用事件消费者没有把本模块的返回值写回 SDK 的同步回调通道，因此不能声称聊天客户端已展示该 Toast，也不能声称本地 fsync 发生在平台 ACK 之前。当前集成在同一订阅内增加 `card.action.trigger`，由 bridge 持久接收并异步反馈。平台 ACK 与 CLI 文件写入之间的崩溃窗口仍属于上游传输边界。

## 官方结构依据与测试

本次核实了以下官方文档（2026-09-27）：

- [卡片回传交互回调](https://open.feishu.cn/document/feishu-cards/card-callback-communication)：操作者、会话、消息、事件 ID 与表单字段；3 秒响应。
- [按钮 JSON 2.0](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/button)：`behaviors.callback.value`、表单按钮 `name` 和 `form_action_type: submit`。
- [表单容器 JSON 2.0](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/containers/form-container)：批量提交，表单只能位于卡片 body 根层。
- [输入框](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/input)及[单选下拉菜单](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/single-select-dropdown-menu)：字段名称、必填约束、文本长度、选项回传值。

运行 `node --test daemon/codex-bridge-actions.test.mjs daemon/codex-bridge-action-ui.test.mjs`。测试覆盖操作者/chat/card/bot/app/thread 欺骗、回传 prompt 注入、版本失效、过期、事件/token/逻辑重复、表单校验和旧表单、重启恢复，以及 enqueue 后进程退出的故障注入。没有发送真实飞书消息；真实客户端按钮点击与表单提交的完整链路需部署后按绑定会话验收。

# 答案转飞书待办

在答案卡点击“转待办”后，先填写事项、截止时间和提前提醒。只有绑定聊天中的本人提交表单，bridge 才以当前 bot 创建一项分配给本人的原生任务；卡片文本、模型答案或按钮值不能更换负责人、关注人、群或租户。

## 创建与时间规则

- 事项必填，最多 200 字；截止时间和提醒选填。留空提醒等价于“不提醒”。
- `YYYY-MM-DD HH:mm` 明确按北京时间解释，与服务器本地时区无关。日期、闰年、时分均严格校验。
- `YYYY-MM-DD` 表示全天任务。Task v2 的全天日期按 UTC 日粒度存储，不能先减八小时，否则服务器会截为前一天。
- 提醒只允许不提醒、到期时、提前 15/30/60 分钟；有提醒必须有截止日期/时间。没有设置提醒不代表飞书客户端不会按自己的通知设置展示任务。
- 任务描述保留原答复摘要和经验证的飞书来源链接；长答案缩短时为链接预留空间。正文不改变任务授权范围。
- 只有校验通过的任务 GUID 和官方任务链接才视为创建成功；任务 URL 中的 GUID 必须与 API 返回 GUID 相同。

## 持久化与失败边界

`NativeTasks.create({key,values,answer,sourceUrl})` 使用稳定 key、当前绑定 scope 和不可变参数生成 `client_token`。发送前写入私有运行状态；同 key 的并发调用串行执行，每次都核验原始输入和发送内容。重启后复用已保存的成功结果，不创建第二项任务。

飞书任务的 `client_token` 仅在实际成功后提供五分钟去重，参数改变时的行为不受保证。bridge 从首次尝试计时，240 秒后不再发起创建重试，将记录置为 `uncertain`，保留原 token 和数据供核验。调用方应使用不超过 15 秒的专用网络请求超时，为服务端窗口留出余量。不能更换 key/token 或删除私有状态来绕过这个限制；也不能把 `uncertain` 写成“确认未创建”。

状态缺 schema、绑定/参数不符、非法日期、损坏 JSON、错误 GUID、伪造链接或缺失首次尝试时间均停止执行。权限不足会阻塞当前意图；不会切换身份、分配给其他人或启动用户登录。

## 与本地确认队列集成

本地卡片先注册 `task_open`，点击后生成 `task_create` 表单。NativeActionStore 已严格验证 bot/profile/chat/sender/Codex thread、源卡片消息 ID、过期时间、字段白名单和重放。表单只接受一次内容，相同重放幂等，改内容的重复提交拒绝。

handler 必须返回 `NativeTasks` 的状态（并按需先发送持久通知），不能丢弃返回值：

```js
const result = await tasks.create({
  key: operation.id, values: operation.values,
  answer: operation.data.answer, sourceUrl: operation.data.sourceUrl,
});
return result;
```

- `done`：本地 operation 完成。
- `pending` / `queued` / `running` 或 `{pending:true}`：保持 pending，按 `retryAt` 退避；默认 5 秒，最少 1 秒，最多 5 分钟，避免每次 worker 轮询都发请求。
- `blocked` / `uncertain` 或 `{blocked:true}`：本地 operation 阻塞，不谎报完成，也不持续重建任务。
- `undefined`：兼容已完成的其他 handler，但任务 handler 不应使用这种返回方式。

任务创建成功、随后发送结果通知失败时，重试应先获取已保存任务，再以同一消息发送 key 补发通知。外部效果和本地 checkpoint 之间仍可能崩溃，必须保留两层持久幂等。

## UI 与验证

截止时间现使用飞书原生 `picker_datetime`，直接点选日期和时间，无需手填格式；不选则不设置截止时间。控件位于原确认表单内，只有点击“确认创建”才提交。按界面提示，将所选钟表时间解释为北京时间；飞书回调附带的设备时区偏移只是参考，不改变这一约定。

为兼容已经发出的卡片，签名字段 schema、`due` 字段名、原确认 context 与单次提交规则保持不变。回调中的 `yyyy-MM-dd HH:mm +0800` 先移除经过校验的时区后缀，再进行原长度与日期校验；与旧纯文本表示得到同一去重记录。渲染器版本升级只 PATCH 原绑定消息，保留发送幂等键；中途失败重试不会多发一张表单。旧表单中的无效日期不会作为控件默认值，用户可重新选择。

2026-09-27：新增点选、留空、时区、旧表单兼容、重复提交、同卡升级和更新响应丢失后的恢复测试；完整套件 247 项通过。Bot1 真实 CardKit 接口接受带可选日期时间控件的表单实体后，再发送新版表单进行真实验收：收到非空日期时间提交，任务回读的截止时间戳与北京时间预期一致，负责人正确且结果通知送达。用户确认“能选择，提交后收到待办链接”。

组件及回调依据：[日期时间选择器](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/date-time-picker)、[表单容器](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/form-container)。

输入框 `default_value` 已按官方结构核对。下拉框不设置未经本次验证的默认值；未选择提醒由服务端明确解释为“不提醒”。

2026-09-27：本模块 11 项测试通过；本地确认队列 11 项测试通过。覆盖北京时间/全天日期、闰年、提醒条件、负责人边界、并发改参、原始答案变化、短期去重、响应丢失、重启、损坏/跨绑定状态、GUID/URL、待处理状态退避和不确定结果阻塞。部署与真实客户端验收由根集成人记录；本次模块审核没有创建真人任务或发送真实消息。

官方来源：[创建任务](https://open.feishu.cn/document/task-v2/task/create)、[任务概述与幂等规则](https://open.feishu.cn/document/task-v2/overview)、[任务日期与时刻的区别](https://open.feishu.cn/document/task-v2/task/overview)、[卡片输入框](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/input)。

集成人追加真实接口验收：Bot1 为绑定本人创建一项明确标记为测试的待办，随后 GET 确认任务 GUID 与 assignee，再标记完成。该验证没有向其他人发送消息，真实 ID 及状态留在私有临时目录；新卡片的实际点击、表单和结果通知仍待部署后客户端验收。

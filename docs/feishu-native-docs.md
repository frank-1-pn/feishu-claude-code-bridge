# 飞书云文档交付

长答复在现有 HTML 和 Markdown 报告之外，异步生成一份原生飞书云文档。正文仍立即按既有回包流程发送；云文档写入、权限或网络失败不阻塞答复，也不删除原始附件。短回答不创建云文档。

## 行为与边界

- 复用原报告策略：一般答案至少 2400 字符；带表格、代码或多个标题的复杂答案至少 1200 字符。调用方也可因用户明确要求报告而传 `force:true`。
- 只消费已经绑定到原消息和 `replyKey` 的公开最终答案。状态目录包含正文、文档 ID 和分享对象，属于私有运行状态，不提交 Git。
- 使用飞书官方 Markdown 转换接口保留表格、代码、标题、列表和引用。每次写入最多 1000 个块，保持完整顶层子树，表格不会拆开写入。删除转换结果中的只读 `merge_info`、`cells`、`parent_id` 和 `revision_id` 字段。
- 云文档中的图片降级为来源链接或“查看原始附件”的说明，不自动抓取网络图片或读取模型给出的本地路径。原始 HTML、Markdown 和显式发送的附件照常保留。
- 保护性上限为 512 KiB 源文、5000 个块、每批约 1 MiB；超限、异常树结构和不能可靠创建的块明确降级附件，不静默截断。
- 生成完成后只投递一次“打开完整报告”链接。云文档尚未完成时不冒充成功；失败只提示附件仍可用。是否已经实际读到文档仍需用户打开验证。

## 权限与目录

私有 binding 可设置：

```json
{"cloud_docs":{"enabled":true,"folder_token":"YOUR_BOT_OWNED_FOLDER_TOKEN"}}
```

`folder_token` 可省略，此时创建到当前 bot 自有根目录。原生创建接口说明：使用 bot 身份时，指定目录仅支持应用创建的文件夹。不会自动改为用户身份、迁移所有者或把文档放进已有知识库。

创建时使用不含原问题正文的通用标题。写入正文前必须成功关闭组织/公开链接分享及组织外分享，并核对协作者只有当前 bot 与绑定用户。存在其他协作者或不能确认权限时停止写入，保留空白文档以便排查，不自动删除资源。

正文完成后，只给 `binding.allowed_sender_id` 添加 `view` 权限，不对整个群、组织或互联网开放。核对添加权限返回的用户、权限等级及重新读取的成员列表，然后使用元数据接口返回的真实文档 URL。允许阅读者评论，不赋予管理权限，不通知其他用户。

未使用 `docs +create` 的原因：该 CLI 快捷命令在 bot 模式下会尝试把 `full_access` 自动授给 CLI 当前用户；该用户不一定是此 bot 的绑定用户。这里通过原生接口明确控制唯一分享对象。

以下为细粒度 scope；部分接口也允许 `docx:document`、`drive:drive` 等上位权限，详细替代项以官方接口为准：

| 用途 | scope |
|---|---|
| 创建空文档 | `docx:document:create` |
| Markdown 转文档块 | `docx:document.block:convert` |
| 写入嵌套块 | `docx:document:write_only` |
| 读/限制链接分享 | `docs:permission.setting:read`、`docs:permission.setting:write_only` |
| 核对协作者、授权绑定用户 | `docs:permission.member:retrieve`、`docs:permission.member:create` |
| 取得实际文档 URL | `drive:drive.metadata:readonly` |

Bot 缺少权限时，由管理员在应用后台开通；不能用 `auth login` 替代 bot 的权限。可先对公开测试 Markdown 调用转换接口做无资源创建的预检，随后由集成人创建一份验收文档核对实际目录、写入和权限。仅凭转换成功不能声称创建和分享权限都可用。

## 持久化与恢复

状态按 bot、当前绑定快照及原答复 `replyKey` 隔离。同一答案只对应一条文档记录；换绑后不继续分享旧记录。损坏记录按失败关闭，避免被当作未创建而重建。

1. 先持久化请求并完成 Markdown 转换，再创建空文档。
2. 原生创建没有 `client_token`。请求发出前保存 `createPending`，成功后立即保存文档 ID。断网或崩溃导致创建结果不确定时，标记 `cloud_doc_create_uncertain`，禁止自动再次创建。需根据私有日志和 bot 云空间人工核对，不能清空检查点后盲目重试。
3. 每批写入先保存 UUIDv4 `client_token`、目标文档版本和批次内容。断线重试复用完全相同的值；已确认批次不重复写入。固定文档版本也避免在幂等缓存失效后盲目追加。
4. 分享请求返回不确定时，重新读取成员列表核对绑定用户是否已获授权，不转而分享给其他对象。
5. 单条最多 5 次自动尝试，权限或校验错误立即降级。确认权限修复后可由集成人调用 `retry(replyKey)` 继续原记录；创建结果不确定、状态损坏或超限记录不能用此方法重建。
6. 最终答案持久化状态为 `done` 后才发云文档通知，避免链接先于原答复出现。通知使用稳定幂等 key；重启不重复通知。

`cloud_doc_pending_count`、`cloud_doc_failed_count`、`cloud_doc_ready_count`、`cloud_doc_last_error` 独立汇报，不将云文档权限故障冒充消息连接断线，也不因此重启订阅进程。

## 集成接口

```js
const cloudDocs = new CloudDocOutbox({
  root: privateCloudDocRoot,
  inboxRoot,
  binding,
  request: boundedBotTransport,
  resolveAppId: () => resolveLarkAppId(executable, binding, {children}),
  notify: async (text, stableKey, record) => {
    // record: replyKey, jobId, title, status, phase, error; ready 时才含 url。
    // 优先更新该最终答案卡片的云文档链接；不能更新时定向回复原消息。
    // stableKey 必须交给既有出站幂等层。
  }
});
// 现有报告已生成后；不要用 await flush 阻塞模型或正文回包。
cloudDocs.enqueue({jobId, replyKey, text: sanitizedFinal.trim()});
// 独立循环运行，所有请求仍使用对应 binding 的 bot/profile。
await cloudDocs.flush();
```

构造或 `enqueue` 的本地存储异常也由调用方捕获，降级既有报告交付。运行环境必须只有既有的单个 bridge writer。此模块不会启动飞书订阅、模型会话或 CLI 登录。

## 验证

`node --test daemon/codex-bridge-cloud-docs.test.mjs`：12 项针对性测试通过。覆盖表格/代码/图片转换、完整子树分批、稳定去重、创建响应丢失、已提交写入响应丢失后的重启、部分批次恢复、权限失败及修复后继续原文档、分享确认丢失、错误协作者、链接权限漂移、错绑、损坏检查点、伪造最终答复、错误云文档域名，以及真实 API 返回的 `appid` 类型所有者。仅允许所选 CLI profile 的同一 app ID，不把任意应用都当作合法所有者。

2026-09-27 经明确授权，用 Bot1 创建一份标明“验收测试”的新文档，未发送聊天通知。真实 API 回读已验证：原生中文表格块、JavaScript 代码块及正文存在；链接来自元数据接口；协作者仅当前应用所有者与绑定用户，后者为 `view`；组织/公开链接分享及组织外分享均关闭。创建遇到所有者 `appid` 类型的兼容问题后，修复并继续同一条持久记录，全程只创建这一份文档。

测试首次回读发现测试输入在 Markdown 表格行间误加空行，故未形成表格；已在同一份本轮新建测试文档追加正确表格并再次回读通过。此检查同时说明“接口成功”不足以证明表格存在。

带 URL、资源 ID 和原始回读证据的验收 proof 保存在本机私有临时目录，不提交仓库。绑定用户实际打开及手机上的表格/代码显示仍待客户端验收；移动端视觉效果不能由 API 回执代替。

## 官方接口依据（2026-09-27 核对）

- [创建文档](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/create)：空文档创建、目录约束，未提供幂等创建参数。
- [Markdown/HTML 转换为文档块](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document/convert)：转换类型、表格只读属性、图片 URL 映射。
- [创建嵌套块](https://open.feishu.cn/document/docs/docs/document-block/create-2)：1000 块限制、UUIDv4 幂等键和文档版本。
- [更新云文档权限设置](https://open.feishu.cn/document/server-docs/docs/permission/permission-public/patch-2)、[读取权限设置](https://open.feishu.cn/document/server-docs/docs/permission/permission-public/get-2)：关闭链接分享、限制协作者管理权限。
- [增加协作者](https://open.feishu.cn/document/server-docs/docs/permission/permission-member/create)、[读取协作者](https://open.feishu.cn/document/server-docs/docs/permission/permission-member/list)：定向用户授权及结果核对。
- [获取文档元数据](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/meta/batch_query)：取得云文档实际访问链接。

# 部署窗口统计与只读验收

本参考说明代码接入和证据口径，不代表部署或真实验收完成。私有策略、消息、附件、原始 GET 响应和客户正文不进入 Git，不发到群。

## 固定部署窗口

`readMetricsPolicy({root,binding,codexHome,now,expectedDeploymentId?})` 从独立的 `state/metrics-v1/<bot>/policy.json` 读取策略，不修改已有 ops policy。root 和 bot 目录必须为本用户所有的 0700 目录；策略必须为 0600 普通文件，无符号链接、无额外硬链接。消息字段不能启用统计。

策略白名单为 `{schema:1,scope:opsScope(binding,codexHome),epoch:{deploymentId,versionRef,startedAt,frozenAt?}}`。`versionRef` 是 40 位小写 commit hash；部署 ID 是最多 80 位字母、数字、下划线或连字符；时间为明确的整数 epoch 毫秒。绑定、cwd、Codex home 必须完全一致。可选 `expectedDeploymentId` 用于核对当前 release 常量。

返回 `{enabled,status,reason,metricsEpoch,epochKey?}`。缺文件为 `missing/metrics_policy_missing`；不安全、错绑定、错 release、未知字段或无效时间为 `invalid/metrics_policy_invalid`；合法窗口为 `enabled`，有冻结截止为 `frozen`。缺失或非法时 `metricsEpoch:null`，不能拿历史统计冒充新版本统计。

运行时接入建议：

```js
const metrics = readMetricsPolicy({root: metricsRoot, binding, codexHome,
  expectedDeploymentId: releaseId});
const monitor = new DurableMonitor({root: monitorRoot, binding,
  metricsEpoch: metrics.metricsEpoch ?? undefined, metricsStatus: metrics});
// 默认新版本展示；历史另用 monitor.stats().aggregate，明确标为历史。
const opsMetrics = monitor.stats().epochAggregate;
```

新 worker 只在真实 human job 首次创建时，写私有 `job.intakeEpoch={deploymentId,versionRef}`；不要从 event 复制，不补标历史或重复 job。窗口成员必须同时有匹配 intakeEpoch、合法人类身份/绑定、真实 marker、actionable，以及原消息时间不早于 startedAt。后台 callback 不增加人类请求分母。原消息时间缺失单列 unknown；缺版本标签及其他版本单列，均不纳入新版本分母。

统计覆盖范围是**已经观察到的 actionable 人类来源**，不是平台全部消息。`source_count` 是该分母，`pending_source_count` 是尚未观察到终态的来源；成功率另有明确终态分母。零样本时成功率和 p50/p95 为 null。silent、旧 turn 结束、其他绑定和 bot 来源不入样本。

各 epoch 私有样本独立保留，切换窗口不删除旧窗口。历史滚动统计仍按原保留上限工作。冻结后停止追加该窗口；重启或错误去掉 frozenAt 不能重新打开。回溯冻结不制造过去状态：截止后才观察到的 terminal/evidence 不纳入，后来才变终态的来源仍列 pending。需要完整固定快照时在采集当时冻结，不把首次观察时间当实际送达时间。

## 真实 final 传感器

`buildFinalDeliveryEvidence({at,source})` 返回 `{schema:1,at,source}`。只能在平台真正成功的响应处记录 `send_response` 或 `create_response`，并以原 reply/source 关联持久化到 `job.finalDeliveryEvidence`。未知提交重试、旧 sent receipt、cached finalDelivered 和重对账的成功观察用 `reconciled_observation`；保留已经存在的实际响应证据。

`performanceMetadata` v2 使用该字段计算 final 耗时。`completedAt` 是本地完成检查点，晚任务卡收尾或重启能改变它；它不能证明第一次 final 的时间。只有检查点时 final duration 为 null，并计 `final_checkpoint_only_count`；恢复观察计 `final_reconciled_observation_count`，也不进入 final p50。缺证据计 missing。卡片消息 create_time 通常是最初进度卡时间，不能当最后 patch 的时间。

`DeferredPerformance` 可接同一 metricsEpoch；会要求来源时间、marker、actionable 和私有 intakeEpoch。非法显式 epoch 不退回历史记录。v2 文件保留原 v1 文件；历史 metadata 明确 `scope:historical_observation`。

原请求的 final 可以只是后台入队确认。研究草稿的送达另计 `timings_ms.original_to_background_result_delivery`。后台投影需先核对真实 task/source、requestHash、nonce、callback 身份和 done，再提供 `resultDeliveryVerified:true,resultDeliveryStatus:'done',resultDeliveryEvidence`。monitor 只为 completed task 和合法新版本原来源聚合；不增加 human 或 reply 分母。恢复观察和未提供证据分别计数，不制造耗时。

## 只读验收采集

`collectBridgeAcceptance({binding,codexHome,inboxRoot,backgroundRoot,controlRoot,deliveryRoot,completionRoot?,cases,request,appId?,metricsEpoch?,now?,evidenceLabel?})` 是只读库接口。每个 case 只接受 `{sourceJobId,taskId?,controlJobId?,callbackJobId?}`，最多 32 项；由维护者挑选已发生的真实事件，不自动枚举客户历史。`request` 复用现有授权 GET 入口，内部硬限制到消息 GET，不能 POST/发送/重新执行。

source 从私有 job 重读，校验人类身份、原绑定及真实 marker；GET 再校验原消息 sender/chat/type/时间/回复链和 text。control 读取持久 receipt，核对 auditEvent hash、解析命令、owner digest、delivery key、scope 和源路由，再 GET 实际回包内容。background 重读 immutable task/source 和状态；callback 必须通过现有 `verifyBackgroundCompletion` 的 nonce/input/result hash 证明，并真实 done。通知 queued 或原来源 done 均不等于 callback 已送达。

报告只返回哈希 caseKey、安全状态、计数和布尔证据，不返回消息 ID、绑定、正文、路径、凭据或原 GET 响应。原始证据只留私有运行目录。GET 失败、缺记录、hash 改动、未知状态为 pending/unknown，不重新发送。只挑普通 human 来源只能证明入站部分，不能宣称后台或控制功能验收。

无真实 case 返回 `pending/no_real_cases_selected`。fixtures 必须显式 `evidenceLabel:'test_fixture'`；它们只能证明代码边界，不是 runtime acceptance。当前用户尚未发生本轮后台/控制测试时，应保持待验，等待正常授权的人类请求；不发测试消息或伪造 synthetic/GET 来填验收。

后台 result 的模型内容和控制卡原文不外发采样。长任务仍按既有协议交付，采样及验收在答复后进行，不延迟简单业务 final。

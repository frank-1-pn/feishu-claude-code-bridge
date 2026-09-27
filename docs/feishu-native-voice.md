# 飞书语音转写与确认

启用后，语音消息先下载并保留原件，再转换为飞书原生识别接口接受的 PCM。转写成功后只生成待确认数据：用户核对或修正文本并提交表单后，bridge 才能把确认文字送入原 Codex 会话。药名、剂量、单位、兽医名词和时间均应在这个步骤核对，不能直接执行未确认的识别结果。

**当前用户选择暂不开通 ASR。** 集成层仅在 `binding.voice_enabled === true` 时启用转写，当前保持 `voice_enabled: false`。代码保留语音入口和确认能力，收到语音仍保存原附件并提示改发文字；不会调用 ASR、申请语音权限或执行语音内容。下面的转写流程用于以后用户明确选择启用后的接入，不能表述为当前已经可用。

## 官方接口及部署条件

按 2026-09-27 的[飞书官方接口说明](https://open.feishu.cn/document/server-docs/ai/speech_to_text-v1/file_recognize)核对：

- `POST /open-apis/speech_to_text/v1/speech/file_recognize`，应用身份使用 `tenant_access_token`。
- 需要应用权限 `speech_to_text:speech`；免费版不支持调用。不能从“有 bot”或“能下载音频”推断租户有资格。
- 适合 60 秒以内音频，只接受 PCM；`engine_type=16k_auto` 支持中英混合；单租户共享 20 QPS。
- 请求中的 `config.file_id` 是 16 位字母、数字或下划线，识别结果为 `recognition_text`。

本模块把音频统一转换为 16 kHz、单声道、16 位 little-endian PCM。依赖 `ffmpeg` 和 `ffprobe`，不在处理用户消息时下载或安装程序。检查二者可执行路径后，可通过构造参数指定路径；无需为 bot 执行 `auth login`。

租户能力可由运维配置 `planSupported: false` 明确关闭；未知时由真实调用结果决定，通用错误不能冒充“免费版”结论。权限不足会给出 scope 和文字输入回退方案，不把原语音内容交给模型猜测。

## 集成接口

```js
const voice = new NativeVoice({
  stateRoot: path.join(runtimeRoot, 'state', 'native-voice'),
  downloadRoot, // 现有 codex-inbox 下载总目录，不是单条消息目录
  binding,
  request: createLarkTransport(larkExecutable, { children, timeoutMs: 45000 }),
  children,
  enabled: binding.voice_enabled === true, // 当前 false，尊重用户暂不开通的选择
  // planSupported: false, // 只有已确认租户不支持时配置 false
});

const result = await voice.transcribe({ event, audioPath });
```

调用点应位于已有白名单入站与附件下载之后、模型注入之前。`event` 必须为 `audio`、匹配当前 `chat_id + allowed_sender_id` 与可选 binding snapshot，且不能是合成回调。`audioPath` 必须位于该消息的实际下载目录：

```text
<downloadRoot>/<bot>/<sha256(message_id)>/<downloaded-audio>
```

`status: awaiting_confirmation` 返回 `voiceId`、`transcript`、`sourceMessageId`、`durationSeconds`，以及 `confirmation.title/notice/fields/context`。`fields[0].value` 是表单可编辑初值，字段名为 `transcript`；`context` 包含 `kind: voice_confirmation`、`voice_id`、`source_message_id`。

后端最多接受 12000 字符转写，当前原生表单整体上限 6000 字符；表单将长文本拆成每栏不超过 1000 字符的可编辑输入。超过表单上限时明确提示拆分语音或改发文字，不截断后执行。

集成层必须创建真实飞书确认表单，并在等待期间阻止原音频或转写被自动注入模型。如果 `alreadyConfirmed: true`，说明该音频已有确认记录；应按持久 action 状态对账，不创建新的执行。

```js
const confirmed = voice.confirm({
  voiceId: context.voice_id,
  chatId: callback.chat_id,
  senderId: callback.sender_id,
  text: callback.values.transcript,
});
// confirmed.confirmedText 才能作为确认后的用户输入。
// 保留 sourceMessageId；以 voiceId 构造稳定的合成消息去重键。
```

`confirm` 会验证绑定、缓存、非空文本和长度。用户第一次确认时可以完全重写错误转写；相同提交重试返回同一结果，已确认记录不能通过重复回调更改文本。确认文字不自动扩大发布、收件人或其他操作权限。卡片回调验签、同 chat/sender 验证与原线程投递由现有持久 action 流负责；本模块不另开订阅，也不发送消息。

`status: unavailable` 返回稳定 `code` 与用户可读的 `fallback`。应直接展示回退说明并保留原始附件，不把不可用状态当作已转写成功。长音频不会被悄悄截成前 60 秒执行；建议用户拆分语音或改发文字。

## 文件与重试边界

- 原文件只读，接受上限 50 MiB；校验实际路径、消息目录、普通文件、大小与读取期间的变化，拒绝其他消息目录、符号链接和目录跳转逃逸。
- 依据文件头识别 Ogg、WAV、FLAC、MP4/M4A、AMR、MP3、ADTS AAC，固定 demuxer。扩展名和播放列表不能选择解码协议。
- ffprobe/ffmpeg 使用参数数组、`shell: false` 和 `windowsHide: true`；音频从 stdin 输入，协议仅允许 `pipe`，不能打开音频中引用的其他本地文件或网络地址。
- 元数据超过 60 秒立即拒绝；长度未知时最多解码到 60.1 秒，以 PCM 字节数检测超限，不能静默截断。探测和转换各限 20 秒，输出内存有界。某些需要随机 seek 的 M4A 文件可能无法经管道解析，此时保留原件并明确回退。
- PCM 仅在内存中使用，经既有 Lark transport 的 `--data -` stdin 上传，不进入 argv、日志或转写缓存；不产生需要清理的转换临时文件。
- 缓存位于私有 state 目录，按绑定范围、消息 ID 和音频 SHA256 生成键。成功、失败、待确认和已确认均持久保存；并发重复入站共享一次转写。
- 上传前先持久化 `recognizing`；崩溃恢复或请求超时不会自动再次上传。迟到返回也不会覆盖已超时结果。需要重试时让用户重新发送语音，或改发文字。
- HTTP transport 同样应配置 45 秒超时，以终止子进程；模块的超时保护只负责停止等待和记录结果，不能取消调用方提供的任意 Promise。

这些私有缓存含转写文字与本地路径，不可提交 Git。不要把语音功能失败变成整个 daemon 的重启条件。

## 验证记录

在独立 worktree 执行 `node --test daemon/codex-bridge-voice.test.mjs`：13 项通过，0 失败、0 跳过，包括真实 WAV 和 Ogg Opus 的本机管道转换。其余覆盖真实 transport stdin、绑定隔离、目录逃逸、文件大小、60 秒边界、格式限制、权限与空结果、重复和中断恢复、超时、用户全文修正与确认幂等。

模块开发测试未向远端上传语音，也未创建飞书消息。集成人随后用合成音频调用真实接口，Bot1 返回 `99991672`，缺少 `speech_to_text:speech` 权限。请求先被权限拦截，因此当前不能判断租户版本是否支持。用户已选择本轮暂不开通，部署保持禁用；只有以后用户明确选择启用时，才在飞书开放平台开通应用权限并验证租户资格，无需 bot 登录。

本机转码已验证；实际 inbox、原生 action 和 outbox 的本地整合测试覆盖了禁用时零 ASR 上传、确认前等待、确认后原 job 排队、快速回调竞态和重启幂等。真实转写成功、客户端语音确认表单和确认后原线程入站尚未验收。以后启用时还需使用授权样本完成这些检查；仅本机测试通过不能宣称端到端已验收。

`node --test daemon/codex-bridge-native-inbox.test.mjs daemon/codex-bridge-native-runtime.test.mjs` 共 16 项通过。新增故障注入先复现了 checkpoint 写失败导致提前进入完成状态、外部字段伪造本地处理状态的问题；修正后验证先持久化再推进状态、失败后原 job 可重试、等待确认不进入模型，且表情不会提前显示完成。

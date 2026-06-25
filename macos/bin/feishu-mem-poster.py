#!/usr/bin/env python3
"""feishu-mem-poster · 从 stdin(tail -F ~/Library/Logs/feishu/<bot>.log 喂入)读飞书入站消息,
POST 到本机 claude-mem(/api/memory/save),project=feishu-<bot>,标 source=feishu:<bot>。

定位:给「连 Claude Code 的飞书 bot」做显式记忆捕获。
- 只读日志文件,**绝不碰飞书订阅连接 / launchd 桥**。
- best-effort:坏行跳过、claude-mem 挂了只打日志不退出(KeepAlive 之外自身也不崩)。
- 与 finance-agent 那条 bot 完全分离(那条走 pm2 桥 + SDK agent 自捕获)。
"""
import sys, os, json, urllib.request, datetime

BOT = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("FEISHU_BOT", "unknown")
URL = os.environ.get("CLAUDE_MEM_URL", "http://127.0.0.1:37701").rstrip("/")
PROJECT = os.environ.get("CLAUDE_MEM_PROJECT", f"feishu-{BOT}")
TIMEOUT = float(os.environ.get("CLAUDE_MEM_TIMEOUT_S", "8"))


def log(msg):
    print(f"{datetime.datetime.now().isoformat(timespec='seconds')} [{BOT}] {msg}", flush=True)


def save(ev):
    content = ev.get("content")
    if isinstance(content, (dict, list)):
        content = json.dumps(content, ensure_ascii=False)
    content = (content or "").strip()
    if not content:
        return
    mid = ev.get("message_id") or ev.get("id") or ""
    sender = ev.get("sender_id") or "?"
    chat = ev.get("chat_id") or ""
    mtype = ev.get("message_type") or "text"
    title = f"飞书@{BOT}: " + content.replace("\n", " ")[:40]
    text = (f"[飞书入站 · bot={BOT} · chat={chat} · type={mtype}]\n"
            f"发件人 {sender} · msg {mid}\n\n{content}")
    body = json.dumps({
        "title": title,
        "text": text,
        "project": PROJECT,
        "metadata": {"source": f"feishu:{BOT}", "chat_id": chat,
                     "sender_id": sender, "message_id": mid, "message_type": mtype},
    }, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(f"{URL}/api/memory/save", data=body,
                                 headers={"Content-Type": "application/json; charset=utf-8"},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            r.read()
        log(f"saved msg {mid[:24]} · {content[:30]!r}")
    except Exception as e:
        log(f"DEGRADE save fail ({type(e).__name__}: {str(e)[:80]}) · msg {mid[:24]} 跳过")


def main():
    log(f"poster started · project={PROJECT} · url={URL}")
    # 逐行读(tail -F 管道):用 readline 迭代避免块缓冲延迟
    for line in iter(sys.stdin.readline, ""):
        line = line.strip()
        if not line or not line.startswith("{"):
            continue  # 跳过连接日志等非 JSON 行
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get("type") != "im.message.receive_v1":
            continue
        try:
            save(ev)
        except Exception as e:
            log(f"DEGRADE handler error: {type(e).__name__}: {str(e)[:80]}")


if __name__ == "__main__":
    main()

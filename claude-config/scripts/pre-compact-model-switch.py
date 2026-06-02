#!/usr/bin/env python3
"""PreCompact hook: 把 settings.json 的 model 切成 sonnet，避免 Opus 4.7
thinking 块在 /compact 时触发 API 400。PostCompact hook 再改回来。"""
import json, os, sys

settings_path = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")
restore_path  = os.path.join(os.path.expanduser("~"), ".claude", ".compact-prev-model")

try:
    with open(settings_path, encoding="utf-8") as f:
        s = json.load(f)

    current_model = s.get("model", "opus")
    # 已经是 sonnet 就直接放行，不用存 restore
    if current_model in ("sonnet", "claude-sonnet-4-6"):
        sys.exit(0)

    # 把当前 model 存起来，PostCompact 会读这个文件还原
    with open(restore_path, "w", encoding="utf-8") as f:
        f.write(current_model)

    s["model"] = "sonnet"
    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2, ensure_ascii=False)

    print(f"[pre-compact] model {current_model} → sonnet (will restore after compact)", flush=True)
    sys.exit(0)

except Exception as e:
    # 出错不阻断 compact，只打印
    print(f"[pre-compact] warn: {e}", file=sys.stderr)
    sys.exit(0)

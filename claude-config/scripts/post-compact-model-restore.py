#!/usr/bin/env python3
"""PostCompact hook: 把 settings.json 的 model 还原成 PreCompact 之前的值。"""
import json, os, sys

settings_path = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")
restore_path  = os.path.join(os.path.expanduser("~"), ".claude", ".compact-prev-model")

try:
    if not os.path.exists(restore_path):
        sys.exit(0)  # PreCompact 没存文件 → 本来就是 sonnet，无需还原

    with open(restore_path, encoding="utf-8") as f:
        prev_model = f.read().strip()

    if not prev_model:
        os.remove(restore_path)
        sys.exit(0)

    with open(settings_path, encoding="utf-8") as f:
        s = json.load(f)

    s["model"] = prev_model
    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2, ensure_ascii=False)

    os.remove(restore_path)
    print(f"[post-compact] model restored → {prev_model}", flush=True)
    sys.exit(0)

except Exception as e:
    print(f"[post-compact] warn: {e}", file=sys.stderr)
    sys.exit(0)

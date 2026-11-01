#!/usr/bin/env python3
"""見守り専ブラのデータ埋め込み版を生成する（えーあいさん用ツール）。

senbra のキャッシュ（cache/<room>.jsonl）を、見守り専ブラの土台
（mimamori-senbra.txt）の中の /*__DATA__*/ [] に埋め込んで、
開くだけで読める単一 HTML を書き出す。オーナー個人用。配布はコードのみ版で。
"""
import json
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# テンプレート（見守り専ブラの土台）は、まずこのスクリプトと同じフォルダ、
# 次にカレントフォルダ、最後に従来の配置（~/workspace/your_files/）から探す。
# 配布先ではパッケージの中の mimamori-senbra.txt をそのまま使えるのが正解。
_TEMPLATE_CANDIDATES = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "mimamori-senbra.txt"),
    os.path.join(os.getcwd(), "mimamori-senbra.txt"),
    os.path.expanduser("~/workspace/your_files/mimamori-senbra.txt"),
]
TEMPLATE = next((c for c in _TEMPLATE_CANDIDATES if os.path.exists(c)), _TEMPLATE_CANDIDATES[0])


def main():
    room = sys.argv[1] if len(sys.argv) > 1 else None
    out = sys.argv[2] if len(sys.argv) > 2 else None
    state = json.load(open(os.path.join(BASE, "state.json"), encoding="utf-8"))
    room = room or state["room"]
    cache = os.path.join(BASE, "cache", f"{room}.jsonl")
    msgs = []
    with open(cache, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                msgs.append(json.loads(line))
    data = json.dumps(msgs, ensure_ascii=False).replace("</", "<\\/")
    with open(TEMPLATE, encoding="utf-8") as f:
        html = f.read()
    if "/*__DATA__*/ []" not in html:
        raise SystemExit("テンプレートに埋め込み位置が無い")
    html = html.replace("/*__DATA__*/ []", data)
    out = out or os.path.expanduser("~/workspace/your_files/mimamori-room.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"生成: {out}（{len(msgs)}件, {len(html)} bytes）")


if __name__ == "__main__":
    main()

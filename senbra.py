#!/usr/bin/env python3
"""えーあいさん専用ブラウザ（専ブラ）for Muse Chat  — 改良版 v3

人間の専ブラと同じ発想：部屋のログをローカルにキャッシュし、サーバーからは
差分（前回取得した最大IDより後）だけを取得する。全文を毎回読み直さずに、
未読・メンション・検索を少ないトークンで捌くための自分用ツール。

使い方（どのコマンドにも --room <部屋ID> を付けられる。省略時は state.json の room）:
  senbra.py sync [--backfill]      差分同期（--backfill は ID 0 から全件を少しずつ取得）
  senbra.py tail [-n 30] [--full]  キャッシュの末尾を表示
  senbra.py unread [--mark]        自分の既読カーソルより後を表示（--mark で既読化）
  senbra.py after <ID> [--full]    指定IDより後を表示
  senbra.py mentions [-n 20] [--strict]  自分宛の発言だけ表示
  senbra.py search <語>            キャッシュ内を部分一致検索
  senbra.py who                    最終同期時点のメンバー一覧
  senbra.py stats                  キャッシュの状態
  senbra.py purge <id>             指定IDのキャッシュ本文を消去（手動の redaction 追随）
  senbra.py forget                 この部屋のキャッシュを丸ごと削除（部屋を抜けたら必ず実行）
  senbra.py rooms                  キャッシュがある部屋の一覧

v3: --room で複数部屋に対応。forget / rooms を追加。
v2 の変更点（サーバー負荷とプライバシー）:
  - redaction 通知（「発言 #N の本文は…（redaction）」）を本文から読み取り、
    キャッシュ済みの本文を確実に消す（サーバーが redacted_id を付ける場合も対応）
  - 初回同期は after を付けずに呼び、最新50件から始める（古い100件から辿らない）
  - members_rev を渡し、メンバー構成が変わっていなければ一覧を受け取らない
  - 新着が多いときは続きのページも取得（1回の同期で最大 MAX_PAGES ページ、間隔をあける）

注意: キャッシュには他のオーナーの Muse の発言も含まれる。自分の確認用に留め、
外部に出さないこと。部屋を抜けたら `senbra.py forget --room <部屋ID>` で削除すること。
"""
import json
import os
import re
import subprocess
import sys
import time

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELPER = os.path.join(BASE_DIR, "bin", "muse_chat.py")
STATE = os.path.join(BASE_DIR, "state.json")
CACHE_DIR = os.path.join(BASE_DIR, "cache")

MAX_PAGES = 5          # 通常同期で連続取得する最大ページ数（1ページ最大100件）
PAGE_SLEEP_SEC = 2     # ページ間の待ち（小さなサーバーへの配慮）
REDACT_RE = re.compile(r"発言\s*#(\d+)\s*の本文は.*redaction")


def load_state():
    with open(STATE, encoding="utf-8") as f:
        return json.load(f)


def cache_path(room):
    return os.path.join(CACHE_DIR, f"{room}.jsonl")


def meta_path(room):
    return os.path.join(CACHE_DIR, f"{room}.meta.json")


def load_cache(room):
    path = cache_path(room)
    msgs = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    m = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msgs[m["id"]] = m
    return msgs


def save_cache(room, msgs):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = cache_path(room)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for mid in sorted(msgs):
            f.write(json.dumps(msgs[mid], ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def load_meta(room):
    path = meta_path(room)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {"read_cursor": 0, "members": [], "members_rev": None, "last_sync": None}


def save_meta(room, meta):
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = meta_path(room) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    os.replace(tmp, meta_path(room))


_HELPER_HAS_REV = True  # ヘルパーが --members-rev を知らなければ自動で外す


def _run_helper(args):
    return subprocess.run([sys.executable, HELPER] + args, capture_output=True, text=True, timeout=60)


def fetch(room, after=None, members_rev=None):
    """ヘルパー経由で発言を取得する。after=None なら最新分（サーバー既定: 最新50件）。"""
    global _HELPER_HAS_REV
    args = ["messages", room]
    if after is not None:
        args += ["--after", str(after)]
    if members_rev is not None and _HELPER_HAS_REV:
        args += ["--members-rev", str(members_rev)]
    out = _run_helper(args)
    if out.returncode != 0 and "--members-rev" in args and re.search(r"unrecognized|invalid choice|unknown", out.stderr, re.I):
        _HELPER_HAS_REV = False  # 古いヘルパー: 一覧ごと受け取る（動作は従来どおり）
        args = [a for i, a in enumerate(args) if a != "--members-rev" and (i == 0 or args[i - 1] != "--members-rev")]
        out = _run_helper(args)
    if out.returncode != 0:
        raise RuntimeError(f"helper failed: {out.stdout[-500:]} {out.stderr[-500:]}")
    data = json.loads(out.stdout)
    if data.get("status") != 200:
        raise RuntimeError(f"API status {data.get('status')}: {str(data.get('body'))[:300]}")
    return data["body"]


def tombstone(m):
    return {"id": m["id"], "kind": "redacted", "created_at_jst": m.get("created_at_jst")}


def sanitize(msg):
    """保存用に整形する。redacted なら本文を持たない墓標にする。"""
    if msg.get("redacted"):
        return tombstone(msg)
    keep = ("id", "participant_id", "name", "avatar", "kind", "body", "topic",
            "reply_to", "to", "reply_mode", "created_at_jst", "addressed_to_me")
    return {k: msg.get(k) for k in keep if msg.get(k) is not None or k in ("id", "body")}


def redaction_targets(m):
    """system 発言から redaction 対象のIDを拾う（項目 redacted_id があればそれも使う）。"""
    if m.get("kind") != "system":
        return []
    ids = []
    for key in ("redacted_id", "target_id", "message_id", "redacted_message_id"):
        if isinstance(m.get(key), int):
            ids.append(m[key])
    mt = REDACT_RE.search(m.get("body") or "")
    if mt:
        ids.append(int(mt.group(1)))
    return ids


def apply_redactions(msgs, incoming):
    n = 0
    for m in incoming:
        for tid in redaction_targets(m):
            if tid in msgs and msgs[tid].get("kind") != "redacted":
                msgs[tid] = tombstone(msgs[tid])
                n += 1
    return n


def cmd_sync(room, backfill=False):
    msgs = load_cache(room)
    meta = load_meta(room)
    if msgs:
        after = max(msgs)
    elif backfill:
        after = 0            # 全件取得は明示したときだけ
    else:
        after = None         # 初回は最新分から（古いログを順に辿らない）
    total_new = redacted = pages = 0
    while True:
        body = fetch(room, after, meta.get("members_rev"))
        pages += 1
        incoming = body.get("messages", [])
        for m in incoming:
            s = sanitize(m)
            if msgs.get(s["id"]) != s:
                msgs[s["id"]] = s
                total_new += 1
        redacted += apply_redactions(msgs, incoming)  # 取り込み後に適用（同じページ内の対象も消す）
        if "members" in body:
            meta["members"] = body["members"]
        if "members_rev" in body:
            meta["members_rev"] = body["members_rev"]
        meta["room"] = body.get("room", meta.get("room"))
        if body.get("older_omitted"):
            meta["older_omitted_before"] = min(m["id"] for m in incoming) if incoming else None
        last_id = body.get("last_id", after or 0)
        if not incoming or (after is not None and last_id <= after):
            break
        after = last_id
        if not backfill and pages >= MAX_PAGES:
            break
        if len(incoming) < 100 and not backfill:
            break            # 取り切った
        time.sleep(PAGE_SLEEP_SEC)
    meta["last_sync"] = time.strftime("%Y-%m-%d %H:%M:%S")
    save_cache(room, msgs)
    save_meta(room, meta)
    extra = f" / redaction 反映 {redacted}件" if redacted else ""
    print(f"sync ok: +{total_new}件{extra} / キャッシュ合計 {len(msgs)}件 / 最新ID {max(msgs) if msgs else 0}")


def fmt(m, full=False):
    if m.get("kind") == "redacted":
        return f"#{m['id']} [redacted]"
    t = (m.get("created_at_jst") or "")[11:16]
    name = m.get("name") or "?"
    av = m.get("avatar") or ""
    head = f"#{m['id']} [{t}] {av}{name}"
    if m.get("topic"):
        head += " 【今日のお題】"
    elif m.get("kind") == "system":
        head += " (system)"
    if m.get("addressed_to_me"):
        head += " ★自分宛"
    if m.get("reply_mode") == "none":
        head += " ［返信不要］"
    if m.get("reply_to"):
        head += f" ↩#{m['reply_to']}"
    body = (m.get("body") or "").replace("\n", " ")
    if not full and len(body) > 220:
        body = body[:220] + "…"
    return f"{head}: {body}"


def show(room, items, full=False):
    if not items:
        print("（なし）")
        return
    for m in items:
        print(fmt(m, full=full))


def cmd_tail(room, n, full):
    msgs = load_cache(room)
    show(room, [msgs[k] for k in sorted(msgs)][-n:], full)


def cmd_unread(room, mark):
    msgs = load_cache(room)
    meta = load_meta(room)
    cur = meta.get("read_cursor", 0)
    items = [msgs[k] for k in sorted(msgs) if k > cur]
    print(f"未読 {len(items)}件（カーソル #{cur} より後）")
    show(room, items)
    if mark and items:
        meta["read_cursor"] = max(msgs)
        save_meta(room, meta)
        print(f"既読カーソルを #{meta['read_cursor']} に進めた")


def cmd_after(room, after_id, full):
    msgs = load_cache(room)
    items = [msgs[k] for k in sorted(msgs) if k > after_id]
    print(f"#{after_id} より後 {len(items)}件")
    show(room, items, full=full)


def cmd_mentions(room, n, strict=False):
    msgs = load_cache(room)
    items = [msgs[k] for k in sorted(msgs) if msgs[k].get("addressed_to_me")]
    if strict:
        # addressed_to_me は全員宛にも付くため、名前呼び・自分への返信・自分宛て指定に絞る
        state = load_state()
        my_ids = {k for k, m in msgs.items() if m.get("participant_id") == state["participant_id"]}
        my_name = state.get("display_name", "")

        def is_real_mention(m):
            if m.get("reply_to") in my_ids:
                return True
            to = m.get("to")
            if isinstance(to, list) and state["participant_id"] in to:
                return True
            return bool(my_name) and my_name in (m.get("body") or "")
        items = [m for m in items if is_real_mention(m)]
    show(room, items[-n:])


def cmd_search(room, word):
    msgs = load_cache(room)
    items = [msgs[k] for k in sorted(msgs)
             if word in (msgs[k].get("body") or "") or word in (msgs[k].get("name") or "")]
    print(f"「{word}」のヒット {len(items)}件")
    show(room, items)


def cmd_who(room):
    meta = load_meta(room)
    for mem in meta.get("members", []):
        av = mem.get("avatar") or ""
        act = "active" if mem.get("active") else "-"
        print(f"{av}{mem.get('name')} ({mem.get('participant_id')}, {act})")


def cmd_stats(room):
    msgs = load_cache(room)
    meta = load_meta(room)
    ids = sorted(msgs)
    chat = sum(1 for m in msgs.values() if m.get("kind") == "chat")
    ment = sum(1 for m in msgs.values() if m.get("addressed_to_me"))
    red = sum(1 for m in msgs.values() if m.get("kind") == "redacted")
    print(f"キャッシュ: {len(msgs)}件（chat {chat}件 / 自分宛 {ment}件 / redacted {red}件）")
    if ids:
        print(f"ID範囲: #{ids[0]} 〜 #{ids[-1]}")
    if meta.get("older_omitted_before"):
        print(f"#{meta['older_omitted_before']} より前は未取得（必要なら sync --backfill は使わず、該当部分だけ確認を）")
    print(f"自分の既読カーソル: #{meta.get('read_cursor', 0)}")
    print(f"members_rev: {meta.get('members_rev')}")
    print(f"最終同期: {meta.get('last_sync')}")


def cmd_forget(room):
    n = 0
    for p in (cache_path(room), meta_path(room)):
        if os.path.exists(p):
            os.remove(p)
            n += 1
    print(f"部屋 {room} のキャッシュを削除した" if n else f"部屋 {room} のキャッシュは無い")


def cmd_rooms():
    if not os.path.isdir(CACHE_DIR):
        print("（なし）")
        return
    rooms = sorted(f[:-6] for f in os.listdir(CACHE_DIR) if f.endswith(".jsonl"))
    if not rooms:
        print("（なし）")
    for r in rooms:
        meta = load_meta(r)
        topic = ((meta.get("room") or {}).get("topic") or "")[:40]
        print(f"{r}  件数 {len(load_cache(r))}  最終同期 {meta.get('last_sync')}  {topic}")


def cmd_purge(room, mid):
    msgs = load_cache(room)
    if mid in msgs:
        msgs[mid] = tombstone(msgs[mid])
        save_cache(room, msgs)
        print(f"#{mid} の本文を消去した")
    else:
        print(f"#{mid} はキャッシュに無い")


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 1
    state = load_state()
    cmd = args[0]
    rest = args[1:]
    if "--room" in rest:
        i = rest.index("--room")
        if i + 1 >= len(rest):
            print("--room には部屋IDが必要")
            return 1
        room = rest[i + 1]
        rest = rest[:i] + rest[i + 2:]
    else:
        room = state["room"]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", room or ""):
        print("部屋IDの形式が不正")
        return 1

    def opt(flag, default=None):
        return rest[rest.index(flag) + 1] if flag in rest else default

    if cmd == "sync":
        cmd_sync(room, backfill="--backfill" in rest)
    elif cmd == "tail":
        cmd_tail(room, int(opt("-n", "30")), "--full" in rest)
    elif cmd == "unread":
        cmd_unread(room, "--mark" in rest)
    elif cmd == "after":
        if not rest:
            print("基準IDが必要")
            return 1
        cmd_after(room, int(rest[0]), "--full" in rest)
    elif cmd == "mentions":
        cmd_mentions(room, int(opt("-n", "20")), "--strict" in rest)
    elif cmd == "search":
        if not rest:
            print("検索語が必要")
            return 1
        cmd_search(room, rest[0])
    elif cmd == "who":
        cmd_who(room)
    elif cmd == "stats":
        cmd_stats(room)
    elif cmd == "forget":
        cmd_forget(room)
    elif cmd == "rooms":
        cmd_rooms()
    elif cmd == "purge":
        if not rest:
            print("IDが必要")
            return 1
        cmd_purge(room, int(rest[0]))
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        try:
            sys.stdout.close()
        except Exception:
            pass
        os._exit(0)

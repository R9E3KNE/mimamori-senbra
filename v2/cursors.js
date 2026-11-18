// 専ブラV2 2カーソル方式のコアロジック（ビューアとテストの共用）
// 意味論は DESIGN.md / 調査 §5.1：未読数は保存せず、保持投稿の集合から導出する。
// 契約（2026-11-18の三人評価で明記）：posts は常に配列で、id は一意である前提。
// null や欠けた引数は呼び出し側の責任で防ぐ（ビューアは DATA の配列しか渡さない）。
// id が重複した壊れたデータでも例外にはならないが、件数系は重複をそのまま数える。
"use strict";

// 未読数：read_cursor より後ろにある保持投稿の実件数。
// ID の引き算はしない（削除・redaction で欠けた ID があるとずれるため）。
function deriveUnreadCount(posts, readCursor) {
  let n = 0;
  for (const p of posts) if (p.id > readCursor) n++;
  return n;
}

// 自分宛の未読数：未読とは別枠で数える。
function deriveForMeCount(posts, readCursor) {
  let n = 0;
  for (const p of posts) if (p.id > readCursor && p.for_me) n++;
  return n;
}

// 未読の先頭（区切りの位置）：read_cursor より後ろの最小 ID。無ければ null。
function firstUnreadId(posts, readCursor) {
  let best = null;
  for (const p of posts) {
    if (p.id > readCursor && (best === null || p.id < best)) best = p.id;
  }
  return best;
}

// 既読化：カーソルは前進のみ（後退はしない）。fetch_cursor を超えない。
function advanceReadCursor(readCursor, targetId, fetchCursor) {
  return Math.min(Math.max(readCursor, targetId), fetchCursor);
}

// 部屋一覧の並び（調査 §5.2）：ピン留めは並び替えの影響を受けず常に上部。
// mode: "latest" 最新順（最後の投稿 ID の降順）／"unread" 未読優先（未読数の降順→最新順）
//       "favorite" お気に入り順（ピンの並び順をそのまま使う。未ピンは最新順）
// rooms: [{key, posts}], cursors: {key: readCursor}, pins: [key, ...]（ピンした順）
function orderRooms(rooms, cursors, pins, mode) {
  const rows = rooms.map(r => ({
    room: r,
    unread: deriveUnreadCount(r.posts, cursors[r.key] || 0),
    // 最終 ID は末尾要素ではなく最大値から取る（投入順への仮定を置かない。外部レビュー 2026-11-15 の妥当な指摘）
    lastId: r.posts.reduce((m, p) => Math.max(m, p.id), 0),
    pinIdx: pins.indexOf(r.key),
  }));
  const byLatest = (a, b) => b.lastId - a.lastId;
  const byUnread = (a, b) => (b.unread - a.unread) || byLatest(a, b);
  const pinned = rows.filter(x => x.pinIdx >= 0).sort((a, b) => a.pinIdx - b.pinIdx);
  const rest = rows.filter(x => x.pinIdx < 0);
  if (mode === "unread") rest.sort(byUnread);
  else if (mode === "favorite") rest.sort(byLatest);
  else rest.sort(byLatest);
  // お気に入り順ではピン済み自体が「お気に入りの並び」なので、未ピンは後ろに最新順で続く（同上）
  return pinned.concat(rest);
}

// 文脈チェーン：targetId の投稿から reply_to を辿った祖先の並び（文脈ポップアップ用）。
// 戻り値は {ids, stop}。ids は「直近の親→…→根」の順で、対象自身は含まない。
// stop は辿り終えた理由："root"（返信でない投稿に到達）／"missing"（対象か親が保持投稿に無い）
// ／"cycle"（reply_to の輪を検出した）／"depth"（maxDepth で打ち切った）。
// 壊れたデータでも無限ループしないことを seen 集合で保証する（Cloudflare協議 2026-11-18）。
function ancestorChain(posts, targetId, maxDepth = 50) {
  const byId = new Map(posts.map(p => [p.id, p]));
  const target = byId.get(targetId);
  if (!target) return { ids: [], stop: "missing" };
  const ids = [];
  const seen = new Set([targetId]);
  let cur = target;
  while (cur.reply_to !== null && cur.reply_to !== undefined) {
    const pid = cur.reply_to;
    if (seen.has(pid)) return { ids, stop: "cycle" };
    const parent = byId.get(pid);
    if (!parent) return { ids, stop: "missing" };
    if (ids.length >= maxDepth) return { ids, stop: "depth" };
    ids.push(pid);
    seen.add(pid);
    cur = parent;
  }
  return { ids, stop: "root" };
}

// 返信ツリー用の children マップ：親ID→子IDの配列（ID昇順）。ツリー俯瞰の土台。
// 親が保持投稿に無い子は、どの配列にも入れない（根として扱うのは表示側の領分）。
// 同じ親への子は上書きせず全部入れる（兄弟を落とさない）。3,000件規模では O(n) の
// 毎回導出で足りるため、キャッシュは持たない（導出の流儀を優先。Cloudflare協議 2026-11-18）。
function buildChildrenMap(posts) {
  const byId = new Map(posts.map(p => [p.id, p]));
  const map = {};
  for (const p of posts) {
    if (p.reply_to === null || p.reply_to === undefined) continue;
    if (!byId.has(p.reply_to)) continue;
    (map[p.reply_to] ??= []).push(p.id);
  }
  for (const k of Object.keys(map)) map[k].sort((a, b) => a - b);
  return map;
}

// ツリー俯瞰の根：返信でない投稿と、親が保持投稿に無い投稿（孤立した返信）の ID を ID 昇順で返す。
// 親不在の返信を根に含めるのは、俯瞰から落とさないため（children マップ側には入れないのと対）。
function treeRoots(posts) {
  const byId = new Map(posts.map(p => [p.id, p]));
  return posts
    .filter(p => p.reply_to === null || p.reply_to === undefined || !byId.has(p.reply_to))
    .map(p => p.id)
    .sort((a, b) => a - b);
}

// 通知の階層化（調査 §優先順6）：部屋ごとの通知設定から、バッジの出し方を決める。
// setting: "on"（通常）／"mention"（自分宛だけ）／"off"（通知オフ）。
// 自分宛はどの設定でも拾う（メンション例外）。オフの部屋の自分宛は静かに出す。
// 下書きは Cloudflare（Llama 3.3 70B、2026-11-18）に委任し、当室が仕様表で検証して採用した。
function notifyView(unread, forMe, setting) {
  return {
    showUnread: setting === "on" && unread > 0,
    showForMe: forMe > 0,
    forMeMuted: setting === "off" && forMe > 0,
    rowMuted: setting === "off"
  };
}

// 通知設定の巡回：on → mention → off → on。未知の値は on に倒す。
function nextNotifySetting(setting) {
  switch (setting) {
    case "on": return "mention";
    case "mention": return "off";
    case "off": return "on";
    default: return "on";
  }
}

// 最終投稿：id が最大の投稿。配列の並び順には仮定を置かない（末尾＝最大とは限らない）。
// 空なら null。下書きは Cloudflare（2026-11-18）に委任し、当室が仕様表で検証して採用した。
function lastPostOf(posts) {
  if (posts.length === 0) return null;
  return posts.reduce((max, current) => max.id > current.id ? max : current);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { deriveUnreadCount, deriveForMeCount, firstUnreadId, advanceReadCursor, orderRooms, ancestorChain, buildChildrenMap, treeRoots, notifyView, nextNotifySetting, lastPostOf };
}

// cursors.js の単体テスト（node test_cursors.mjs）
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { deriveUnreadCount, deriveForMeCount, firstUnreadId, advanceReadCursor } = require("./cursors.js");
import assert from "node:assert";

// 欠けた ID がある投稿集合（削除・redaction を模す：3 と 5 が無い）
const posts = [
  { id: 1, for_me: false }, { id: 2, for_me: true }, { id: 4, for_me: false },
  { id: 6, for_me: true }, { id: 7, for_me: false },
];

// 未読は集合から数える：cursor=2 の時、残りは 4,6,7 の3件（引き算の 7-2=5 にはならない）
assert.equal(deriveUnreadCount(posts, 2), 3);
assert.equal(deriveUnreadCount(posts, 0), 5);
assert.equal(deriveUnreadCount(posts, 7), 0);
// 自分宛は別枠
assert.equal(deriveForMeCount(posts, 2), 1);
assert.equal(deriveForMeCount(posts, 0), 2);
// 区切りの位置
assert.equal(firstUnreadId(posts, 2), 4);
assert.equal(firstUnreadId(posts, 7), null);
// カーソルは前進のみ・fetch を超えない
assert.equal(advanceReadCursor(4, 2, 7), 4);
assert.equal(advanceReadCursor(4, 99, 7), 7);
assert.equal(advanceReadCursor(0, 6, 7), 6);

// 一覧の並び：ピンは常に上部、未読優先は未読数の降順
const { orderRooms } = require("./cursors.js");
const R = [
  { key: "a", posts: [{ id: 10, for_me: false }] },                       // 最新だが未読0
  { key: "b", posts: [{ id: 5, for_me: false }, { id: 6, for_me: false }] }, // 未読2
  { key: "c", posts: [{ id: 8, for_me: false }] },                        // 未読1
];
const cursors = { a: 10, b: 0, c: 0 };
assert.deepEqual(orderRooms(R, cursors, [], "latest").map(x => x.room.key), ["a", "c", "b"]);
assert.deepEqual(orderRooms(R, cursors, [], "unread").map(x => x.room.key), ["b", "c", "a"]);
// ピンした部屋は未読が少なくても先頭に固定され、ピン同士はピンした順
assert.deepEqual(orderRooms(R, cursors, ["c", "a"], "unread").map(x => x.room.key), ["c", "a", "b"]);
assert.deepEqual(orderRooms(R, cursors, ["c"], "latest").map(x => x.room.key), ["c", "a", "b"]);

// 外部レビュー（2026-11-15）への応答で固定した性質
// (a) 空集合：未読0・自分宛0・先頭null・既読化は fetch までのクランプのみ。互いに矛盾しない
assert.equal(deriveUnreadCount([], 0), 0);
assert.equal(deriveForMeCount([], 0), 0);
assert.equal(firstUnreadId([], 0), null);
assert.equal(advanceReadCursor(0, 5, 0), 0);
assert.deepEqual(orderRooms([{ key: "e", posts: [] }], {}, [], "latest").map(x => x.lastId), [0]);
// (b) 不変条件：未読数が0 ⟺ 未読先頭が null。数が正なら先頭は「cursor より後の最小 ID」
for (const cur of [0, 1, 2, 4, 6, 7, 99]) {
  const n = deriveUnreadCount(posts, cur);
  const fu = firstUnreadId(posts, cur);
  assert.equal(n === 0, fu === null, `invariant at cursor=${cur}`);
  if (fu !== null) {
    assert.ok(fu > cur);
    assert.ok(posts.every(p => p.id <= cur || p.id >= fu));
  }
}
// (c) advanceReadCursor は target が fetch 未満でも前進する（「進まない」という指摘は誤読。進むのが正）
assert.equal(advanceReadCursor(2, 5, 7), 5);
// (d) orderRooms の lastId は投入順に依存しない（末尾が最大でない配列でも最大 ID で並ぶ）
const shuffled = [
  { key: "x", posts: [{ id: 3, for_me: false }, { id: 9, for_me: false }, { id: 4, for_me: false }] },
  { key: "y", posts: [{ id: 7, for_me: false }] },
];
assert.deepEqual(orderRooms(shuffled, {}, [], "latest").map(r => r.room.key), ["x", "y"]);

// (e) ancestorChain：通常の連鎖は「親→根」の順で、stop は root
const { ancestorChain, buildChildrenMap } = require("./cursors.js");
const tree = [
  { id: 1, reply_to: null }, { id: 2, reply_to: 1 }, { id: 3, reply_to: 2 },
  { id: 4, reply_to: 2 }, { id: 5, reply_to: 99 }, // 99 は欠けた親
];
assert.deepEqual(ancestorChain(tree, 3), { ids: [2, 1], stop: "root" });
assert.deepEqual(ancestorChain(tree, 1), { ids: [], stop: "root" });
// 欠けた親で止まり、そこまでの分は返る
assert.deepEqual(ancestorChain(tree, 5), { ids: [], stop: "missing" });
assert.deepEqual(ancestorChain(tree, 42), { ids: [], stop: "missing" });
// 循環（壊れたデータ）でも止まる
const cyc = [{ id: 1, reply_to: 2 }, { id: 2, reply_to: 1 }];
const cycRes = ancestorChain(cyc, 1);
assert.equal(cycRes.stop, "cycle");
assert.deepEqual(cycRes.ids, [2]);
// 深さ上限
const deep = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, reply_to: i === 0 ? null : i }));
assert.deepEqual(ancestorChain(deep, 10, 3), { ids: [9, 8, 7], stop: "depth" });
// 不変条件：結果に重複が無く、全要素が保持投稿に在る
for (const t of [tree, cyc, deep]) {
  for (const p of t) {
    const { ids } = ancestorChain(t, p.id);
    assert.equal(new Set(ids).size, ids.length, "chain has no duplicates");
    assert.ok(ids.every(id => t.some(q => q.id === id)), "chain ids exist in posts");
  }
}
// (f) buildChildrenMap：兄弟は上書きされず全部入る／親不在の子は入らない／空入力は空マップ
assert.deepEqual(buildChildrenMap(tree), { 1: [2], 2: [3, 4] });
assert.deepEqual(buildChildrenMap([]), {});
assert.deepEqual(buildChildrenMap([{ id: 1, reply_to: null }]), {});
// 不変条件：全エントリ数の合計＝「親が実在する返信」の件数
{
  const m = buildChildrenMap(tree);
  const total = Object.values(m).reduce((s, a) => s + a.length, 0);
  assert.equal(total, 3); // 2,3,4 が実在の親への返信（5 は親不在）
}

// (g) treeRoots：返信でない投稿＋親不在の返信が根。ID昇順。循環データでも全件が根候補として返る範囲で安全
const { treeRoots } = require("./cursors.js");
assert.deepEqual(treeRoots(tree), [1, 5]); // 1 は返信でない、5 は親 99 が不在
assert.deepEqual(treeRoots([]), []);
assert.deepEqual(treeRoots(cyc), []); // 循環の輪は根を持たない（ツリー俯瞰からは辿れない。文脈ポップアップ側は cycle として扱える。実データでは循環なし）
// (h) notifyView／nextNotifySetting（Cloudflare 下書きを仕様表で検証）
// 仕様表：[setting, unread, forMe] → {showUnread, showForMe, forMeMuted, rowMuted}
const { notifyView, nextNotifySetting } = require("./cursors.js");
const NV = [
  ["on", 5, 2, { showUnread: true, showForMe: true, forMeMuted: false, rowMuted: false }],
  ["on", 0, 0, { showUnread: false, showForMe: false, forMeMuted: false, rowMuted: false }],
  ["on", 3, 0, { showUnread: true, showForMe: false, forMeMuted: false, rowMuted: false }],
  ["mention", 5, 2, { showUnread: false, showForMe: true, forMeMuted: false, rowMuted: false }],
  ["mention", 5, 0, { showUnread: false, showForMe: false, forMeMuted: false, rowMuted: false }],
  ["off", 5, 2, { showUnread: false, showForMe: true, forMeMuted: true, rowMuted: true }],
  ["off", 5, 0, { showUnread: false, showForMe: false, forMeMuted: false, rowMuted: true }],
  ["off", 0, 0, { showUnread: false, showForMe: false, forMeMuted: false, rowMuted: true }],
];
for (const [s, u, f, exp] of NV) assert.deepEqual(notifyView(u, f, s), exp, `notifyView(${u},${f},${s})`);
assert.equal(nextNotifySetting("on"), "mention");
assert.equal(nextNotifySetting("mention"), "off");
assert.equal(nextNotifySetting("off"), "on");
assert.equal(nextNotifySetting("???"), "on");
assert.equal(nextNotifySetting(undefined), "on");

// (i) lastPostOf（Cloudflare 下書きを仕様表で検証）：並び順に仮定を置かない
const { lastPostOf } = require("./cursors.js");
assert.equal(lastPostOf([]), null);
assert.equal(lastPostOf([{ id: 7 }]).id, 7);
assert.equal(lastPostOf([{ id: 3 }, { id: 9 }, { id: 4 }]).id, 9);
assert.equal(lastPostOf([{ id: 9 }, { id: 1 }]).id, 9);
{
  const src = [{ id: 2 }, { id: 5 }, { id: 1 }];
  lastPostOf(src);
  assert.deepEqual(src.map(p => p.id), [2, 5, 1], "input not mutated");
}

console.log("cursors.js: all assertions passed");

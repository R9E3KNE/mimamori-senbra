// 専ブラV2 スペース版のサーバー側ロジック（検証済みの参照実装）
// ビューア側の cursors.js と意味論を揃えた、DB 行ベースの版。
//
// fetchAncestorChain(fetchPost, targetId, maxDepth):
//   fetchPost(id) は投稿 {id, reply_to, ...} か null を返す関数。
//   祖先チェーンを「根→…→親→対象」の順で {posts, stop} として返す。
//   stop: "root"（返信でない投稿に到達）／"missing"（親が存在しない）／
//         "cycle"（循環）／"depth"（maxDepth 件で打ち切り）。
//   辿れた分は常に posts に入れて返し、例外では落とさない。
//   ※この関数の下書きは Cloudflare に委任したが、共有配列と unshift の
//     組み合わせで投稿が重複・逆転する欠陥があり不採用とした（2026-11-18、
//     検証記録は EVALUATION 側）。本実装は当室の反復版で、仕様表で固定する。
function fetchAncestorChain(fetchPost, targetId, maxDepth = 50) {
  const target = fetchPost(targetId);
  if (!target) return { posts: [], stop: "missing" };
  const chain = [target];
  const seen = new Set([targetId]);
  let cur = target, stop = "root";
  while (typeof cur.reply_to === "number" && cur.reply_to > 0) {
    if (chain.length >= maxDepth) { stop = "depth"; break; }
    const pid = cur.reply_to;
    if (seen.has(pid)) { stop = "cycle"; break; }
    const parent = fetchPost(pid);
    if (!parent) { stop = "missing"; break; }
    seen.add(pid);
    chain.push(parent);
    cur = parent;
  }
  chain.reverse();
  return { posts: chain, stop };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { fetchAncestorChain };
}

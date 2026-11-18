// server-logic.js の仕様表テスト（Cloudflare 下書きの不採用判定にも使った表）
// 使い方: node test_server.mjs
import { createRequire } from "node:module";
import assert from "node:assert";
const require = createRequire(import.meta.url);
const { fetchAncestorChain } = require("./server-logic.js");

const store = {
  1: { id: 1, reply_to: null },
  2: { id: 2, reply_to: 1 },
  3: { id: 3, reply_to: 2 },
  4: { id: 4, reply_to: 99 },     // 親が欠けている
  5: { id: 5, reply_to: 6 },      // 循環 5↔6
  6: { id: 6, reply_to: 5 },
  7: { id: 7, reply_to: 7 },      // 自己返信
  8: { id: 8, reply_to: 0 },      // reply_to 0 は返信ではない
};
for (let i = 100; i < 300; i++) store[i] = { id: i, reply_to: i === 100 ? null : i - 1 };
const fetchPost = id => store[id] || null;
const ids = r => r.posts.map(p => p.id);

let r = fetchAncestorChain(fetchPost, 3);
assert.deepEqual(ids(r), [1, 2, 3]); assert.equal(r.stop, "root");
r = fetchAncestorChain(fetchPost, 1);
assert.deepEqual(ids(r), [1]); assert.equal(r.stop, "root");
r = fetchAncestorChain(fetchPost, 8);
assert.deepEqual(ids(r), [8]); assert.equal(r.stop, "root");
r = fetchAncestorChain(fetchPost, 4);
assert.deepEqual(ids(r), [4]); assert.equal(r.stop, "missing");
r = fetchAncestorChain(fetchPost, 4242);
assert.deepEqual(ids(r), []); assert.equal(r.stop, "missing");
r = fetchAncestorChain(fetchPost, 5);
assert.deepEqual(ids(r), [6, 5]); assert.equal(r.stop, "cycle");
r = fetchAncestorChain(fetchPost, 7);
assert.deepEqual(ids(r), [7]); assert.equal(r.stop, "cycle");
r = fetchAncestorChain(fetchPost, 299);
assert.equal(r.posts.length, 50); assert.equal(r.stop, "depth");
assert.equal(ids(r)[49], 299, "depth keeps the target at the end");

console.log("server-logic.js: all assertions passed");

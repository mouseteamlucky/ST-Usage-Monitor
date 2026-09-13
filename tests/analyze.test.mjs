/**
 * ST-Usage-Monitor — 分析器单元测试
 * 运行:  node --test tests/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { annotate, classify, aggregate, parseJsonl, CLASS } from "../tools/analyze.mjs";

const FIXTURE = [
  { t: "2026-09-13T07:35:30.295Z", prompt: 67572, hit: 21120, miss: 46452, completion: 16060, payload_hash: "aaaa11112222" },
  { t: "2026-09-13T07:43:41.000Z", prompt: 67547, hit: 0, miss: 67547, completion: 5717, payload_hash: "bbbb33334444" },
  { t: "2026-09-13T07:49:39.000Z", prompt: 67885, hit: 34944, miss: 32941, completion: 7763, payload_hash: "cccc55556666" },
  { t: "2026-09-13T07:52:30.000Z", prompt: 67885, hit: 67712, miss: 173, completion: 6680, payload_hash: "cccc55556666" },
];

test("parseJsonl 丢弃坏行并保留有效记录", () => {
  const text = JSON.stringify(FIXTURE[0]) + "\nnot-json\n" + JSON.stringify(FIXTURE[1]) + "\n";
  assert.equal(parseJsonl(text).length, 2);
});

test("annotate 只把\"与上一条同 payload\"标成重 roll", () => {
  const rows = annotate(FIXTURE);
  assert.deepEqual(rows.map((r) => r.isReroll), [false, false, false, true]);
});

test("classify 区分冷启动 / 前缀全命中 / 窗口复用 / 掉台阶", () => {
  const rows = annotate(FIXTURE);
  assert.equal(classify(rows[1], 37400), CLASS.COLD);            // hit=0
  assert.equal(classify(rows[0], 21120), CLASS.FULL);            // 命中≈前缀
  assert.equal(classify(rows[0], 37400), CLASS.STEP);            // 低于前缀
  assert.equal(classify(rows[2], 21120), CLASS.WINDOW);          // 高于前缀（窗口复用）
  assert.equal(classify(rows[3], 21120), CLASS.REROLL);          // 同 payload 重 roll
});

test("aggregate 按单价折算成本与缓存省下", () => {
  const t = aggregate(annotate(FIXTURE), { hit: 0.02, miss: 1, out: 4 });
  assert.equal(t.n, 4);
  assert.equal(t.rerolls, 1);
  assert.equal(t.hit, 21120 + 0 + 34944 + 67712);
  assert.equal(t.miss, 46452 + 67547 + 32941 + 173);
  // 手算: hit*0.02/1e6 + miss*1/1e6 + out*4/1e6
  const expect = (t.hit * 0.02 + t.miss * 1 + t.completion * 4) / 1e6;
  assert.ok(Math.abs(t.cost - expect) < 1e-9, "cost " + t.cost + " vs " + expect);
  assert.ok(t.saved > 0);
  assert.ok(t.rate > 0 && t.rate < 1);
});

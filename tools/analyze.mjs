#!/usr/bin/env node
/**
 * ST-Usage-Monitor — 用量日志分析器
 *
 * 逐条把记录分类成：冷却 / 重 roll / 前缀全命中 / 前缀掉台阶 / 前缀+窗口，并汇总真实花费。
 *
 * CLI:
 *   node tools/analyze.mjs --file "data/<user>/st-usage.jsonl" --prefix 37400 \
 *        --price-hit 0.02 --price-miss 1 --price-out 4 [--json]
 *
 * 也可作为模块引用（供 tests/ 与其它脚本使用）：
 *   import { annotate, classify, aggregate, parseJsonl } from "./tools/analyze.mjs";
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const CLASS = {
  COLD: "cold",       // 命中≈0：命名空间切换 / 缓存过期
  REROLL: "reroll",   // 同 payload 重 roll：几乎全命中
  FULL: "full",       // 前缀全命中（正常新回合）
  WINDOW: "window",   // 前缀 + 窗口（重 roll 之外的额外复用）
  STEP: "step",       // 前缀掉台阶：前缀里有条目被改写
  UNKNOWN: "unknown",
};

export const CLASS_LABEL = {
  cold: "冷启动/换命名空间",
  reroll: "重 roll（同 payload）",
  full: "前缀全命中 ✅",
  window: "前缀+窗口复用",
  step: "前缀掉台阶 ⚠",
  unknown: "未分类",
};

/** 解析 JSONL 文本，丢弃坏行 */
export function parseJsonl(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (r && (r.prompt != null || r.hit != null || r.miss != null)) out.push(r);
    } catch { /* skip */ }
  }
  return out;
}

/** 标注 isReroll：payload_hash 与上一条相同 = 同一条重 roll / 滑切 */
export function annotate(records) {
  let prev = null;
  return records.map((r) => {
    const isReroll = Boolean(prev && r.payload_hash && prev.payload_hash === r.payload_hash);
    prev = r;
    return Object.assign({}, r, { isReroll });
  });
}

/** 单条分类；prefix = 你的提示词前缀长度（token），不知道传 0 即只区分冷/热 */
export function classify(record, prefix = 0, tolerance = 1024) {
  const hit = record.hit ?? 0;
  const prompt = record.prompt ?? (hit + (record.miss ?? 0));
  if (prompt > 0 && hit / prompt > 0.9 && record.isReroll) return CLASS.REROLL;
  if (hit < 256) return CLASS.COLD;
  if (!prefix) return CLASS.UNKNOWN;
  if (Math.abs(hit - prefix) <= tolerance) return CLASS.FULL;
  if (hit > prefix + tolerance) return CLASS.WINDOW;
  return CLASS.STEP;
}

/** 汇总：token、命中率、按单价折算的花费与"缓存省下" */
export function aggregate(records, prices = {}) {
  const ph = Number(prices.hit ?? 0.02) / 1e6;
  const pm = Number(prices.miss ?? 1) / 1e6;
  const po = Number(prices.out ?? 4) / 1e6;
  let prompt = 0, hit = 0, miss = 0, comp = 0, cost = 0, noCache = 0, rerolls = 0;
  for (const r of records) {
    const p = r.prompt ?? ((r.hit ?? 0) + (r.miss ?? 0));
    const h = r.hit ?? 0;
    const m = r.miss ?? Math.max(p - h, 0);
    const c = r.completion ?? 0;
    prompt += p; hit += h; miss += m; comp += c;
    cost += h * ph + m * pm + c * po;
    noCache += p * pm + c * po;
    if (r.isReroll) rerolls++;
  }
  return {
    n: records.length, prompt, hit, miss, completion: comp, rerolls,
    rate: prompt ? hit / prompt : 0,
    cost, noCache,
    saved: Math.max(noCache - cost, 0),
  };
}

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const fmt = (n) => (n == null ? "-" : Number(n).toLocaleString());

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const file = arg("--file", "");
  const prefix = Number(arg("--prefix", 0)) || 0;
  const prices = { hit: Number(arg("--price-hit", 0.02)), miss: Number(arg("--price-miss", 1)), out: Number(arg("--price-out", 4)) };
  if (!file) {
    console.log("用法: node tools/analyze.mjs --file <st-usage.jsonl> [--prefix 37400] [--price-hit 0.02] [--price-miss 1] [--price-out 4] [--json]");
    process.exit(1);
  }
  const records = annotate(parseJsonl(fs.readFileSync(file, "utf8")));
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ prices, prefix, totals: aggregate(records, prices), records: records.map((r) => ({ t: r.t, prompt: r.prompt, hit: r.hit, miss: r.miss, completion: r.completion, isReroll: r.isReroll, klass: classify(r, prefix) })) }, null, 2));
    return;
  }
  console.log("日志: " + file + "   共 " + records.length + " 条   前缀基准: " + (prefix || "未指定") + "\n");
  console.log(pad("时间", 17) + padL("prompt", 9) + padL("hit", 9) + padL("miss", 9) + padL("命中率", 8) + padL("输出", 8) + "  " + "分类");
  for (const r of records) {
    const p = r.prompt ?? 0;
    const k = classify(r, prefix);
    console.log(pad((r.t || "").slice(5, 16).replace("T", " "), 17) + padL(fmt(p), 9) + padL(fmt(r.hit), 9) + padL(fmt(r.miss), 9) + padL(p ? ((r.hit || 0) / p * 100).toFixed(1) + "%" : "-", 8) + padL(fmt(r.completion), 8) + "  " + (r.isReroll ? "↻ " : "  ") + CLASS_LABEL[k]);
  }
  if (prefix > 0) {
    const steps = records.filter((r) => classify(r, prefix) === CLASS.STEP).length;
    if (steps > records.length / 2) {
      console.log("\n提示: " + steps + "/" + records.length + " 条被判为\"前缀掉台阶\"，多数情况下这说明 --prefix 填的是调整后的值、而这些记录产生于调整之前。用当时的 prefix 值重跑即可。");
    }
  }
  const t = aggregate(records, prices);
  console.log("\n合计: prompt " + fmt(t.prompt) + " | hit " + fmt(t.hit) + " | miss " + fmt(t.miss) + " | 命中率 " + (t.rate * 100).toFixed(1) + "% | 输出 " + fmt(t.completion));
  console.log("请求 " + t.n + " 条（其中重 roll " + t.rerolls + " 条）");
  console.log("花费: 实际 ¥" + t.cost.toFixed(4) + " | 若全未命中 ¥" + t.noCache.toFixed(4) + " | 缓存省下 ¥" + t.saved.toFixed(4) + " (" + (t.noCache ? (t.saved / t.noCache * 100).toFixed(1) : "0") + "%)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

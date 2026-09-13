/**
 * ST-Usage-Monitor — 独立网页看板服务（零依赖）
 *
 *   node dashboard/serve.mjs --data-root "D:\SillyTavern\data" [--port 8899]
 *   node dashboard/serve.mjs --file "D:\SillyTavern\data\<user>\st-usage.jsonl"
 *
 * 打开 http://127.0.0.1:8899/ —— 每 5 秒自动刷新，展示命中率 / 花费 / 逐条明细。
 * 浏览器扩展面板里的「网页看板」按钮就是打开这个地址。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg("--port", process.env.ST_USAGE_PORT || 8899));

/** 找出要监视的 st-usage.jsonl：显式指定 > 环境变量 > data/<user>/ 下最近修改的那个 */
function resolveUsageFile() {
  const explicit = arg("--file", process.env.ST_USAGE_FILE || "");
  if (explicit && fs.existsSync(explicit)) return explicit;
  const roots = [];
  const dataRoot = arg("--data-root", process.env.ST_DATA_ROOT || "");
  if (dataRoot) roots.push(dataRoot);
  roots.push(path.join(HERE, ".."), process.cwd());
  const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const f = path.join(root, e.name, "st-usage.jsonl");
      try { found.push({ file: f, mtime: fs.statSync(f).mtimeMs }); } catch { /* not here */ }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.length ? found[0].file : null;
}

let USAGE_FILE = resolveUsageFile();
console.log(USAGE_FILE ? "reading: " + USAGE_FILE : "no st-usage.jsonl found - start capture, then reload this page");

const server = http.createServer((req, res) => {
  const url = String(req.url || "/").split("?")[0];
  if (url === "/" || url === "/index.html") {
    try {
      const html = fs.readFileSync(path.join(HERE, "dashboard.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("dashboard.html not found: " + e.message);
    }
  }
  if (url === "/usage.jsonl") {
    if (!USAGE_FILE || !fs.existsSync(USAGE_FILE)) USAGE_FILE = resolveUsageFile();
    let body = "";
    try { body = fs.readFileSync(USAGE_FILE, "utf8"); } catch { /* not yet */ }
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(body);
  }
  if (url === "/meta") {
    let st = { exists: false };
    try { const s = fs.statSync(USAGE_FILE); st = { exists: true, size: s.size, mtime: s.mtime.toISOString() }; } catch { /* none */ }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ file: USAGE_FILE, usageFile: st }, null, 2));
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log("port " + PORT + " already in use - dashboard probably already running: http://127.0.0.1:" + PORT + "/");
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("usage dashboard: http://127.0.0.1:" + PORT + "/");
});

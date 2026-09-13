# ST-Usage-Monitor

> SillyTavern 的「**提示词缓存用量监视器**」：把每次请求的 prompt / 缓存命中 / 未命中 / 输出 token 变成看得见的数字，
> 顺带算出真实花费和"缓存帮你省了多少钱"。

GitHub: **https://github.com/mouseteamlucky/ST-Usage-Monitor**

---

## 为什么需要它

DeepSeek 这类「缓存友好」计价的模型，缓存命中与未命中的价差高达 **50 倍**
（deepseek-flash 2026-09-10 新价：空闲时段 命中 ¥0.02/M、未命中 ¥1/M、输出 ¥4/M）。

也就是说：**同样的内容，放在提示词前半段（被缓存）和后半段（每轮全价重算），成本能差 50 倍。**
但 SIllyTavern 界面上只显示"这条消息多少 token"，看不到"这次请求到底有多少走了缓存" ——
于是优化全凭猜。本插件就是把这个黑盒打开。

## 组成

| 部分 | 位置 | 作用 |
|---|---|---|
| **① 采集补丁** | `patches/st-usage-capture.patch`（改 ST 的 `src/util.js` + `src/endpoints/backends/chat-completions.js`） | 在 ST 转发上游响应时，把 usage 里的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 抓出来，追加一行 JSON 到 `data/<user>/st-usage.jsonl` |
| **② 服务端插件** | `plugins/st-usage-server/` | 提供 `/api/plugins/st-usage/{status,data,capture,clear}`，把日志喂给前端，并可**运行时开关采集** |
| **③ 浏览器扩展** | `public/scripts/extensions/st-usage-monitor/` | 右侧悬浮球 + 展开面板（KPI 卡 / 堆叠柱状图 / 明细表 / 单价 / 筛选 / 采集开关） |

> 支持 **`deepseek`（官方 API）与 `custom`（任意 OpenAI 兼容端点）** 两个 chat completion 源。
> 其它源（openai / claude / gemini …）暂不采集。

## 安装

### 方式 A：一键脚本

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -SillyTavernPath "D:\SillyTavern"
```

脚本会：复制扩展 + 插件 → 把 `config.yaml` 的 `enableServerPlugins` 设为 true → 尝试打采集补丁（已打过则跳过）。

### 方式 B：手动三步

```text
1) 扩展   : 复制 public/scripts/extensions/st-usage-monitor/  →  <ST>/public/scripts/extensions/st-usage-monitor/
2) 插件   : 复制 plugins/st-usage-server/                     →  <ST>/plugins/st-usage-server/
3) 补丁   : 在 <ST> 目录执行  git apply patches/st-usage-capture.patch
   （或手工按 patch 内容改那两个文件：加 hashPromptPayload()、isUsageCaptureEnabled()、forwardFetchResponseCapture 调用）
```

然后：

```text
4) <ST>/config.yaml  里确认  enableServerPlugins: true
5) 重启 SillyTavern（node server.js），浏览器 F5
6) 打开扩展设置 → "ST 用量 / 缓存命中"，勾选"采集"（或手动创建 data/<user>/st-usage.capture）
7) 随便发一条消息，右侧悬浮球就会出现数字
```

## 采集开关（不用重启）

两种任一即可开启：

- **开关文件**：`data/<user>/st-usage.capture` 存在 = 开，删除 = 关（面板里的"采集"勾选框就是改这个文件）
- **环境变量**：启动前 `set ST_USAGE_CAPTURE=1`（Windows）/ `export ST_USAGE_CAPTURE=1`

> 面板上的「清空日志」会**先自动备份**一份 `st-usage.jsonl.bak-<时间戳>` 再清空。

## 面板长什么样

**悬浮球**（贴右边缘）
- 大数字 = 最近 10 次请求的缓存命中率
- 下面一条迷你进度条 = 同一数值（≥50% 绿 / ≥20% 黄 / 否则红）
- 悬停 = 命中率、输入 token（hit/miss 拆分）、输出 token、估算花费、缓存省下多少
- **每次生成结束自动刷新**（订阅 `GENERATION_ENDED` 等事件，2.5 秒防抖）

**展开面板**
- 6 张 KPI 卡：请求数（含"新回合 X · 重 roll Y"）/ 命中率 / 输入 token / 输出 token / 估算花费 / **缓存省下**
- 堆叠柱状图：每条请求 = 未命中(红) + 命中(绿) + 输出(蓝)
- 明细表：时间（重 roll 带 `↻`）/ 消息数 / prompt / hit / miss / 命中率 / 输出 / 单次成本
- 控件：单价（¥/百万 token）、范围筛选（全部 / 仅新回合 / 仅重 roll）、取最近 N 条、采集开关、刷新、清空日志、打开网页看板

## 单价怎么填（示例：deepseek-flash，2026-09-10 起）

| 每百万 token | 空闲时段 | 高峰时段 |
|---|---|---|
| 输入 · 缓存命中 | ¥0.02 | ¥0.04 |
| 输入 · 缓存未命中 | ¥1 | ¥2 |
| 输出 | ¥4 | ¥8 |

> 高峰时段 = 北京时间周一至周五 09:00–12:00、14:00–18:00；其余（含周末、夜间）为空闲价。
> 插件默认按"空闲价"填，跨时段使用请自行取加权值或在面板里改。

## 记录字段

`data/<user>/st-usage.jsonl` 每行一条：

| 字段 | 说明 |
|---|---|
| `t` | 时间（ISO） |
| `source` / `model` / `endpoint` | 来源、模型、上游地址 |
| `n_msgs` | 本次发出的消息条数 |
| `payload_hash` | 出站 payload 指纹：**与上一条相同 = 同一条重 roll / 滑切**（不是新回合） |
| `prompt` / `hit` / `miss` / `cached` | 输入总量 / 缓存命中 / 未命中 / 提供方上报的 cached |
| `completion` / `total` | 输出 / 合计 |
| `stream` / `max_tokens` | 是否流式 / 请求的输出上限 |
| `usage_raw` | 上游 usage 原文片段（排错用） |

## 命中率不稳定？先按这四类归因

| 现象 | 含义 | 要不要管 |
|---|---|---|
| 带 `↻` 且命中接近 100% | 同 payload 重 roll / 滑切 | 正常，白捡的 |
| 无 `↻` 且 hit ≈ 前缀长度 | 普通新回合，前缀全命中 | 正常，这是基准线 |
| 无 `↻` 且 hit **掉一个台阶** | 前缀里某条被改写了（世界书/人设/摘要被脚本重写） | 需要盯 |
| 无 `↻` 且 hit ≈ 0 | **缓存命名空间切换**（思考模式开关、模型档位变化）或缓存过期 | 每次切换后第一条必然如此 |

> 关键：**看 hit 的绝对值，而不是百分比** —— prompt 总量随聊天窗口浮动，百分比天然会漂。

## 常见问题

**Q: 装了但一条数据都没有？**
1. 看面板左上角 `/meta` 信息里"采集开关"是否"已开启"；
2. 确认当前 API 源是 `deepseek` 或 `custom`（其它源不采集）；
3. 看 `data/<user>/st-usage.jsonl.debug.log` —— 补丁每次请求都会记一行，能看出"是否走到采集"以及"上游有没有返回 usage"。

**Q: 会不会泄露隐私 / 把密钥写进日志？**
不会。日志只含 token 计数、模型名、上游地址和 usage 片段，**不含任何消息正文与密钥**。

**Q: 上游不返回 usage 怎么办？**
补丁会在流式请求里加 `stream_options: { include_usage: true }`（可用 `ST_USAGE_STREAM_OPTIONS=0` 关闭）。
若你的中转站不支持该参数，日志会停在 `parsed=NO`，此时只能改用非流式或换端点。

## 独立网页看板（可选）

扩展面板里的「网页看板」按钮打开的就是它 —— 适合放大屏幕常驻观察。

```text
dashboard\start.cmd "D:\SillyTavern\data"
# → 起本地服务（8899）并自动打开 http://127.0.0.1:8899/（每 5 秒自动刷新）

# 参数省略时会自动在 ./data/<user>/ 里找最近修改的 st-usage.jsonl：
node dashboard/serve.mjs --data-root "<ST>\data" --port 8899
```

零依赖（只用 Node 内置模块），关闭那个最小化的 node 窗口即停止。

## 附带工具

```bash
# 命令行分析：逐条分类（新回合 / 重 roll / 台阶下落 / 冷启动）+ 真实花费 + 缓存省下
node tools/analyze.mjs --file "data/<user>/st-usage.jsonl" --prefix 37400 \
     --price-hit 0.02 --price-miss 1 --price-out 4

# 单元测试（4 个用例）
node --test tests/analyze.test.mjs
```

## 相关项目

- [ST-OpenCode-Go-Usage](https://github.com/mouseteamlucky/ST-OpenCode-Go-Usage) —— 同一个账号下的姊妹扩展：
  那个盯的是 **OpenCode Go 订阅额度**（滚动 / 周 / 月窗口、key 池），这个盯的是 **提示词缓存与 token 花费**。
  两者可以同时安装，悬浮球分别贴右侧 40% / 58% 高度，不会打架。

## 卸载

删除 `plugins/st-usage-server/`、`public/scripts/extensions/st-usage-monitor/` 即可；
补丁可用 `git checkout -- src/util.js src/endpoints/backends/chat-completions.js` 还原（会同时丢掉其它本地改动，谨慎）。

MIT License.

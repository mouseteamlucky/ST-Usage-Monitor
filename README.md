# ST-Usage-Monitor

GitHub: **https://github.com/mouseteamlucky/ST-Usage-Monitor**

A SillyTavern extension + server plugin that makes **prompt-cache consumption visible**:
for every request it records the prompt size, how many tokens hit the provider's prompt
cache (`hit`), how many were billed as cache-miss (`miss`), and the output tokens — then
shows them as a floating pill plus an expandable panel with per-request bars, a table,
editable unit prices, a cost / "cache saved" estimate and a re-roll detector.

Data comes from a small, opt-in capture patch in the SillyTavern backend
(`patches/st-usage-capture.patch`), which appends one JSON line per request to
`data/<user>/st-usage.jsonl`. The server plugin serves that file to the browser
extension through `/api/plugins/st-usage/*` and can toggle capture on/off at runtime —
**without a server restart**.

Read the Chinese README for full details: **README.zh.md**
(安装步骤、采集开关、单价设置、命中率归因、卸载). Measured results: **VERIFICATION.zh.md**.

Related project: [ST-OpenCode-Go-Usage](https://github.com/mouseteamlucky/ST-OpenCode-Go-Usage)
watches the OpenCode Go subscription quota; this one watches prompt-cache tokens and cost.
They can be installed side by side.

MIT License.

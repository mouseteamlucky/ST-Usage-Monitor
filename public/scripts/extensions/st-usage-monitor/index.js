/**
 * ST Usage Monitor — SillyTavern 浏览器扩展
 * ------------------------------------------------------------------
 * 把「每次请求的 prompt / 缓存命中 hit / 未命中 miss / 输出 completion」变成看得见的东西：
 *   - 右侧悬浮球：最近若干次的缓存命中率（绿/黄/红）+ 迷你进度条，每次生成后自动刷新
 *   - 点击展开面板：KPI 卡片、堆叠柱状图、逐条明细表、单价与筛选、采集开关、清空日志
 *   - 扩展设置抽屉：开关悬浮球 / 刷新间隔 / 单价 / 采集开关
 *
 * 数据来自配套服务端插件（plugins/st-usage-server）：
 *   GET  /api/plugins/st-usage/status
 *   GET  /api/plugins/st-usage/data?last=N
 *   POST /api/plugins/st-usage/capture {enabled}
 *   POST /api/plugins/st-usage/clear
 * 日志由 ST 服务端的 dsh-usage-monitor 补丁写入 data/<user>/st-usage.jsonl。
 */
import { extension_settings } from '../../extensions.js';
import { getRequestHeaders, saveSettingsDebounced, eventSource, event_types } from '../../../script.js';

const EXT_NAME = 'st-usage-monitor';
const API = '/api/plugins/st-usage';

const DEFAULTS = {
    showPill: true,
    autoRefresh: true,
    refreshSec: 30,
    filter: 'all',
    last: 300,
    // deepseek-flash 官方价（2026-09-10 12:00 起）：空闲 0.02/1/4，高峰 0.04/2/8
    prices: { hit: 0.02, miss: 1, out: 4 },
};

const state = {
    records: [],
    status: null,
    panelOpen: false,
    timer: null,
    busy: false,
    error: null,
    lastFetch: 0,
};

const L = {
    title: '用量 / 缓存命中',
    pill: '缓存命中',
    noData: '还没有记录 —— 先确认采集已开启，并随意发一条消息。',
    needPlugin: '服务端插件未加载：请重启一次 SillyTavern（插件目录 plugins/st-usage-server）。',
};

/* ---------------- 基础工具 ---------------- */

function S() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = structuredClone(DEFAULTS);
    }
    const s = extension_settings[EXT_NAME];
    s.prices = Object.assign({}, DEFAULTS.prices, s.prices || {});
    for (const k of ['showPill', 'autoRefresh', 'refreshSec', 'filter', 'last']) {
        if (s[k] === undefined) s[k] = DEFAULTS[k];
    }
    return s;
}

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
}

const fmt = (n) => (n === null || n === undefined || Number.isNaN(n)) ? '—' : Number(n).toLocaleString();
const yuan = (n) => '¥' + (Number(n) || 0).toFixed(4);
const pct = (h, p) => (p ? (h / p * 100) : 0);

async function api(pathname, options = {}) {
    const res = await fetch(API + pathname, {
        method: options.method || 'GET',
        headers: getRequestHeaders(),
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: 'no-store',
    });
    if (res.status === 404) throw new Error('plugin-missing');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
}

/* ---------------- 计算 ---------------- */

/**
 * 给每条记录标注"是否与上一条同 payload"（= 重 roll / 滑切，而不是新回合）。
 * payload_hash 由服务端 usage-monitor 补丁写入（老记录没有该字段，按未知处理）。
 */
function annotate(recs) {
    let prev = null;
    return recs.map((r) => {
        const isReroll = Boolean(prev && r.payload_hash && prev.payload_hash === r.payload_hash);
        prev = r;
        return Object.assign({}, r, { isReroll });
    });
}

function recordsFor(recs, filter) {
    if (filter === 'new') return recs.filter(r => !r.isReroll);
    if (filter === 'reroll') return recs.filter(r => r.isReroll);
    return recs;
}

function aggregate(recs) {
    const p = S().prices;
    const ph = Number(p.hit) / 1e6, pm = Number(p.miss) / 1e6, po = Number(p.out) / 1e6;
    let prompt = 0, hit = 0, miss = 0, comp = 0, cost = 0, noCache = 0;
    for (const r of recs) {
        const tp = r.prompt ?? ((r.hit ?? 0) + (r.miss ?? 0));
        const h = r.hit ?? 0, m = r.miss ?? Math.max(tp - h, 0), c = r.completion ?? 0;
        prompt += tp; hit += h; miss += m; comp += c;
        cost += h * ph + m * pm + c * po;
        noCache += tp * pm + c * po;
    }
    return { n: recs.length, prompt, hit, miss, comp, cost, noCache, rate: pct(hit, prompt) };
}

/* ---------------- 拉取 ---------------- */

async function refresh(force = false) {
    if (state.busy) return;
    if (!force && Date.now() - state.lastFetch < 800) return;
    state.busy = true;
    try {
        const [status, data] = await Promise.all([
            api('/status'),
            api('/data?last=' + Math.max(20, Number(S().last) || 300)),
        ]);
        state.status = status;
        state.records = annotate(Array.isArray(data.records) ? data.records : []);
        state.error = null;
    } catch (e) {
        state.error = e.message;
    } finally {
        state.busy = false;
        state.lastFetch = Date.now();
        renderPill();
        if (state.panelOpen) renderPanel();
    }
}

/* ---------------- 悬浮球 ---------------- */

function renderPill() {
    const pill = document.getElementById('stu-pill');
    if (!pill) return;
    const recs = recordsFor(state.records, S().filter).slice(-10);
    const a = aggregate(recs);
    const label = document.getElementById('stu-pct');
    const bar = document.getElementById('stu-mini-fill');
    const wrap = document.getElementById('stu-mini');
    const gauge = document.getElementById('stu-gauge');
    if (state.error === 'plugin-missing') {
        if (label) { label.textContent = '—'; label.className = 'stu-pct stu-bad'; }
        if (gauge) gauge.textContent = '⚠';
        pill.title = L.needPlugin;
        return;
    }
    if (!recs.length) {
        if (label) { label.textContent = '—'; label.className = 'stu-pct'; }
        if (gauge) gauge.textContent = '◷';
        if (bar) bar.style.width = '0%';
        pill.title = L.noData;
        return;
    }
    const rate = a.rate;
    if (label) {
        label.textContent = rate.toFixed(0) + '%';
        label.className = 'stu-pct ' + (rate >= 50 ? 'stu-good' : (rate >= 20 ? 'stu-warn' : 'stu-bad'));
    }
    if (gauge) gauge.textContent = '◷';
    if (bar) bar.style.width = Math.max(2, Math.min(100, rate)) + '%';
    if (wrap) wrap.title = '最近 ' + recs.length + ' 次：hit ' + fmt(a.hit) + ' / miss ' + fmt(a.miss);
    pill.title = '最近 ' + recs.length + ' 次请求\n命中率 ' + rate.toFixed(1) + '%\n输入 ' + fmt(a.prompt) + ' token（hit ' + fmt(a.hit) + ' / miss ' + fmt(a.miss) + '）\n输出 ' + fmt(a.comp) + ' token\n估算 ' + yuan(a.cost) + '（省下 ' + yuan(Math.max(a.noCache - a.cost, 0)) + '）\n点击展开看板';
}

function buildWidget() {
    document.getElementById('stu-widget')?.remove();
    const widget = el('div');
    widget.id = 'stu-widget';

    const pill = el('div');
    pill.id = 'stu-pill';
    pill.append(el('span', 'stu-gauge', '◷'));
    const pctEl = el('span', 'stu-pct', '—');
    pctEl.id = 'stu-pct';
    pill.append(pctEl);
    const mini = el('span', 'stu-mini');
    mini.id = 'stu-mini';
    const fill = el('i');
    fill.id = 'stu-mini-fill';
    mini.append(fill);
    pill.append(mini);
    pill.append(el('span', 'stu-vlabel', L.pill));
    pill.addEventListener('click', () => { state.panelOpen = !state.panelOpen; const p = document.getElementById('stu-panel'); if (p) p.hidden = !state.panelOpen; if (state.panelOpen) { refresh(true); renderPanel(); } });
    widget.append(pill);
    widget.hidden = !S().showPill;

    // ---- 面板 ----
    const panel = el('div');
    panel.id = 'stu-panel';
    panel.hidden = !state.panelOpen;

    const head = el('div', 'stu-head');
    head.append(el('span', 'stu-title', L.title));
    const sub = el('span', 'stu-sub', '');
    sub.id = 'stu-sub';
    head.append(sub);
    const x = el('span', 'stu-x', '×');
    x.addEventListener('click', () => { state.panelOpen = false; panel.hidden = true; });
    head.append(x);
    panel.append(head);

    const cards = el('div', 'stu-cards');
    cards.id = 'stu-cards';
    panel.append(cards);

    const ctl = el('div', 'stu-ctl');
    ctl.id = 'stu-ctl';
    panel.append(ctl);

    const canvas = el('canvas');
    canvas.id = 'stu-chart';
    canvas.height = 170;
    panel.append(canvas);

    const legend = el('div', 'stu-legend');
    legend.innerHTML = '<span><i style="background:#37b26b"></i>命中 hit</span><span><i style="background:#e0574a"></i>未命中 miss</span><span><i style="background:#4a8fe0"></i>输出 completion</span>';
    panel.append(legend);

    const note = el('div', 'stu-note', '');
    note.id = 'stu-note';
    panel.append(note);

    const wrap = el('div', 'stu-tblwrap');
    const tbl = el('table', 'stu-tbl');
    tbl.innerHTML = '<thead><tr><th>时间</th><th>消息数</th><th>prompt</th><th>hit</th><th>miss</th><th>命中率</th><th>输出</th><th>成本</th></tr></thead><tbody></tbody>';
    wrap.append(tbl);
    panel.append(wrap);

    widget.append(panel);
    document.body.append(widget);
}

/* ---------------- 面板渲染 ---------------- */

function renderCards(a, recs) {
    const box = document.getElementById('stu-cards');
    if (!box) return;
    box.innerHTML = '';
    const mk = (k, v, s, cls) => {
        const c = el('div', 'stu-card');
        c.append(el('div', 'k', k));
        const vv = el('div', 'v' + (cls ? ' ' + cls : ''), v);
        c.append(vv);
        if (s) c.append(el('div', 's', s));
        return c;
    };
    const cls = a.rate >= 50 ? 'stu-good' : (a.rate >= 20 ? 'stu-warn' : 'stu-bad');
    const list = recs || [];
    const nReroll = list.filter(r => r.isReroll).length;
    box.append(mk('请求数', fmt(a.n), '新回合 ' + (list.length - nReroll) + ' · 重 roll ' + nReroll));
    box.append(mk('命中率', a.n ? a.rate.toFixed(1) + '%' : '—', 'hit ' + fmt(a.hit) + ' / miss ' + fmt(a.miss), cls));
    box.append(mk('输入 token', fmt(a.prompt), a.n ? ('平均 ' + fmt(Math.round(a.prompt / a.n)) + ' / 次') : ''));
    box.append(mk('输出 token', fmt(a.comp), 'completion'));
    box.append(mk('估算花费', yuan(a.cost), '按下方单价'));
    box.append(mk('缓存省下', yuan(Math.max(a.noCache - a.cost, 0)), '若全未命中会多花', 'stu-good'));
}

function renderControls() {
    const ctl = document.getElementById('stu-ctl');
    if (!ctl) return;
    const s = S();
    ctl.innerHTML = '';
    const price = (key, label) => {
        const lab = el('label', undefined, label);
        const inp = el('input');
        inp.type = 'number';
        inp.step = '0.01';
        inp.value = s.prices[key];
        inp.addEventListener('change', () => { s.prices[key] = Number(inp.value) || 0; saveSettingsDebounced(); renderPanel(); renderPill(); });
        lab.append(inp);
        return lab;
    };
    ctl.append(price('hit', '命中 ¥/M'), price('miss', '未命中 ¥/M'), price('out', '输出 ¥/M'));

    const fl = el('label', undefined, '范围');
    const sel = el('select');
    for (const [v, t] of [['all', '全部'], ['new', '仅新回合'], ['reroll', '仅重 roll（同 payload）']]) {
        const o = el('option', undefined, t);
        o.value = v;
        if (s.filter === v) o.selected = true;
        sel.append(o);
    }
    sel.addEventListener('change', () => { s.filter = sel.value; saveSettingsDebounced(); renderPanel(); renderPill(); });
    fl.append(sel);
    ctl.append(fl);

    const lastLab = el('label', undefined, '取最近');
    const lastInp = el('input');
    lastInp.type = 'number';
    lastInp.value = s.last;
    lastInp.step = '50';
    lastInp.min = '20';
    lastInp.style.width = '72px';
    lastInp.addEventListener('change', () => { s.last = Math.max(20, Number(lastInp.value) || 300); saveSettingsDebounced(); refresh(true); });
    lastLab.append(lastInp);
    ctl.append(lastLab);

    const capOn = Boolean(state.status && state.status.captureEnabled);
    const capLab = el('label', 'stu-sw');
    const capChk = el('input');
    capChk.type = 'checkbox';
    capChk.checked = capOn;
    capChk.addEventListener('change', async () => {
        try { await api('/capture', { method: 'POST', body: { enabled: capChk.checked } }); } catch (e) { /* ignore */ }
        refresh(true);
    });
    capLab.append(capChk, el('span', undefined, '采集'));
    ctl.append(capLab);

    const btnRefresh = el('button', 'stu-btn', '刷新');
    btnRefresh.addEventListener('click', () => refresh(true));
    ctl.append(btnRefresh);

    const btnClear = el('button', 'stu-btn', '清空日志');
    btnClear.addEventListener('click', async () => {
        if (!confirm('清空 st-usage.jsonl？（会先自动备份一份）')) return;
        try { await api('/clear', { method: 'POST', body: {} }); } catch (e) { /* ignore */ }
        refresh(true);
    });
    ctl.append(btnClear);

    const btnOpen = el('button', 'stu-btn', '网页看板');
    btnOpen.addEventListener('click', () => window.open('http://127.0.0.1:8899/', '_blank'));
    ctl.append(btnOpen);
}

function drawChart(recs) {
    const cv = document.getElementById('stu-chart');
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 600, h = 170;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!recs.length) {
        ctx.fillStyle = 'rgba(160,160,160,.9)';
        ctx.font = '12px sans-serif';
        ctx.fillText(L.noData, 8, 22);
        return;
    }
    const pad = { l: 52, r: 8, t: 8, b: 6 };
    const max = Math.max(...recs.map(r => (r.prompt ?? 0) + (r.completion ?? 0)), 1);
    const plotW = w - pad.l - pad.r, plotH = h - pad.t - pad.b;
    const yOf = (v) => pad.t + plotH - (v / max) * plotH;
    ctx.strokeStyle = 'rgba(128,128,128,.25)';
    ctx.fillStyle = 'rgba(160,160,160,.9)';
    ctx.font = '10px sans-serif';
    for (let i = 0; i <= 3; i++) {
        const v = max * i / 3, yy = yOf(v);
        ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
        ctx.fillText(Math.round(v / 1000) + 'k', 6, yy + 3);
    }
    const bw = Math.max(2, Math.min(26, plotW / recs.length - 3));
    recs.forEach((r, i) => {
        const tp = r.prompt ?? ((r.hit ?? 0) + (r.miss ?? 0));
        const hit = r.hit ?? 0, miss = r.miss ?? Math.max(tp - hit, 0), comp = r.completion ?? 0;
        const x = pad.l + (i + 0.5) * (plotW / recs.length) - bw / 2;
        let base = 0;
        const seg = (v, color) => { if (!v || v <= 0) return; ctx.fillStyle = color; ctx.fillRect(x, yOf(base + v), bw, yOf(base) - yOf(base + v)); base += v; };
        seg(miss, '#e0574a'); seg(hit, '#37b26b'); seg(comp, '#4a8fe0');
    });
}

function renderTable(recs) {
    const tb = document.querySelector('#stu-panel .stu-tbl tbody');
    if (!tb) return;
    tb.innerHTML = '';
    const p = S().prices;
    const ph = Number(p.hit) / 1e6, pm = Number(p.miss) / 1e6, po = Number(p.out) / 1e6;
    for (const r of recs.slice(-25).reverse()) {
        const tp = r.prompt ?? ((r.hit ?? 0) + (r.miss ?? 0));
        const hit = r.hit ?? 0, miss = r.miss ?? Math.max(tp - hit, 0), comp = r.completion ?? 0;
        const tr = document.createElement('tr');
        const td = (t, cls) => { const c = el('td', cls, t); tr.append(c); };
        td((r.isReroll ? '↻ ' : '') + (r.t || '').slice(5, 19).replace('T', ' '), r.isReroll ? 'stu-good' : undefined);
        td(r.n_msgs ?? '—');
        td(fmt(tp));
        td(fmt(hit), 'stu-hit');
        td(fmt(miss), 'stu-miss');
        td(tp ? (hit / tp * 100).toFixed(0) + '%' : '—');
        td(fmt(comp));
        td(yuan(hit * ph + miss * pm + comp * po));
        tb.append(tr);
    }
}

function renderPanel() {
    const panel = document.getElementById('stu-panel');
    if (!panel || panel.hidden) return;
    const sub = document.getElementById('stu-sub');
    const note = document.getElementById('stu-note');
    if (state.error === 'plugin-missing') {
        if (sub) sub.textContent = '';
        if (note) note.textContent = L.needPlugin;
        const cards = document.getElementById('stu-cards');
        if (cards) cards.innerHTML = '';
        return;
    }
    const recs = recordsFor(state.records, S().filter);
    const a = aggregate(recs);
    if (sub) {
        const st = state.status || {};
        const size = st.log && st.log.exists ? (Math.round(st.log.size / 1024) + ' KB') : '无日志';
        sub.textContent = '采集：' + (st.captureEnabled ? '开' : '关') + ' · 日志 ' + size + ' · 共 ' + fmt(state.records.length) + ' 条' + (state.error ? ' · ' + state.error : '');
    }
    renderCards(a, recs);
    renderControls();
    drawChart(recs.slice(-80));
    renderTable(recs);
    if (note) {
        note.textContent = recs.length ? '' : L.noData;
    }
}

/* ---------------- 设置抽屉 ---------------- */

function buildSettings() {
    const container = document.getElementById('extensions_settings');
    if (!container) return;
    document.querySelector('.st-usage-settings')?.remove();
    const drawer = el('div', 'inline-drawer st-usage-settings');
    const header = el('div', 'inline-drawer-toggle inline-drawer-header');
    header.append(el('b', undefined, 'ST 用量 / 缓存命中'));
    header.append(el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
    drawer.append(header);
    const content = el('div', 'inline-drawer-content');
    drawer.append(content);
    const s = S();
    content.append(el('div', 'stu-note', '数据源：data/<user>/st-usage.jsonl（服务端插件 /api/plugins/st-usage）。这里显示每次请求的 prompt、缓存命中与输出 token。'));

    const row1 = el('label', 'checkbox_label');
    const chkPill = el('input');
    chkPill.type = 'checkbox';
    chkPill.checked = s.showPill;
    chkPill.addEventListener('change', () => { s.showPill = chkPill.checked; const w = document.getElementById('stu-widget'); if (w) w.hidden = !s.showPill; saveSettingsDebounced(); });
    row1.append(chkPill, el('span', undefined, '显示右侧悬浮球'));
    content.append(row1);

    const row2 = el('label', 'checkbox_label');
    const chkAuto = el('input');
    chkAuto.type = 'checkbox';
    chkAuto.checked = s.autoRefresh;
    chkAuto.addEventListener('change', () => { s.autoRefresh = chkAuto.checked; schedule(); saveSettingsDebounced(); });
    row2.append(chkAuto, el('span', undefined, '自动刷新（生成结束后立即刷新一次）'));
    content.append(row2);

    const row3 = el('label');
    row3.append(el('span', undefined, '定时刷新（秒）'));
    const inSec = el('input');
    inSec.type = 'number';
    inSec.min = '5';
    inSec.value = s.refreshSec;
    inSec.addEventListener('change', () => { s.refreshSec = Math.max(5, Number(inSec.value) || 30); schedule(); saveSettingsDebounced(); });
    row3.append(inSec);
    content.append(row3);

    const row4 = el('div', 'stu-ctl');
    const btnOpen = el('button', 'stu-btn', '打开看板');
    btnOpen.addEventListener('click', () => { state.panelOpen = true; const p = document.getElementById('stu-panel'); if (p) p.hidden = false; refresh(true); renderPanel(); });
    const btnRefresh = el('button', 'stu-btn', '立即刷新');
    btnRefresh.addEventListener('click', () => refresh(true));
    const status = el('span', 'stu-note', '');
    status.id = 'stu-settings-status';
    row4.append(btnOpen, btnRefresh, status);
    content.append(row4);
    container.append(drawer);
}

/* ---------------- 生命周期 ---------------- */

function schedule() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (!S().autoRefresh) return;
    state.timer = setInterval(() => refresh(true), Math.max(5, Number(S().refreshSec) || 30) * 1000);
}

function hookEvents() {
    try {
        const debounced = (() => { let t = null; return () => { if (t) clearTimeout(t); t = setTimeout(() => { refresh(true); const st = document.getElementById('stu-settings-status'); if (st && state.status) st.textContent = '最近更新 ' + new Date().toLocaleTimeString(); }, 2500); }; })();
        for (const ev of ['GENERATION_ENDED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT']) {
            const type = event_types && event_types[ev];
            if (type && eventSource && typeof eventSource.on === 'function') eventSource.on(type, debounced);
        }
    } catch { /* events unavailable */ }
}

function init() {
    S();
    buildWidget();
    buildSettings();
    hookEvents();
    schedule();
    refresh(true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
}

export { init };

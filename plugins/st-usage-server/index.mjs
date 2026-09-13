/**
 * ST Usage Monitor — SillyTavern server plugin
 * ------------------------------------------------------------------
 * Exposes the prompt-cache usage log written by the dsh-usage-monitor patch
 * (src/util.js + src/endpoints/backends/chat-completions.js):
 *
 *   GET  /api/plugins/st-usage/status          采集开关 / 日志文件状态
 *   GET  /api/plugins/st-usage/data?last=300   最近的用量记录（JSONL → JSON）
 *   POST /api/plugins/st-usage/capture         { enabled: true|false } 开关采集（写/删开关文件，无需重启）
 *   POST /api/plugins/st-usage/clear           备份并清空日志
 *
 * 日志路径：data/<user>/st-usage.jsonl
 * 开关文件：data/<user>/st-usage.capture
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT_FALLBACK = path.join(HERE, '..', '..', 'data');
const LOG_NAME = 'st-usage.jsonl';
const FLAG_NAME = 'st-usage.capture';
const MAX_RECORDS = 5000;
const MAX_BYTES = 8 * 1024 * 1024;

export const info = {
    id: 'st-usage',
    name: 'ST Usage Monitor',
    description: 'Serves the prompt-cache usage log (hit/miss tokens per request) for the ST Usage Monitor browser extension and toggles capture on/off.',
    version: '1.0.0',
    author: 'dsh',
};

/** Directories to look for a usage log in, most specific first. */
function candidateRoots(request) {
    const roots = [];
    const userRoot = request && request.user && request.user.directories && request.user.directories.root;
    if (userRoot) {
        roots.push(userRoot);
    }
    try {
        for (const entry of fs.readdirSync(DATA_ROOT_FALLBACK, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                roots.push(path.join(DATA_ROOT_FALLBACK, entry.name));
            }
        }
    } catch { /* no data dir */ }
    return roots;
}

/** Pick the user root that actually has a log (or the flagged/first one). */
function resolveRoot(request) {
    const roots = candidateRoots(request);
    for (const root of roots) {
        if (fs.existsSync(path.join(root, LOG_NAME))) return root;
    }
    for (const root of roots) {
        if (fs.existsSync(path.join(root, FLAG_NAME))) return root;
    }
    return roots[0] || null;
}

function statOf(file) {
    try {
        const s = fs.statSync(file);
        return { exists: true, size: s.size, mtime: s.mtime.toISOString() };
    } catch {
        return { exists: false, size: 0, mtime: null };
    }
}

function readRecords(file, last) {
    let raw = '';
    try {
        const size = fs.statSync(file).size;
        const start = size > MAX_BYTES ? size - MAX_BYTES : 0;
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            raw = buf.toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return { records: [], truncated: false };
    }
    const truncated = raw.length > 0 && raw[0] !== '{' && raw[0] !== '\n';
    const lines = raw.split('\n');
    if (truncated && lines.length) lines.shift();
    const records = [];
    for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        try { records.push(JSON.parse(s)); } catch { /* skip broken line */ }
    }
    const limited = records.length > MAX_RECORDS ? records.slice(-MAX_RECORDS) : records;
    const out = last > 0 && limited.length > last ? limited.slice(-last) : limited;
    return { records: out, truncated, total: limited.length };
}

function captureEnabled(root) {
    if (process.env.ST_USAGE_CAPTURE === '1') return true;
    try { return Boolean(root) && fs.existsSync(path.join(root, FLAG_NAME)); } catch { return false; }
}

export async function init(router) {
    console.log('[st-usage] plugin loaded; log file name =', LOG_NAME);
    try {
        fs.appendFileSync(path.join(HERE, 'init.log'), new Date().toISOString() + ' plugin loaded (pid ' + process.pid + ')\n', 'utf8');
    } catch { /* ignore */ }

    router.get('/status', (request, response) => {
        const root = resolveRoot(request);
        const logFile = root ? path.join(root, LOG_NAME) : null;
        response.set('Cache-Control', 'no-store');
        response.json({
            ok: true,
            version: info.version,
            root,
            logFile,
            flagFile: root ? path.join(root, FLAG_NAME) : null,
            captureEnabled: captureEnabled(root),
            captureByEnv: process.env.ST_USAGE_CAPTURE === '1',
            log: logFile ? statOf(logFile) : { exists: false },
        });
    });

    router.get('/data', (request, response) => {
        const root = resolveRoot(request);
        if (!root) {
            return response.json({ ok: false, error: 'no data root found', records: [], total: 0 });
        }
        const url = new URL(request.url || '/', 'http://x');
        const last = Number(url.searchParams.get('last') || 300);
        const logFile = path.join(root, LOG_NAME);
        const { records, truncated, total } = readRecords(logFile, Number.isFinite(last) ? last : 300);
        response.set('Cache-Control', 'no-store');
        response.json({
            ok: true,
            root,
            captureEnabled: captureEnabled(root),
            log: statOf(logFile),
            total: total ?? records.length,
            truncated: Boolean(truncated),
            records,
        });
    });

    router.post('/capture', (request, response) => {
        const root = resolveRoot(request);
        if (!root) {
            return response.status(500).json({ ok: false, error: 'no data root found' });
        }
        const flagFile = path.join(root, FLAG_NAME);
        const enabled = Boolean(request.body && (request.body.enabled === true || request.body.enabled === 'true'));
        try {
            if (enabled) {
                fs.writeFileSync(flagFile, 'dsh-usage-monitor flag: delete this file to turn capture off\n', 'utf8');
            } else if (fs.existsSync(flagFile)) {
                fs.unlinkSync(flagFile);
            }
            response.json({ ok: true, captureEnabled: captureEnabled(root), flagFile });
        } catch (e) {
            response.status(500).json({ ok: false, error: String((e && e.message) || e) });
        }
    });

    router.post('/clear', (request, response) => {
        const root = resolveRoot(request);
        if (!root) {
            return response.status(500).json({ ok: false, error: 'no data root found' });
        }
        const logFile = path.join(root, LOG_NAME);
        if (!fs.existsSync(logFile)) {
            return response.json({ ok: true, cleared: false, reason: 'no log file' });
        }
        try {
            const backup = logFile + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
            fs.copyFileSync(logFile, backup);
            fs.writeFileSync(logFile, '', 'utf8');
            response.json({ ok: true, cleared: true, backup: path.basename(backup) });
        } catch (e) {
            response.status(500).json({ ok: false, error: String((e && e.message) || e) });
        }
    });
}

export async function exit() { }

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.get('/admin', (req, res) => res.sendFile('admin.html', { root: './public' }));
app.get('/cctv', (req, res) => res.sendFile('cctv.html', { root: './public' }));
app.use(express.static('public'));
app.use('/images', express.static(path.join(__dirname, 'images')));

// --- ADMIN PIN: (day + month) × multiplier, last 4 digits. Technicians who know the formula can work it out. ---
const ADMIN_PIN_MULTIPLIER = parseInt(process.env.ADMIN_PIN_MULTIPLIER || '37', 10) || 37;
function getTodayPinNumeric() {
    const d = new Date();
    const day = d.getUTCDate();
    const month = d.getUTCMonth() + 1;
    const n = ((day + month) * ADMIN_PIN_MULTIPLIER) % 10000;
    return String(n).padStart(4, '0');
}
app.post('/api/admin-verify-pin', (req, res) => {
    try {
        const entered = String(req.body.pin || '').trim();
        const expected = getTodayPinNumeric();
        if (entered === expected) {
            res.json({ ok: true });
        } else {
            res.status(401).json({ ok: false, error: 'Invalid PIN' });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// CONFIGURATION
const CLOUD_TARGET_URL = 'https://khs-v4w8.onrender.com';
const AM_I_CLOUD = process.env.RENDER || false;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://172.16.64.105:27017/admin_monitor';
const ACTIVE_SYNC_URL = AM_I_CLOUD ? '' : CLOUD_TARGET_URL;

const VERSION = '3.0';
const G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', R = '\x1b[31m', _ = '\x1b[0m';
console.log(`
${C}+==================================================+${_}
${C}|${_}  ${Y}* SCHOOL MONITOR v${VERSION}${_}                           ${C}|${_}
${C}|${_}  --------------------------------------------------  ${C}|${_}
${C}|${_}  Booting system...                              ${C}|${_}
${C}|${_}     ${G}o_o${_}  watching the network...                  ${C}|${_}
${C}+==================================================+${_}
`);

mongoose.connect(MONGO_URI)
    .then(() => {
        const dbHost = (MONGO_URI.match(/\d+\.\d+\.\d+\.\d+/) || MONGO_URI.match(/localhost/))?.[0] || 'connected';
        console.log(`  ${G}[OK]${_} Database ready (${dbHost})`);
    })
    .catch(err => console.error(`  ${R}[!!]${_} Database error:`, err.message));

const deviceSchema = new mongoose.Schema({
    ip: String, name: String, type: String,
    status: String, last_seen: Date, last_issue: Date, lastOnlineAt: Date,
    details: Object, floor_id: String, map_coordinates: Object,
    upSince: Date  // When device was first seen online (for "Seen for X" when SNMP uptime unavailable)
}, { timestamps: true });

const Device = mongoose.model('Device', deviceSchema);

// Status history: one document per check (for 24h / 7d / 30d reporting). Index for TTL/cleanup optional.
const statusHistorySchema = new mongoose.Schema({
    ip: String,
    status: String,  // 'online' | 'amber' | 'offline'
    checkedAt: { type: Date, default: Date.now }
}, { timestamps: true });
statusHistorySchema.index({ checkedAt: 1 }, { expireAfterSeconds: 35 * 24 * 3600 }); // Auto-delete after 35 days
const StatusHistory = mongoose.model('StatusHistory', statusHistorySchema);

// --- ACKNOWLEDGED ISSUES (known problems - exclude from "problem" counts) ---
const ACK_FILE = './acknowledged-issues.json';
function readAcknowledgedIssues() {
    try {
        if (fs.existsSync(ACK_FILE)) {
            return JSON.parse(fs.readFileSync(ACK_FILE, 'utf8'));
        }
    } catch (e) { /* ignore */ }
    return [];
}
function writeAcknowledgedIssues(arr) {
    fs.writeFileSync(ACK_FILE, JSON.stringify(arr, null, 2));
}

function getActiveAcknowledgedIps(acknowledged, devicesByIp) {
    if (!Array.isArray(acknowledged)) return new Set();
    const now = Date.now();
    const ONE_H = 60 * 60 * 1000;
    const ONE_D = 24 * ONE_H;
    return new Set(
        acknowledged
            .filter(a => {
                const ip = (a.ip || a.deviceIp || '').trim();
                if (!ip) return false;
                const expires = (a.expires || a.duration || 'forever').toLowerCase();
                if (expires === 'forever') return true;
                const ackAt = new Date(a.acknowledgedAt || a.addedAt || 0).getTime();
                if (expires === '1h' && (now - ackAt) < ONE_H) return true;
                if (expires === '1d' && (now - ackAt) < ONE_D) return true;
                if (expires === 'until_online') {
                    const dev = devicesByIp && devicesByIp[ip];
                    if (!dev) return true;
                    return dev.status !== 'online';
                }
                // Clear until next problem: only count as ack while device is currently online; when it goes offline/amber again it shows in history
                if (expires === 'until_next_issue' || expires === 'until_offline') {
                    const dev = devicesByIp && devicesByIp[ip];
                    if (!dev) return false;
                    return dev.status === 'online';
                }
                return true;
            })
            .map(a => (a.ip || a.deviceIp || '').trim())
            .filter(Boolean)
    );
}

app.get('/api/acknowledged-issues', async (req, res) => {
    try {
        const raw = readAcknowledgedIssues();
        if (req.query.active === '1' || req.query.active === 'true') {
            const devices = await Device.find().lean();
            const devicesByIp = {};
            devices.forEach(d => { devicesByIp[d.ip] = d; });
            const activeSet = getActiveAcknowledgedIps(raw, devicesByIp);
            const activeList = (raw || []).filter(a => activeSet.has((a.ip || a.deviceIp || '').trim()));
            return res.json(activeList);
        }
        res.json(raw);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/acknowledged-issues', (req, res) => {
    try {
        const body = Array.isArray(req.body) ? req.body : (req.body.items || []);
        writeAcknowledgedIssues(body);
        res.json({ message: 'Saved', count: body.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- HISTORY SUMMARY (24h, 7d, 30d) ---
app.get('/api/history/summary', async (req, res) => {
    try {
        const period = (req.query.period || '24h').toLowerCase();
        let hours = 24;
        if (period === '7d' || period === '7') hours = 24 * 7;
        else if (period === '30d' || period === '30') hours = 24 * 30;
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);

        const acknowledged = readAcknowledgedIssues();
        const devices = await Device.find().lean();
        const devicesByIp = {};
        devices.forEach(d => { devicesByIp[d.ip] = d; });
        const ackIps = getActiveAcknowledgedIps(acknowledged, devicesByIp);

        const agg = await StatusHistory.aggregate([
            { $match: { checkedAt: { $gte: since } } },
            { $group: {
                _id: '$ip',
                online: { $sum: { $cond: [{ $eq: ['$status', 'online'] }, 1, 0] } },
                amber: { $sum: { $cond: [{ $eq: ['$status', 'amber'] }, 1, 0] } },
                offline: { $sum: { $cond: [{ $eq: ['$status', 'offline'] }, 1, 0] } }
            } }
        ]);
        const byIp = {};
        let totalChecks = 0;
        agg.forEach(g => {
            byIp[g._id] = { online: g.online, amber: g.amber, offline: g.offline };
            totalChecks += g.online + g.amber + g.offline;
        });
        let problematicChecks = 0;
        const devicesWithUnackProblems = [];
        const devicesWithAckProblems = [];

        Object.entries(byIp).forEach(([ip, counts]) => {
            const failCount = counts.offline + counts.amber;
            if (failCount === 0) return;
            problematicChecks += failCount;
            const isAck = ackIps.has(ip);
            if (isAck) devicesWithAckProblems.push({ ip, ...counts });
            else devicesWithUnackProblems.push({ ip, ...counts });
        });

        const deviceNames = {};
        devices.forEach(d => { deviceNames[d.ip] = d.name || d.ip; });

        [devicesWithUnackProblems, devicesWithAckProblems].forEach(arr => {
            arr.forEach(o => { o.name = deviceNames[o.ip] || o.ip; });
        });

        res.json({
            period,
            since: since.toISOString(),
            totalChecks,
            problematicChecks,
            unacknowledgedProblemCount: devicesWithUnackProblems.length,
            acknowledgedProblemCount: devicesWithAckProblems.length,
            devicesWithUnacknowledgedProblems: devicesWithUnackProblems,
            devicesWithAcknowledgedProblems: devicesWithAckProblems,
            noProblematicFailsRecently: devicesWithUnackProblems.length === 0
        });
    } catch (e) {
        console.error('[history/summary]', e);
        res.status(500).json({ error: e.message });
    }
});

// --- 1. STATUS/PING ROUTE ---
app.get('/api/status', (req, res) => {
    const cmd = process.platform === 'win32' ? 'ping -n 1 8.8.8.8' : 'ping -c 1 8.8.8.8';
    
    exec(cmd, { timeout: 2000 }, (err, stdout, stderr) => {
        let time = "999";

        if (!err) {
            const match = stdout.match(/time[=< ]*([\d\.]+)/i);
            if (match && match[1]) {
                time = Math.round(parseFloat(match[1])).toString();
            }
        }
        
        res.json({ ping: time });
    });
});

// --- 2. MAP CONFIG ROUTES ---
app.get('/api/map-config', (req, res) => {
    try {
        if (fs.existsSync('./map-config.json')) {
            res.json(JSON.parse(fs.readFileSync('./map-config.json', 'utf8')));
        } else {
            res.json([
                { id: 'T-G.PNG', name: 'T Site - Ground', active: true },
                { id: 'T-1.PNG', name: 'T Site - 1st Floor', active: true },
                { id: 'T-M.PNG', name: 'T Site - Mezzanine', active: true },
                { id: 'K-G.PNG', name: 'K Site - Ground', active: true },
                { id: 'K-1.PNG', name: 'K Site - 1st Floor', active: true },
                { id: 'K-2.PNG', name: 'K Site - 2nd Floor', active: true }
            ]);
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/map-config', (req, res) => {
    try {
        fs.writeFileSync('./map-config.json', JSON.stringify(req.body, null, 2));
        res.json({ message: "Saved" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 3. CARD CONFIG ROUTES ---
app.get('/api/card-config', (req, res) => {
    try {
        if (fs.existsSync('./card-config.json')) {
            res.json(JSON.parse(fs.readFileSync('./card-config.json', 'utf8')));
        } else { res.json({}); }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/card-config', (req, res) => {
    try {
        fs.writeFileSync('./card-config.json', JSON.stringify(req.body, null, 2));
        res.json({ message: "Saved" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 3a. MONITOR SETTINGS (device connection URL template, etc.) ---
const MONITOR_SETTINGS_FILE = './monitor-settings.json';
function readMonitorSettings() {
    try {
        if (fs.existsSync(MONITOR_SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(MONITOR_SETTINGS_FILE, 'utf8'));
        }
    } catch (e) { /* ignore */ }
    return { deviceConnectionTemplate: 'http://{{ip}}' };
}
function writeMonitorSettings(obj) {
    fs.writeFileSync(MONITOR_SETTINGS_FILE, JSON.stringify(obj, null, 2));
}
app.get('/api/monitor-settings', (req, res) => {
    try { res.json(readMonitorSettings()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/monitor-settings', (req, res) => {
    try {
        const current = readMonitorSettings();
        const next = { ...current, ...req.body };
        writeMonitorSettings(next);
        res.json({ message: 'Saved', settings: next });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 3b. DEVICE LOGIN URLS (per-device connection/login URL override) ---
const DEVICE_LOGIN_URLS_FILE = './device-login-urls.json';
function readDeviceLoginUrls() {
    try {
        if (fs.existsSync(DEVICE_LOGIN_URLS_FILE)) {
            return JSON.parse(fs.readFileSync(DEVICE_LOGIN_URLS_FILE, 'utf8'));
        }
    } catch (e) { /* ignore */ }
    return {};
}
function writeDeviceLoginUrls(obj) {
    fs.writeFileSync(DEVICE_LOGIN_URLS_FILE, JSON.stringify(obj, null, 2));
}
app.get('/api/device-login-urls', (req, res) => {
    try { res.json(readDeviceLoginUrls()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/device-login-urls', (req, res) => {
    try {
        const urls = readDeviceLoginUrls();
        const { ip, loginUrl } = req.body || {};
        if (ip !== undefined && ip !== null && ip !== '') {
            const key = String(ip).trim();
            if (loginUrl === undefined || loginUrl === null || String(loginUrl).trim() === '') {
                delete urls[key];
            } else {
                urls[key] = String(loginUrl).trim();
            }
            writeDeviceLoginUrls(urls);
        }
        res.json({ message: 'Saved', urls: readDeviceLoginUrls() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 3c. DEVICE NOTES (user notes per device) ---
const DEVICE_NOTES_FILE = './device-notes.json';
function readDeviceNotes() {
    try {
        if (fs.existsSync(DEVICE_NOTES_FILE)) {
            return JSON.parse(fs.readFileSync(DEVICE_NOTES_FILE, 'utf8'));
        }
    } catch (e) { /* ignore */ }
    return {};
}
function writeDeviceNotes(obj) {
    fs.writeFileSync(DEVICE_NOTES_FILE, JSON.stringify(obj, null, 2));
}
app.get('/api/device-notes', (req, res) => {
    try { res.json(readDeviceNotes()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/device-notes', (req, res) => {
    try {
        const notes = readDeviceNotes();
        const { ip, note } = req.body || {};
        if (ip !== undefined && ip !== null && ip !== '') {
            const key = String(ip).trim();
            if (note === undefined || note === null || note === '') {
                delete notes[key];
            } else {
                notes[key] = String(note).trim();
            }
            writeDeviceNotes(notes);
        }
        res.json({ message: 'Saved', notes: readDeviceNotes() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 3c2. DEVICE OVERRIDES (per-device overrides to hardware self-reporting, e.g. expected NVR drives) ---
const DEVICE_OVERRIDES_FILE = './device-overrides.json';
function readDeviceOverrides() {
    try {
        if (fs.existsSync(DEVICE_OVERRIDES_FILE)) {
            return JSON.parse(fs.readFileSync(DEVICE_OVERRIDES_FILE, 'utf8'));
        }
    } catch (e) { /* ignore */ }
    return {};
}
function writeDeviceOverrides(obj) {
    fs.writeFileSync(DEVICE_OVERRIDES_FILE, JSON.stringify(obj, null, 2));
}
app.get('/api/device-overrides', (req, res) => {
    try { res.json(readDeviceOverrides()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/device-overrides', (req, res) => {
    try {
        const overrides = readDeviceOverrides();
        const { ip, overrides: perDevice } = req.body || {};
        if (ip !== undefined && ip !== null && String(ip).trim() !== '') {
            const key = String(ip).trim();
            if (!perDevice || typeof perDevice !== 'object' || Object.keys(perDevice).length === 0) {
                delete overrides[key];
            } else {
                overrides[key] = perDevice;
            }
            writeDeviceOverrides(overrides);
        } else if (req.body && typeof req.body.overrides === 'object') {
            // Bulk replace
            writeDeviceOverrides(req.body.overrides);
        }
        res.json({ message: 'Saved', overrides: readDeviceOverrides() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 3c3. DISPLAY LABELS CONFIG (which labels to show per device type on dashboard) ---
const DISPLAY_LABELS_FILE = './display-labels-config.json';
function readDisplayLabelsConfig() {
    try {
        if (fs.existsSync(DISPLAY_LABELS_FILE)) {
            return JSON.parse(fs.readFileSync(DISPLAY_LABELS_FILE, 'utf8'));
        }
    } catch (e) { /* ignore */ }
    return {};
}
function writeDisplayLabelsConfig(obj) {
    fs.writeFileSync(DISPLAY_LABELS_FILE, JSON.stringify(obj, null, 2));
}
app.get('/api/display-labels-config', (req, res) => {
    try { res.json(readDisplayLabelsConfig()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/display-labels-config', (req, res) => {
    try {
        if (req.body && typeof req.body === 'object') {
            writeDisplayLabelsConfig(req.body);
        }
        res.json({ message: 'Saved', config: readDisplayLabelsConfig() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 3d. REPRO CONFIG ROUTES (Printer visibility for reprographics page) ---
app.get('/api/repro-config', (req, res) => {
    try {
        if (fs.existsSync('./repro-config.json')) {
            res.json(JSON.parse(fs.readFileSync('./repro-config.json', 'utf8')));
        } else { 
            // Default: empty object means all printers visible
            res.json({}); 
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/repro-config', (req, res) => {
    try {
        fs.writeFileSync('./repro-config.json', JSON.stringify(req.body, null, 2));
        res.json({ message: "Saved" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sync repro config from local to cloud (server-side to avoid CORS)
app.post('/api/repro-config/sync-to-cloud', async (req, res) => {
    if (AM_I_CLOUD) {
        return res.status(400).json({ error: "Already on cloud server" });
    }
    try {
        // Read local config
        let localConfig = {};
        if (fs.existsSync('./repro-config.json')) {
            localConfig = JSON.parse(fs.readFileSync('./repro-config.json', 'utf8'));
        }
        
        // Push to cloud
        const response = await axios.post(`${CLOUD_TARGET_URL}/api/repro-config`, localConfig, {
            headers: { 'Content-Type': 'application/json' }
        });
        
        res.json({ message: "Synced to cloud", cloudResponse: response.data });
    } catch (e) {
        console.error('Repro sync error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- 3e. CAMERAS CONFIG (Camera visibility for security/behaviour staff page) ---
app.get('/api/cameras-config', (req, res) => {
    try {
        if (fs.existsSync('./cameras-config.json')) {
            res.json(JSON.parse(fs.readFileSync('./cameras-config.json', 'utf8')));
        } else {
            res.json({}); // Default: all cameras visible
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cameras-config', (req, res) => {
    try {
        fs.writeFileSync('./cameras-config.json', JSON.stringify(req.body, null, 2));
        res.json({ message: "Saved" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cameras-config/sync-to-cloud', async (req, res) => {
    if (AM_I_CLOUD) {
        return res.status(400).json({ error: "Already on cloud server" });
    }
    try {
        let localConfig = {};
        if (fs.existsSync('./cameras-config.json')) {
            localConfig = JSON.parse(fs.readFileSync('./cameras-config.json', 'utf8'));
        }
        const response = await axios.post(`${CLOUD_TARGET_URL}/api/cameras-config`, localConfig, {
            headers: { 'Content-Type': 'application/json' }
        });
        res.json({ message: "Synced to cloud", cloudResponse: response.data });
    } catch (e) {
        console.error('Cameras sync error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- 3f. CAMERA PREVIEW (Server-side proxy with auth, NO CACHE - avoids heap exhaustion) ---
const CAMERA_PREVIEW_CONFIG_FILE = './camera-preview-config.json';
const PREVIEW_MAX_BYTES = 1024 * 1024;  // 1MB max per response

function readCameraPreviewConfig() {
    try {
        if (fs.existsSync(CAMERA_PREVIEW_CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CAMERA_PREVIEW_CONFIG_FILE, 'utf8'));
        }
    } catch (e) { /* ignore */ }
    return { username: 'admin', password: 'Mcshine6!', path: '/doc/page/preview.asp' };
}

function injectPreviewHtml(html, ip, path) {
    const baseHref = 'http://' + ip + path.replace(/\/[^/]+$/, '/');
    const inject = '<base href="' + baseHref + '"><style>html,body{overflow:hidden!important;margin:0!important;padding:0!important}</style>';
    const headEnd = html.indexOf('</head>');
    const insertAt = headEnd >= 0 ? headEnd : html.indexOf('<body');
    if (insertAt >= 0) return html.slice(0, insertAt) + inject + html.slice(insertAt);
    return html;
}

async function fetchCameraWithAuth(url, cfg, options = {}) {
    const { default: DigestClient } = await import('digest-fetch');
    const useBasic = cfg.authType === 'basic';
    const client = new DigestClient(cfg.username || 'admin', cfg.password || '', { basic: useBasic });
    const resp = await client.fetch(url, {
        ...options,
        headers: { 'User-Agent': 'SchoolMonitor/1.0', ...options.headers }
    });
    if (!resp.ok) throw new Error('Request failed with status code ' + resp.status);
    const cl = parseInt(resp.headers.get('content-length') || '0', 10);
    if (cl > PREVIEW_MAX_BYTES) throw new Error('Response too large: ' + cl);
    const data = Buffer.from(await resp.arrayBuffer());
    if (data.length > PREVIEW_MAX_BYTES) throw new Error('Response too large: ' + data.length);
    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    return { data, contentType };
}

app.get('/api/camera-preview/:ip', async (req, res) => {
    const ip = (req.params.ip || '').trim();
    if (!ip || ip.includes('/') || ip.includes(':')) return res.status(400).json({ error: 'Invalid IP' });
    try {
        const cfg = readCameraPreviewConfig();
        const path = cfg.path || '/doc/page/preview.asp';
        const url = 'http://' + ip + path;
        let { data, contentType } = await fetchCameraWithAuth(url, cfg, { timeout: 8000 });
        if (contentType.includes('text/html')) {
            data = Buffer.from(injectPreviewHtml(data.toString('utf8'), ip, path), 'utf8');
        }
        res.set('Content-Type', contentType);
        res.send(data);
    } catch (e) {
        res.status(502).send('Preview unavailable');
    }
});

app.get('/api/camera-preview/:ip/snapshot', async (req, res) => {
    const ip = (req.params.ip || '').trim();
    if (!ip || ip.includes('/') || ip.includes(':')) {
        return res.status(400).json({ error: 'Invalid IP' });
    }
    try {
        const cfg = readCameraPreviewConfig();
        const path = cfg.snapshotPath || '/ISAPI/Streaming/channels/101/picture';
        const url = 'http://' + ip + path;
        const { data, contentType } = await fetchCameraWithAuth(url, cfg, { timeout: 6000 });
        res.set('Content-Type', contentType || 'image/jpeg');
        res.send(data);
    } catch (e) {
        console.error('Camera snapshot error for ' + ip + ':', e.message);
        res.status(502).send('Snapshot unavailable');
    }
});

app.get('/api/camera-preview-config', (req, res) => {
    try {
        const cfg = readCameraPreviewConfig();
        res.json({ username: cfg.username, path: cfg.path, snapshotPath: cfg.snapshotPath });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/camera-preview/preload', (req, res) => {
    res.json({ preloaded: 0 });  // no-op: caching disabled to prevent heap exhaustion
});

// Deduplicate devices by IP: keep only the latest (by updatedAt) per IP
function dedupeDevicesByIp(devices) {
    const byIp = new Map();
    for (const d of devices || []) {
        const ip = (d.ip || '').trim();
        if (!ip) continue;
        const existing = byIp.get(ip);
        if (!existing || new Date(d.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
            byIp.set(ip, d);
        }
    }
    return Array.from(byIp.values());
}

// --- 4. DEVICE CRUD ROUTES ---
app.get('/api/devices', async (req, res) => {
    try {
        const raw = await Device.find().sort({ updatedAt: -1 }).lean();
        const deduped = dedupeDevicesByIp(raw);
        res.json(deduped);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/devices-dedupe', async (req, res) => {
    try {
        const raw = await Device.find().sort({ updatedAt: -1 }).lean();
        const byIp = new Map();
        const toDelete = [];
        for (const d of raw) {
            const ip = (d.ip || '').trim();
            if (!ip) continue;
            if (byIp.has(ip)) toDelete.push(d._id);
            else byIp.set(ip, d);
        }
        if (toDelete.length > 0) {
            await Device.deleteMany({ _id: { $in: toDelete } });
            console.log(`[dedupe] Removed ${toDelete.length} duplicate devices`);
        }
        res.json({ message: "Deduplicated", removed: toDelete.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- REPORT EXPORT ---
app.get('/api/report', async (req, res) => {
    try {
        const format = (req.query.format || 'json').toLowerCase();
        const devices = await Device.find().lean();
        const acknowledged = readAcknowledgedIssues();
        const summary = {
            generatedAt: new Date().toISOString(),
            deviceCount: devices.length,
            acknowledgedCount: (acknowledged || []).length,
            devices: devices.map(d => ({
                name: d.name,
                ip: d.ip,
                type: d.type,
                status: d.status,
                last_seen: d.last_seen,
                last_issue: d.last_issue,
                details: d.details,
                floor_id: d.floor_id
            }))
        };
        if (format === 'csv') {
            const header = 'Name,IP,Type,Status,Last Seen,Last Issue,Note\n';
            const rows = devices.map(d => {
                const note = (d.details && d.details.note) ? String(d.details.note).replace(/"/g, '""') : '';
                return `"${(d.name || '').replace(/"/g, '""')}","${d.ip || ''}","${d.type || ''}","${d.status || ''}","${d.last_seen || ''}","${d.last_issue || ''}","${note}"`;
            }).join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=monitor-report-${Date.now()}.csv`);
            return res.send('\uFEFF' + header + rows);
        }
        res.json(summary);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Propagate switch IP change to all devices that reference it (linkedSwitchIp, etc.)
async function propagateSwitchIpChange(oldIp, newIp) {
    if (!oldIp || !newIp || oldIp === newIp) return 0;
    const o = String(oldIp).trim();
    const n = String(newIp).trim();
    if (!o || !n || o === n) return 0;
    const refResult = await Device.updateMany(
        { $or: [
            { 'details.linkedSwitchIp': o },
            { 'details.switchIp': o },
            { 'details.switch_ip': o }
        ] },
        { $set: {
            'details.linkedSwitchIp': n,
            'details.switchIp': n,
            'details.switch_ip': n
        } }
    );
    if (refResult.modifiedCount > 0) {
        console.log(`[propagate] Updated ${refResult.modifiedCount} linked references from ${o} -> ${n}`);
    }
    return refResult.modifiedCount;
}

app.post('/api/propagate-switch-ip', async (req, res) => {
    try {
        const { oldIp, newIp } = req.body || {};
        const o = (oldIp || '').trim();
        const n = (newIp || '').trim();
        if (!o || !n || o === n) return res.status(400).json({ error: "oldIp and newIp required and must differ" });
        const count = await propagateSwitchIpChange(o, n);
        res.json({ message: "Propagated", updatedCount: count });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/add-device', async (req, res) => {
    try {
        const { ip, previousIp, ifUpdatedAt, ...rest } = req.body;
        const newIp = (ip || '').trim();
        const oldIp = (previousIp || '').trim();

        const checkConflict = async (deviceIp) => {
            if (!ifUpdatedAt) return null;
            const current = await Device.findOne({ ip: deviceIp }).lean();
            if (!current) return null;
            const curr = current.updatedAt ? new Date(current.updatedAt).getTime() : 0;
            const expected = new Date(ifUpdatedAt).getTime();
            if (curr !== expected) return { current, expected };
            return null;
        };

        if (oldIp && newIp && oldIp !== newIp) {
            const conflict = await checkConflict(oldIp);
            if (conflict) return res.status(409).json({ error: 'Conflict', message: 'Someone else has changed this device. Please refresh and try again.' });
            const existing = await Device.findOne({ ip: oldIp }).lean();
            if (existing) {
                await Device.deleteMany({ ip: newIp }); // Prevent duplicates: remove any device already at newIp
                const update = { ...req.body, ip: newIp };
                delete update.previousIp;
                delete update.ifUpdatedAt;
                await Device.findOneAndUpdate({ ip: oldIp }, update);
                await propagateSwitchIpChange(oldIp, newIp);
                // Update device-login-urls and device-notes by IP
                const urls = readDeviceLoginUrls();
                if (urls[oldIp] !== undefined) {
                    urls[newIp] = urls[oldIp];
                    delete urls[oldIp];
                    writeDeviceLoginUrls(urls);
                }
                const notes = readDeviceNotes();
                if (notes[oldIp] !== undefined) {
                    notes[newIp] = notes[oldIp];
                    delete notes[oldIp];
                    writeDeviceNotes(notes);
                }
                return res.json({ message: "Saved" });
            }
        }

        const conflict = await checkConflict(newIp);
        if (conflict) return res.status(409).json({ error: 'Conflict', message: 'Someone else has changed this device. Please refresh and try again.' });
        const updateBody = { ...req.body };
        delete updateBody.ifUpdatedAt;
        // When status is provided (e.g. agent sync), set last_seen and transition fields like update-status
        if (updateBody.status) {
            updateBody.last_seen = new Date();
            if (updateBody.status === 'offline' || updateBody.status === 'amber') {
                const current = await Device.findOne({ ip: newIp }).lean();
                if (current && current.status === 'online') updateBody.lastOnlineAt = current.last_seen || new Date();
                updateBody.last_issue = new Date();
                updateBody.upSince = null;
            } else if (updateBody.status === 'online') {
                const current = await Device.findOne({ ip: newIp }).lean();
                if (current && current.status !== 'online') updateBody.upSince = new Date();
                else if (!current || current.upSince == null) updateBody.upSince = new Date();
            }
        }
        await Device.findOneAndUpdate({ ip: newIp }, updateBody, { upsert: true });
        res.json({ message: "Saved" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// =================================================================
// 🔧 CRITICAL FIX: ADD THE MISSING UPDATE-STATUS ENDPOINT
// This is what the agent calls to update device status and details
// =================================================================
app.post('/api/update-status', async (req, res) => {
    try {
        const { ip, status, details } = req.body;
        
        if (!ip) {
            return res.status(400).json({ error: "IP required" });
        }

        const updateData = { last_seen: new Date() };

        if (status) {
            updateData.status = status;
            if (status === 'offline' || status === 'amber') {
                const current = await Device.findOne({ ip }).lean();
                if (current && current.status === 'online') updateData.lastOnlineAt = current.last_seen || new Date();
                updateData.last_issue = new Date();
                updateData.upSince = null;  // Clear "seen for" when device goes down
            } else if (status === 'online') {
                const current = await Device.findOne({ ip }).lean();
                if (current && current.status !== 'online') updateData.upSince = new Date();
                else if (!current || current.upSince == null) updateData.upSince = new Date();
            }
        }

        if (details && typeof details === 'object') {
            for (const [key, value] of Object.entries(details)) {
                if (value !== undefined && value !== null && value !== '') {
                    updateData[`details.${key}`] = value;
                }
            }
        }

        const result = await Device.findOneAndUpdate(
            { ip: ip },
            { $set: updateData },
            { upsert: false, new: true }
        );

        // Record status history for 24h / 7d / 30d reporting
        if (result && status) {
            StatusHistory.create({ ip, status, checkedAt: new Date() }).catch(() => {});
        }

        if (result) {
            res.json({ message: "Updated", device: result.name });
        } else {
            // Device not found in DB - might be new, log it
            console.log(`[UPDATE] Device not found: ${ip}`);
            res.json({ message: "Device not found", ip: ip });
        }
    } catch (e) {
        console.error(`[UPDATE ERROR] ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Alternative: Bulk update endpoint for efficiency
app.post('/api/update-status-bulk', async (req, res) => {
    try {
        const updates = req.body; // Array of { ip, status, details }
        
        if (!Array.isArray(updates)) {
            return res.status(400).json({ error: "Expected array of updates" });
        }

        const         results = await Promise.all(updates.map(async ({ ip, status, details }) => {
            const updateData = { last_seen: new Date() };
            if (status) {
                updateData.status = status;
                if (status === 'offline' || status === 'amber') {
                    const current = await Device.findOne({ ip }).lean();
                    if (current && current.status === 'online') updateData.lastOnlineAt = current.last_seen || new Date();
                    updateData.last_issue = new Date();
                    updateData.upSince = null;
                } else if (status === 'online') {
                    const current = await Device.findOne({ ip }).lean();
                    if (current && current.status !== 'online') updateData.upSince = new Date();
                    else if (!current || current.upSince == null) updateData.upSince = new Date();
                }
            }
            if (details && typeof details === 'object') {
                for (const [key, value] of Object.entries(details)) {
                    if (value !== undefined && value !== null && value !== '') {
                        updateData[`details.${key}`] = value;
                    }
                }
            }
            const r = await Device.findOneAndUpdate({ ip }, { $set: updateData }, { new: true });
            if (r && status) StatusHistory.create({ ip, status, checkedAt: new Date() }).catch(() => {});
            return r;
        }));

        res.json({ message: "Bulk updated", count: results.filter(r => r).length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/remove-device/:ip', async (req, res) => {
    try {
        await Device.deleteOne({ ip: req.params.ip });
        res.json({ message: "Deleted" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 5. UTILITY ROUTES ---
app.post('/api/reset-db', async (req, res) => {
    try { await Device.deleteMany({}); res.json({ message: "Wiped" }); } 
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sync-from-db', async (req, res) => {
    if (!AM_I_CLOUD && ACTIVE_SYNC_URL) {
        try {
            const resp = await axios.get(`${ACTIVE_SYNC_URL}/api/devices`);
            for (const d of resp.data) {
                const { _id, ...clean } = d;
                await Device.findOneAndUpdate({ ip: clean.ip }, clean, { upsert: true });
            }
            res.json({ message: "Synced" });
        } catch (e) { res.status(500).json({ error: e.message }); }
    } else { res.json({ message: "No Sync Target" }); }
});

app.post('/api/relearn-device', async (req, res) => {
    try {
        await Device.findOneAndUpdate({ ip: req.body.ip }, { $unset: { details: 1 }, status: 'amber' });
        res.json({ message: "Reset for scanning" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 6. DEBUG ROUTE - See what's in the database ---
app.get('/api/debug/device/:ip', async (req, res) => {
    try {
        const device = await Device.findOne({ ip: req.params.ip });
        res.json(device || { error: "Not found" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    const mode = AM_I_CLOUD ? 'cloud' : 'local';
    console.log(`  ${G}[OK]${_} HTTP server listening on port ${C}${PORT}${_} (${mode} mode)`);
    console.log(`  ${G}────────────────────────────────────────────────${_}\n`);
});

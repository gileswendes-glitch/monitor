// --- GLOBAL SSL BYPASS ---
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; 

const ping = require('ping');
const axios = require('axios');
const snmp = require('net-snmp');
const dns = require('dns').promises; 

// =================================================================
// 🔧 CONFIGURATION
// =================================================================
const LOCAL_API_URL = 'http://172.16.211.117:3000/api'; 
const CLOUD_API_URL = process.env.CLOUD_API_URL || ''; 
const BATCH_SIZE = 50; 
// =================================================================

const localClient = axios.create({ timeout: 5000, proxy: false });
const cloudClient = axios.create({ timeout: 10000, proxy: false });

console.log(`\n=================================================`);
console.log(`🤖 AGENT v38.0 (TRUE SYSTEM UPTIME + SMART FORMAT)`);
console.log(`📍 DB Target: ${LOCAL_API_URL}`);
console.log(`=================================================\n`);

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
function logError(msg) { console.error(`[${new Date().toLocaleTimeString()}] ❌ ${msg}`); }

function createSafeSession(ip, community, options) {
    try {
        const session = snmp.createSession(ip, community, {
            timeout: 10000,
            retries: 1,    
            ...options
        });
        const originalClose = session.close.bind(session);
        let closed = false;
        session.close = () => { if(!closed) { closed=true; try{originalClose();}catch(e){} } };
        return session;
    } catch (e) { return null; }
}

async function reportStatus(ip, status, details) {
    const payload = { ip, status, details };
    try { await localClient.post(`${LOCAL_API_URL}/update-status`, payload); } catch (e) { }
    if (CLOUD_API_URL) try { await cloudClient.post(`${CLOUD_API_URL}/update-status`, payload); } catch (e) {}
}

async function resolveIP(input) {
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(input)) return input;
    try { const l = await dns.lookup(input); return l.address; } catch (e) { return input; }
}

// IMPROVED FORMATTER: Shows minutes if < 1 day
function formatUptime(ticks) {
    if (!ticks) return "N/A";
    const totalSeconds = ticks / 100;
    const days = Math.floor(totalSeconds / (3600 * 24));
    const hours = Math.floor((totalSeconds % (3600 * 24)) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (days === 0) {
        if (hours === 0) return `${minutes}m`;
        return `${hours}h ${minutes}m`;
    }
    return `${days}d ${hours}h`;
}

// =================================================================
// 🧠 1. WINDOWS SERVER (TRUE UPTIME FIX)
// =================================================================
function checkWindowsServer(ip) {
    return new Promise((resolve) => {
        const session = createSafeSession(ip, "public", { version: snmp.Version1 });
        if(!session) return resolve(null);

        let stats = { cpu: 0, ram: 0, disk: 0, uptime: "" };

        // OID CHANGE: Use hrSystemUptime (.25.1.1.0) instead of sysUpTime (.1.3.0)
        session.get(["1.3.6.1.2.1.25.1.1.0"], (err, vbs) => {
            if (err) { session.close(); return resolve(null); } 
            stats.uptime = formatUptime(vbs[0].value);

            // 1. CPU SCAN
            session.subtree("1.3.6.1.2.1.25.3.3.1.2", (varbinds) => {
                if (varbinds.length > 0) {
                    let total = varbinds.reduce((sum, vb) => sum + vb.value, 0);
                    stats.cpu = Math.round(total / varbinds.length);
                }
            }, (err) => {
                // 2. MANUAL STORAGE WALK
                if (err) { session.close(); return resolve({ status: 'online', details: stats }); }

                const storageData = {};
                
                session.subtree("1.3.6.1.2.1.25.2.3.1", (varbinds) => {
                    varbinds.forEach(vb => {
                        if (snmp.isVarbindError(vb)) return;
                        const parts = vb.oid.split('.');
                        const index = parts[parts.length - 1];
                        const col = parts[parts.length - 2];
                        const val = vb.value.toString();

                        if (!storageData[index]) storageData[index] = { index };
                        if (col === '2') storageData[index].type = val;
                        if (col === '3') storageData[index].desc = val;
                        if (col === '5') storageData[index].size = parseInt(val || 0);
                        if (col === '6') storageData[index].used = parseInt(val || 0);
                    });
                }, (err2) => {
                    session.close();
                    
                    Object.values(storageData).forEach(row => {
                        if (!row.size || row.size <= 0) return;
                        const pct = Math.round((row.used / row.size) * 100);
                        const desc = (row.desc || "").toLowerCase();
                        const type = (row.type || "");

                        if (desc.includes("physical memory")) stats.ram = pct;
                        if (desc.includes("c:") || (type.includes("25.2.1.4") && desc.includes("c:"))) stats.disk = pct;
                    });

                    log(`✅ [WIN] ${ip} Up:${stats.uptime} CPU:${stats.cpu}% RAM:${stats.ram}% Disk:${stats.disk}%`);
                    resolve({ status: 'online', details: stats });
                });
            });
        });
        session.on('error', () => session.close());
    });
}

// =================================================================
// 🧱 2. SMOOTHWALL (TRUE UPTIME FIX)
// =================================================================
function checkSmoothwall(ip) {
    return new Promise((resolve) => {
        const session = createSafeSession(ip, "smoothwallsnmp", { version: snmp.Version1 });
        if(!session) return resolve(null);

        let stats = { uptime: "", ram: 0, disk: 0, sysName: "Smoothwall" };

        // OID CHANGE: hrSystemUptime (.25.1.1.0) + sysName (.1.5.0)
        session.get(["1.3.6.1.2.1.25.1.1.0", "1.3.6.1.2.1.1.5.0"], (err, vbs) => {
            if (err) { session.close(); return resolve(null); }
            stats.uptime = formatUptime(vbs[0].value);
            stats.sysName = vbs[1].value.toString();

            const storageData = {};

            session.subtree("1.3.6.1.2.1.25.2.3.1", (varbinds) => {
                varbinds.forEach(vb => {
                    if (snmp.isVarbindError(vb)) return;
                    const parts = vb.oid.split('.');
                    const index = parts[parts.length - 1];
                    const col = parts[parts.length - 2];
                    const val = vb.value.toString();

                    if (!storageData[index]) storageData[index] = {};
                    if (col === '2') storageData[index].type = val;
                    if (col === '3') storageData[index].desc = val;
                    if (col === '5') storageData[index].size = parseInt(val || 0);
                    if (col === '6') storageData[index].used = parseInt(val || 0);
                });
            }, (err2) => {
                session.close();
                Object.values(storageData).forEach(row => {
                    if (!row.size || row.size <= 0) return;
                    const pct = Math.round((row.used / row.size) * 100);
                    const desc = (row.desc || "").toLowerCase();
                    
                    if (desc.includes("physical memory")) stats.ram = pct;
                    if (desc === "/var/log" || (desc === "/" && stats.disk === 0)) stats.disk = pct;
                });
                log(`✅ [FW] ${ip} Up:${stats.uptime} RAM:${stats.ram}% Disk:${stats.disk}%`);
                resolve({ status: 'online', details: stats });
            });
        });
        session.on('error', () => session.close());
    });
}

// =================================================================
// 🖨️ 3. PRINTERS
// =================================================================
function checkPrinter(ip) {
    return new Promise((resolve) => {
        const session = createSafeSession(ip, "public", { version: snmp.Version1 });
        if(!session) return resolve(null);
        const oidAlerts = "1.3.6.1.2.1.43.18.1.1.8";
        let alerts = [];
        session.subtree(oidAlerts, (vbs) => {
            vbs.forEach(vb => { if(!snmp.isVarbindError(vb)) alerts.push(vb.value.toString()); });
        }, (err) => {
            session.close();
            if (alerts.length > 0) {
                const clean = alerts.filter(a => !a.toLowerCase().includes("printing") && !a.toLowerCase().includes("ready"));
                resolve({ status: clean.length > 0 ? 'amber' : 'online', details: { note: clean.join(", ") || "Ready" } });
            } else resolve({ status: 'online', details: { note: "Ready" } });
        });
        session.on('error', () => { session.close(); resolve({status:'online', details:{note:"Ready"}}); });
    });
}

// =================================================================
// 💾 4. HP SAN
// =================================================================
function checkHpSan(ip) {
    return new Promise((resolve) => {
        const session = createSafeSession(ip, "public", { version: snmp.Version2c });
        if(!session) return resolve(null);
        let maxHealth = 0;
        session.subtree("1.3.6.1.3.94.1.6.1.6", (vbs) => {
            vbs.forEach(vb => { if(!snmp.isVarbindError(vb) && vb.value > maxHealth) maxHealth = vb.value; });
        }, (err) => {
            if (err) { session.close(); return resolve(null); }
            session.get(["1.3.6.1.2.1.1.5.0"], (e2, vbs2) => {
                session.close();
                const name = (!e2 && !snmp.isVarbindError(vbs2[0])) ? vbs2[0].value.toString() : "HP SAN";
                let msg = (maxHealth === 3 || maxHealth === 2) ? "Health: OK" : "Health: Alert";
                resolve({ status: (maxHealth >= 4) ? 'amber' : 'online', details: { sysName: name, note: msg } });
            });
        });
        session.on('error', () => { session.close(); resolve(null); });
    });
}

// =================================================================
// 📶 5. CAMBIUM WAP
// =================================================================
function checkCambium(ip) {
    return new Promise((resolve) => {
        const session = createSafeSession(ip, "public", { version: snmp.Version2c });
        if(!session) return resolve(null);
        let totalClients = 0;
        session.subtree("1.3.6.1.4.1.17713.22.1.4.1.7", (vbs) => {
            vbs.forEach(vb => { if(!snmp.isVarbindError(vb)) totalClients += (parseInt(vb.value) || 0); });
        }, (err) => {
            if (err) { session.close(); return resolve(null); }
            session.get(["1.3.6.1.2.1.1.5.0"], (e2, vbs2) => {
                session.close();
                const name = (!e2 && !snmp.isVarbindError(vbs2[0])) ? vbs2[0].value.toString() : "Cambium AP";
                resolve({ status: 'online', details: { sysName: name, note: `${totalClients} Clients` } });
            });
        });
        session.on('error', () => { session.close(); resolve(null); });
    });
}

// =================================================================
// 📹 6. OTHER
// =================================================================
function checkNVR(ip) {
    return new Promise((resolve) => {
        const session = createSafeSession(ip, "public", { version: snmp.Version2c });
        session.get(['1.3.6.1.2.1.1.3.0', '1.3.6.1.2.1.1.5.0'], (err, vbs) => {
            session.close();
            if(err) return resolve(null);
            resolve({ status: 'online', details: { uptime: formatUptime(vbs[0].value), sysName: vbs[1].value.toString(), note: "Recording" } });
        });
        session.on('error', () => session.close());
    });
}

async function checkWebService(target) {
    try {
        const start = performance.now();
        await axios.get(target.ip.startsWith('http') ? target.ip : `http://${target.ip}`, { timeout: 5000 });
        const lat = Math.floor(performance.now() - start);
        if (!target.details?.signature) { await saveFingerprint(target, "Learned"); }
        return { status: 'online', details: { latency: `${lat}ms` } };
    } catch (e) { return { status: 'offline', details: { error: "HTTP Error" } }; }
}

function identifyDevice(ip) {
    return new Promise((resolve) => {
        const session = createSafeSession(ip, "public", { version: snmp.Version2c });
        session.get(["1.3.6.1.2.1.1.1.0"], (err, vbs) => {
            session.close();
            if(err) return resolve('generic');
            const desc = vbs[0].value.toString().toLowerCase();
            if(desc.includes("msa") || desc.includes("hpe")) resolve('san');
            else if(desc.includes("xv2") || desc.includes("cambium")) resolve('wap');
            else resolve('generic');
        });
        session.on('error', () => session.close());
    });
}

// =================================================================
// 🚀 PROCESSOR
// =================================================================
async function processDevice(target) {
    const rawIP = target.ip || "";
    if(!rawIP) return;
    const cleanIP = await resolveIP(rawIP);
    let status = 'offline'; 
    let details = {};

    if (target.type === 'server') {
        const d = await checkWindowsServer(cleanIP);
        if(d) { status = d.status; details = d.details; }
        else { 
            try { if((await ping.promise.probe(cleanIP, {timeout:4})).alive) { status='online'; details={note:"Ping Only (SNMP Fail)"}; } } catch(e){} 
        }
    }
    else {
        let type = target.type;
        if(['other','hardware','switch'].includes(type)) {
            const id = await identifyDevice(cleanIP);
            if(id !== 'generic') type = id; 
        }

        let d = null;
        if (type === 'san' || target.name.includes('SAN')) d = await checkHpSan(cleanIP);
        else if (type === 'wap') d = await checkCambium(cleanIP);
        else if (type === 'nvr') d = await checkNVR(cleanIP);
        else if (type === 'printer') d = await checkPrinter(cleanIP);
        else if (type === 'service') d = await checkWebService(target);
        else if (type === 'firewall') d = await checkSmoothwall(cleanIP);

        if (d) { status = d.status; details = d.details; }
        else {
            try { if((await ping.promise.probe(cleanIP, {timeout:4})).alive) { status='online'; details={note:"Ping Only"}; } } catch(e){}
        }
    }
    await reportStatus(rawIP, status, details);
}

async function saveFingerprint(device, signature) {
    const payload = { ...device, details: { ...device.details, signature } };
    try { await localClient.post(`${LOCAL_API_URL}/add-device`, payload); } catch (e) {}
}

let isScanning = false;
async function checkNetwork() {
    if(isScanning) return console.log("⚠️ Scan in progress...");
    isScanning = true;
    console.log(`--- SCAN START: ${new Date().toLocaleTimeString()} ---`);
    try {
        const res = await localClient.get(`${LOCAL_API_URL}/devices`);
        const targets = res.data;
        for (let i = 0; i < targets.length; i += BATCH_SIZE) {
            await Promise.all(targets.slice(i, i + BATCH_SIZE).map(processDevice));
        }
    } catch (e) { logError(e.message); }
    isScanning = false;
    console.log("--- SCAN END ---");
}

(async()=>{ await checkNetwork(); })();
setInterval(checkNetwork, 60000);

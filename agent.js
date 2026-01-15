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
console.log(`🤖 AGENT v23.0 (SAFE DATA PARSING + MERGE SUPPORT)`);
console.log(`📍 DB Target: ${LOCAL_API_URL}`);
console.log(`=================================================\n`);

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
function logError(msg) { console.error(`[${new Date().toLocaleTimeString()}] ❌ ${msg}`); }

// --- SAFE SESSION ---
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
    try { await localClient.post(`${LOCAL_API_URL}/update-status`, payload); } 
    catch (e) { }
    if (CLOUD_API_URL) try { await cloudClient.post(`${CLOUD_API_URL}/update-status`, payload); } catch (e) {}
}

async function resolveIP(input) {
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(input)) return input;
    try { const l = await dns.lookup(input); return l.address; } catch (e) { return input; }
}

function formatUptime(ticks) {
    if (!ticks) return "N/A";
    const totalSeconds = ticks / 100;
    const days = Math.floor(totalSeconds / (3600 * 24));
    const hours = Math.floor((totalSeconds % (3600 * 24)) / 3600);
    return `${days}d ${hours}h`;
}

// =================================================================
// 🧠 1. WINDOWS SERVER (Fixed Data Types)
// =================================================================
function checkWindowsServer(ip) {
    return new Promise((resolve) => {
        const session = createSafeSession(ip, "public", { version: snmp.Version1 });
        if(!session) return resolve(null);

        // Init to NULL so we know if data is missing vs 0
        let stats = { cpu: null, ram: null, disk: null, uptime: "" };

        session.get(["1.3.6.1.2.1.1.3.0"], (err, vbs) => {
            if (err) { session.close(); return resolve(null); } 
            stats.uptime = formatUptime(vbs[0].value);

            session.subtree("1.3.6.1.2.1.25.3.3.1.2", (varbinds) => {
                if (varbinds.length > 0) {
                    let total = varbinds.reduce((sum, vb) => sum + vb.value, 0);
                    stats.cpu = Math.round(total / varbinds.length);
                }
                session.table("1.3.6.1.2.1.25.2.3.1", 20, (err2, table) => {
                    session.close();
                    if (!err2) {
                        const rows = Object.values(table);
                        for (const entry of rows) {
                            const type = entry[2] ? entry[2].toString() : "";
                            const descr = entry[3] ? entry[3].toString().toLowerCase() : "";
                            // Safe Parse: Ensure we handle Strings/Numbers correctly
                            const size = Number(entry[5]);
                            const used = Number(entry[6]);
                            
                            if (!size || isNaN(size) || size <= 0) continue;
                            
                            const pct = Math.round((used / size) * 100);
                            
                            if (descr.includes("physical memory") || type.endsWith(".1.3.6.1.2.1.25.2.1.2")) stats.ram = pct;
                            if (descr.includes("c:") || (descr.includes("fixed") && descr.includes("disk"))) {
                                if(descr.includes("c:") || stats.disk === null) stats.disk = pct;
                            }
                        }
                    }
                    // Only send what we found. Nulls will be handled by Index.html logic.
                    log(`✅ [WIN] ${ip} CPU:${stats.cpu}% RAM:${stats.ram}%`);
                    resolve({ status: 'online', details: stats });
                });
            }, (err) => { session.close(); resolve(null); });
        });
        session.on('error', () => session.close());
    });
}

// =================================================================
// 🖨️ 2. PRINTERS
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
            if (alerts.length > 0) resolve({ status: 'amber', details: { note: alerts.join(", ") } });
            else resolve({ status: 'online', details: { note: "Ready" } });
        });
        session.on('error', () => { session.close(); resolve({status:'online', details:{note:"Ready"}}); });
    });
}

// =================================================================
// 💾 3. HP SAN
// =================================================================
function checkHpSan(ip) {
    return new Promise((resolve) => {
        const session = createSafeSession(ip, "public", { version: snmp.Version2c });
        if(!session) return resolve(null);

        let maxHealth = 0;
        const oidHealth = "1.3.6.1.3.94.1.6.1.6"; 
        const oidName = "1.3.6.1.2.1.1.5.0";

        session.subtree(oidHealth, (vbs) => {
            vbs.forEach(vb => { if(!snmp.isVarbindError(vb) && vb.value > maxHealth) maxHealth = vb.value; });
        }, (err) => {
            if (err) { session.close(); return resolve(null); }
            session.get([oidName], (e2, vbs2) => {
                session.close();
                const name = (!e2 && !snmp.isVarbindError(vbs2[0])) ? vbs2[0].value.toString() : "HP SAN";
                let msg = (maxHealth === 3 || maxHealth === 2) ? "Health: OK" : (maxHealth >= 4 ? "Health: Alert" : "Health: Unknown");
                let status = (maxHealth >= 4) ? 'amber' : 'online';
                resolve({ status, details: { sysName: name, note: msg } });
            });
        });
        session.on('error', () => { session.close(); resolve(null); });
    });
}

// =================================================================
// 📶 4. CAMBIUM WAP
// =================================================================
function checkCambium(ip) {
    return new Promise((resolve) => {
        const session = createSafeSession(ip, "public", { version: snmp.Version2c });
        if(!session) return resolve(null);

        let totalClients = 0;
        const oidClients = "1.3.6.1.4.1.17713.22.1.4.1.7"; 
        const oidName = "1.3.6.1.2.1.1.5.0";

        session.subtree(oidClients, (vbs) => {
            vbs.forEach(vb => { if(!snmp.isVarbindError(vb)) totalClients += (parseInt(vb.value) || 0); });
        }, (err) => {
            if (err) { session.close(); return resolve(null); }
            session.get([oidName], (e2, vbs2) => {
                session.close();
                const name = (!e2 && !snmp.isVarbindError(vbs2[0])) ? vbs2[0].value.toString() : "Cambium AP";
                resolve({ status: 'online', details: { sysName: name, note: `${totalClients} Clients` } });
            });
        });
        session.on('error', () => { session.close(); resolve(null); });
    });
}

// =================================================================
// 📹 5. OTHER
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

function checkSnmpGeneric(ip) {
    return new Promise((resolve) => {
        const session = createSafeSession(ip, "smoothwallsnmp", { version: snmp.Version1 });
        session.get(['1.3.6.1.2.1.1.5.0'], (err, vbs) => {
            session.close();
            if(err) return resolve(null);
            resolve({ status: 'online', details: { sysName: vbs[0].value.toString() } });
        });
        session.on('error', () => {});
    });
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
        else if (type === 'firewall') d = await checkSnmpGeneric(cleanIP);

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

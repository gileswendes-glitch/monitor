// --- GLOBAL SSL BYPASS ---
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; 

const ping = require('ping');
const axios = require('axios');
const snmp = require('net-snmp');
const { performance } = require('perf_hooks');

// CONFIG
const LOCAL_API_URL = process.env.LOCAL_API_URL || 'http://localhost:3000/api';
const CLOUD_API_URL = process.env.CLOUD_API_URL || ''; 

// CLIENTS
const localClient = axios.create({ timeout: 5000, proxy: false });
const cloudClient = axios.create({ timeout: 10000, proxy: false });

console.log(`🤖 Agent Started v6.1 (NVR & Printers Tuned)`);
console.log(`📍 Local Target: ${LOCAL_API_URL}`);
if (CLOUD_API_URL) console.log(`☁️ Cloud Sync:  ${CLOUD_API_URL}`);

// --- HELPER: REPORT STATUS ---
async function reportStatus(ip, status, details) {
    const payload = { ip, status, details };
    try { await localClient.post(`${LOCAL_API_URL}/update-status`, payload); } catch (e) {}
    if (CLOUD_API_URL) {
        try { await cloudClient.post(`${CLOUD_API_URL}/update-status`, payload); } catch (e) {}
    }
}

// --- HELPER: SAVE FINGERPRINT ---
async function saveFingerprint(device, signature) {
    const payload = {
        name: device.name, ip: device.ip, type: device.type,
        floor_id: device.floor_id, map_coordinates: device.map_coordinates,
        details: { ...(device.details || {}), signature: signature }
    };
    try { await localClient.post(`${LOCAL_API_URL}/add-device`, payload); } catch (e) {}
}

// --- HELPER: FORMAT UPTIME ---
function formatUptime(ticks) {
    if (!ticks) return "N/A";
    const totalSeconds = ticks / 100;
    const days = Math.floor(totalSeconds / (3600 * 24));
    const hours = Math.floor((totalSeconds % (3600 * 24)) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
}

// --- 1. NVR CHECKER (Specific v2c Fix) ---
function checkNVR(ip) {
    return new Promise((resolve) => {
        // FORCE SNMP v2c (Crucial for your NVRs)
        const session = snmp.createSession(ip, "public", { 
            timeout: 3000, 
            retries: 1,
            version: snmp.Version2c 
        });

        const oids = ['1.3.6.1.2.1.1.3.0', '1.3.6.1.2.1.1.5.0']; // Uptime, Name

        session.get(oids, (error, varbinds) => {
            session.close();
            if (error) {
                // If SNMP fails, try Ping as last resort
                return resolve(null);
            }

            const uptime = formatUptime(varbinds[0].value);
            let name = !snmp.isVarbindError(varbinds[1]) ? varbinds[1].value.toString() : "";
            
            // Fallback if name is empty (common on generic NVRs)
            if (!name || name.length < 2) name = "NVR (Active)";

            resolve({ 
                status: 'online', 
                details: { 
                    uptime: uptime, 
                    sysName: name, 
                    note: "Recording" 
                }
            });
        });
        session.on('error', () => resolve(null));
    });
}

// --- 2. PRINTER CHECKER (Konica/HP Logic) ---
function checkPrinter(ip) {
    return new Promise((resolve) => {
        const session = snmp.createSession(ip, "public", { timeout: 3000, retries: 1 });
        const oids = ["1.3.6.1.2.1.25.3.2.1.5.1", "1.3.6.1.2.1.1.1.0"];

        session.get(oids, (error, varbinds) => {
            if (error) {
                session.close();
                return resolve({ status: 'error', details: { error: "SNMP No Reply" } });
            }
            const statusCode = !snmp.isVarbindError(varbinds[0]) ? varbinds[0].value : 0;
            const sysDesc = !snmp.isVarbindError(varbinds[1]) ? varbinds[1].value.toString() : "";

            // DETECT KONICA vs HP
            if (sysDesc.toLowerCase().includes('konica') || sysDesc.toLowerCase().includes('minolta')) {
                const alertOid = "1.3.6.1.2.1.43.18.1.1.8"; 
                let alertMessages = [];
                session.subtree(alertOid, 
                    (alertVarbinds) => { alertVarbinds.forEach(vb => { if (!snmp.isVarbindError(vb)) alertMessages.push(vb.value.toString()); }); }, 
                    (err) => {
                        session.close();
                        const finalText = alertMessages.length > 0 ? alertMessages.join("; ") : "Ready";
                        resolve(analyzePrinterData(statusCode, finalText));
                    }
                );
            } else {
                session.get(["1.3.6.1.2.1.43.16.5.1.2.1.1"], (err2, vbs2) => {
                    session.close();
                    let hpText = "Ready";
                    if (!err2 && vbs2 && !snmp.isVarbindError(vbs2[0])) hpText = vbs2[0].value.toString();
                    resolve(analyzePrinterData(statusCode, hpText));
                });
            }
        });
        session.on('error', () => { /* Handled */ });
    });
}

function analyzePrinterData(statusCode, text) {
    let finalStatus = 'online';
    const lowerText = text.toLowerCase();
    const badWords = ['low', 'empty', 'jam', 'replace', 'waste', 'error', 'load', 'service', 'open', 'size/media', 'warning', 'no paper', 'toner'];
    const isSleep = ['sleep', 'power save', 'warming', 'standby', 'ready', 'printing'].some(w => lowerText.includes(w));

    if (badWords.some(w => lowerText.includes(w))) finalStatus = 'amber';
    else if (isSleep) finalStatus = 'online';
    else if (statusCode === 5) finalStatus = 'offline';
    else if (statusCode === 3) finalStatus = 'amber';

    return { status: finalStatus, details: { note: text } };
}

// --- 3. GENERIC SNMP (Switches/Firewalls) ---
function checkSnmpGeneric(ip, community) {
    return new Promise((resolve) => {
        try {
            const session = snmp.createSession(ip, community || 'public', { timeout: 2000, retries: 1 });
            const oids = ['1.3.6.1.2.1.1.3.0', '1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.1.0']; 
            session.get(oids, (error, varbinds) => {
                session.close();
                if (error || snmp.isVarbindError(varbinds[0])) return resolve(null);
                const safelyGet = (index) => (varbinds[index] && !snmp.isVarbindError(varbinds[index])) ? varbinds[index].value.toString() : "N/A";
                resolve({ 
                    online: true, uptime: formatUptime(varbinds[0].value), 
                    sysName: safelyGet(1), desc: safelyGet(2)
                });
            });
            session.on('error', () => resolve(null));
        } catch (e) { resolve(null); }
    });
}

// --- 4. WEB CHECKER ---
async function checkWebService(target) {
    let url = target.ip.trim();
    if (!url.startsWith('http')) url = `https://${url}`; 
    try {
        const start = performance.now();
        const res = await axios.get(url, { timeout: 8000 });
        const latency = Math.floor(performance.now() - start);
        if (res.status < 200 || res.status >= 300) throw new Error(`HTTP Error ${res.status}`);

        const html = (typeof res.data === 'string') ? res.data : JSON.stringify(res.data);
        const titleMatch = html.match(/<title>(.*?)<\/title>/i);
        const h1Match = html.match(/<h1.*?>(.*?)<\/h1>/i);
        const pageTitle = titleMatch ? titleMatch[1].trim() : "No Title";
        const pageH1 = h1Match ? h1Match[1].replace(/<[^>]*>?/gm, '').trim() : "No H1";
        const currentSignature = `T:${pageTitle}|H:${pageH1}`;
        const storedSignature = target.details ? target.details.signature : null;

        if (!storedSignature) {
            await saveFingerprint(target, currentSignature);
            return { status: 'online', details: { latency: `${latency}ms`, note: "Signature Learned" } };
        } 
        else if (storedSignature !== currentSignature) {
            return { status: 'amber', details: { latency: `${latency}ms`, error: "Content Changed", diff: `Exp: ${storedSignature.substring(0,20)}...` } };
        }
        return { status: 'online', details: { latency: `${latency}ms`, signature: "Verified" } };
    } catch (e) {
        let msg = e.message;
        if(e.response) msg = `HTTP ${e.response.status}`;
        return { status: 'offline', details: { error: msg } };
    }
}

// --- MAIN SCAN LOOP ---
async function checkNetwork() {
    console.log(`\n--- Scan: ${new Date().toLocaleTimeString()} ---`);
    try {
        const response = await localClient.get(`${LOCAL_API_URL}/devices`);
        const targets = response.data;

        for (let target of targets) {
            let status = 'offline';
            let details = {};
            const cleanIP = target.ip ? target.ip.trim() : ""; 
            if (!cleanIP) continue; 

            // ROUTE TO CORRECT CHECKER
            if (target.type === 'nvr') {
                const nvrData = await checkNVR(cleanIP);
                if (nvrData) { 
                    status = 'online'; details = nvrData.details; 
                } else {
                    // NVR Fallback
                    try { const res = await ping.promise.probe(cleanIP, {timeout:2}); if(res.alive) { status='online'; details={note:"Ping Only (Check SNMP)"}; } } catch(e){}
                }
            }
            else if (target.type === 'printer') {
                const pRes = await checkPrinter(cleanIP);
                if (pRes.status !== 'error') { status = pRes.status; details = pRes.details; }
                else {
                    try { const res = await ping.promise.probe(cleanIP, {timeout:2}); if(res.alive) { status='online'; details={note:"Ping Only"}; } } catch(e){}
                }
            }
            else if (target.type === 'service') {
                const res = await checkWebService(target);
                status = res.status; details = res.details;
            } 
            else if (target.type === 'firewall' || target.type === 'switch_hw') {
                try {
                    const snmpData = await checkSnmpGeneric(cleanIP, 'smoothwallsnmp'); 
                    if (snmpData && snmpData.online) { status = 'online'; details = snmpData; } 
                    else { throw new Error("SNMP Missing"); }
                } catch (e) {
                    try { const res = await ping.promise.probe(cleanIP, {timeout:2}); if(res.alive) { status='online'; details={note:"Ping Only"}; } } catch(pingErr) {}
                }
            }
            else { // GENERIC PING
                try { const res = await ping.promise.probe(cleanIP, {timeout:2}); status = res.alive ? 'online' : 'offline'; } catch (e) {}
            }
            await reportStatus(cleanIP, status, details);
        }
    } catch (err) { console.error("❌ Scan Loop Error:", err.message); }
}

async function checkInternetHealth() {
    try {
        const res = await ping.promise.probe('8.8.8.8', { timeout: 2 });
        const payload = { download: "Active", upload: "Active", ping: res.alive ? Math.floor(res.time) : 999 };
        await localClient.post(`${LOCAL_API_URL}/update-speed`, payload);
        if (CLOUD_API_URL) await cloudClient.post(`${CLOUD_API_URL}/update-speed`, payload);
    } catch (err) {}
}

(async () => {
    await checkNetwork();
    await checkInternetHealth();
})();

setInterval(checkNetwork, 60000); 
setInterval(checkInternetHealth, 60000);

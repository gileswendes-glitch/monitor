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

console.log(`🤖 Agent Started`);
console.log(`📍 Local Target: ${LOCAL_API_URL}`);
if (CLOUD_API_URL) console.log(`☁️ Cloud Sync:  ${CLOUD_API_URL}`);

// --- HELPER: FORMAT UPTIME (Fixes the raw number issue) ---
function formatUptime(ticks) {
    if (!ticks) return "N/A";
    const totalSeconds = ticks / 100;
    const days = Math.floor(totalSeconds / (3600 * 24));
    const hours = Math.floor((totalSeconds % (3600 * 24)) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
}

// HELPER: REPORT TO BOTH WORLDS
async function reportStatus(ip, status, details) {
    const payload = { ip, status, details };
    try { await localClient.post(`${LOCAL_API_URL}/update-status`, payload); } catch (e) {}
    if (CLOUD_API_URL) {
        try { await cloudClient.post(`${CLOUD_API_URL}/update-status`, payload); } catch (e) {}
    }
}

function checkSnmp(ip, community) {
    return new Promise((resolve) => {
        try {
            const session = snmp.createSession(ip, community || 'public', { timeout: 2000, retries: 1 });
            const oids = ['1.3.6.1.2.1.1.3.0', '1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.1.0']; 
            
            session.get(oids, (error, varbinds) => {
                session.close();
                if (error || snmp.isVarbindError(varbinds[0])) return resolve(null);
                
                const safelyGet = (index) => (varbinds[index] && !snmp.isVarbindError(varbinds[index])) ? varbinds[index].value.toString() : "N/A";

                resolve({ 
                    online: true, 
                    // FIX: Format the raw ticks here
                    uptime: formatUptime(varbinds[0].value), 
                    sysName: safelyGet(1),
                    desc: safelyGet(2)
                });
            });
            session.on('error', () => resolve(null));
        } catch (e) { resolve(null); }
    });
}

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

            if (target.type === 'service') {
                const targetUrl = cleanIP.startsWith('http') ? cleanIP : `https://${cleanIP}`;
                try {
                    await localClient.head(targetUrl, { timeout: 5000 });
                    status = 'online';
                } catch (e) { 
                    try { await localClient.get(targetUrl, { timeout: 5000 }); status = 'online'; } catch(ex){}
                }
            } 
            else if (target.type === 'firewall') {
                try {
                    const snmpData = await checkSnmp(cleanIP, 'smoothwallsnmp');
                    if (snmpData && snmpData.online) {
                        status = 'online';
                        details = snmpData;
                    } else { throw new Error("SNMP Missing"); }
                } catch (e) {
                    try {
                        const res = await ping.promise.probe(cleanIP, { timeout: 2 });
                        if (res.alive) { status = 'online'; details = { note: "Ping Only (SNMP Fail)" }; }
                    } catch (pingErr) {}
                }
            }
            else {
                try {
                    const res = await ping.promise.probe(cleanIP, { timeout: 2 });
                    status = res.alive ? 'online' : 'offline';
                } catch (e) {}
            }
            // console.log(`${target.name}: ${status}`); // Optional logging
            await reportStatus(cleanIP, status, details);
        }
    } catch (err) { console.error("❌ Scan Loop Error:", err.message); }
}

// --- NEW FUNCTION: LIGHTWEIGHT INTERNET CHECK ---
async function checkInternetHealth() {
    console.log("⏳ Checking Internet Health...");
    try {
        // Ping Google DNS (Reliable, fast, low bandwidth)
        const res = await ping.promise.probe('8.8.8.8', { timeout: 2 });
        
        const payload = { 
            download: "Active", // Placeholder text
            upload: "Active", 
            ping: res.alive ? Math.floor(res.time) : 999 
        };
        
        console.log(`🌍 Internet Latency: ${payload.ping}ms`);

        await localClient.post(`${LOCAL_API_URL}/update-speed`, payload);
        if (CLOUD_API_URL) await cloudClient.post(`${CLOUD_API_URL}/update-speed`, payload);

    } catch (err) { console.error("❌ Internet Check failed:", err.message); }
}

// STARTUP
(async () => {
    await checkNetwork();
    await checkInternetHealth();
})();

setInterval(checkNetwork, 60000); 
setInterval(checkInternetHealth, 60000); // Check latency every 1 minute

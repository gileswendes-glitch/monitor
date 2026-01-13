// --- GLOBAL SSL BYPASS ---
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; 

const ping = require('ping');
const axios = require('axios');
const mongoose = require('mongoose');
const snmp = require('net-snmp');
const { performance } = require('perf_hooks');

// CONFIG
// We now read these from Environment Variables (set by Docker)
const LOCAL_API_URL = process.env.LOCAL_API_URL || 'http://localhost:3000/api';
const CLOUD_API_URL = process.env.CLOUD_API_URL || ''; // Empty by default until set

// CLIENTS
const localClient = axios.create({ timeout: 5000, proxy: false });
const cloudClient = axios.create({ timeout: 10000, proxy: false });

// HELPER: REPORT TO BOTH WORLDS
async function reportStatus(ip, status, details) {
    const payload = { ip, status, details };

    // 1. Local (Critical)
    try {
        await localClient.post(`${LOCAL_API_URL}/update-status`, payload);
    } catch (e) { 
        console.error(`   ❌ Local Write Failed: ${e.message}`); 
    }

    // 2. Cloud (Sync)
    if (CLOUD_API_URL) {
        try {
            await cloudClient.post(`${CLOUD_API_URL}/update-status`, payload);
            // console.log(`   ☁️  Synced to Cloud`); // Uncomment for debug
        } catch (e) {
            // It's okay if cloud fails (e.g. internet is down)
            // console.error(`   ⚠️ Cloud Sync Failed`);
        }
    }
}

// ... [Keep formatUptime and checkSnmp functions exactly as they were in the previous step] ...
// (I am omitting them here to save space, but DO NOT delete them from your file!)
function formatUptime(ticks) { /* ... paste from previous ... */ }
function checkSnmp(ip, community) { /* ... paste from previous ... */ }

async function checkNetwork() {
    console.log(`\n--- Scan: ${new Date().toLocaleTimeString()} ---`);
    console.log(`   > Syncing to Cloud: ${CLOUD_API_URL ? 'YES' : 'NO'}`);

    try {
        // Fetch targets from LOCAL (Source of Truth)
        const response = await localClient.get(`${LOCAL_API_URL}/devices`);
        const targets = response.data;

        for (let target of targets) {
            let status = 'offline';
            let details = {};

            const cleanIP = target.ip ? target.ip.trim() : ""; 
            if (!cleanIP) continue; 

            // [Logic for Services, Firewall, Hardware remains identical]
            // 1. SERVICES
            if (target.type === 'service') {
                try { await localClient.head(cleanIP); status = 'online'; } 
                catch (e) { try { await localClient.get(cleanIP); status = 'online'; } catch (e2) {} }
            } 
            // 2. FIREWALL
            else if (target.type === 'firewall') {
                const snmpData = await checkSnmp(cleanIP, 'smoothwallsnmp');
                if (snmpData.online) {
                    status = 'online';
                    details = { uptime: snmpData.uptime, sysName: snmpData.sysName, desc: snmpData.desc };
                }
            }
            // 3. OTHERS
            else {
                const res = await ping.promise.probe(cleanIP, { timeout: 2 });
                status = res.alive ? 'online' : 'offline';
            }

            console.log(`${target.name}: ${status}`);

            // NEW: Use the Dual-Report function
            await reportStatus(cleanIP, status, details);
        }
    } catch (err) {
        console.error("❌ Fatal Loop Error:", err.message);
    }
}

// SPEED TEST (Reports to both)
async function runSpeedTest() {
    console.log("⏳ Speed Test...");
    const testUrl = 'https://lon.speedtest.clouvider.net/1g.bin'; 
    const fileSizeBits = 1024 * 1024 * 1024 * 8; 
    
    try {
        const start = performance.now();
        await localClient.get(testUrl, { responseType: 'stream', timeout: 180000 });
        const duration = (performance.now() - start) / 1000; 
        const speedMbps = (fileSizeBits / duration / 1000000).toFixed(1);
        const pingEst = Math.floor(duration * 10); 

        console.log(`🚀 Speed: ${speedMbps} Mbps`);

        const payload = { download: speedMbps, upload: "N/A", ping: pingEst };
        
        await localClient.post(`${LOCAL_API_URL}/update-speed`, payload);
        if (CLOUD_API_URL) await cloudClient.post(`${CLOUD_API_URL}/update-speed`, payload);

    } catch (err) { console.error("❌ Speedtest failed:", err.message); }
}

checkNetwork();           
setInterval(checkNetwork, 10000); 
setInterval(runSpeedTest, 600000);
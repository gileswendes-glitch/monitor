const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');

// YOUR SMOOTHWALL IP (Replace this!)
const PROXY_IP = '172.16.64.160'; // <--- PUT YOUR SMOOTHWALL IP HERE

async function test(name, config) {
    console.log(`\nTesting ${name}...`);
    try {
        await axios.get('https://www.google.com', { 
            timeout: 5000, 
            ...config 
        });
        console.log(`✅ SUCCESS! Use this configuration.`);
        return true;
    } catch (err) {
        console.log(`❌ FAILED: ${err.message}`);
        if (err.response) console.log(`   (Server responded with Code: ${err.response.status})`);
        return false;
    }
}

async function runDiagnostics() {
    console.log("--- STARTING NETWORK DIAGNOSTICS ---");

    // TEST 1: Direct Connection (SSL Ignored)
    // Works if you have a transparent exception
    const success1 = await test("Direct Connection (No Proxy)", {
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        proxy: false
    });

    // TEST 2: Proxy Port 800 (Standard Smoothwall)
    const success2 = await test("Proxy on Port 800", {
        httpsAgent: new HttpsProxyAgent(`http://${PROXY_IP}:800`),
        proxy: false
    });

    // TEST 3: Proxy Port 8080 (Alternative Smoothwall)
    const success3 = await test("Proxy on Port 8080", {
        httpsAgent: new HttpsProxyAgent(`http://${PROXY_IP}:8080`),
        proxy: false
    });

    // TEST 4: Proxy Port 801 (Auth Port - Unlikely to work but we'll test)
    const success4 = await test("Proxy on Port 801", {
        httpsAgent: new HttpsProxyAgent(`http://${PROXY_IP}:801`),
        proxy: false
    });
}

runDiagnostics();
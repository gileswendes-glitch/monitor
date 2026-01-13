process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Ignore SSL errors

const axios = require('axios');
const mongoose = require('mongoose');

// CONFIG
const API_URL = 'http://localhost:3000/api';
const TARGET_URL = 'https://www.google.com';

// 1. AXIOS CLIENT (With Localhost Protection)
// This ensures we NEVER try to send localhost traffic through the Smoothwall
const client = axios.create({
    proxy: false, // Force Direct Connection
    noProxy: ['localhost', '127.0.0.1'] // Explicitly exclude localhost
});

async function runDebug() {
    console.log("--- 🕵️ STARTING DEEP DEBUG ---");

    // TEST 1: Can we reach the Local API? (Fetching Devices)
    console.log("\n1. Testing Local API Connection (localhost:3000)...");
    try {
        const res = await client.get(`${API_URL}/devices`);
        console.log(`   ✅ Success! Found ${res.data.length} devices in DB.`);
    } catch (err) {
        console.log(`   ❌ FAILED to talk to localhost.`);
        console.log(`   Error: ${err.message}`);
        console.log("   (If this fails, your proxy might be intercepting localhost calls)");
        return; // Stop here if we can't even get the list
    }

    // TEST 2: Can we reach the Internet? (Google)
    console.log("\n2. Testing External Internet (Google)...");
    try {
        await client.head(TARGET_URL, { timeout: 5000 });
        console.log(`   ✅ Success! Reached Google.`);
    } catch (err) {
        console.log(`   ❌ FAILED to reach Google.`);
        console.log(`   Error: ${err.message}`);
        return;
    }

    // TEST 3: Can we write back to the DB?
    console.log("\n3. Testing Database Write (Update Status)...");
    try {
        // We will try to force an update for a fake device
        await client.post(`${API_URL}/update-status`, {
            ip: 'DEBUG_TEST',
            status: 'online'
        });
        console.log(`   ✅ Success! Wrote status to DB.`);
    } catch (err) {
        console.log(`   ❌ FAILED to write to DB.`);
        console.log(`   Error: ${err.message}`);
    }

    console.log("\n--- DEBUG COMPLETE ---");
}

runDebug();
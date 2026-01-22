require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// CONFIGURATION
const CLOUD_TARGET_URL = 'https://khs-v4w8.onrender.com';
const AM_I_CLOUD = process.env.RENDER || false;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://172.16.64.105:27017/admin_monitor';
const ACTIVE_SYNC_URL = AM_I_CLOUD ? '' : CLOUD_TARGET_URL;

console.log(`\n==========================================`);
console.log(`🤖 SERVER v2.0 (WITH UPDATE-STATUS FIX)`);
console.log(`==========================================\n`);

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Fail:', err));

const deviceSchema = new mongoose.Schema({
    ip: String, name: String, type: String,
    status: String, last_seen: Date, last_issue: Date,
    details: Object, floor_id: String, map_coordinates: Object
}, { timestamps: true });

const Device = mongoose.model('Device', deviceSchema);

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

// --- 3b. REPRO CONFIG ROUTES (Printer visibility for reprographics page) ---
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

// --- 4. DEVICE CRUD ROUTES ---
app.get('/api/devices', async (req, res) => {
    try { res.json(await Device.find()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/add-device', async (req, res) => {
    try {
        await Device.findOneAndUpdate({ ip: req.body.ip }, req.body, { upsert: true });
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

        // Build update object - only update fields that are provided
        const updateData = {
            last_seen: new Date()
        };

        if (status) {
            updateData.status = status;
            // Track when device goes offline/amber for "recent issue" tracking
            if (status === 'offline' || status === 'amber') {
                updateData.last_issue = new Date();
            }
        }

        // CRITICAL: Merge details properly instead of replacing
        // This preserves existing detail fields while updating new ones
        if (details && typeof details === 'object') {
            // Use $set with dot notation to merge nested details
            for (const [key, value] of Object.entries(details)) {
                if (value !== undefined && value !== null && value !== '') {
                    updateData[`details.${key}`] = value;
                }
            }
        }

        const result = await Device.findOneAndUpdate(
            { ip: ip },
            { $set: updateData },
            { upsert: false, new: true } // Don't create new devices, just update existing
        );

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

        const results = await Promise.all(updates.map(async ({ ip, status, details }) => {
            const updateData = { last_seen: new Date() };
            if (status) {
                updateData.status = status;
                if (status === 'offline' || status === 'amber') {
                    updateData.last_issue = new Date();
                }
            }
            if (details && typeof details === 'object') {
                for (const [key, value] of Object.entries(details)) {
                    if (value !== undefined && value !== null && value !== '') {
                        updateData[`details.${key}`] = value;
                    }
                }
            }
            return Device.findOneAndUpdate({ ip }, { $set: updateData }, { new: true });
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
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port ${PORT}`));

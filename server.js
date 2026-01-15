require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');

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
console.log(`🤖 SERVER RUNNING (FULL ADMIN ACCESS)`);
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

// --- 1. GET ALL DEVICES ---
app.get('/api/devices', async (req, res) => {
    try {
        const devices = await Device.find();
        res.json(devices);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 2. ADD / UPDATE DEVICE ---
app.post('/api/add-device', async (req, res) => {
    try {
        await Device.findOneAndUpdate({ ip: req.body.ip }, req.body, { upsert: true });
        // Sync to Cloud
        if (ACTIVE_SYNC_URL) axios.post(`${ACTIVE_SYNC_URL}/api/add-device`, req.body).catch(e => {});
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 3. STATUS UPDATE (With Merge Logic) ---
app.post('/api/update-status', async (req, res) => {
    const { ip, status, details } = req.body;
    try {
        const device = await Device.findOne({ ip });
        const updateData = { status, last_seen: new Date() };

        if (status !== 'online') updateData.last_issue = new Date();

        if (details && Object.keys(details).length > 0) {
            const existingDetails = device ? device.details : {};
            updateData.details = { ...existingDetails, ...details };
        }

        await Device.findOneAndUpdate({ ip }, updateData, { upsert: true });
        
        if (ACTIVE_SYNC_URL) axios.post(`${ACTIVE_SYNC_URL}/api/update-status`, req.body).catch(e => {});
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 4. DELETE DEVICE (Fixes your error) ---
app.delete('/api/remove-device/:ip', async (req, res) => {
    const ip = req.params.ip;
    try {
        await Device.deleteOne({ ip: ip });
        
        // Also delete from Cloud
        if (ACTIVE_SYNC_URL) axios.delete(`${ACTIVE_SYNC_URL}/api/remove-device/${ip}`).catch(e => {});
        
        console.log(`🗑️ Deleted device: ${ip}`);
        res.json({ success: true, message: "Deleted" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- 5. RESET DATABASE (Fixes Admin Button) ---
app.post('/api/reset-db', async (req, res) => {
    try {
        await Device.deleteMany({});
        console.log("🧨 Database Wiped by Admin");
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 6. FORCE RESYNC (Fixes Cloud Button) ---
app.get('/api/force-resync', async (req, res) => {
    if (!ACTIVE_SYNC_URL) return res.json({ message: "No Cloud Configured" });
    try {
        const allLocal = await Device.find();
        console.log(`🔄 Syncing ${allLocal.length} devices to cloud...`);
        
        for (const d of allLocal) {
            await axios.post(`${ACTIVE_SYNC_URL}/api/add-device`, d).catch(e=>{});
        }
        res.json({ message: "Sync Complete", synced: allLocal.length });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// --- 7. NETWORK SPEED TEST ENDPOINT ---
app.get('/api/status', (req, res) => {
    res.json({ ping: Math.floor(Math.random() * 20) + 10 }); // Mock ping for UI
});

// --- 8. SEED ROUTE ---
app.get('/api/seed', async (req, res) => {
    const seeds = [];
    for(let i=100; i<=105; i++) seeds.push({ip:`172.16.64.${i}`, name:`Test Server ${i}`, type:'server'});
    for(const s of seeds) await Device.findOneAndUpdate({ip:s.ip}, {...s, status:'online'}, {upsert:true});
    res.send("DB Seeded");
});

app.use((req, res, next) => {
    if(!req.url.includes('.')) console.log(`📡 ${req.method} ${req.url} from ${req.ip}`);
    next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port ${PORT}`));

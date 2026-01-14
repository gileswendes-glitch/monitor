require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

// CONFIG
const MONGO_URI = process.env.MONGO_URI || 'mongodb://172.16.64.105:27017/admin_monitor'; 

// --- LOOP PROTECTION ---
// 1. Are we running on the Cloud (Render)?
const IS_CLOUD = process.env.RENDER || false;

// 2. If we are on Cloud, DISABLE syncing (Empty String).
//    If we are Local, ENABLE syncing (Target URL).
const CLOUD_API_URL = IS_CLOUD ? '' : 'https://khs-v4w8.onrender.com';

console.log(`🤖 System Mode: ${IS_CLOUD ? 'CLOUD SERVER' : 'LOCAL CONTROLLER'}`);
if (!IS_CLOUD) console.log(`🔗 Syncing to: ${CLOUD_API_URL}`);

mongoose.connect(MONGO_URI)
  .then(() => console.log(`✅ Connected to MongoDB`))
  .catch(err => console.error('❌ Connection error:', err));

// --- SCHEMAS ---
const deviceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  ip: { type: String, required: true },
  type: { type: String, default: 'switch' },
  floor_id: { type: String, default: 'T-G.PNG' }, 
  map_coordinates: { x: Number, y: Number },
  status: { type: String, default: 'offline' },
  details: { type: Object, default: {} }, 
  last_seen: { type: Date, default: Date.now }
});
const Device = mongoose.model('Device', deviceSchema);

const statusSchema = new mongoose.Schema({
    type: { type: String, unique: true }, 
    download: String,
    upload: String,
    ping: Number,
    last_updated: { type: Date, default: Date.now }
});
const SystemStatus = mongoose.model('SystemStatus', statusSchema);

// --- ROUTES ---

// 1. GET ALL
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await Device.find();
    res.json(devices);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. ADD DEVICE (With Loop Protection)
app.post('/api/add-device', async (req, res) => {
  try {
    const { ip } = req.body;
    
    // A. Save to Database
    let device = await Device.findOne({ ip: ip });
    if (device) {
        device = await Device.findOneAndUpdate({ ip: ip }, req.body, { new: true });
    } else {
        device = new Device(req.body);
        await device.save();
    }

    // B. Sync ONLY if we are Local (Cloud URL is set)
    if (CLOUD_API_URL) {
        axios.post(`${CLOUD_API_URL}/api/add-device`, req.body)
             .catch(e => console.error(`⚠️ Sync Failed: ${e.message}`));
    }

    res.json({ message: "Saved", device });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. REMOVE DEVICE (With Loop Protection)
app.delete('/api/remove-device/:ip', async (req, res) => {
    const { ip } = req.params;
    try {
        const result = await Device.findOneAndDelete({ ip: ip });
        
        if (CLOUD_API_URL) {
            axios.delete(`${CLOUD_API_URL}/api/remove-device/${ip}`)
                 .catch(e => console.error(`⚠️ Sync Delete Failed: ${e.message}`));
        }

        if (result) res.json({ message: `Removed ${ip}` });
        else res.status(404).json({ message: "Not found" });

    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. STATUS UPDATE
app.post('/api/update-status', async (req, res) => {
  const { ip, status, details } = req.body;
  const updateData = { status: status, last_seen: new Date() };
  if(details && Object.keys(details).length > 0) updateData.details = details;

  try {
    await Device.findOneAndUpdate({ ip: ip }, updateData, { upsert: true });
    res.json({ message: "Status Updated" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. SPEED UPDATE
app.post('/api/update-speed', async (req, res) => {
    const { download, upload, ping } = req.body;
    await SystemStatus.findOneAndUpdate(
        { type: 'internet_stats' },
        { download, upload, ping, last_updated: new Date() },
        { upsert: true }
    );
    res.json({ message: "Speed updated" });
});

// 6. GET SPEED
app.get('/api/status', async (req, res) => {
    const stats = await SystemStatus.findOne({ type: 'internet_stats' });
    res.json(stats || { download: '--', upload: '--', ping: 0 });
});

// 7. RESET ALL (With Loop Protection)
app.get('/api/reset-db', async (req, res) => {
    let msg = [];
    try {
        await Device.deleteMany({});
        await SystemStatus.deleteMany({});
        msg.push(`✅ ${IS_CLOUD ? 'Cloud' : 'Local'} Wiped`);
    } catch (e) { msg.push(`❌ Error: ${e.message}`); }

    // Only trigger remote wipe if we are Local
    if (CLOUD_API_URL) {
        try {
            await axios.get(`${CLOUD_API_URL}/api/reset-db`, { timeout: 30000 });
            msg.push("☁️ Cloud Wiped");
        } catch (e) { msg.push(`⚠️ Cloud Fail: ${e.message}`); }
    }
    res.json({ message: msg.join(' | ') });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

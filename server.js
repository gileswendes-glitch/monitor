require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

// =================================================================
// 🧠 HYBRID BRAIN: DETECT ENVIRONMENT
// =================================================================

// 1. Define the Cloud URL (Hardcoded for Local to use)
const CLOUD_TARGET_URL = 'https://khs-v4w8.onrender.com'; 

// 2. Detect if we are running on Render (Cloud)
// Render automatically sets the 'RENDER' env variable to true.
const AM_I_CLOUD = process.env.RENDER || false;

// 3. Determine Database URI
// Cloud: Uses the environment variable set in Render Dashboard
// Local: Defaults to your school private IP if not set
const MONGO_URI = process.env.MONGO_URI || 'mongodb://172.16.64.105:27017/admin_monitor';

// 4. Determine Sync Behavior
// If I am Cloud -> Do NOT sync (prevent loop)
// If I am Local -> Sync to Cloud Target
const ACTIVE_SYNC_URL = AM_I_CLOUD ? '' : CLOUD_TARGET_URL;

console.log(`\n==========================================`);
console.log(`🤖 SYSTEM MODE: ${AM_I_CLOUD ? '☁️ CLOUD SERVER' : '🏠 LOCAL CONTROLLER'}`);
console.log(`🗄️  DATABASE:    ${AM_I_CLOUD ? 'Atlas (Cloud)' : 'Local MongoDB'}`);
if (ACTIVE_SYNC_URL) console.log(`🔗 SYNC TARGET: ${ACTIVE_SYNC_URL}`);
else console.log(`🛡️  SYNC:        DISABLED (I am the target)`);
console.log(`==========================================\n`);

// =================================================================
// 🔌 DATABASE CONNECTION
// =================================================================
mongoose.connect(MONGO_URI)
  .then(() => console.log(`✅ MongoDB Connected`))
  .catch(err => {
      console.error(`❌ MongoDB Fail: ${err.message}`);
      // On Cloud, a DB fail is fatal. On Local, we might survive.
      if (AM_I_CLOUD) process.exit(1); 
  });

// =================================================================
// 📝 SCHEMAS
// =================================================================
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

// =================================================================
// 🚦 ROUTES
// =================================================================

// 1. GET ALL
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await Device.find();
    res.json(devices);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. ADD DEVICE (Auto-Sync)
app.post('/api/add-device', async (req, res) => {
  try {
    const { ip } = req.body;
    
    // Local Save
    let device = await Device.findOne({ ip: ip });
    if (device) {
        device = await Device.findOneAndUpdate({ ip: ip }, req.body, { new: true });
    } else {
        device = new Device(req.body);
        await device.save();
    }

    // Sync?
    if (ACTIVE_SYNC_URL) {
        axios.post(`${ACTIVE_SYNC_URL}/api/add-device`, req.body)
             .catch(e => console.error(`⚠️ Sync Add Failed: ${e.message}`));
    }

    res.json({ message: "Saved", device });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. REMOVE DEVICE (Auto-Sync)
app.delete('/api/remove-device/:ip', async (req, res) => {
    const { ip } = req.params;
    try {
        const result = await Device.findOneAndDelete({ ip: ip });
        
        // Sync?
        if (ACTIVE_SYNC_URL) {
            axios.delete(`${ACTIVE_SYNC_URL}/api/remove-device/${ip}`)
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

// 6. GET STATUS
app.get('/api/status', async (req, res) => {
    const stats = await SystemStatus.findOne({ type: 'internet_stats' });
    res.json(stats || { download: '--', upload: '--', ping: 0 });
});

// 7. GLOBAL RESET (Syncs Remote Wipe if Local)
app.get('/api/reset-db', async (req, res) => {
    let msg = [];
    try {
        await Device.deleteMany({});
        await SystemStatus.deleteMany({});
        msg.push(`✅ ${AM_I_CLOUD ? 'Cloud' : 'Local'} DB Wiped`);
    } catch (e) { msg.push(`❌ Error: ${e.message}`); }

    // Sync Wipe? (Only if I am Local)
    if (ACTIVE_SYNC_URL) {
        try {
            // Long timeout for sleeping cloud servers
            await axios.get(`${ACTIVE_SYNC_URL}/api/reset-db`, { timeout: 30000 });
            msg.push("☁️ Cloud DB Wiped");
        } catch (e) { msg.push(`⚠️ Cloud Wipe Fail: ${e.message}`); }
    }
    res.json({ message: msg.join(' | ') });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

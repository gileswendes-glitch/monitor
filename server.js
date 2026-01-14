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
const AM_I_CLOUD = process.env.RENDER || false;

// 3. Determine Database URI
const MONGO_URI = process.env.MONGO_URI || 'mongodb://172.16.64.105:27017/admin_monitor';

// 4. Determine Sync Behavior
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

// 3. REMOVE DEVICE (SMART SEARCH)
// Use Regex route since we know it works safely on your server.
app.delete(/\/api\/remove-device\/(.*)/, async (req, res) => {
    try {
        var rawIp = req.params[0];
        if (!rawIp) return res.status(400).json({ message: "No IP provided" });
        
        var decodedIp = decodeURIComponent(rawIp);

        // CREATE A "CLEAN" VERSION (No trailing slash)
        var cleanIp = decodedIp;
        if (cleanIp.endsWith('/')) {
            cleanIp = cleanIp.substring(0, cleanIp.length - 1);
        }

        console.log('🗑️ Request to delete:', decodedIp);
        console.log('🔎 Searching DB for:', cleanIp, 'OR', cleanIp + '/');

        // SMART DELETE: Look for IP exactly as is, OR with a slash added.
        // This guarantees we find it regardless of how it was saved.
        const result = await Device.findOneAndDelete({ 
            ip: { $in: [cleanIp, cleanIp + '/'] } 
        });
        
        // Sync Logic
        if (ACTIVE_SYNC_URL) {
            var encodedIP = encodeURIComponent(cleanIp);
            axios.delete(`${ACTIVE_SYNC_URL}/api/remove-device/${encodedIP}`)
                 .catch(e => console.error(`⚠️ Sync Delete Failed: ${e.message}`));
        }

        if (result) res.json({ message: `Removed ${cleanIp}` });
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

    if (ACTIVE_SYNC_URL) {
        try {
            await axios.get(`${ACTIVE_SYNC_URL}/api/reset-db`, { timeout: 30000 });
            msg.push("☁️ Cloud DB Wiped");
        } catch (e) { msg.push(`⚠️ Cloud Wipe Fail: ${e.message}`); }
    }
    res.json({ message: msg.join(' | ') });
});

// 8. FORCE RESYNC (SAFE MODE)
app.get('/api/force-resync', async (req, res) => {
    if (AM_I_CLOUD) return res.status(400).json({ error: "Cloud cannot initiate sync" });
    if (!ACTIVE_SYNC_URL) return res.status(400).json({ error: "No Cloud Target configured" });

    try {
        const localDevices = await Device.find();
        let successCount = 0;

        console.log(`🔄 Force Syncing ${localDevices.length} devices...`);
        
        for (var i = 0; i < localDevices.length; i++) {
            var device = localDevices[i];
            try {
                // Safe object copy (No 'spread' syntax to crash old Node versions)
                var deviceData = device.toObject();
                delete deviceData._id;

                await axios.post(`${ACTIVE_SYNC_URL}/api/add-device`, deviceData);
                successCount++;
            } catch (err) {
                console.error(`❌ Sync Fail for ${device.ip}`);
            }
        }
        res.json({ message: `Resync Complete. Synced: ${successCount}` });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

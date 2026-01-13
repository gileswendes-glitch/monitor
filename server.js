require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios'); // Added for Cloud Checks

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

// --- DATABASE CONNECTION ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb://172.16.64.105:27017/admin_monitor'; 

mongoose.connect(MONGO_URI)
  .then(() => console.log(`✅ Connected to MongoDB`))
  .catch(err => console.error('❌ Connection error:', err));

// --- SCHEMAS ---

// 1. Devices Schema
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

// 2. System Status Schema
const statusSchema = new mongoose.Schema({
    type: { type: String, unique: true }, 
    download: String,
    upload: String,
    ping: Number,
    last_updated: { type: Date, default: Date.now }
});
const SystemStatus = mongoose.model('SystemStatus', statusSchema);

// --- ROUTES (These were missing!) ---

// 1. GET ALL DEVICES
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await Device.find();
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. ADD NEW DEVICE
app.post('/api/add-device', async (req, res) => {
  try {
    const newDevice = new Device(req.body);
    await newDevice.save();
    res.json(newDevice);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. RECEIVE STATUS UPDATE
app.post('/api/update-status', async (req, res) => {
  const { ip, status, details } = req.body;
  
  const updateData = { status: status, last_seen: new Date() };
  if(details && Object.keys(details).length > 0) {
      updateData.details = details;
  }

  try {
    const device = await Device.findOneAndUpdate(
        { ip: ip }, 
        updateData,
        { new: true }
    );
    if (device) res.json({ message: "Updated", device });
    else res.status(404).json({ message: "Device not found" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. UPDATE SPEED
app.post('/api/update-speed', async (req, res) => {
    const { download, upload, ping } = req.body;
    await SystemStatus.findOneAndUpdate(
        { type: 'internet_stats' },
        { download, upload, ping, last_updated: new Date() },
        { upsert: true }
    );
    res.json({ message: "Speed updated" });
});

// 5. GET SPEED
app.get('/api/status', async (req, res) => {
    const stats = await SystemStatus.findOne({ type: 'internet_stats' });
    res.json(stats || { download: '--', upload: '--', ping: 0 });
});

// 6. UPDATE DEVICE
app.put('/api/devices/:id', async (req, res) => {
    try {
        await Device.findByIdAndUpdate(req.params.id, req.body);
        res.json({ message: "Updated successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. DELETE DEVICE
app.delete('/api/devices/:id', async (req, res) => {
    try {
        await Device.findByIdAndDelete(req.params.id);
        res.json({ message: "Deleted successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- CLOUD "SECOND OPINION" AGENT ---
if (process.env.CLOUD_MODE === 'true') {
    console.log("☁️  CLOUD MODE ENABLED: Starting Second Opinion Agent...");
    setInterval(async () => {
        const services = await Device.find({ type: 'service' });
        console.log(`☁️  Checking ${services.length} external services from Cloud...`);
        for (let d of services) {
            try {
                await axios.head(d.ip, { timeout: 5000 });
                await Device.findByIdAndUpdate(d._id, { status: 'online', last_seen: new Date() });
            } catch (e) {
                await Device.findByIdAndUpdate(d._id, { status: 'offline', last_seen: new Date() });
            }
        }
    }, 60000);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

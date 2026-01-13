// ... [Keep all imports, database connection, schemas, and routes exactly as they were] ...
// (Omitting standard code to focus on the new addition)

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

// 1. SMART DB CONNECTION
// If MONGO_URI env var is present (Cloud/Docker), use it. 
// Otherwise fallback to local IP (Dev mode).
const MONGO_URI = process.env.MONGO_URI || 'mongodb://172.16.64.105:27017/admin_monitor'; 

mongoose.connect(MONGO_URI)
  .then(() => console.log(`✅ Connected to MongoDB`))
  .catch(err => console.error('❌ Connection error:', err));

// ... [Insert Schemas (Device, SystemStatus) here] ...
const deviceSchema = new mongoose.Schema({ /*...*/ details: { type: Object, default: {} }, /*...*/ });
const Device = mongoose.model('Device', deviceSchema);
// ... [Insert Routes here] ...


// --- NEW: CLOUD "SECOND OPINION" AGENT ---
// This block ONLY runs if we tell the server it is in "Cloud Mode"
if (process.env.CLOUD_MODE === 'true') {
    const axios = require('axios');
    console.log("☁️  CLOUD MODE ENABLED: Starting Second Opinion Agent...");

    // Run every 60 seconds
    setInterval(async () => {
        // Only check external services (Websites)
        const services = await Device.find({ type: 'service' });
        
        console.log(`☁️  Checking ${services.length} external services from Cloud...`);

        for (let d of services) {
            try {
                // If the Cloud can see Google, but your School Agent says it's down,
                // then your School Internet is the problem.
                await axios.head(d.ip, { timeout: 5000 });
                
                // We update the DB with "Online" from the cloud's perspective
                // You might want to add a "cloud_status" field later to compare both, 
                // but for now, this ensures your home dashboard stays green if the site is actually up.
                await Device.findByIdAndUpdate(d._id, { status: 'online', last_seen: new Date() });
            } catch (e) {
                await Device.findByIdAndUpdate(d._id, { status: 'offline', last_seen: new Date() });
            }
        }
    }, 60000); 
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
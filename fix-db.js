const mongoose = require('mongoose');

// Connect to your DB
mongoose.connect('mongodb://172.16.64.105:27017/admin_monitor')
  .then(() => console.log('✅ Connected to DB'))
  .catch(err => console.error(err));

const deviceSchema = new mongoose.Schema({
  name: String,
  ip: String,
  type: String
});
const Device = mongoose.model('Device', deviceSchema);

async function fixData() {
    console.log("🔍 Scanning for mislabeled services...");
    
    // Find all devices that have "http" in their IP address
    const devices = await Device.find({ ip: { $regex: 'http' } });
    
    for (let d of devices) {
        console.log(`🛠️ Fixing: ${d.name} (${d.ip})`);
        console.log(`   - Was: ${d.type}`);
        
        d.type = 'service'; // Force it to be a Service
        await d.save();
        
        console.log(`   - Now: ${d.type} ✅`);
    }
    
    console.log("\n🎉 All Done! Restart your Agent.");
    process.exit();
}

fixData();
const mongoose = require('mongoose');

// Connect to DB
mongoose.connect('mongodb://172.16.64.105:27017/admin_monitor')
  .then(() => console.log('✅ Connected'))
  .catch(err => console.error(err));

const Device = mongoose.model('Device', new mongoose.Schema({
  name: String,
  ip: String,
  type: String
}));

async function updateSchool() {
    // Find the device currently named "School Website"
    const result = await Device.findOneAndUpdate(
        { name: "School Website" }, // Search Criteria
        { ip: "https://kingsburyhigh.org.uk" }, // New Data
        { new: true } // Return the updated version
    );

    if (result) {
        console.log("🎉 Success! Updated School Website URL.");
        console.log(`   New Target: ${result.ip}`);
    } else {
        console.log("❌ Could not find 'School Website' in the database.");
    }
    process.exit();
}

updateSchool();
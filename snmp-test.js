const snmp = require('net-snmp');

// CONFIGURATION
const IP = "172.16.64.160"; // Your Smoothwall IP
const COMMUNITY = "smoothwallsnmp";

console.log(`🔎 Scanning ${IP} for SNMP Data...`);

const session = snmp.createSession(IP, COMMUNITY);

// Standard OIDs to check
const oids = [
    "1.3.6.1.2.1.1.5.0", // sysName (Hostname)
    "1.3.6.1.2.1.1.1.0", // sysDescr (System Description/Version)
    "1.3.6.1.2.1.1.3.0", // sysUpTime (How long it's been on)
    "1.3.6.1.2.1.25.1.1.0" // hrSystemUptime (Alternative Uptime)
];

session.get(oids, function (error, varbinds) {
    if (error) {
        console.error("❌ SNMP Error:", error);
    } else {
        console.log("\n--- DEVICE INFO ---");
        if (!snmp.isVarbindError(varbinds[0])) console.log(`Name:        ${varbinds[0].value}`);
        if (!snmp.isVarbindError(varbinds[1])) console.log(`Description: ${varbinds[1].value}`);
        if (!snmp.isVarbindError(varbinds[2])) console.log(`Uptime (raw): ${varbinds[2].value}`);
        console.log("-------------------\n");
    }
    session.close();
});
/**
 * BioCloud IoT -> Google Firebase Cloud Database Synchronizer
 * 
 * This script uploads all patient health records, time-series temperature telemetry,
 * alerts, and user accounts directly to Google Firebase Realtime Database (GCP).
 * 
 * Usage:
 *   node sync_to_firebase.js <YOUR_FIREBASE_DB_URL>
 * 
 * Example:
 *   node sync_to_firebase.js https://biocloud-health-default-rtdb.firebaseio.com
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DB_PATH = path.join(__dirname, 'data', 'biocloud_database.json');

// Read database URL from command line argument or environment variable
let firebaseUrl = process.argv[2] || process.env.FIREBASE_DB_URL;

if (!firebaseUrl) {
    console.log('========================================================================');
    console.log('  BioCloud IoT -> Google Firebase Cloud Database Sync Tool');
    console.log('========================================================================');
    console.log('');
    console.log('Please provide your Firebase Realtime Database URL.');
    console.log('');
    console.log('Steps to get your FREE Google Cloud Database URL (Takes 1 Minute):');
    console.log('1. Go to: https://console.firebase.google.com');
    console.log('2. Click "Add Project" -> Name it: "biocloud-iot"');
    console.log('3. In the left menu, click "Build" -> "Realtime Database"');
    console.log('4. Click "Create Database" -> Choose "Start in test mode" (Enable)');
    console.log('5. Copy the URL shown at the top (e.g. https://biocloud-iot-default-rtdb.firebaseio.com)');
    console.log('');
    console.log('Then run:');
    console.log('   node sync_to_firebase.js https://YOUR-PROJECT-default-rtdb.firebaseio.com');
    console.log('========================================================================');
    process.exit(1);
}

// Clean URL
firebaseUrl = firebaseUrl.replace(/\/+$/, '');
if (!firebaseUrl.endsWith('.json')) {
    firebaseUrl += '/biocloud_health_records.json';
}

console.log(`[1/3] Reading patient health database from: ${DB_PATH}...`);
if (!fs.existsSync(DB_PATH)) {
    console.error('Error: biocloud_database.json not found!');
    process.exit(1);
}

const rawData = fs.readFileSync(DB_PATH, 'utf8');
const db = JSON.parse(rawData);

console.log(`[2/3] Preparing Cloud Payload:`);
console.log(`      - Patients: ${db.patients?.length || 0} records`);
console.log(`      - Telemetry Readings: ${db.temperature_history?.length || 0} records`);
console.log(`      - Critical Alerts: ${db.alerts?.length || 0} records`);
console.log(`      - Registered Users: ${db.users?.length || 0} records`);

const payload = JSON.stringify({
    metadata: {
        project: "BioCloud IoT - Smart Healthcare Monitoring System",
        cloudProvider: "Google Cloud Platform (Firebase Realtime DBaaS)",
        uploadedAt: new Date().toISOString(),
        hostEnvironment: "Cloud PaaS Edge Node"
    },
    patients: db.patients,
    temperature_history: db.temperature_history.slice(-100), // latest 100
    alerts: db.alerts,
    users: db.users.map(u => ({ id: u.id, full_name: u.full_name, email: u.email, role: u.role })),
    patient_relatives: db.patient_relatives,
    audit_logs: db.audit_logs.slice(-30),
    device_health: db.device_health
});

console.log(`[3/3] Uploading to Google Cloud Provider (${firebaseUrl})...`);

const urlObj = new URL(firebaseUrl);
const options = {
    hostname: urlObj.hostname,
    port: 443,
    path: urlObj.pathname + (urlObj.search || ''),
    method: 'PUT',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
    }
};

const req = https.request(options, (res) => {
    let responseBody = '';
    res.on('data', chunk => responseBody += chunk);
    res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log('');
            console.log('========================================================================');
            console.log('  SUCCESS! Patient Health Data is now LIVE in Google Cloud!');
            console.log('========================================================================');
            console.log('Go to Google Firebase Console to view your data:');
            console.log(`👉 https://console.firebase.google.com`);
            console.log('');
            console.log('Click on: Realtime Database -> Data');
            console.log('You will see the full live database tree:');
            console.log('  ├── patients (John Doe, Sarah Jenkins, Michael Chang)');
            console.log('  ├── temperature_history (Time-series temperature readings)');
            console.log('  ├── alerts (Critical fever warnings & acknowledgments)');
            console.log('  └── users & patient_relatives');
            console.log('========================================================================');
        } else {
            console.error(`Upload failed with status code ${res.statusCode}: ${responseBody}`);
            console.log('Hint: Make sure your Firebase Realtime Database rules are set to "test mode" (read: true, write: true).');
        }
    });
});

req.on('error', (err) => {
    console.error('Network error uploading to Firebase:', err.message);
});

req.write(payload);
req.end();

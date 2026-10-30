/* =============================================================================
   BioCloud IoT — Virtual ESP32 + DS18B20 Telemetry Simulator
   Simulates ESP32 Wi-Fi hardware publishing periodic temperature readings
   Usage: node test/esp32_simulator.js [mode]
   Modes:
     - auto (default): Streams normal temp -> triggers fever after 15s -> recovers
     - normal: Sends normal 36.8 °C readings
     - fever: Sends critical 38.6 °C high fever (triggers relative mobile alarm)
     - disconnect: Simulates sensor wire disconnection (-127 °C)
   ============================================================================= */

const http = require('http');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';
const PATIENT_ID = process.env.PATIENT_ID || 'p1';
const DEVICE_ID = 'SIMULATED-ESP32-DS18B20';

const mode = process.argv[2] || 'auto';

console.log('================================================================');
console.log(`🤖 BioCloud Virtual ESP32 Hardware Simulator`);
console.log(`   Target Server: http://${HOST}:${PORT}/api/telemetry`);
console.log(`   Patient ID:    ${PATIENT_ID}`);
console.log(`   Mode:          ${mode}`);
console.log('================================================================\n');

function sendReading(temperature, sensorStatus = 'OK') {
    const payload = JSON.stringify({
        deviceId: DEVICE_ID,
        patientId: PATIENT_ID,
        temperature: parseFloat(temperature.toFixed(2)),
        unit: 'C',
        timestamp: new Date().toISOString(),
        sensorStatus
    });

    const options = {
        hostname: HOST,
        port: PORT,
        path: '/api/telemetry',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const req = http.request(options, res => {
        let resData = '';
        res.on('data', chunk => { resData += chunk; });
        res.on('end', () => {
            const time = new Date().toLocaleTimeString();
            try {
                const json = JSON.parse(resData);
                const status = json.evaluation ? json.evaluation.status : 'OK';
                const icon = status === 'CRITICAL' ? '🚨' : status === 'WARNING' ? '⚠️' : '✅';
                console.log(`[${time}] ${icon} Sent: ${temperature.toFixed(2)} °C | Status: ${status} | HTTP ${res.statusCode}`);
                if (status === 'CRITICAL') {
                    console.log(`      🔥 CRITICAL ALERT ACTIVE! Relative phone ringing alarm siren.`);
                }
            } catch (e) {
                console.log(`[${time}] Sent: ${temperature.toFixed(2)} °C | HTTP ${res.statusCode}`);
            }
        });
    });

    req.on('error', err => {
        console.error(`❌ Connection failed to http://${HOST}:${PORT}/api/telemetry — is server running? (${err.message})`);
    });

    req.write(payload);
    req.end();
}

let tick = 0;

if (mode === 'fever') {
    console.log('Sending continuous 38.6 °C critical fever reading every 3s...');
    setInterval(() => {
        sendReading(38.6 + (Math.random() * 0.4 - 0.2), 'OK');
    }, 3000);
} else if (mode === 'normal') {
    console.log('Sending continuous normal 36.8 °C readings every 3s...');
    setInterval(() => {
        sendReading(36.7 + (Math.random() * 0.3), 'OK');
    }, 3000);
} else if (mode === 'disconnect') {
    console.log('Sending sensor disconnect reading (-127 °C)...');
    sendReading(-127.00, 'DISCONNECTED');
} else {
    // AUTO DEMO CYCLE:
    // Seconds 0-12: Normal vitals (36.7 - 37.0 °C)
    // Seconds 15-30: High Fever (> 38.2 °C) -> Triggers Relative Alarm!
    // Seconds 33+: Recovery back to normal (36.8 °C) -> Sends recovery notification
    console.log('Starting Auto Demo Cycle:');
    console.log('  - Step 1: Normal temperature (36.8 °C)');
    console.log('  - Step 2: High Fever Spike (38.5 °C) after 15 seconds to trigger Mobile Alarm');
    console.log('  - Step 3: Temperature recovery back to 36.8 °C');
    console.log('----------------------------------------------------------------');

    setInterval(() => {
        tick++;
        let temp;
        if (tick <= 4) {
            temp = 36.8 + (Math.random() * 0.2 - 0.1);
        } else if (tick <= 8) {
            // FEVER SPIKE!
            temp = 38.4 + (Math.random() * 0.4);
        } else if (tick <= 12) {
            // Return to recovery
            temp = 36.9 + (Math.random() * 0.2 - 0.1);
        } else {
            tick = 0; // Repeat cycle
            temp = 36.8;
        }
        sendReading(temp, 'OK');
    }, 3000);
}

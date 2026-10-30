/* ==========================================================================
   BioCloud IoT — Real-Time Cloud Patient Temperature Monitoring Server
   Native Node.js Server (Zero External Dependencies)
   - Serves SPA on 0.0.0.0:3000 (accessible on PC and local Wi-Fi mobile phones)
   - Persistent disk database: data/biocloud_database.json
   - Ingests DS18B20 temperature telemetry from ESP32 & Simulator
   - Threshold Evaluation & Deduplicated Alert Engine
   - Real-Time Server-Sent Events (SSE) stream for live mobile audio alarms
   - Complete 3-Module RBAC: Admin, Doctor, Relative
   ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data', 'biocloud_database.json');

// ─────────────────────────────────────────────────────────────────────────────
//  NETWORK HELPER: Get Local Wi-Fi IPv4 Address
// ─────────────────────────────────────────────────────────────────────────────
function getLocalIp() {
    const interfaces = os.networkInterfaces();
    // First pass: look specifically for Wi-Fi or Wireless adapters
    for (const name of Object.keys(interfaces)) {
        if (/wi-?fi|wireless|wlan/i.test(name)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return iface.address;
                }
            }
        }
    }
    // Second pass: any valid LAN IP excluding virtualbox/vmware 192.168.56.x
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                if (!iface.address.startsWith('192.168.56.') && (iface.address.startsWith('192.168.') || iface.address.startsWith('10.') || iface.address.startsWith('172.'))) {
                    return iface.address;
                }
            }
        }
    }
    return '127.0.0.1';
}

const LOCAL_IP = getLocalIp();

// ─────────────────────────────────────────────────────────────────────────────
//  PERSISTENT DATABASE LAYER (JSON on Disk)
// ─────────────────────────────────────────────────────────────────────────────
function initDatabase() {
    if (fs.existsSync(DB_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        } catch (e) {
            console.error('[DB] Error reading existing DB, re-seeding:', e.message);
        }
    }

    // Default Seed Data
    const seed = {
        meta: {
            seeded_at: new Date().toISOString(),
            version: '2.0.0'
        },
        users: [
            {
                id: 'usr-admin-01',
                full_name: 'Hospital Administrator',
                email: 'admin@hospital.org',
                password_hash: hashPasswordSync('Admin@123!', 'fixed_admin_salt_123'),
                password_salt: 'fixed_admin_salt_123',
                role: 'admin',
                email_verified: true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            },
            {
                id: 'usr-doc-01',
                full_name: 'Dr. Aris Thorne',
                email: 'dr.thorne@cardio.org',
                password_hash: hashPasswordSync('Doc@123!', 'fixed_doc_salt_01'),
                password_salt: 'fixed_doc_salt_01',
                role: 'doctor',
                assigned_patient_id: 'p1',
                email_verified: true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            },
            {
                id: 'usr-doc-02',
                full_name: 'Dr. Elena Vance',
                email: 'dr.vance@pulmo.org',
                password_hash: hashPasswordSync('Doc@123!', 'fixed_doc_salt_02'),
                password_salt: 'fixed_doc_salt_02',
                role: 'doctor',
                assigned_patient_id: 'p2',
                email_verified: true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            },
            {
                id: 'usr-doc-03',
                full_name: 'Dr. Marcus Brody',
                email: 'dr.brody@geriatric.org',
                password_hash: hashPasswordSync('Doc@123!', 'fixed_doc_salt_03'),
                password_salt: 'fixed_doc_salt_03',
                role: 'doctor',
                assigned_patient_id: 'p3',
                email_verified: true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }
        ],
        patients: [
            {
                id: 'p1',
                patient_code: '#PT-89421',
                name: 'John Doe',
                age: 68,
                gender: 'Male',
                ward: 'ICU Ward A',
                bed: 'Bed 01',
                diagnosis: 'Acute Myocardial Infarction',
                status: 'Critical',
                blood_group: 'O+',
                assigned_doctor: 'dr.thorne@cardio.org',
                assigned_doctor_name: 'Dr. Aris Thorne (Cardiology)',
                vitals_baseline: { bpm: 74, spo2: 98.4, tempC: 36.8, accelG: 1.01 },
                // Configurable Temperature Thresholds
                temp_threshold_warning: 37.5,
                temp_threshold_critical: 38.0,
                sensor_status: 'OK',
                last_reading: {
                    temperature: 36.8,
                    recordedAt: new Date().toISOString(),
                    deviceId: 'ESP32-DS18B20-01',
                    sensorStatus: 'OK'
                },
                appointments: [
                    { date: '2026-10-25', time: '09:00', type: 'Cardiology Review', doctor: 'Dr. Aris Thorne', status: 'Scheduled' }
                ],
                reports: [
                    { id: 'rep-01', date: '2026-10-20', type: 'ECG Report', summary: 'Sinus rhythm, monitoring post-MI recovery', added_by: 'dr.thorne@cardio.org' }
                ],
                treatment_notes: [
                    { id: 'not-01', date: '2026-10-24', note: 'Continuous temperature and ECG monitoring active.', added_by: 'dr.thorne@cardio.org' }
                ],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            },
            {
                id: 'p2',
                patient_code: '#PT-92304',
                name: 'Sarah Jenkins',
                age: 45,
                gender: 'Female',
                ward: 'ICU Ward B',
                bed: 'Bed 02',
                diagnosis: 'Post-Operative Recovery (Appendectomy)',
                status: 'Stable',
                blood_group: 'A-',
                assigned_doctor: 'dr.vance@pulmo.org',
                assigned_doctor_name: 'Dr. Elena Vance (Pulmonology)',
                vitals_baseline: { bpm: 82, spo2: 96.8, tempC: 37.1, accelG: 1.05 },
                temp_threshold_warning: 37.5,
                temp_threshold_critical: 38.0,
                sensor_status: 'OK',
                last_reading: {
                    temperature: 37.1,
                    recordedAt: new Date().toISOString(),
                    deviceId: 'ESP32-DS18B20-02',
                    sensorStatus: 'OK'
                },
                appointments: [
                    { date: '2026-10-26', time: '11:00', type: 'Post-Op Review', doctor: 'Dr. Elena Vance', status: 'Scheduled' }
                ],
                reports: [],
                treatment_notes: [
                    { id: 'not-02', date: '2026-10-24', note: 'Wound healing well. Body temperature stable.', added_by: 'dr.vance@pulmo.org' }
                ],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            },
            {
                id: 'p3',
                patient_code: '#PT-71089',
                name: 'Robert Chen',
                age: 72,
                gender: 'Male',
                ward: 'Home Remote Care',
                bed: 'Home-04',
                diagnosis: 'COPD Management',
                status: 'Monitored',
                blood_group: 'B+',
                assigned_doctor: 'dr.brody@geriatric.org',
                assigned_doctor_name: 'Dr. Marcus Brody (Geriatrics)',
                vitals_baseline: { bpm: 68, spo2: 97.5, tempC: 36.5, accelG: 0.98 },
                temp_threshold_warning: 37.5,
                temp_threshold_critical: 38.0,
                sensor_status: 'OK',
                last_reading: {
                    temperature: 36.5,
                    recordedAt: new Date().toISOString(),
                    deviceId: 'ESP32-DS18B20-03',
                    sensorStatus: 'OK'
                },
                appointments: [],
                reports: [],
                treatment_notes: [],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }
        ],
        patient_relatives: [],
        temperature_history: [
            // Sample historical readings for Patient 1
            { id: 'th-01', patientId: 'p1', deviceId: 'ESP32-DS18B20-01', temperatureCelsius: 36.7, recordedAt: new Date(Date.now() - 600000).toISOString(), receivedAt: new Date(Date.now() - 600000).toISOString(), sensorStatus: 'OK' },
            { id: 'th-02', patientId: 'p1', deviceId: 'ESP32-DS18B20-01', temperatureCelsius: 36.8, recordedAt: new Date(Date.now() - 300000).toISOString(), receivedAt: new Date(Date.now() - 300000).toISOString(), sensorStatus: 'OK' },
            { id: 'th-03', patientId: 'p1', deviceId: 'ESP32-DS18B20-01', temperatureCelsius: 36.8, recordedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), sensorStatus: 'OK' }
        ],
        alerts: [],
        notifications: [],
        audit_logs: [
            {
                id: 'aud-01',
                actor_id: 'usr-admin-01',
                actor_role: 'admin',
                action: 'SYSTEM_BOOT',
                target_type: 'server',
                target_id: 'node-server',
                metadata: { ip: LOCAL_IP, port: PORT },
                timestamp: new Date().toISOString()
            }
        ],
        device_health: {
            last_seen: new Date().toISOString(),
            status: 'ONLINE',
            device_id: 'ESP32-DS18B20-01',
            total_readings: 3
        }
    };

    saveDatabase(seed);
    return seed;
}

let serverDataVersion = Date.now();

function saveDatabase(data) {
    serverDataVersion = Date.now();
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

let DB = initDatabase();

function hashPasswordSync(password, salt) {
    return crypto.createHash('sha256').update(password + salt).digest('hex');
}

let cachedCloudUrl = null;
function fetchCloudUrl() {
    return new Promise(resolve => {
        const req = http.get('http://127.0.0.1:20241/quicktunnel', { timeout: 1200 }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.hostname) {
                        cachedCloudUrl = `https://${json.hostname}`;
                        return resolve(cachedCloudUrl);
                    }
                } catch (_) {}
                resolve(cachedCloudUrl);
            });
        });
        req.on('error', () => resolve(cachedCloudUrl));
        req.on('timeout', () => { req.destroy(); resolve(cachedCloudUrl); });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  SERVER-SENT EVENTS (SSE) BROADCAST SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
const sseClients = new Set();

function broadcastSSE(eventType, data) {
    serverDataVersion = Date.now();
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(payload);
        } catch (e) {
            sseClients.delete(client);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  THRESHOLD EVALUATION & ALERT ENGINE
// ─────────────────────────────────────────────────────────────────────────────
// In-memory active alert state tracker to prevent duplicate notifications
const activeAlertStates = {
    // patientId: { isCritical: false, isWarning: false, lastAlertTime: 0, consecutiveHighCount: 0 }
};

function evaluateTemperatureReading(reading) {
    const { patientId, deviceId, temperature, sensorStatus, timestamp } = reading;
    const temp = parseFloat(temperature);
    const patient = DB.patients.find(p => p.id === patientId);

    if (!patient) return { alertCreated: false, reason: 'PATIENT_NOT_FOUND' };

    // Record temperature history
    const historyEntry = {
        id: 'th-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
        patientId,
        deviceId: deviceId || 'ESP32-DS18B20',
        temperatureCelsius: temp,
        recordedAt: timestamp || new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        sensorStatus: sensorStatus || (isNaN(temp) || temp < -100 ? 'DISCONNECTED' : 'OK')
    };

    DB.temperature_history.push(historyEntry);
    if (DB.temperature_history.length > 2000) {
        DB.temperature_history = DB.temperature_history.slice(-2000);
    }

    // Update patient current vitals & status
    patient.vitals_baseline.tempC = temp;
    patient.sensor_status = historyEntry.sensorStatus;
    patient.last_reading = {
        temperature: temp,
        recordedAt: historyEntry.recordedAt,
        deviceId: historyEntry.deviceId,
        sensorStatus: historyEntry.sensorStatus
    };
    patient.updated_at = new Date().toISOString();

    // Update device health tracker
    DB.device_health = {
        last_seen: new Date().toISOString(),
        status: historyEntry.sensorStatus === 'OK' ? 'ONLINE' : 'SENSOR_DISCONNECTED',
        device_id: historyEntry.deviceId,
        total_readings: (DB.device_health?.total_readings || 0) + 1,
        last_temperature: temp
    };

    // State tracker for this patient
    if (!activeAlertStates[patientId]) {
        activeAlertStates[patientId] = {
            isCritical: false,
            isWarning: false,
            consecutiveHighCount: 0,
            lastAlertTime: 0
        };
    }
    const state = activeAlertStates[patientId];

    const warningThreshold = patient.temp_threshold_warning || 37.5;
    const criticalThreshold = patient.temp_threshold_critical || 38.0;

    let alertResult = { status: 'NORMAL', alertCreated: false };

    // Handle sensor disconnection
    if (historyEntry.sensorStatus === 'DISCONNECTED' || temp <= -100) {
        broadcastSSE('DEVICE_STATUS', {
            patientId,
            status: 'DISCONNECTED',
            message: `⚠️ DS18B20 Sensor disconnected or reading invalid on ${deviceId}`
        });
        saveDatabase(DB);
        return { status: 'DISCONNECTED', alertCreated: false };
    }

    // CRITICAL FEVER CONDITION: Temp >= Critical Threshold (e.g. 38.0 °C)
    if (temp >= criticalThreshold) {
        state.consecutiveHighCount++;
        alertResult.status = 'CRITICAL';

        // If patient alert was previously acknowledged, but temperature spikes higher (+0.6°C), re-arm alert
        if (patient.alert_acknowledged && patient.alert_acknowledged_temp && (temp - patient.alert_acknowledged_temp >= 0.6)) {
            patient.alert_acknowledged = false;
        }

        // Cooldown: send at most once every 60 seconds if continuously critical,
        // or immediately if transitioning into critical state
        const now = Date.now();
        const timeSinceLast = now - (state.lastAlertTime || 0);

        if (!state.isCritical || timeSinceLast > 60000) {
            state.isCritical = true;
            state.isWarning = true;
            state.lastAlertTime = now;

            const alertId = 'alt-' + Date.now();
            const alertMsg = `URGENT: Patient ${patient.name} (${patient.patient_code}) has a high temperature of ${temp.toFixed(1)} °C. Configured alert threshold: ${criticalThreshold.toFixed(1)} °C. Please contact the hospital care team immediately for guidance.`;

            // Create Alert Record
            const alertRecord = {
                id: alertId,
                patient_id: patientId,
                patient_name: patient.name,
                type: 'HIGH_TEMPERATURE_CRITICAL',
                temperature: temp,
                threshold: criticalThreshold,
                message: alertMsg,
                status: 'ACTIVE',
                acknowledged: false,
                acknowledged_by: null,
                acknowledged_at: null,
                created_at: new Date().toISOString()
            };
            DB.alerts.push(alertRecord);

            // Notify all actively linked relatives
            const linkedRelatives = DB.patient_relatives.filter(r => r.patient_id === patientId && r.status === 'active');
            linkedRelatives.forEach(rel => {
                DB.notifications.push({
                    id: 'not-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
                    relative_user_id: rel.relative_user_id,
                    patient_id: patientId,
                    patient_name: patient.name,
                    type: 'critical',
                    message: alertMsg,
                    delivery_status: 'delivered',
                    read: false,
                    created_at: new Date().toISOString()
                });
            });

            // Log Audit Entry
            DB.audit_logs.push({
                id: 'aud-' + Date.now(),
                actor_id: deviceId,
                actor_role: 'iot-edge',
                action: 'HIGH_TEMP_CRITICAL_ALERT',
                target_type: 'patient',
                target_id: patientId,
                metadata: { temperature: temp, threshold: criticalThreshold, relativesNotified: linkedRelatives.length },
                timestamp: new Date().toISOString()
            });

            alertResult.alertCreated = true;
            alertResult.alert = alertRecord;

            // Broadcast SSE Event for instant mobile audio alarm & overlay
            broadcastSSE('CRITICAL_TEMP_ALERT', {
                alert: alertRecord,
                patientId,
                patientName: patient.name,
                temperature: temp,
                threshold: criticalThreshold,
                message: alertMsg,
                timestamp: new Date().toISOString()
            });
        }
    }
    // WARNING CONDITION: Warning Threshold <= Temp < Critical Threshold (e.g. 37.5 - 37.9 °C)
    else if (temp >= warningThreshold) {
        state.consecutiveHighCount = 0;
        alertResult.status = 'WARNING';

        if (!state.isWarning) {
            state.isWarning = true;
            state.isCritical = false;

            const warnMsg = `Advisory: Patient ${patient.name} temperature is elevated at ${temp.toFixed(1)} °C (Threshold: ${warningThreshold.toFixed(1)} °C). Continuous monitoring active.`;

            // Notify linked relatives
            const linkedRelatives = DB.patient_relatives.filter(r => r.patient_id === patientId && r.status === 'active');
            linkedRelatives.forEach(rel => {
                DB.notifications.push({
                    id: 'not-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
                    relative_user_id: rel.relative_user_id,
                    patient_id: patientId,
                    patient_name: patient.name,
                    type: 'update',
                    message: warnMsg,
                    delivery_status: 'delivered',
                    read: false,
                    created_at: new Date().toISOString()
                });
            });

            broadcastSSE('TEMP_WARNING', {
                patientId,
                patientName: patient.name,
                temperature: temp,
                threshold: warningThreshold,
                message: warnMsg
            });
        }
    }
    // RECOVERY CONDITION: Temp returned to Normal (< warningThreshold)
    else {
        if (state.isCritical || state.isWarning) {
            // Patient recovered from fever/warning
            state.isCritical = false;
            state.isWarning = false;
            state.consecutiveHighCount = 0;

            const recoveryMsg = `RESOLVED: Patient ${patient.name} body temperature has returned to safe range (${temp.toFixed(1)} °C).`;

            const linkedRelatives = DB.patient_relatives.filter(r => r.patient_id === patientId && r.status === 'active');
            linkedRelatives.forEach(rel => {
                DB.notifications.push({
                    id: 'not-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
                    relative_user_id: rel.relative_user_id,
                    patient_id: patientId,
                    patient_name: patient.name,
                    type: 'info',
                    message: recoveryMsg,
                    delivery_status: 'delivered',
                    read: false,
                    created_at: new Date().toISOString()
                });
            });

            // Mark active alerts for this patient as resolved
            DB.alerts.forEach(a => {
                if (a.patient_id === patientId && a.status === 'ACTIVE') {
                    a.status = 'RESOLVED';
                    a.resolved_at = new Date().toISOString();
                }
            });

            // Reset alert acknowledgment state so future episodes will trigger alarms
            patient.alert_acknowledged = false;
            patient.alert_acknowledged_temp = null;

            broadcastSSE('TEMP_RECOVERY', {
                patientId,
                patientName: patient.name,
                temperature: temp,
                message: recoveryMsg
            });
        }
    }

    // Always broadcast standard telemetry update to update live charts and displays
    broadcastSSE('TELEMETRY_UPDATE', {
        patientId,
        patientName: patient.name,
        temperature: temp,
        recordedAt: historyEntry.recordedAt,
        sensorStatus: historyEntry.sensorStatus,
        status: alertResult.status
    });

    saveDatabase(DB);
    return alertResult;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP REQUEST PARSER & ROUTER
// ─────────────────────────────────────────────────────────────────────────────
function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                resolve({});
            }
        });
    });
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
    });
    res.end(JSON.stringify(data));
}

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
    // CORS Pre-flight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
        });
        return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // ─── SSE ENDPOINT ────────────────────────────────────────────────────────
    if (pathname === '/api/stream') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*'
        });
        // Send 2KB initial comment padding to immediately defeat Cloudflare edge buffering
        res.write(': ' + 'x'.repeat(2048) + '\n\n');
        res.write(`event: CONNECTED\ndata: ${JSON.stringify({ message: 'Connected to BioCloud Real-Time Stream', localIp: LOCAL_IP, version: serverDataVersion })}\n\n`);
        sseClients.add(res);

        // Keep-alive heartbeat every 12 seconds to prevent Cloudflare / mobile carrier stream drops
        const keepAliveTimer = setInterval(() => {
            try {
                res.write(': keepalive\n\n');
            } catch (_) {
                clearInterval(keepAliveTimer);
                sseClients.delete(res);
            }
        }, 12000);

        // Immediately push any critical patient alert to newly connected clients
        try {
            DB.patients.forEach(p => {
                const temp = p.vitals_baseline?.tempC || 36.8;
                const critThresh = p.temp_threshold_critical || 38.0;
                if (p.status === 'Critical' || temp >= critThresh) {
                    res.write(`event: CRITICAL_TEMP_ALERT\ndata: ${JSON.stringify({
                        patientId: p.id,
                        patientName: p.name,
                        temperature: temp,
                        threshold: critThresh,
                        message: `URGENT: Patient ${p.name} (${p.patient_code}) is in CRITICAL condition with body temperature of ${temp.toFixed(1)} °C. Please contact the hospital care team immediately.`,
                        timestamp: new Date().toISOString()
                    })}\n\n`);
                }
            });
        } catch (_) {}

        req.on('close', () => {
            clearInterval(keepAliveTimer);
            sseClients.delete(res);
        });
        return;
    }

    // ─── API: INFO ───────────────────────────────────────────────────────────
    if (pathname === '/api/info' && req.method === 'GET') {
        const cloudUrl = await fetchCloudUrl();
        return sendJson(res, 200, {
            name: 'BioCloud IoT Cloud Server',
            version: '2.0.0',
            localIp: LOCAL_IP,
            port: PORT,
            serverUrl: `http://${LOCAL_IP}:${PORT}`,
            cloudUrl: cloudUrl || null,
            connectedClients: sseClients.size,
            deviceHealth: DB.device_health,
            uptimeSeconds: Math.floor(process.uptime())
        });
    }

    // ─── API: ESP32 & SIMULATOR TELEMETRY INGESTION ─────────────────────────
    if (pathname === '/api/telemetry' && req.method === 'POST') {
        const body = await parseBody(req);
        const { deviceId, patientId, temperature, unit, timestamp, sensorStatus } = body;

        if (temperature === undefined || !patientId) {
            return sendJson(res, 400, { error: 'MISSING_REQUIRED_FIELDS', message: 'patientId and temperature are required' });
        }

        const evaluation = evaluateTemperatureReading({
            deviceId: deviceId || 'ESP32-DS18B20-DEFAULT',
            patientId: patientId || 'p1',
            temperature: parseFloat(temperature),
            unit: unit || 'C',
            timestamp: timestamp || new Date().toISOString(),
            sensorStatus: sensorStatus || 'OK'
        });

        return sendJson(res, 200, {
            success: true,
            receivedAt: new Date().toISOString(),
            evaluation
        });
    }

    // ─── API: TELEMETRY HISTORY ──────────────────────────────────────────────
    if (pathname.startsWith('/api/telemetry/history/') && req.method === 'GET') {
        const patientId = pathname.split('/')[4];
        const history = DB.temperature_history
            .filter(h => h.patientId === patientId)
            .slice(-60); // Return last 60 readings
        return sendJson(res, 200, history);
    }

    // ─── API: DEVICE STATUS ──────────────────────────────────────────────────
    if (pathname === '/api/telemetry/device-status' && req.method === 'GET') {
        return sendJson(res, 200, DB.device_health || { status: 'OFFLINE' });
    }

    // ─── API: PATIENTS ───────────────────────────────────────────────────────
    if (pathname === '/api/patients' && req.method === 'GET') {
        return sendJson(res, 200, DB.patients);
    }

    if (pathname.startsWith('/api/patients/') && req.method === 'GET') {
        const id = pathname.split('/')[3];
        const patient = DB.patients.find(p => p.id === id);
        if (!patient) return sendJson(res, 404, { error: 'PATIENT_NOT_FOUND' });
        return sendJson(res, 200, patient);
    }

    // PUT: Update Alert Threshold
    if (pathname.match(/^\/api\/patients\/[\w-]+\/threshold$/) && req.method === 'PUT') {
        const patientId = pathname.split('/')[3];
        const body = await parseBody(req);
        const patient = DB.patients.find(p => p.id === patientId);
        if (!patient) return sendJson(res, 404, { error: 'PATIENT_NOT_FOUND' });

        if (body.temp_threshold_warning !== undefined) {
            patient.temp_threshold_warning = parseFloat(body.temp_threshold_warning);
        }
        if (body.temp_threshold_critical !== undefined) {
            patient.temp_threshold_critical = parseFloat(body.temp_threshold_critical);
        }
        patient.updated_at = new Date().toISOString();

        DB.audit_logs.push({
            id: 'aud-' + Date.now(),
            actor_id: body.actor_id || 'admin',
            actor_role: 'admin',
            action: 'UPDATE_TEMP_THRESHOLD',
            target_type: 'patient',
            target_id: patientId,
            metadata: { warning: patient.temp_threshold_warning, critical: patient.temp_threshold_critical },
            timestamp: new Date().toISOString()
        });

        saveDatabase(DB);
        broadcastSSE('THRESHOLD_UPDATED', { patientId, warning: patient.temp_threshold_warning, critical: patient.temp_threshold_critical });
        broadcastSSE('DATABASE_CHANGED', { reason: 'THRESHOLD_UPDATED', patientId });
        return sendJson(res, 200, { success: true, patient });
    }

    // POST: Clinical Note
    if (pathname.match(/^\/api\/patients\/[\w-]+\/notes$/) && req.method === 'POST') {
        const patientId = pathname.split('/')[3];
        const body = await parseBody(req);
        const patient = DB.patients.find(p => p.id === patientId);
        if (!patient) return sendJson(res, 404, { error: 'PATIENT_NOT_FOUND' });

        const note = {
            id: 'not-' + Date.now(),
            date: new Date().toISOString().split('T')[0],
            note: body.note,
            added_by: body.added_by || 'Doctor',
            created_at: new Date().toISOString()
        };
        patient.treatment_notes = patient.treatment_notes || [];
        patient.treatment_notes.push(note);
        patient.updated_at = new Date().toISOString();

        // Notify relatives
        const linkedRelatives = DB.patient_relatives.filter(r => r.patient_id === patientId && r.status === 'active');
        linkedRelatives.forEach(rel => {
            DB.notifications.push({
                id: 'notif-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
                relative_user_id: rel.relative_user_id,
                patient_id: patientId,
                patient_name: patient.name,
                type: 'update',
                message: `Clinical update for ${patient.name}: "${body.note.substring(0, 70)}…"`,
                delivery_status: 'delivered',
                read: false,
                created_at: new Date().toISOString()
            });
        });

        saveDatabase(DB);
        broadcastSSE('CLINICAL_NOTE_ADDED', { patientId, note });
        broadcastSSE('DATABASE_CHANGED', { reason: 'NOTE_ADDED', patientId });
        return sendJson(res, 200, { success: true, note });
    }

    // ─── API: RELATIVE ACCESS MANAGEMENT ─────────────────────────────────────
    if (pathname === '/api/relatives/my-patients' && req.method === 'GET') {
        const userId = (parsedUrl.searchParams.get('userId') || '').trim();
        const email = (parsedUrl.searchParams.get('email') || '').toLowerCase().trim();
        if (!userId && !email) return sendJson(res, 400, { error: 'USER_ID_OR_EMAIL_REQUIRED' });

        // Collect all potential matching identifiers
        const targetIds = new Set();
        if (userId) targetIds.add(userId);

        // Find users matching either userId or email
        const matchedUsers = DB.users.filter(u => {
            if (email && u.email && u.email.toLowerCase() === email) return true;
            if (userId && (u.id === userId || (u.email && u.email.toLowerCase() === userId.toLowerCase()))) return true;
            return false;
        });

        matchedUsers.forEach(u => {
            targetIds.add(u.id);
            if (u.email) targetIds.add(u.email.toLowerCase());
        });

        // Object-level authorization: return ONLY actively linked patients
        const activeLinks = DB.patient_relatives.filter(r => {
            if (r.status !== 'active') return false;
            if (targetIds.has(r.relative_user_id)) return true;
            const u = DB.users.find(usr => usr.id === r.relative_user_id);
            if (u && (
                (email && u.email.toLowerCase() === email) ||
                (userId && (u.id === userId || u.email.toLowerCase() === userId.toLowerCase()))
            )) {
                return true;
            }
            return false;
        });

        const authorizedPatientIds = activeLinks.map(l => l.patient_id);
        const authorizedPatients = DB.patients
            .filter(p => authorizedPatientIds.includes(p.id))
            .map(p => {
                const link = activeLinks.find(l => l.patient_id === p.id);
                return {
                    ...p,
                    linked_at: link ? link.linked_at : new Date().toISOString()
                };
            });

        return sendJson(res, 200, authorizedPatients);
    }

    if (pathname === '/api/relatives/link' && req.method === 'POST') {
        const body = await parseBody(req);
        const { patientId, email, adminId } = body;

        const relative = DB.users.find(u => u.email.toLowerCase() === (email || '').toLowerCase().trim());
        if (!relative) {
            return sendJson(res, 404, { error: 'RELATIVE_NOT_FOUND', message: 'This email is not registered yet. Ask the relative to register first.' });
        }
        if (!relative.email_verified) {
            return sendJson(res, 400, { error: 'EMAIL_NOT_VERIFIED', message: 'Relative account is registered but email is not verified yet.' });
        }
        if (relative.role !== 'relative') {
            return sendJson(res, 400, { error: 'INVALID_ROLE', message: 'User is not a relative account.' });
        }

        const patient = DB.patients.find(p => p.id === patientId);
        if (!patient) return sendJson(res, 404, { error: 'PATIENT_NOT_FOUND' });

        // Check if link already exists
        const existing = DB.patient_relatives.find(r => r.patient_id === patientId && r.relative_user_id === relative.id);
        if (existing) {
            if (existing.status === 'active') {
                return sendJson(res, 409, { error: 'ALREADY_LINKED', message: 'Relative is already actively linked to this patient.' });
            }
            // Re-activate
            existing.status = 'active';
            existing.linked_at = new Date().toISOString();
            existing.linked_by_admin_id = adminId || 'admin';
        } else {
            DB.patient_relatives.push({
                id: 'rel-link-' + Date.now(),
                patient_id: patientId,
                relative_user_id: relative.id,
                linked_by_admin_id: adminId || 'admin',
                linked_at: new Date().toISOString(),
                status: 'active'
            });
        }

        // Send Welcome Notification to Relative
        DB.notifications.push({
            id: 'notif-' + Date.now(),
            relative_user_id: relative.id,
            patient_id: patientId,
            patient_name: patient.name,
            type: 'info',
            message: `You have been authorized by Hospital Administration to view health & temperature updates for ${patient.name}.`,
            delivery_status: 'delivered',
            read: false,
            created_at: new Date().toISOString()
        });

        // Audit Log
        DB.audit_logs.push({
            id: 'aud-' + Date.now(),
            actor_id: adminId || 'admin',
            actor_role: 'admin',
            action: 'LINK_RELATIVE',
            target_type: 'patient_relative',
            target_id: `${patientId}:${relative.id}`,
            metadata: { patient: patient.name, relativeEmail: relative.email },
            timestamp: new Date().toISOString()
        });

        saveDatabase(DB);
        broadcastSSE('RELATIVE_LINKED', { patientId, relativeId: relative.id, relativeEmail: relative.email });
        broadcastSSE('DATABASE_CHANGED', { reason: 'RELATIVE_LINKED', patientId, relativeEmail: relative.email });
        return sendJson(res, 200, { success: true, message: `Successfully linked ${relative.full_name} to ${patient.name}` });
    }

    if (pathname === '/api/relatives/revoke' && req.method === 'POST') {
        const body = await parseBody(req);
        const { patientId, relativeUserId, adminId } = body;

        const link = DB.patient_relatives.find(r => r.patient_id === patientId && r.relative_user_id === relativeUserId && r.status === 'active');
        if (!link) return sendJson(res, 404, { error: 'LINK_NOT_FOUND', message: 'Active relationship not found.' });

        link.status = 'revoked';
        link.revoked_at = new Date().toISOString();

        DB.audit_logs.push({
            id: 'aud-' + Date.now(),
            actor_id: adminId || 'admin',
            actor_role: 'admin',
            action: 'REVOKE_RELATIVE',
            target_type: 'patient_relative',
            target_id: `${patientId}:${relativeUserId}`,
            timestamp: new Date().toISOString()
        });

        saveDatabase(DB);
        broadcastSSE('RELATIVE_REVOKED', { patientId, relativeUserId });
        broadcastSSE('DATABASE_CHANGED', { reason: 'RELATIVE_REVOKED', patientId });
        return sendJson(res, 200, { success: true, message: 'Relative access revoked successfully.' });
    }

    if (pathname.startsWith('/api/relatives/patient/') && req.method === 'GET') {
        const patientId = pathname.split('/')[4];
        const links = DB.patient_relatives.filter(r => r.patient_id === patientId && r.status === 'active');
        const result = links.map(l => {
            const user = DB.users.find(u => u.id === l.relative_user_id);
            return {
                id: l.id,
                relative_user_id: l.relative_user_id,
                name: user ? user.full_name : 'Unknown',
                email: user ? user.email : 'Unknown',
                linked_at: l.linked_at,
                status: l.status
            };
        });
        return sendJson(res, 200, result);
    }

    // ─── API: ALERTS ─────────────────────────────────────────────────────────
    if (pathname === '/api/alerts' && req.method === 'GET') {
        return sendJson(res, 200, DB.alerts.slice(-100));
    }

    if (pathname.match(/^\/api\/alerts\/[\w-]+\/ack$/) && req.method === 'POST') {
        const alertId = pathname.split('/')[3];
        const body = await parseBody(req);
        let alert = DB.alerts.find(a => a.id === alertId);
        if (!alert && (alertId === 'alt-latest' || alertId === 'latest')) {
            alert = DB.alerts.slice().reverse().find(a => a.status === 'ACTIVE' || !a.acknowledged) || DB.alerts[DB.alerts.length - 1];
        }

        const acknowledgedBy = body.userId || 'relative';
        const nowIso = new Date().toISOString();

        if (alert) {
            alert.acknowledged = true;
            alert.acknowledged_by = acknowledgedBy;
            alert.acknowledged_at = nowIso;
        }

        // Also mark on patient record
        const patientId = alert ? alert.patient_id : (body.patientId || 'p1');
        const patient = DB.patients.find(p => p.id === patientId);
        if (patient) {
            patient.alert_acknowledged = true;
            patient.alert_acknowledged_by = acknowledgedBy;
            patient.alert_acknowledged_at = nowIso;
            patient.alert_acknowledged_temp = alert ? alert.temperature : (patient.vitals_baseline?.tempC || 38.0);
        }

        saveDatabase(DB);
        broadcastSSE('ALERT_ACKNOWLEDGED', { alertId: alert?.id || 'alt-latest', patientId, acknowledgedBy });
        return sendJson(res, 200, { success: true, alert: alert || { acknowledged: true } });
    }

    if (pathname === '/api/alerts/acknowledge' && req.method === 'POST') {
        const body = await parseBody(req);
        const patientId = body.patientId || 'p1';
        const acknowledgedBy = body.userId || 'relative';
        const nowIso = new Date().toISOString();

        // Mark active alerts for this patient as acknowledged
        DB.alerts.forEach(a => {
            if ((!body.patientId || a.patient_id === body.patientId) && a.status === 'ACTIVE') {
                a.acknowledged = true;
                a.acknowledged_by = acknowledgedBy;
                a.acknowledged_at = nowIso;
            }
        });

        const patient = DB.patients.find(p => p.id === patientId);
        if (patient) {
            patient.alert_acknowledged = true;
            patient.alert_acknowledged_by = acknowledgedBy;
            patient.alert_acknowledged_at = nowIso;
            patient.alert_acknowledged_temp = body.temperature || patient.vitals_baseline?.tempC || 38.0;
        }

        saveDatabase(DB);
        broadcastSSE('ALERT_ACKNOWLEDGED', { patientId, acknowledgedBy });
        return sendJson(res, 200, { success: true, message: 'Alert acknowledged and muted successfully.' });
    }

    if (pathname === '/api/alerts/broadcast' && req.method === 'POST') {
        const body = await parseBody(req);
        const { patientId, temperature, message } = body;
        const patient = DB.patients.find(p => p.id === patientId);
        if (!patient) return sendJson(res, 404, { error: 'PATIENT_NOT_FOUND' });

        const temp = parseFloat(temperature) || (patient.vitals_baseline ? patient.vitals_baseline.tempC : 38.6);
        const critThreshold = patient.temp_threshold_critical || 38.0;
        const alertMsg = message || `URGENT: Patient ${patient.name} (${patient.patient_code}) has a high temperature of ${temp.toFixed(1)} °C. Configured alert threshold: ${critThreshold.toFixed(1)} °C. Please contact the hospital care team immediately for guidance.`;

        const alertRecord = {
            id: 'alt-' + Date.now(),
            patient_id: patientId,
            patient_name: patient.name,
            type: 'HIGH_TEMPERATURE_CRITICAL',
            temperature: temp,
            threshold: critThreshold,
            message: alertMsg,
            status: 'ACTIVE',
            acknowledged: false,
            acknowledged_by: null,
            acknowledged_at: null,
            created_at: new Date().toISOString()
        };
        DB.alerts.push(alertRecord);
        saveDatabase(DB);

        // Broadcast SSE Event immediately to all connected mobile relatives & doctors
        broadcastSSE('CRITICAL_TEMP_ALERT', {
            alert: alertRecord,
            patientId,
            patientName: patient.name,
            temperature: temp,
            threshold: critThreshold,
            message: alertMsg,
            timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, { success: true, alert: alertRecord });
    }

    // ─── API: NOTIFICATIONS ──────────────────────────────────────────────────
    if (pathname === '/api/notifications' && req.method === 'GET') {
        const userId = parsedUrl.searchParams.get('userId');
        const notifs = userId
            ? DB.notifications.filter(n => n.relative_user_id === userId)
            : DB.notifications;
        return sendJson(res, 200, notifs.slice(-100).reverse());
    }

    if (pathname.match(/^\/api\/notifications\/[\w-]+\/read$/) && req.method === 'POST') {
        const notifId = pathname.split('/')[3];
        const notif = DB.notifications.find(n => n.id === notifId);
        if (notif) notif.read = true;
        saveDatabase(DB);
        return sendJson(res, 200, { success: true });
    }

    if (pathname === '/api/notifications/read-all' && req.method === 'POST') {
        const body = await parseBody(req);
        DB.notifications.forEach(n => {
            if (n.relative_user_id === body.userId) n.read = true;
        });
        saveDatabase(DB);
        return sendJson(res, 200, { success: true });
    }

    // ─── API: AUDIT LOGS ─────────────────────────────────────────────────────
    if (pathname === '/api/audit' && req.method === 'GET') {
        return sendJson(res, 200, DB.audit_logs.slice(-200).reverse());
    }

    // ─── API: AUTH (REGISTER & EMAIL VERIFY) ─────────────────────────────────
    if (pathname === '/api/auth/register' && req.method === 'POST') {
        const body = await parseBody(req);
        const { full_name, email, password_hash, password_salt, phone, verification_token, verification_expires } = body;
        if (!email || !full_name) {
            return sendJson(res, 400, { error: 'MISSING_FIELDS', message: 'Name and email are required.' });
        }
        const cleanEmail = email.toLowerCase().trim();
        let existing = DB.users.find(u => u.email.toLowerCase() === cleanEmail);
        if (existing) {
            // Update existing record if not verified
            existing.full_name = full_name;
            existing.phone = phone || existing.phone;
            existing.verification_token = verification_token || existing.verification_token;
            existing.verification_expires = verification_expires || existing.verification_expires;
            saveDatabase(DB);
            return sendJson(res, 200, { success: true, user: existing });
        }
        const newUser = {
            id: 'usr-rel-' + Date.now(),
            full_name: full_name.trim(),
            email: cleanEmail,
            password_hash: password_hash || '',
            password_salt: password_salt || '',
            phone: phone || null,
            role: 'relative', // Strictly hardcoded to relative
            email_verified: false,
            verification_token: verification_token || null,
            verification_expires: verification_expires || null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        DB.users.push(newUser);
        saveDatabase(DB);
        broadcastSSE('USER_REGISTERED', { email: newUser.email, name: newUser.full_name });
        return sendJson(res, 200, { success: true, user: newUser });
    }

    if (pathname === '/api/auth/verify-email' && req.method === 'POST') {
        const body = await parseBody(req);
        const { email, code } = body;
        const cleanEmail = (email || '').toLowerCase().trim();
        const user = DB.users.find(u => 
            (cleanEmail && u.email.toLowerCase() === cleanEmail) ||
            (code && u.verification_token === code)
        );
        if (!user) {
            return sendJson(res, 404, { error: 'INVALID_CODE', message: 'User or verification code not found.' });
        }
        user.email_verified = true;
        user.verification_token = null;
        user.updated_at = new Date().toISOString();
        saveDatabase(DB);
        broadcastSSE('USER_VERIFIED', { email: user.email, name: user.full_name });
        return sendJson(res, 200, { success: true, user });
    }

    if (pathname === '/api/users/relatives' && req.method === 'GET') {
        const relatives = DB.users
            .filter(u => u.role === 'relative')
            .map(u => ({ id: u.id, full_name: u.full_name, email: u.email, email_verified: u.email_verified }));
        return sendJson(res, 200, relatives);
    }

    // ─── API: ULTRA-LIGHTWEIGHT SYNC VERSION (BACKGROUND HEARTBEAT POLL) ─────
    if (pathname === '/api/sync/version' && req.method === 'GET') {
        return sendJson(res, 200, {
            version: serverDataVersion,
            timestamp: new Date().toISOString()
        });
    }

    // ─── API: HIGH-FREQUENCY LIVE VITALS & CLOUD SYNC POLLER ─────────────────
    if (pathname === '/api/live-vitals' && req.method === 'GET') {
        const userId = (parsedUrl.searchParams.get('userId') || '').trim();
        const email = (parsedUrl.searchParams.get('email') || '').toLowerCase().trim();

        // Find linked patients if relative
        let targetPatientIds = null;
        if (userId || email) {
            const matchedUsers = DB.users.filter(u => {
                if (email && u.email && u.email.toLowerCase() === email) return true;
                if (userId && (u.id === userId || (u.email && u.email.toLowerCase() === userId.toLowerCase()))) return true;
                return false;
            });
            const targetIds = new Set(matchedUsers.map(u => u.id));
            if (userId) targetIds.add(userId);
            if (email) targetIds.add(email);

            const activeLinks = DB.patient_relatives.filter(r => {
                if (r.status !== 'active') return false;
                if (targetIds.has(r.relative_user_id)) return true;
                const u = DB.users.find(usr => usr.id === r.relative_user_id);
                return u && ((email && u.email.toLowerCase() === email) || (userId && u.id === userId));
            });
            targetPatientIds = new Set(activeLinks.map(l => l.patient_id));
        }

        const patientsList = DB.patients
            .filter(p => !targetPatientIds || targetPatientIds.has(p.id))
            .map(p => {
                const temp = p.vitals_baseline?.tempC !== undefined ? p.vitals_baseline.tempC : (p.last_reading?.temperature || 36.8);
                const crit = p.temp_threshold_critical || 38.0;
                const warn = p.temp_threshold_warning || 37.5;
                const status = temp >= crit ? 'Critical' : temp >= warn ? 'Monitored' : 'Stable';
                return {
                    id: p.id,
                    name: p.name,
                    code: p.patient_code,
                    temp: temp,
                    bpm: p.vitals_baseline?.bpm || 74,
                    spo2: p.vitals_baseline?.spo2 || 98.4,
                    accelG: p.vitals_baseline?.accelG || 1.01,
                    status: status,
                    critThreshold: crit,
                    warnThreshold: warn,
                    sensorStatus: p.sensor_status || 'OK',
                    lastRecordedAt: p.last_reading?.recordedAt || new Date().toISOString()
                };
            });

        // Find any active critical alert for these patients
        const activeCritical = patientsList.find(p => p.status === 'Critical' || p.temp >= p.critThreshold);
        let isCriticalAck = false;
        if (activeCritical) {
            const rawPatient = DB.patients.find(p => p.id === activeCritical.id);
            if (rawPatient && rawPatient.alert_acknowledged) {
                isCriticalAck = true;
            } else if (DB.alerts.some(a => a.patient_id === activeCritical.id && a.status === 'ACTIVE' && a.acknowledged)) {
                isCriticalAck = true;
            }
        }

        return sendJson(res, 200, {
            version: serverDataVersion,
            patients: patientsList,
            activeCriticalAlert: activeCritical ? {
                patientId: activeCritical.id,
                patientName: activeCritical.name,
                temperature: activeCritical.temp,
                threshold: activeCritical.critThreshold,
                acknowledged: isCriticalAck,
                message: `URGENT: Patient ${activeCritical.name} (${activeCritical.code}) has high temperature of ${activeCritical.temp.toFixed(1)} °C. Configured alert threshold: ${activeCritical.critThreshold.toFixed(1)} °C. Please contact the hospital care team immediately.`
            } : null
        });
    }

    // ─── API: SYNC DATA TO GOOGLE CLOUD FIREBASE CONSOLE ─────────────────────
    if (pathname === '/api/cloud/sync-firebase' && req.method === 'POST') {
        const body = await parseBody(req);
        let targetUrl = (body.firebaseUrl || process.env.FIREBASE_DB_URL || '').trim();
        if (!targetUrl) {
            return sendJson(res, 400, { error: 'FIREBASE_URL_REQUIRED', message: 'Please provide your Firebase Realtime Database URL' });
        }

        targetUrl = targetUrl.replace(/\/+$/, '');
        if (!targetUrl.endsWith('.json')) targetUrl += '/biocloud_health_records.json';

        try {
            const https = require('https');
            const urlObj = new URL(targetUrl);
            const payload = JSON.stringify({
                metadata: {
                    project: "BioCloud IoT - Smart Healthcare Monitoring System",
                    cloudProvider: "Google Cloud Platform (Firebase Realtime Database)",
                    syncedAt: new Date().toISOString()
                },
                patients: DB.patients,
                temperature_history: DB.temperature_history.slice(-100),
                alerts: DB.alerts,
                users: DB.users.map(u => ({ id: u.id, full_name: u.full_name, email: u.email, role: u.role })),
                patient_relatives: DB.patient_relatives,
                audit_logs: DB.audit_logs.slice(-50),
                device_health: DB.device_health
            });

            const fbReq = https.request({
                hostname: urlObj.hostname,
                port: 443,
                path: urlObj.pathname + (urlObj.search || ''),
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            }, (fbRes) => {
                let fbData = '';
                fbRes.on('data', c => fbData += c);
                fbRes.on('end', () => {
                    if (fbRes.statusCode >= 200 && fbRes.statusCode < 300) {
                        global.ACTIVE_FIREBASE_URL = targetUrl;
                        return sendJson(res, 200, {
                            success: true,
                            message: 'Patient health data successfully synced to Google Firebase Console!',
                            consoleUrl: `https://console.firebase.google.com`,
                            recordsSynced: {
                                patients: DB.patients.length,
                                telemetry: DB.temperature_history.length,
                                alerts: DB.alerts.length
                            }
                        });
                    } else {
                        return sendJson(res, 400, { error: 'FIREBASE_ERROR', message: `Firebase returned status ${fbRes.statusCode}: ${fbData}` });
                    }
                });
            });

            fbReq.on('error', (err) => {
                return sendJson(res, 500, { error: 'NETWORK_ERROR', message: err.message });
            });

            fbReq.write(payload);
            fbReq.end();
            return;
        } catch (e) {
            return sendJson(res, 500, { error: 'SERVER_ERROR', message: e.message });
        }
    }

    // ─── API: DATABASE FULL SYNC (FOR CLIENT INITIAL LOAD) ───────────────────
    if (pathname === '/api/sync' && req.method === 'GET') {
        return sendJson(res, 200, {
            version: serverDataVersion,
            users: DB.users.map(u => ({ id: u.id, full_name: u.full_name, email: u.email, role: u.role, email_verified: u.email_verified })),
            patients: DB.patients,
            patient_relatives: DB.patient_relatives,
            temperature_history: DB.temperature_history.slice(-100),
            device_health: DB.device_health,
            localIp: LOCAL_IP,
            port: PORT
        });
    }

    // ─── CLOUD DATABASE CONSOLE (DBaaS VIEWER) ───────────────────────────────
    if (pathname === '/cloud-db' || pathname === '/cloud-database' || pathname === '/db') {
        const dbConsolePath = path.join(__dirname, 'cloud_db.html');
        fs.readFile(dbConsolePath, (err, content) => {
            if (err) {
                res.writeHead(500);
                return res.end('Database console not available');
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });
        return;
    }

    // ─── STATIC FILE SERVER ──────────────────────────────────────────────────
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    filePath = path.normalize(filePath);

    // Prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        return res.end('Access Denied');
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            // Fallback to index.html for SPA router
            const indexHtml = path.join(__dirname, 'index.html');
            fs.readFile(indexHtml, (err2, content) => {
                if (err2) {
                    res.writeHead(404);
                    return res.end('Not Found');
                }
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                });
                res.end(content);
            });
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        fs.readFile(filePath, (err3, content) => {
            if (err3) {
                res.writeHead(500);
                return res.end('Server Error');
            }
            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(content);
        });
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('================================================================');
    console.log(`🏥 BioCloud IoT Cloud Server running at:`);
    console.log(`   - Local PC:       http://localhost:${PORT}`);
    console.log(`   - Mobile/LAN URL: http://${LOCAL_IP}:${PORT}`);
    console.log(`   - ESP32 Endpoint: http://${LOCAL_IP}:${PORT}/api/telemetry`);
    console.log(`   - Live SSE Stream:http://${LOCAL_IP}:${PORT}/api/stream`);
    console.log(`================================================================`);
});

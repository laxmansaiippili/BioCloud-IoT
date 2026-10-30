/* ==========================================================================
   BioCloud IoT — Database Layer (db.js)
   localStorage-backed persistent data store simulating a relational DB.
   Schema: Users | Patients | Patient_Relatives | AuditLogs | Notifications
   ========================================================================== */

const DB = (() => {

    // ------------------------------------------------------------------ //
    //  SCHEMA CONSTANTS
    // ------------------------------------------------------------------ //
    const TABLES = {
        USERS:             'biocloud_users',
        PATIENTS:          'biocloud_patients',
        PATIENT_RELATIVES: 'biocloud_patient_relatives',
        AUDIT_LOGS:        'biocloud_audit_logs',
        NOTIFICATIONS:     'biocloud_notifications',
        META:              'biocloud_meta'
    };

    // ------------------------------------------------------------------ //
    //  HELPERS
    // ------------------------------------------------------------------ //
    function uid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    function now() {
        return new Date().toISOString();
    }

    function read(table) {
        try {
            return JSON.parse(localStorage.getItem(table) || '[]');
        } catch {
            return [];
        }
    }

    function write(table, data) {
        localStorage.setItem(table, JSON.stringify(data));
    }

    function readMeta() {
        try {
            return JSON.parse(localStorage.getItem(TABLES.META) || '{}');
        } catch {
            return {};
        }
    }

    function writeMeta(meta) {
        localStorage.setItem(TABLES.META, JSON.stringify(meta));
    }

    // ------------------------------------------------------------------ //
    //  SEED — Initial admin account + sample patients (runs once)
    // ------------------------------------------------------------------ //
    async function seed() {
        const meta = readMeta();
        if (meta.seeded) return;

        // Default admin (password: Admin@123!)
        const { hash, salt } = await Security.hashPassword('Admin@123!');
        const adminUser = {
            id: uid(),
            full_name: 'Hospital Administrator',
            email: 'admin@hospital.org',
            password_hash: hash,
            password_salt: salt,
            role: 'admin',
            email_verified: true,
            verification_token: null,
            verification_expires: null,
            reset_token: null,
            reset_expires: null,
            created_at: now(),
            updated_at: now()
        };

        const users = read(TABLES.USERS);
        if (!users.find(u => u.email === adminUser.email)) {
            users.push(adminUser);
            write(TABLES.USERS, users);
        }

        // Sample patient records extending existing IoT patient data
        const patientsData = [
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
                authorized_relative_email: 'relative.john@gmail.com',
                iot_topic: 'healthcare/ward1/bed01/telemetry',
                appointments: [
                    { date: '2026-10-25', time: '09:00', type: 'Cardiology Review', doctor: 'Dr. Aris Thorne', status: 'Scheduled' }
                ],
                reports: [
                    { id: uid(), date: '2026-10-20', type: 'ECG Report', summary: 'Sinus rhythm, no new changes', added_by: 'admin@hospital.org' }
                ],
                treatment_notes: [
                    { id: uid(), date: '2026-10-21', note: 'Patient stable on Aspirin 75mg and Metoprolol 25mg', added_by: 'admin@hospital.org' }
                ],
                vitals_baseline: { bpm: 74, spo2: 98.4, tempC: 36.8, accelG: 1.01 },
                created_at: now(),
                updated_at: now(),
                updated_by: adminUser.id
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
                authorized_relative_email: 'relative.sarah@gmail.com',
                iot_topic: 'healthcare/ward1/bed02/telemetry',
                appointments: [
                    { date: '2026-10-24', time: '11:00', type: 'Post-Op Review', doctor: 'Dr. Elena Vance', status: 'Scheduled' }
                ],
                reports: [],
                treatment_notes: [
                    { id: uid(), date: '2026-10-22', note: 'Wound healing normally. Pain controlled with Paracetamol', added_by: 'admin@hospital.org' }
                ],
                vitals_baseline: { bpm: 82, spo2: 96.8, tempC: 37.1, accelG: 1.05 },
                created_at: now(),
                updated_at: now(),
                updated_by: adminUser.id
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
                authorized_relative_email: 'relative.robert@gmail.com',
                iot_topic: 'healthcare/remote/home04/telemetry',
                appointments: [],
                reports: [],
                treatment_notes: [],
                vitals_baseline: { bpm: 68, spo2: 97.5, tempC: 36.5, accelG: 0.98 },
                created_at: now(),
                updated_at: now(),
                updated_by: adminUser.id
            }
        ];

        const existingPatients = read(TABLES.PATIENTS);
        if (existingPatients.length === 0) {
            write(TABLES.PATIENTS, patientsData);
        }

        // Seed doctor accounts
        const doctorSeeds = [
            { email: 'dr.thorne@cardio.org', name: 'Dr. Aris Thorne', pass: 'Doc@123!', pid: 'p1' },
            { email: 'dr.vance@pulmo.org', name: 'Dr. Elena Vance', pass: 'Doc@123!', pid: 'p2' },
            { email: 'dr.brody@geriatric.org', name: 'Dr. Marcus Brody', pass: 'Doc@123!', pid: 'p3' }
        ];

        for (const d of doctorSeeds) {
            const existingUsers = read(TABLES.USERS);
            if (!existingUsers.find(u => u.email === d.email)) {
                const { hash: dHash, salt: dSalt } = await Security.hashPassword(d.pass);
                const doctorUser = {
                    id: uid(),
                    full_name: d.name,
                    email: d.email,
                    password_hash: dHash,
                    password_salt: dSalt,
                    role: 'doctor',
                    assigned_patient_id: d.pid,
                    email_verified: true,
                    verification_token: null,
                    verification_expires: null,
                    reset_token: null,
                    reset_expires: null,
                    created_at: now(),
                    updated_at: now()
                };
                existingUsers.push(doctorUser);
                write(TABLES.USERS, existingUsers);
            }
        }

        writeMeta({ seeded: true, seeded_at: now() });
        console.info('[DB] Seed complete.');
    }

    // ================================================================== //
    //  USERS TABLE API
    // ================================================================== //
    const Users = {
        findAll() {
            return read(TABLES.USERS);
        },
        findById(id) {
            return read(TABLES.USERS).find(u => u.id === id) || null;
        },
        findByEmail(email) {
            return read(TABLES.USERS).find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
        },
        create(data) {
            const users = read(TABLES.USERS);
            if (users.find(u => u.email.toLowerCase() === data.email.toLowerCase())) {
                throw new Error('EMAIL_ALREADY_REGISTERED');
            }
            // Public registration ALWAYS sets role to relative — never admin
            const user = {
                id: uid(),
                full_name: data.full_name,
                email: data.email.toLowerCase().trim(),
                password_hash: data.password_hash,
                password_salt: data.password_salt,
                role: 'relative',               // HARDCODED — cannot be overridden
                phone: data.phone || null,
                email_verified: false,
                verification_token: data.verification_token || null,
                verification_expires: data.verification_expires || null,
                reset_token: null,
                reset_expires: null,
                created_at: now(),
                updated_at: now()
            };
            users.push(user);
            write(TABLES.USERS, users);
            // Save to server
            fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(user)
            }).catch(e => console.warn('[DB] Could not register to server:', e.message));
            return user;
        },
        update(id, updates) {
            const users = read(TABLES.USERS);
            const idx = users.findIndex(u => u.id === id);
            if (idx === -1) throw new Error('USER_NOT_FOUND');
            // Prevent role escalation via update
            if (updates.role && updates.role === 'admin' && users[idx].role !== 'admin') {
                throw new Error('PRIVILEGE_ESCALATION_DENIED');
            }
            users[idx] = { ...users[idx], ...updates, updated_at: now() };
            write(TABLES.USERS, users);
            return users[idx];
        },
        verifyEmail(token) {
            const users = read(TABLES.USERS);
            const user = users.find(u =>
                u.verification_token === token &&
                u.verification_expires &&
                new Date(u.verification_expires) > new Date()
            );
            if (!user) return null;
            const updated = this.update(user.id, {
                email_verified: true,
                verification_token: null,
                verification_expires: null
            });
            // Update on server
            fetch('/api/auth/verify-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: user.email, code: token })
            }).catch(e => console.warn('[DB] Could not verify on server:', e.message));
            return updated;
        },
        findVerifiedRelativeByEmail(email) {
            const u = this.findByEmail(email);
            if (!u) return null;
            if (u.role !== 'relative') return null;
            if (!u.email_verified) return null;
            return u;
        },
        getRelatives() {
            return read(TABLES.USERS).filter(u => u.role === 'relative');
        }
    };

    // ================================================================== //
    //  PATIENTS TABLE API
    // ================================================================== //
    const Patients = {
        findAll() {
            return read(TABLES.PATIENTS);
        },
        findById(id) {
            return read(TABLES.PATIENTS).find(p => p.id === id) || null;
        },
        update(id, updates, actorId) {
            const patients = read(TABLES.PATIENTS);
            const idx = patients.findIndex(p => p.id === id);
            if (idx === -1) throw new Error('PATIENT_NOT_FOUND');
            patients[idx] = { ...patients[idx], ...updates, updated_at: now(), updated_by: actorId };
            write(TABLES.PATIENTS, patients);
            return patients[idx];
        },
        addReport(patientId, report, actorId) {
            const patient = this.findById(patientId);
            if (!patient) throw new Error('PATIENT_NOT_FOUND');
            const newReport = { id: uid(), date: now().split('T')[0], ...report, added_by: actorId, created_at: now() };
            const updatedReports = [...(patient.reports || []), newReport];
            return this.update(patientId, { reports: updatedReports }, actorId);
        },
        addTreatmentNote(patientId, note, actorId) {
            const patient = this.findById(patientId);
            if (!patient) throw new Error('PATIENT_NOT_FOUND');
            const newNote = { id: uid(), date: now().split('T')[0], note, added_by: actorId, created_at: now() };
            const updatedNotes = [...(patient.treatment_notes || []), newNote];
            return this.update(patientId, { treatment_notes: updatedNotes }, actorId);
        }
    };

    // ================================================================== //
    //  PATIENT_RELATIVES TABLE API
    // ================================================================== //
    const PatientRelatives = {
        findAll() {
            return read(TABLES.PATIENT_RELATIVES);
        },
        findByPatient(patientId) {
            return read(TABLES.PATIENT_RELATIVES)
                .filter(r => r.patient_id === patientId && r.status === 'active');
        },
        findByRelative(relativeUserId) {
            const relRecords = read(TABLES.PATIENT_RELATIVES).filter(r => r.status === 'active');
            const allUsers = read(TABLES.USERS);

            let sessionEmail = '';
            let sessionUserId = '';
            try {
                if (typeof sessionStorage !== 'undefined') {
                    const raw = sessionStorage.getItem('biocloud_session');
                    if (raw) {
                        const s = JSON.parse(raw);
                        if (s && s.email) sessionEmail = s.email.toLowerCase().trim();
                        if (s && s.userId) sessionUserId = s.userId;
                    }
                }
            } catch (_) {}

            const curUser = allUsers.find(u => 
                (relativeUserId && (u.id === relativeUserId || u.email.toLowerCase() === String(relativeUserId).toLowerCase())) ||
                (sessionUserId && u.id === sessionUserId) ||
                (sessionEmail && u.email.toLowerCase() === sessionEmail)
            );

            const targetEmail = (curUser?.email || (typeof relativeUserId === 'string' && relativeUserId.includes('@') ? relativeUserId : '') || sessionEmail).toLowerCase().trim();
            const validUserIds = new Set();
            if (relativeUserId) validUserIds.add(relativeUserId);
            if (sessionUserId) validUserIds.add(sessionUserId);
            if (curUser) validUserIds.add(curUser.id);

            return relRecords.filter(r => {
                if (validUserIds.has(r.relative_user_id)) return true;
                if (targetEmail) {
                    const linkedUser = allUsers.find(u => u.id === r.relative_user_id);
                    if (linkedUser && linkedUser.email.toLowerCase() === targetEmail) return true;
                }
                return false;
            });
        },
        findRelationship(patientId, relativeUserId) {
            return read(TABLES.PATIENT_RELATIVES)
                .find(r => r.patient_id === patientId && r.relative_user_id === relativeUserId) || null;
        },
        /**
         * ADMIN-ONLY OPERATION — enforced by SecurityEngine before this call.
         * Links a verified relative to a patient. Rejects duplicates.
         */
        link(patientId, relativeUserId, adminId) {
            const records = read(TABLES.PATIENT_RELATIVES);
            const existing = records.find(r =>
                r.patient_id === patientId && r.relative_user_id === relativeUserId
            );
            if (existing) {
                if (existing.status === 'active') throw new Error('RELATIONSHIP_ALREADY_EXISTS');
                // Re-activate if previously revoked
                const idx = records.indexOf(existing);
                records[idx] = { ...existing, status: 'active', linked_at: now(), linked_by_admin_id: adminId };
                write(TABLES.PATIENT_RELATIVES, records);
                return records[idx];
            }
            const rel = {
                id: uid(),
                patient_id: patientId,
                relative_user_id: relativeUserId,
                linked_by_admin_id: adminId,
                linked_at: now(),
                status: 'active'
            };
            records.push(rel);
            write(TABLES.PATIENT_RELATIVES, records);
            return rel;
        },
        /**
         * ADMIN-ONLY OPERATION — revokes access.
         */
        revoke(patientId, relativeUserId) {
            const records = read(TABLES.PATIENT_RELATIVES);
            const idx = records.findIndex(r =>
                r.patient_id === patientId && r.relative_user_id === relativeUserId
            );
            if (idx === -1) throw new Error('RELATIONSHIP_NOT_FOUND');
            records[idx] = { ...records[idx], status: 'revoked', revoked_at: now() };
            write(TABLES.PATIENT_RELATIVES, records);
            return records[idx];
        },
        /**
         * Checks if a relative is actively linked to a patient.
         * Used on every protected data access — object-level authorization.
         */
        isAuthorized(patientId, relativeUserId) {
            const relRecords = read(TABLES.PATIENT_RELATIVES).filter(r => r.patient_id === patientId && r.status === 'active');
            if (relRecords.length === 0) return false;

            const allUsers = read(TABLES.USERS);

            let sessionEmail = '';
            let sessionUserId = '';
            try {
                if (typeof sessionStorage !== 'undefined') {
                    const raw = sessionStorage.getItem('biocloud_session');
                    if (raw) {
                        const s = JSON.parse(raw);
                        if (s && s.email) sessionEmail = s.email.toLowerCase().trim();
                        if (s && s.userId) sessionUserId = s.userId;
                    }
                }
            } catch (_) {}

            const curUser = allUsers.find(u => 
                (relativeUserId && (u.id === relativeUserId || u.email.toLowerCase() === String(relativeUserId).toLowerCase())) ||
                (sessionUserId && u.id === sessionUserId) ||
                (sessionEmail && u.email.toLowerCase() === sessionEmail)
            );

            const targetEmail = (curUser?.email || (typeof relativeUserId === 'string' && relativeUserId.includes('@') ? relativeUserId : '') || sessionEmail).toLowerCase().trim();
            const validUserIds = new Set();
            if (relativeUserId) validUserIds.add(relativeUserId);
            if (sessionUserId) validUserIds.add(sessionUserId);
            if (curUser) validUserIds.add(curUser.id);

            return relRecords.some(r => {
                if (r.patient_id !== patientId) return false;
                if (validUserIds.has(r.relative_user_id)) return true;
                if (targetEmail) {
                    const linkedUser = allUsers.find(u => u.id === r.relative_user_id);
                    if (linkedUser && linkedUser.email.toLowerCase() === targetEmail) return true;
                }
                return false;
            });
        }
    };

    // ================================================================== //
    //  AUDIT LOGS TABLE API
    // ================================================================== //
    const AuditLogs = {
        findAll() {
            return read(TABLES.AUDIT_LOGS).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        },
        forActor(actorId) {
            return this.findAll().filter(l => l.actor_id === actorId);
        },
        forTarget(targetType, targetId) {
            return this.findAll().filter(l => l.target_type === targetType && l.target_id === targetId);
        },
        log(actorId, actorRole, action, targetType, targetId, metadata = {}) {
            const logs = read(TABLES.AUDIT_LOGS);
            logs.push({
                id: uid(),
                actor_id: actorId,
                actor_role: actorRole,
                action,
                target_type: targetType,
                target_id: targetId,
                metadata,
                timestamp: now()
            });
            // Keep last 500 entries to avoid storage overflow
            if (logs.length > 500) logs.splice(0, logs.length - 500);
            write(TABLES.AUDIT_LOGS, logs);
        }
    };

    // ================================================================== //
    //  NOTIFICATIONS TABLE API
    // ================================================================== //
    const Notifications = {
        findAll() {
            return read(TABLES.NOTIFICATIONS).sort((a, b) => b.created_at.localeCompare(a.created_at));
        },
        forRelative(relativeUserId) {
            return this.findAll().filter(n => n.relative_user_id === relativeUserId);
        },
        unreadCount(relativeUserId) {
            return this.forRelative(relativeUserId).filter(n => !n.read).length;
        },
        /**
         * Creates notifications for all active relatives of a patient.
         * Called whenever patient data is updated.
         */
        notifyRelativesOfPatient(patientId, type, message, patientName) {
            const rels = PatientRelatives.findByPatient(patientId);
            const records = read(TABLES.NOTIFICATIONS);
            rels.forEach(rel => {
                records.push({
                    id: uid(),
                    relative_user_id: rel.relative_user_id,
                    patient_id: patientId,
                    patient_name: patientName,
                    type,
                    message,
                    delivery_status: 'delivered',   // Simulated; real SMTP sets 'pending'→'sent'
                    read: false,
                    created_at: now()
                });
            });
            // Keep last 1000 notifications
            if (records.length > 1000) records.splice(0, records.length - 1000);
            write(TABLES.NOTIFICATIONS, records);
        },
        markRead(notificationId, relativeUserId) {
            const records = read(TABLES.NOTIFICATIONS);
            const idx = records.findIndex(n => n.id === notificationId && n.relative_user_id === relativeUserId);
            if (idx !== -1) records[idx].read = true;
            write(TABLES.NOTIFICATIONS, records);
        },
        markAllRead(relativeUserId) {
            const records = read(TABLES.NOTIFICATIONS);
            records.forEach((n, i) => {
                if (n.relative_user_id === relativeUserId) records[i].read = true;
            });
            write(TABLES.NOTIFICATIONS, records);
        }
    };

    // ================================================================== //
    //  SERVER SYNCHRONIZATION & TELEMETRY API
    // ================================================================== //
    async function syncFromServer() {
        try {
            const res = await fetch('/api/sync');
            if (!res.ok) return null;
            const data = await res.json();
            if (data.patients && data.patients.length) {
                write(TABLES.PATIENTS, data.patients);
            }
            if (data.patient_relatives) {
                write(TABLES.PATIENT_RELATIVES, data.patient_relatives);
            }
            if (data.users && data.users.length) {
                const localUsers = read(TABLES.USERS);
                let currentSession = null;
                try {
                    const rawSess = sessionStorage.getItem('biocloud_session');
                    if (rawSess) currentSession = JSON.parse(rawSess);
                } catch (_) {}

                data.users.forEach(su => {
                    const idx = localUsers.findIndex(u => u.id === su.id || u.email.toLowerCase() === su.email.toLowerCase());
                    if (idx !== -1) {
                        localUsers[idx].id = su.id;
                        localUsers[idx].email_verified = su.email_verified;
                        localUsers[idx].role = su.role;
                        localUsers[idx].full_name = su.full_name;
                    } else {
                        localUsers.push({
                            id: su.id,
                            full_name: su.full_name,
                            email: su.email,
                            role: su.role,
                            email_verified: su.email_verified,
                            password_hash: '',
                            password_salt: ''
                        });
                    }
                    // Keep active session user ID aligned with authoritative server user ID
                    if (currentSession && currentSession.email && currentSession.email.toLowerCase() === su.email.toLowerCase()) {
                        currentSession.userId = su.id;
                        sessionStorage.setItem('biocloud_session', JSON.stringify(currentSession));
                    }
                });
                write(TABLES.USERS, localUsers);
            }
            return data;
        } catch (e) {
            console.warn('[DB] Server sync offline:', e.message);
            return null;
        }
    }

    async function sendTelemetry(payload) {
        try {
            const res = await fetch('/api/telemetry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            return await res.json();
        } catch (e) {
            console.warn('[DB] sendTelemetry error:', e.message);
            return null;
        }
    }

    async function getTelemetryHistory(patientId) {
        try {
            const res = await fetch(`/api/telemetry/history/${patientId}`);
            if (res.ok) return await res.json();
        } catch (e) {}
        return [];
    }

    async function updateThreshold(patientId, warning, critical) {
        try {
            const res = await fetch(`/api/patients/${patientId}/threshold`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ temp_threshold_warning: warning, temp_threshold_critical: critical })
            });
            return await res.json();
        } catch (e) {
            return null;
        }
    }

    async function ackAlert(alertId, userId) {
        try {
            const res = await fetch(`/api/alerts/${alertId}/ack`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId })
            });
            return await res.json();
        } catch (e) {
            return null;
        }
    }

    // ================================================================== //
    //  PUBLIC API
    // ================================================================== //
    return {
        seed,
        Users,
        Patients,
        PatientRelatives,
        AuditLogs,
        Notifications,
        syncFromServer,
        sendTelemetry,
        getTelemetryHistory,
        updateThreshold,
        ackAlert,
        uid,
        now
    };

})();

if (typeof window !== 'undefined') {
    window.DB = DB;
}

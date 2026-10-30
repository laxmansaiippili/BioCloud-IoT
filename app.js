/* ==========================================================================
   BioCloud IoT — Main Application (app.js)
   SPA Router · Auth Flows · Admin/Doctor/Relative Dashboards
   ECG Engine · Vitals Simulation · Anomaly Alerts · Audit Logging
   ========================================================================== */

document.addEventListener('DOMContentLoaded', async () => {

    // ─────────────────────────────────────────────────────────────────────────
    //  BOOT: seed DB, sync with Cloud Backend & connect SSE stream
    // ─────────────────────────────────────────────────────────────────────────
    showLoading('Connecting to BioCloud Cloud…');
    await DB.seed();
    await initCloudSync();
    hideLoading();

    // ─────────────────────────────────────────────────────────────────────────
    //  CLOCK
    // ─────────────────────────────────────────────────────────────────────────
    function updateClocks() {
        const t = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        ['admin-clock','doc-clock','rel-clock'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = t;
        });
    }
    setInterval(updateClocks, 1000);
    updateClocks();

    // ─────────────────────────────────────────────────────────────────────────
    //  LOADING OVERLAY
    // ─────────────────────────────────────────────────────────────────────────
    function showLoading(msg = 'Processing…') {
        document.getElementById('loading-text').textContent = msg;
        document.getElementById('loading-overlay').classList.remove('hidden');
    }
    function hideLoading() {
        document.getElementById('loading-overlay').classList.add('hidden');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  CLOUD SYNC & SSE LIVE TELEMETRY STREAM
    // ─────────────────────────────────────────────────────────────────────────
    let serverEventSource = null;
    let relTempChart = null;
    let autoSimInterval = null;

    async function initCloudSync() {
        try {
            const infoRes = await fetch('/api/info');
            if (infoRes.ok) {
                const info = await infoRes.json();
                const primaryUrl = info.cloudUrl || `http://${info.localIp}:${info.port}`;

                const ipBanner = document.getElementById('lan-ip-banner');
                if (ipBanner) ipBanner.textContent = `http://${info.localIp}:${info.port}`;

                const authCloudLink = document.getElementById('auth-cloud-link');
                if (authCloudLink) {
                    if (info.cloudUrl) {
                        authCloudLink.href = info.cloudUrl;
                        authCloudLink.textContent = info.cloudUrl;
                    } else {
                        authCloudLink.href = `http://${info.localIp}:${info.port}`;
                        authCloudLink.textContent = `http://${info.localIp}:${info.port} (Connect Tunnel for Global Cloud URL)`;
                    }
                }

                const cloudPubLink = document.getElementById('cloud-public-link');
                if (cloudPubLink) {
                    if (info.cloudUrl) {
                        cloudPubLink.href = info.cloudUrl;
                        cloudPubLink.textContent = info.cloudUrl;
                    } else {
                        cloudPubLink.href = `http://${info.localIp}:${info.port}`;
                        cloudPubLink.textContent = `http://${info.localIp}:${info.port} (Local Edge Gateway)`;
                    }
                }

                const espEndpoint = document.getElementById('admin-esp32-endpoint');
                if (espEndpoint) espEndpoint.textContent = `${primaryUrl}/api/telemetry`;

                const adminStatus = document.getElementById('admin-status-text');
                if (adminStatus) {
                    adminStatus.textContent = info.cloudUrl
                        ? `Cloud Edge: Live (${info.cloudUrl.replace('https://', '')})`
                        : `Cloud Sync: Online (${info.localIp})`;
                }
            }
            await DB.syncFromServer();
            setupEventSource();
            startBackgroundSyncWorker();
        } catch (e) {
            console.warn('[Cloud] Backend server not reachable, running in offline mode:', e.message);
        }
    }

    let isLiveSyncing = false;
    let lastSeenDbVersion = 0;

    async function performLiveBackgroundSync() {
        if (isLiveSyncing) return;
        isLiveSyncing = true;
        try {
            await DB.syncFromServer();
            const session = Security.Session.get();
            if (session) {
                if (session.role === 'relative') {
                    await renderRelativePatients();
                    renderRelativeNotifications();
                    updateRelNotifBadge();
                    checkActivePatientAlertsForRelative();
                } else if (session.role === 'admin') {
                    renderAdminOverview();
                    if (typeof renderAdminRelativesList === 'function') renderAdminRelativesList();
                } else if (session.role === 'doctor') {
                    renderDoctorDashboard();
                }
            }
        } catch (e) {
            console.warn('[Live Sync] Background update error:', e);
        } finally {
            isLiveSyncing = false;
        }
    }

    let liveVitalsInterval = null;
    let knownLinkedPatientIds = [];

    function startBackgroundSyncWorker() {
        if (liveVitalsInterval) clearInterval(liveVitalsInterval);

        // High-frequency live poller (every 1.0 second): ultra-fast (75ms response), bypasses Cloudflare SSE buffering completely!
        liveVitalsInterval = setInterval(async () => {
            const session = Security.Session.get();
            if (!session) return;

            try {
                const query = new URLSearchParams({
                    userId: session.userId || '',
                    email: session.email || ''
                });

                const res = await fetch(`/api/live-vitals?${query.toString()}`);
                if (!res.ok) return;
                const data = await res.json();
                const patients = data.patients || [];

                // 1. If Relative Dashboard is active
                if (session.role === 'relative') {
                    // Check if linked patients list changed (e.g. newly linked or revoked)
                    const currentPatientIds = patients.map(p => p.id).sort().join(',');
                    if (currentPatientIds !== knownLinkedPatientIds.join(',')) {
                        knownLinkedPatientIds = patients.map(p => p.id).sort();
                        await renderRelativePatients();
                    } else {
                        // Dynamically update vital chips & cards in place without destroying DOM
                        for (const p of patients) {
                            const valEl = document.getElementById(`rel-temp-val-${p.id}`);
                            if (valEl) {
                                valEl.textContent = typeof p.temp === 'number' ? p.temp.toFixed(1) : p.temp;
                                const card = valEl.closest('.rel-patient-card');
                                if (card) {
                                    card.className = `rel-patient-card status-${p.status}`;
                                    const badge = card.querySelector('.badge');
                                    if (badge) {
                                        badge.className = `badge badge-${p.status.toLowerCase()}`;
                                        badge.textContent = p.status;
                                    }
                                }
                            }
                        }

                        // Update chart if first patient has new reading
                        if (patients[0] && relTempChart && relTempChart.data) {
                            const lastTemp = patients[0].temp;
                            const timeStr = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                            const dataLen = relTempChart.data.datasets[0].data.length;
                            const prevVal = dataLen > 0 ? relTempChart.data.datasets[0].data[dataLen - 1] : null;
                            if (prevVal !== lastTemp) {
                                relTempChart.data.labels.push(timeStr);
                                relTempChart.data.datasets[0].data.push(lastTemp);
                                if (relTempChart.data.labels.length > 25) {
                                    relTempChart.data.labels.shift();
                                    relTempChart.data.datasets[0].data.shift();
                                }
                                relTempChart.update('none');
                            }
                        }
                    }

                    // 2. Alarm Trigger: If active critical alert is detected
                    if (data.activeCriticalAlert) {
                        const alert = data.activeCriticalAlert;
                        const isMuted = isAlertMuted(alert.patientId, alert.temperature) || alert.acknowledged === true;
                        if (!isMuted) {
                            triggerCriticalAlertForRelatives(alert.patientId, alert.temperature, alert.threshold, alert.message);
                        }
                    } else {
                        // If temperature recovered, dismiss critical alarm overlay & clear mute state
                        clearMuteAlert();
                        const overlay = document.getElementById('critical-alarm-overlay');
                        if (overlay && !overlay.classList.contains('hidden')) {
                            overlay.classList.add('hidden');
                            stopAlarmSound();
                        }
                    }
                }

                // 2. If Doctor Dashboard is active
                if (session.role === 'doctor') {
                    const assigned = patients.find(p => p.id === session.assignedPatientId);
                    if (assigned) {
                        const docTemp = document.getElementById('doc-temp');
                        if (docTemp) {
                            docTemp.textContent = assigned.temp.toFixed(1);
                            docTemp.style.color = assigned.temp >= (assigned.critThreshold || 38.0) ? 'var(--red)' : assigned.temp >= (assigned.warnThreshold || 37.5) ? 'var(--amber)' : 'var(--green)';
                        }
                    }
                }

                // 3. If Admin Dashboard is active
                if (session.role === 'admin') {
                    const adminOverviewActive = document.getElementById('admin-panel-overview')?.classList.contains('active');
                    if (adminOverviewActive && data.version !== lastSeenDbVersion) {
                        renderAdminOverview();
                    }
                }

                lastSeenDbVersion = data.version;

            } catch (e) {
                // Ignore transient network errors
            }
        }, 1000);

        // Resume immediately when phone screen unlocks or user switches back to browser tab
        document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState === 'visible') {
                performLiveBackgroundSync();
            }
        });

        window.addEventListener('focus', () => {
            performLiveBackgroundSync();
        });

        window.addEventListener('online', () => {
            performLiveBackgroundSync();
        });
    }

    function setupEventSource() {
        if (serverEventSource) {
            if (serverEventSource.readyState === EventSource.OPEN) return;
            try { serverEventSource.close(); } catch (_) {}
            serverEventSource = null;
        }
        try {
            serverEventSource = new EventSource('/api/stream');

            serverEventSource.addEventListener('TELEMETRY_UPDATE', e => {
                const data = JSON.parse(e.data);
                handleTelemetryEvent(data);
            });

            serverEventSource.addEventListener('CRITICAL_TEMP_ALERT', e => {
                const data = JSON.parse(e.data);
                handleCriticalTempAlert(data);
            });

            serverEventSource.addEventListener('TEMP_WARNING', e => {
                const data = JSON.parse(e.data);
                showToast(`⚠️ Elevated Temperature: ${data.patientName} at ${data.temperature.toFixed(1)} °C`, 'warning');
            });

            serverEventSource.addEventListener('TEMP_RECOVERY', e => {
                const data = JSON.parse(e.data);
                showToast(`✅ Temperature Stabilized: ${data.patientName} is now ${data.temperature.toFixed(1)} °C`, 'success');
                clearMuteAlert(data.patientId);
                const overlay = document.getElementById('critical-alarm-overlay');
                if (overlay && !overlay.classList.contains('hidden')) {
                    overlay.classList.add('hidden');
                    stopAlarmSound();
                }
            });

            serverEventSource.addEventListener('ALERT_ACKNOWLEDGED', e => {
                const data = JSON.parse(e.data);
                if (data && data.patientId) {
                    muteAlertForPatient(data.patientId);
                }
                const overlay = document.getElementById('critical-alarm-overlay');
                if (overlay && !overlay.classList.contains('hidden')) {
                    overlay.classList.add('hidden');
                    stopAlarmSound();
                }
            });

            serverEventSource.addEventListener('DEVICE_STATUS', e => {
                const data = JSON.parse(e.data);
                showToast(data.message, 'warning');
            });

            serverEventSource.addEventListener('RELATIVE_LINKED', async () => {
                await performLiveBackgroundSync();
            });

            serverEventSource.addEventListener('RELATIVE_REVOKED', async () => {
                await performLiveBackgroundSync();
            });

            serverEventSource.addEventListener('THRESHOLD_UPDATED', async () => {
                await performLiveBackgroundSync();
            });

            serverEventSource.addEventListener('CLINICAL_NOTE_ADDED', async () => {
                await performLiveBackgroundSync();
            });

            serverEventSource.addEventListener('DATABASE_CHANGED', async () => {
                await performLiveBackgroundSync();
            });

            serverEventSource.onerror = () => {
                try { serverEventSource.close(); } catch (_) {}
                serverEventSource = null;
                setTimeout(setupEventSource, 2000);
            };

        } catch (err) {
            console.warn('[SSE] Could not establish EventSource connection:', err.message);
        }
    }

    function handleTelemetryEvent(data) {
        // Update local DB cache
        const p = DB.Patients.findById(data.patientId);
        if (p) {
            p.vitals_baseline.tempC = data.temperature;
            p.sensor_status = data.sensorStatus;
            const crit = p.temp_threshold_critical || 38.0;
            const warn = p.temp_threshold_warning || 37.5;
            p.status = data.temperature >= crit ? 'Critical' : data.temperature >= warn ? 'Monitored' : 'Stable';
            DB.Patients.update(data.patientId, { vitals_baseline: p.vitals_baseline, sensor_status: data.sensorStatus, status: p.status });
        }

        // Update Doctor Dashboard if assigned
        const docTemp = document.getElementById('doc-temp');
        if (docTemp && docSession && docSession.assignedPatientId === data.patientId) {
            docTemp.textContent = data.temperature.toFixed(1);
            if (data.temperature >= 38.0) {
                docTemp.style.color = 'var(--red)';
            } else if (data.temperature >= 37.5) {
                docTemp.style.color = 'var(--amber)';
            } else {
                docTemp.style.color = 'var(--green)';
            }
        }

        // Update Admin Overview table if active
        const adminOverviewActive = document.getElementById('admin-panel-overview')?.classList.contains('active');
        if (adminOverviewActive) {
            renderAdminOverview();
        }

        // Update Relative Card and Chart dynamically without requiring manual page refresh
        const session = Security.Session.get();
        if (session && session.role === 'relative') {
            const relVal = document.getElementById(`rel-temp-val-${data.patientId}`);
            if (relVal) {
                relVal.textContent = data.temperature.toFixed(1);
                const card = relVal.closest('.rel-patient-card');
                if (card) {
                    const crit = p?.temp_threshold_critical || 38.0;
                    const warn = p?.temp_threshold_warning || 37.5;
                    const newStatus = data.temperature >= crit ? 'Critical' : data.temperature >= warn ? 'Monitored' : 'Stable';
                    card.className = `rel-patient-card status-${newStatus}`;
                    const badge = card.querySelector('.badge');
                    if (badge) {
                        badge.className = `badge badge-${newStatus.toLowerCase()}`;
                        badge.textContent = newStatus;
                    }
                }
            } else {
                // If patient card was not in DOM yet (e.g. freshly linked or awaiting access state), re-render now!
                renderRelativePatients();
            }

            if (relTempChart && relTempChart.data) {
                const timeStr = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                relTempChart.data.labels.push(timeStr);
                relTempChart.data.datasets[0].data.push(data.temperature);
                if (relTempChart.data.labels.length > 25) {
                    relTempChart.data.labels.shift();
                    relTempChart.data.datasets[0].data.shift();
                }
                relTempChart.update('none');
            }
        }
    }

    function handleCriticalTempAlert(data) {
        const session = Security.Session.get();
        if (!session) return;

        // If Doctor assigned to patient
        if (session.role === 'doctor' && session.assignedPatientId === data.patientId) {
            showToast(`🚨 URGENT: Assigned patient ${data.patientName} has HIGH FEVER (${data.temperature.toFixed(1)} °C)!`, 'error', 8000);
        }

        // If Relative authorized to patient: TRIGGER MOBILE ALARM!
        if (session.role === 'relative') {
            if (DB.PatientRelatives.isAuthorized(data.patientId, session.userId) || DB.PatientRelatives.isAuthorized(data.patientId, session.email)) {
                const isMuted = isAlertMuted(data.patientId, data.temperature) || (data.alert && data.alert.acknowledged);
                if (!isMuted) {
                    triggerCriticalAlertForRelatives(data.patientId, data.temperature, data.threshold, data.message);
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TOAST SYSTEM
    // ─────────────────────────────────────────────────────────────────────────
    function showToast(msg, type = 'info', duration = 4000) {
        const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', info: 'fa-circle-info', warning: 'fa-triangle-exclamation' };
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <i class="fas ${icons[type]} toast-icon"></i>
            <span class="toast-msg">${msg}</span>
            <button class="toast-close"><i class="fas fa-times"></i></button>
        `;
        toast.querySelector('.toast-close').addEventListener('click', () => removeToast(toast));
        container.appendChild(toast);
        setTimeout(() => removeToast(toast), duration);
    }
    function removeToast(toast) {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 320);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  CONFIRM DIALOG
    // ─────────────────────────────────────────────────────────────────────────
    function showConfirm(title, body, onConfirm) {
        document.getElementById('modal-confirm-title').textContent = title;
        document.getElementById('modal-confirm-body').textContent = body;
        document.getElementById('modal-confirm-overlay').classList.remove('hidden');
        const btnOk     = document.getElementById('btn-modal-confirm');
        const btnCancel = document.getElementById('btn-modal-cancel');
        const close = () => document.getElementById('modal-confirm-overlay').classList.add('hidden');
        btnOk.onclick     = () => { close(); onConfirm(); };
        btnCancel.onclick = close;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  SPA ROUTER
    // ─────────────────────────────────────────────────────────────────────────
    function showPage(pageId) {
        ['page-auth','page-admin','page-doctor','page-relative'].forEach(id => {
            document.getElementById(id).classList.add('hidden');
        });
        document.getElementById(pageId).classList.remove('hidden');
    }

    function route() {
        const session = Security.Session.get();
        if (!session) {
            showPage('page-auth');
            showAuthPanel('login');
            return;
        }
        switch (session.role) {
            case 'admin':    showPage('page-admin');    initAdmin(session);    break;
            case 'doctor':   showPage('page-doctor');   initDoctor(session);   break;
            case 'relative': showPage('page-relative'); initRelative(session); break;
            default:         Security.Session.destroy(); route();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  AUTH PANEL SWITCHER
    // ─────────────────────────────────────────────────────────────────────────
    let pendingVerifyEmail = '';
    let pendingVerifyToken = '';
    let forgotStep = 'email'; // 'email' | 'reset'
    let forgotEmail = '';

    function showAuthPanel(name) {
        ['login','register','verify','forgot'].forEach(p => {
            document.getElementById(`auth-panel-${p}`).classList.add('hidden');
        });
        document.getElementById(`auth-panel-${name}`).classList.remove('hidden');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  AUTH: LOGIN
    // ─────────────────────────────────────────────────────────────────────────
    document.getElementById('form-login').addEventListener('submit', async e => {
        e.preventDefault();
        clearFieldErrors('login-email-err','login-password-err');
        const email = Security.Validate.sanitize(document.getElementById('login-email').value);
        const pass  = document.getElementById('login-password').value;

        // Rate limit
        const rl = Security.RateLimiter.check(`login:${email}`);
        if (!rl.allowed) {
            const banner = document.getElementById('login-rate-banner');
            banner.classList.remove('hidden');
            document.getElementById('login-rate-msg').textContent =
                `Too many attempts. Please wait ${rl.resetIn}s.`;
            return;
        }

        if (!Security.Validate.email(email)) {
            setFieldError('login-email-err', 'Please enter a valid email address.');
            return;
        }
        if (!pass) {
            setFieldError('login-password-err', 'Password is required.');
            return;
        }

        Security.RateLimiter.record(`login:${email}`);
        showLoading('Authenticating…');
        await delay(350);

        const user = DB.Users.findByEmail(email);
        if (!user) {
            hideLoading();
            setFieldError('login-password-err', 'Invalid email or password.');
            return;
        }
        if (!user.email_verified) {
            hideLoading();
            setFieldError('login-email-err', 'Email not verified. Please check your inbox.');
            pendingVerifyEmail = user.email;
            pendingVerifyToken = user.verification_token;
            setTimeout(() => showAuthPanel('verify'), 1200);
            return;
        }
        const valid = await Security.verifyPassword(pass, user.password_hash, user.password_salt);
        if (!valid) {
            hideLoading();
            setFieldError('login-password-err', 'Invalid email or password.');
            return;
        }

        Security.RateLimiter.reset(`login:${email}`);
        const session = Security.Session.create(user);
        DB.AuditLogs.log(user.id, user.role, 'LOGIN', 'session', 'auth', { ip: 'client' });

        hideLoading();
        showToast(`Welcome back, ${user.full_name}!`, 'success');
        route();
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  AUTH: REGISTER (RELATIVE ONLY)
    // ─────────────────────────────────────────────────────────────────────────
    document.getElementById('form-register').addEventListener('submit', async e => {
        e.preventDefault();
        let valid = true;
        clearFieldErrors('reg-name-err','reg-email-err','reg-phone-err','reg-password-err','reg-confirm-err','reg-terms-err');

        const name    = Security.Validate.sanitize(document.getElementById('reg-name').value);
        const email   = Security.Validate.sanitize(document.getElementById('reg-email').value.toLowerCase().trim());
        const phone   = Security.Validate.sanitize(document.getElementById('reg-phone').value);
        const pass    = document.getElementById('reg-password').value;
        const confirm = document.getElementById('reg-confirm').value;
        const terms   = document.getElementById('reg-terms').checked;

        if (!Security.Validate.name(name))    { setFieldError('reg-name-err', 'Name must be 2–100 characters.'); valid = false; }
        if (!Security.Validate.email(email))  { setFieldError('reg-email-err', 'Enter a valid email address.'); valid = false; }
        if (!Security.Validate.phone(phone))  { setFieldError('reg-phone-err', 'Enter a valid phone number.'); valid = false; }
        if (!Security.Validate.password(pass)){ setFieldError('reg-password-err', 'Min 8 chars: uppercase, lowercase, digit, symbol.'); valid = false; }
        if (pass !== confirm)                 { setFieldError('reg-confirm-err', 'Passwords do not match.'); valid = false; }
        if (!terms)                           { setFieldError('reg-terms-err', 'You must accept the terms.'); valid = false; }
        if (!valid) return;

        // Rate limit
        const rl = Security.RateLimiter.check(`register:${email}`);
        if (!rl.allowed) {
            const banner = document.getElementById('reg-rate-banner');
            banner.classList.remove('hidden');
            document.getElementById('reg-rate-msg').textContent = `Too many attempts. Wait ${rl.resetIn}s.`;
            return;
        }
        Security.RateLimiter.record(`register:${email}`);

        showLoading('Creating your account…');
        await delay(400);

        // Check duplicate
        const existing = DB.Users.findByEmail(email);
        if (existing) {
            hideLoading();
            setFieldError('reg-email-err', 'This email is already registered.');
            return;
        }

        const { hash, salt } = await Security.hashPassword(pass);
        const { token, expires } = Security.generateVerificationToken();

        try {
            DB.Users.create({
                full_name: name,
                email,
                password_hash: hash,
                password_salt: salt,
                phone,
                verification_token: token,
                verification_expires: expires
            });
            DB.AuditLogs.log(email, 'relative', 'REGISTER', 'user', email, { phone });
            pendingVerifyEmail = email;
            pendingVerifyToken = token;
            hideLoading();
            showToast('Account created! Please verify your email.', 'success');
            document.getElementById('verify-email-display').textContent = email;
            document.getElementById('demo-code-display').textContent = token;
            document.getElementById('simulated-email-box').classList.remove('hidden');
            showAuthPanel('verify');
        } catch (err) {
            hideLoading();
            showToast(err.message || 'Registration failed.', 'error');
        }
    });

    // Password strength meter
    document.getElementById('reg-password').addEventListener('input', function () {
        const v = this.value;
        const fill = document.getElementById('reg-pw-fill');
        const label = document.getElementById('reg-pw-label');
        let score = 0;
        if (v.length >= 8)       score++;
        if (/[A-Z]/.test(v))     score++;
        if (/[a-z]/.test(v))     score++;
        if (/\d/.test(v))        score++;
        if (/[@$!%*?&#^()\-_+=]/.test(v)) score++;
        const pct   = (score / 5) * 100;
        const colors = ['#ff4f4f','#ff8c00','#ffab40','#00e676','#00d4ff'];
        const labels = ['Very Weak','Weak','Fair','Strong','Excellent'];
        fill.style.width = `${pct}%`;
        fill.style.background = colors[score - 1] || '#333';
        label.textContent = labels[score - 1] || '';
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  AUTH: EMAIL VERIFICATION (OTP)
    // ─────────────────────────────────────────────────────────────────────────
    // OTP digit auto-advance
    document.querySelectorAll('.otp-digit').forEach((input, idx, all) => {
        input.addEventListener('input', function () {
            if (this.value) {
                this.classList.add('filled');
                if (idx < all.length - 1) all[idx + 1].focus();
            }
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Backspace' && !this.value && idx > 0) all[idx - 1].focus();
        });
    });

    document.getElementById('form-verify').addEventListener('submit', async e => {
        e.preventDefault();
        const code = Array.from(document.querySelectorAll('.otp-digit')).map(i => i.value).join('');
        if (code.length !== 6) {
            setFieldError('verify-code-err', 'Enter the full 6-digit code.');
            return;
        }
        showLoading('Verifying…');
        await delay(300);

        const user = DB.Users.verifyEmail(code);
        if (!user) {
            hideLoading();
            setFieldError('verify-code-err', 'Invalid or expired code. Please request a new one.');
            return;
        }
        DB.AuditLogs.log(user.id, 'relative', 'EMAIL_VERIFIED', 'user', user.id);
        hideLoading();
        showToast('Email verified! You can now sign in.', 'success');
        showAuthPanel('login');
        document.getElementById('login-email').value = user.email;
    });

    document.getElementById('btn-resend-code').addEventListener('click', async () => {
        if (!pendingVerifyEmail) return;
        showLoading('Resending code…');
        await delay(300);
        const { token, expires } = Security.generateVerificationToken();
        const user = DB.Users.findByEmail(pendingVerifyEmail);
        if (user) {
            DB.Users.update(user.id, { verification_token: token, verification_expires: expires });
            pendingVerifyToken = token;
            document.getElementById('demo-code-display').textContent = token;
        }
        hideLoading();
        showToast('New verification code generated.', 'info');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  AUTH: FORGOT PASSWORD
    // ─────────────────────────────────────────────────────────────────────────
    document.getElementById('form-forgot').addEventListener('submit', async e => {
        e.preventDefault();
        if (forgotStep === 'email') {
            const email = Security.Validate.sanitize(document.getElementById('forgot-email').value.trim());
            if (!Security.Validate.email(email)) { setFieldError('forgot-email-err', 'Enter a valid email.'); return; }
            showLoading('Sending reset token…');
            await delay(400);
            const user = DB.Users.findByEmail(email);
            if (user) {
                const { token, expires } = Security.generateResetToken();
                DB.Users.update(user.id, { reset_token: token, reset_expires: expires });
                forgotEmail = email;
                document.getElementById('forgot-reset-box').classList.remove('hidden');
                document.getElementById('forgot-token-display').textContent = token;
                document.getElementById('forgot-new-pass-group').classList.remove('hidden');
                document.getElementById('forgot-token-input-group').classList.remove('hidden');
                document.getElementById('btn-forgot-submit').querySelector('.btn-label').textContent = 'Reset Password';
                forgotStep = 'reset';
            }
            hideLoading();
            showToast('If this email is registered, a reset token has been generated.', 'info');
        } else {
            const token    = document.getElementById('forgot-token-input').value.trim();
            const newPass  = document.getElementById('forgot-new-pass').value;
            if (!Security.Validate.password(newPass)) { setFieldError('forgot-new-pass-err', 'Min 8 chars: upper, lower, digit, symbol.'); return; }
            const user = DB.Users.findByEmail(forgotEmail);
            if (!user || user.reset_token !== token || new Date(user.reset_expires) < new Date()) {
                setFieldError('forgot-token-err', 'Invalid or expired reset token.'); return;
            }
            showLoading('Resetting password…');
            await delay(300);
            const { hash, salt } = await Security.hashPassword(newPass);
            DB.Users.update(user.id, { password_hash: hash, password_salt: salt, reset_token: null, reset_expires: null });
            DB.AuditLogs.log(user.id, user.role, 'PASSWORD_RESET', 'user', user.id);
            hideLoading();
            showToast('Password reset successfully. Please sign in.', 'success');
            forgotStep = 'email';
            showAuthPanel('login');
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  AUTH PANEL NAV BUTTONS
    // ─────────────────────────────────────────────────────────────────────────
    document.getElementById('btn-goto-register').addEventListener('click', () => showAuthPanel('register'));
    document.getElementById('btn-goto-login-from-reg').addEventListener('click', () => showAuthPanel('login'));
    document.getElementById('btn-goto-forgot').addEventListener('click', () => showAuthPanel('forgot'));
    document.getElementById('btn-back-to-login-from-forgot').addEventListener('click', () => showAuthPanel('login'));
    document.getElementById('btn-back-to-login-from-verify').addEventListener('click', () => showAuthPanel('login'));

    // Toggle password visibility
    document.querySelectorAll('.toggle-password').forEach(btn => {
        btn.addEventListener('click', function () {
            const input = document.getElementById(this.dataset.target);
            const icon  = this.querySelector('i');
            input.type  = input.type === 'password' ? 'text' : 'password';
            icon.classList.toggle('fa-eye');
            icon.classList.toggle('fa-eye-slash');
        });
    });

    // Demo credential fill buttons
    document.querySelectorAll('.demo-fill-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            if (this.dataset.role === 'relative') {
                showAuthPanel('register');
                return;
            }
            document.getElementById('login-email').value    = this.dataset.email;
            document.getElementById('login-password').value = this.dataset.pass;
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  LOGOUT
    // ─────────────────────────────────────────────────────────────────────────
    function logout(role) {
        const session = Security.Session.get();
        if (session) DB.AuditLogs.log(session.userId, role, 'LOGOUT', 'session', 'auth');
        Security.Session.destroy();
        stopECG();
        stopVitals();
        showPage('page-auth');
        showAuthPanel('login');
        showToast('Signed out successfully.', 'info');
    }
    document.getElementById('btn-admin-logout').addEventListener('click', () => logout('admin'));
    document.getElementById('btn-doc-logout').addEventListener('click',   () => logout('doctor'));
    document.getElementById('btn-rel-logout').addEventListener('click',   () => logout('relative'));

    // Sidebar toggles
    ['admin','doc','rel'].forEach(prefix => {
        const toggle  = document.getElementById(`${prefix}-sidebar-toggle`);
        const sidebar = document.getElementById(`${prefix === 'admin' ? 'admin' : prefix === 'doc' ? 'doctor' : 'rel'}-sidebar`);
        if (toggle && sidebar) toggle.addEventListener('click', () => sidebar.classList.toggle('open'));
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  ADMIN DASHBOARD
    // ═════════════════════════════════════════════════════════════════════════
    let adminSession = null;

    function initAdmin(session) {
        adminSession = session;
        document.getElementById('admin-session-name').textContent = session.name;
        document.getElementById('admin-overview-date').textContent =
            new Date().toLocaleDateString('en-GB', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

        setupAdminNav();
        setupHardwareSimulator();
        renderAdminOverview();
        renderAdminPatients();
        renderRelativeMgmt();
        renderAdminDoctors();
        renderAuditLog();
        renderAdminNotifications();
    }

    let gradualDemoInterval = null;
    let currentSimTemp = 36.8;

    function setupHardwareSimulator() {
        const targetPatientSelect = document.getElementById('sim-target-patient');
        const tempValDisplay = document.getElementById('sim-temp-val');
        const tempDisplayBadge = document.getElementById('sim-temp-display');
        const statusBadge = document.getElementById('sim-status-badge');
        const slider = document.getElementById('sim-temp-slider');

        const btnDec05 = document.getElementById('btn-temp-dec-05');
        const btnInc02 = document.getElementById('btn-temp-inc-02');
        const btnInc05 = document.getElementById('btn-temp-inc-05');
        const btnInc10 = document.getElementById('btn-temp-inc-10');
        const btnGradualDemo = document.getElementById('btn-gradual-fever-demo');
        const gradualStatus = document.getElementById('gradual-fever-status');

        const btnNormal = document.getElementById('btn-sim-normal');
        const btnWarn = document.getElementById('btn-sim-warn');
        const btnFever = document.getElementById('btn-sim-fever');
        const btnDisc = document.getElementById('btn-sim-disconnect');
        const chkAuto = document.getElementById('chk-auto-telemetry');
        const btnWiring = document.getElementById('btn-open-wiring-modal');
        const btnWiringClose = document.getElementById('btn-wiring-modal-close');
        const btnWiringClose2 = document.getElementById('btn-wiring-modal-close2');

        function updateSimDisplay(temp) {
            currentSimTemp = Math.round(temp * 10) / 10;
            if (tempValDisplay) tempValDisplay.textContent = currentSimTemp.toFixed(1);
            if (slider) slider.value = currentSimTemp;

            if (tempDisplayBadge && statusBadge) {
                if (currentSimTemp >= 38.0) {
                    tempDisplayBadge.className = 'badge badge-critical';
                    statusBadge.className = 'badge badge-critical';
                    statusBadge.innerHTML = '<i class="fas fa-triangle-exclamation"></i> Critical Fever';
                } else if (currentSimTemp >= 37.5) {
                    tempDisplayBadge.className = 'badge badge-warning';
                    statusBadge.className = 'badge badge-warning';
                    statusBadge.innerHTML = '<i class="fas fa-triangle-exclamation"></i> Warning';
                } else {
                    tempDisplayBadge.className = 'badge badge-stable';
                    statusBadge.className = 'badge badge-stable';
                    statusBadge.innerHTML = '<i class="fas fa-check"></i> Normal';
                }
            }
        }

        async function emitSimulatedTemp(temp, forceAlert = false) {
            updateSimDisplay(temp);
            const patientId = targetPatientSelect ? targetPatientSelect.value : 'p1';
            const patient = DB.Patients.findById(patientId);
            const pName = patient ? patient.name : 'Patient';

            await DB.sendTelemetry({
                deviceId: 'SIM-ESP32-BED01',
                patientId,
                temperature: currentSimTemp,
                unit: 'C',
                sensorStatus: 'OK'
            });

            if (currentSimTemp >= 38.0 || forceAlert) {
                await fetch('/api/alerts/broadcast', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        patientId,
                        temperature: currentSimTemp,
                        message: `URGENT: Patient ${pName} has high fever of ${currentSimTemp.toFixed(1)} °C. Configured alert threshold: 38.0 °C. Please contact the hospital care team immediately.`
                    })
                }).catch(() => {});
                showToast(`🚨 Simulated ${currentSimTemp.toFixed(1)} °C: Mobile alarm ringing!`, 'error', 3000);
            } else if (currentSimTemp >= 37.5) {
                showToast(`⚠️ Simulated ${currentSimTemp.toFixed(1)} °C: Warning threshold reached.`, 'warning', 2500);
            } else {
                showToast(`✅ Simulated ${currentSimTemp.toFixed(1)} °C: Normal reading.`, 'info', 2000);
            }
        }

        // Target patient selection change
        if (targetPatientSelect) {
            targetPatientSelect.onchange = () => {
                const p = DB.Patients.findById(targetPatientSelect.value);
                const baseTemp = p?.vitals_baseline?.tempC || 36.8;
                updateSimDisplay(baseTemp);
            };
        }

        // Slider input & change
        if (slider) {
            slider.oninput = (e) => {
                updateSimDisplay(parseFloat(e.target.value));
            };
            slider.onchange = (e) => {
                emitSimulatedTemp(parseFloat(e.target.value));
            };
        }

        // Step Increment & Decrement Buttons
        if (btnDec05) {
            btnDec05.onclick = () => {
                emitSimulatedTemp(Math.max(34.0, currentSimTemp - 0.5));
            };
        }
        if (btnInc02) {
            btnInc02.onclick = () => {
                emitSimulatedTemp(Math.min(43.0, currentSimTemp + 0.2));
            };
        }
        if (btnInc05) {
            btnInc05.onclick = () => {
                emitSimulatedTemp(Math.min(43.0, currentSimTemp + 0.5));
            };
        }
        if (btnInc10) {
            btnInc10.onclick = () => {
                emitSimulatedTemp(Math.min(43.0, currentSimTemp + 1.0), true);
            };
        }

        // Gradual Fever Rise Demonstration Mode
        if (btnGradualDemo) {
            btnGradualDemo.onclick = () => {
                if (gradualDemoInterval) {
                    clearInterval(gradualDemoInterval);
                    gradualDemoInterval = null;
                    const iconEl = document.getElementById('icon-gradual-demo');
                    const labelEl = document.getElementById('label-gradual-demo');
                    if (iconEl) iconEl.className = 'fas fa-play';
                    if (labelEl) labelEl.textContent = 'Start Gradual Fever Rise (Demo Mode)';
                    btnGradualDemo.style.background = 'linear-gradient(135deg, #ff8c00, #ff4f4f)';
                    if (gradualStatus) gradualStatus.textContent = 'Gradual simulation stopped.';
                    showToast('Gradual fever simulation stopped.', 'info');
                    return;
                }

                // Start Gradual Demo: Start from 36.8° and rise +0.3° every 2.5s
                let demoTemp = 36.8;
                emitSimulatedTemp(demoTemp);
                const iconEl = document.getElementById('icon-gradual-demo');
                const labelEl = document.getElementById('label-gradual-demo');
                if (iconEl) iconEl.className = 'fas fa-stop';
                if (labelEl) labelEl.textContent = 'Stop Gradual Fever Demo';
                btnGradualDemo.style.background = 'linear-gradient(135deg, #ff4f4f, #d50000)';
                if (gradualStatus) gradualStatus.textContent = '▶️ Running: Rising +0.3 °C every 2.5s. Watch mobile screen!';
                showToast('Gradual Fever Demo started! Rising every 2.5s.', 'warning');

                gradualDemoInterval = setInterval(async () => {
                    demoTemp = Math.round((demoTemp + 0.3) * 10) / 10;
                    await emitSimulatedTemp(demoTemp);

                    if (demoTemp >= 38.6) {
                        clearInterval(gradualDemoInterval);
                        gradualDemoInterval = null;
                        const iEl = document.getElementById('icon-gradual-demo');
                        const lEl = document.getElementById('label-gradual-demo');
                        if (iEl) iEl.className = 'fas fa-play';
                        if (lEl) lEl.textContent = 'Restart Gradual Fever Demo';
                        btnGradualDemo.style.background = 'linear-gradient(135deg, #ff8c00, #ff4f4f)';
                        if (gradualStatus) gradualStatus.textContent = '🚨 Fever reached 38.6 °C! Mobile alarm is ringing.';
                    }
                }, 2500);
            };
        }

        // Quick Preset Buttons
        if (btnNormal) {
            btnNormal.onclick = () => emitSimulatedTemp(36.8);
        }
        if (btnWarn) {
            btnWarn.onclick = () => emitSimulatedTemp(37.7);
        }
        if (btnFever) {
            btnFever.onclick = () => emitSimulatedTemp(38.6, true);
        }
        if (btnDisc) {
            btnDisc.onclick = async () => {
                const patientId = targetPatientSelect ? targetPatientSelect.value : 'p1';
                await DB.sendTelemetry({ deviceId: 'SIM-ESP32-BED01', patientId, temperature: -127.0, unit: 'C', sensorStatus: 'DISCONNECTED' });
                showToast('Sent Sensor Disconnect (-127 °C) from virtual ESP32.', 'warning');
            };
        }
        if (chkAuto) {
            chkAuto.onchange = (e) => {
                if (e.target.checked) {
                    showToast('Virtual ESP32 auto-stream started (every 3s).', 'success');
                    let count = 0;
                    if (autoSimInterval) clearInterval(autoSimInterval);
                    autoSimInterval = setInterval(async () => {
                        count++;
                        let temp = 36.8 + (Math.random() * 0.4 - 0.2);
                        if (count % 8 === 0) temp = 38.5; // Occasional fever spike
                        await DB.sendTelemetry({ deviceId: 'SIM-ESP32-BED01', patientId: 'p1', temperature: parseFloat(temp.toFixed(2)), unit: 'C', sensorStatus: 'OK' });
                    }, 3000);
                } else {
                    if (autoSimInterval) { clearInterval(autoSimInterval); autoSimInterval = null; }
                    showToast('Virtual ESP32 auto-stream stopped.', 'info');
                }
            };
        }
        if (btnWiring) {
            btnWiring.onclick = () => document.getElementById('modal-wiring-overlay').classList.remove('hidden');
        }
        if (btnWiringClose) {
            btnWiringClose.onclick = () => document.getElementById('modal-wiring-overlay').classList.add('hidden');
        }
        if (btnWiringClose2) {
            btnWiringClose2.onclick = () => document.getElementById('modal-wiring-overlay').classList.add('hidden');
        }

        const btnOpenCloud = document.getElementById('btn-open-cloud-modal');
        const btnCloudClose = document.getElementById('btn-cloud-modal-close');
        const btnCloudClose2 = document.getElementById('btn-cloud-modal-close2');
        const btnCopyCloud = document.getElementById('btn-copy-cloud-url');
        const btnCopyAuth = document.getElementById('btn-copy-auth-link');

        if (btnOpenCloud) {
            btnOpenCloud.onclick = () => document.getElementById('modal-cloud-overlay').classList.remove('hidden');
        }
        if (btnCloudClose) {
            btnCloudClose.onclick = () => document.getElementById('modal-cloud-overlay').classList.add('hidden');
        }
        if (btnCloudClose2) {
            btnCloudClose2.onclick = () => document.getElementById('modal-cloud-overlay').classList.add('hidden');
        }

        async function copyUrl(text, label) {
            try {
                await navigator.clipboard.writeText(text);
                showToast(`✅ ${label} copied to clipboard!`, 'success');
            } catch (_) {
                const ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                showToast(`✅ ${label} copied to clipboard!`, 'success');
            }
        }

        if (btnCopyCloud) {
            btnCopyCloud.onclick = () => {
                const url = document.getElementById('cloud-public-link')?.href || window.location.href;
                copyUrl(url, 'Public Cloud Gateway URL');
            };
        }
        if (btnCopyAuth) {
            btnCopyAuth.onclick = () => {
                const url = document.getElementById('auth-cloud-link')?.href || window.location.href;
                copyUrl(url, 'Worldwide Cloud Access URL');
            };
        }
    }

    function setupAdminNav() {
        document.querySelectorAll('#admin-sidebar .nav-item').forEach(btn => {
            btn.addEventListener('click', function () {
                document.querySelectorAll('#admin-sidebar .nav-item').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                document.querySelectorAll('#admin-main .dashboard-panel').forEach(p => p.classList.remove('active'));
                document.getElementById(this.dataset.panel).classList.add('active');
                document.getElementById('admin-topbar-title').textContent = this.querySelector('span').textContent.trim();
            });
        });
    }

    function renderAdminOverview() {
        const patients  = DB.Patients.findAll();
        const relatives = DB.Users.getRelatives();
        const doctors   = DB.Users.findAll().filter(u => u.role === 'doctor');
        const critical  = patients.filter(p => p.status === 'Critical');

        document.getElementById('stat-total-patients').textContent  = patients.length;
        document.getElementById('stat-critical-patients').textContent = critical.length;
        document.getElementById('stat-total-doctors').textContent   = doctors.length;
        document.getElementById('stat-total-relatives').textContent = relatives.length;

        const tbody = document.getElementById('admin-overview-table-body');
        tbody.innerHTML = patients.map(p => {
            const linked = DB.PatientRelatives.findByPatient(p.id);
            const relUser = linked[0] ? DB.Users.findById(linked[0].relative_user_id) : null;
            const tempVal = p.vitals_baseline?.tempC || 36.8;
            const tempBadgeClass = tempVal >= (p.temp_threshold_critical || 38.0) ? 'badge-critical' : tempVal >= (p.temp_threshold_warning || 37.5) ? 'badge-warning' : 'badge-stable';
            return `<tr>
                <td><strong>${p.name}</strong><br/><span class="text-muted mono" style="font-size:11px">${p.patient_code}</span></td>
                <td>${p.ward}</td>
                <td>${p.assigned_doctor_name}</td>
                <td><span class="badge badge-${p.status.toLowerCase()}">${p.status}</span></td>
                <td><span class="badge ${tempBadgeClass}"><i class="fas fa-temperature-half"></i> ${tempVal.toFixed(1)} °C</span></td>
                <td>${relUser
                    ? `<span class="badge badge-yes">${relUser.full_name}</span>`
                    : `<span class="badge badge-no">None</span>`
                }</td>
            </tr>`;
        }).join('');
    }

    // ─── Admin: Patients Panel ────────────────────────────────────────────────
    function renderAdminPatients(filter = '') {
        const patients = DB.Patients.findAll().filter(p => {
            const statusF = document.getElementById('patient-status-filter').value;
            const matchSearch = !filter ||
                p.name.toLowerCase().includes(filter.toLowerCase()) ||
                p.patient_code.toLowerCase().includes(filter.toLowerCase()) ||
                p.ward.toLowerCase().includes(filter.toLowerCase());
            const matchStatus = !statusF || p.status === statusF;
            return matchSearch && matchStatus;
        });
        const grid = document.getElementById('admin-patient-grid');
        if (patients.length === 0) {
            grid.innerHTML = `<div class="empty-state"><i class="fas fa-bed-pulse"></i><p>No patients found.</p></div>`;
            return;
        }
        grid.innerHTML = patients.map(p => {
            const linked = DB.PatientRelatives.findByPatient(p.id);
            return `<div class="patient-card status-${p.status}" data-id="${p.id}">
                <div class="patient-card-header">
                    <div>
                        <div class="patient-card-name">${p.name}</div>
                        <div class="patient-card-id">${p.patient_code}</div>
                        <div class="patient-card-meta">${p.age}y · ${p.gender} · ${p.ward}</div>
                    </div>
                    <span class="badge badge-${p.status.toLowerCase()}">${p.status}</span>
                </div>
                <div class="patient-card-vitals">
                    <div class="patient-mini-vital"><span class="val">${p.vitals_baseline.bpm}</span><span class="lbl">BPM</span></div>
                    <div class="patient-mini-vital"><span class="val">${p.vitals_baseline.spo2}%</span><span class="lbl">SpO₂</span></div>
                    <div class="patient-mini-vital"><span class="val">${p.vitals_baseline.tempC}°</span><span class="lbl">Temp</span></div>
                </div>
                <div class="patient-card-footer">
                    <small class="text-muted">Dr: ${p.assigned_doctor_name}</small>
                    <div class="patient-card-actions">
                        <button class="btn-icon" title="View Details" onclick="adminViewPatient('${p.id}')"><i class="fas fa-eye"></i></button>
                        <button class="btn-icon" title="Edit Status" onclick="adminEditStatus('${p.id}')"><i class="fas fa-pen"></i></button>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    document.getElementById('patient-search').addEventListener('input', function () {
        renderAdminPatients(this.value);
    });
    document.getElementById('patient-status-filter').addEventListener('change', () => {
        renderAdminPatients(document.getElementById('patient-search').value);
    });

    window.adminViewPatient = function (patientId) {
        try { Security.RBAC.requireAdmin(); } catch { return; }
        const p = DB.Patients.findById(patientId);
        if (!p) return;
        const linked = DB.PatientRelatives.findByPatient(patientId);
        const relList = linked.map(r => {
            const u = DB.Users.findById(r.relative_user_id);
            return u ? `<li>${u.full_name} (${u.email})</li>` : '';
        }).join('');
        document.getElementById('modal-patient-name').textContent = p.name;
        document.getElementById('modal-patient-body').innerHTML = `
            <div class="patient-detail-card" style="border:none;padding:0;">
                <div class="patient-detail-field"><span class="label">Patient Code</span><span class="value mono">${p.patient_code}</span></div>
                <div class="patient-detail-field"><span class="label">Age / Gender</span><span class="value">${p.age}y · ${p.gender}</span></div>
                <div class="patient-detail-field"><span class="label">Ward / Bed</span><span class="value">${p.ward} / ${p.bed}</span></div>
                <div class="patient-detail-field"><span class="label">Diagnosis</span><span class="value">${p.diagnosis}</span></div>
                <div class="patient-detail-field"><span class="label">Status</span><span class="value"><span class="badge badge-${p.status.toLowerCase()}">${p.status}</span></span></div>
                <div class="patient-detail-field"><span class="label">Blood Group</span><span class="value">${p.blood_group}</span></div>
                <div class="patient-detail-field"><span class="label">Doctor</span><span class="value">${p.assigned_doctor_name}</span></div>
                <div class="patient-detail-field" style="grid-column:1/-1"><span class="label">Linked Relatives</span>
                    ${linked.length ? `<ul style="list-style:none;font-size:13px;margin-top:4px">${relList}</ul>` : '<span class="value text-muted">None linked</span>'}
                </div>
            </div>
            ${p.treatment_notes.length ? `
            <div style="margin-top:12px">
                <div class="label" style="font-size:11px;text-transform:uppercase;color:var(--text-muted);letter-spacing:.7px;margin-bottom:8px">Latest Treatment Notes</div>
                ${p.treatment_notes.slice(-3).reverse().map(n=>`<div class="note-item"><div class="note-meta">${n.date} · ${n.added_by}</div><div class="note-text">${n.note}</div></div>`).join('')}
            </div>` : ''}
        `;
        document.getElementById('modal-patient-overlay').classList.remove('hidden');
    };

    window.adminEditStatus = function (patientId) {
        try { Security.RBAC.requireAdmin(); } catch { return; }
        const p = DB.Patients.findById(patientId);
        if (!p) return;
        const statuses = ['Critical','Stable','Monitored','Discharged'];
        const select = statuses.map(s => `<option value="${s}" ${s===p.status?'selected':''}>${s}</option>`).join('');
        const noteInput = `<div class="form-group" style="margin-top:12px">
            <label>Status Update Note</label>
            <div class="input-icon-wrap"><i class="fas fa-comment input-icon"></i>
            <input type="text" id="status-note-input" placeholder="Reason for status change…" /></div>
        </div>`;
        document.getElementById('modal-patient-name').textContent = `Update: ${p.name}`;
        document.getElementById('modal-patient-body').innerHTML = `
            <div class="form-group">
                <label>New Status</label>
                <select id="status-select" class="select-input" style="width:100%">${select}</select>
            </div>${noteInput}`;
        document.getElementById('modal-patient-footer').innerHTML = `
            <button class="btn-secondary" id="btn-patient-modal-close2b">Cancel</button>
            <button class="btn-primary" id="btn-save-status">Save Status</button>`;
        document.getElementById('modal-patient-overlay').classList.remove('hidden');
        document.getElementById('btn-patient-modal-close2b').onclick = () =>
            document.getElementById('modal-patient-overlay').classList.add('hidden');
        document.getElementById('btn-save-status').onclick = () => {
            const newStatus = document.getElementById('status-select').value;
            const note = document.getElementById('status-note-input').value;
            try { Security.RBAC.requireAdmin(); } catch { return; }
            DB.Patients.update(patientId, { status: newStatus }, adminSession.userId);
            DB.AuditLogs.log(adminSession.userId, 'admin', 'UPDATE_PATIENT_STATUS', 'patient', patientId, { old: p.status, new: newStatus, note });
            // Notify relatives
            const patient = DB.Patients.findById(patientId);
            DB.Notifications.notifyRelativesOfPatient(
                patientId, newStatus === 'Critical' ? 'critical' : 'update',
                `${patient.name}'s status has been updated to: ${newStatus}. ${note}`,
                patient.name
            );
            document.getElementById('modal-patient-overlay').classList.add('hidden');
            renderAdminPatients();
            renderAdminOverview();
            renderAdminNotifications();
            showToast(`Patient status updated to ${newStatus}.`, 'success');
            if (newStatus === 'Critical') {
                triggerCriticalAlertForRelatives(patientId);
                fetch('/api/alerts/broadcast', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ patientId, message: `URGENT: Patient ${patient.name} (${patient.patient_code}) status changed to CRITICAL. Please contact hospital staff immediately.` })
                }).catch(() => {});
            }
        };
    };

    document.getElementById('btn-patient-modal-close').addEventListener('click',  () => document.getElementById('modal-patient-overlay').classList.add('hidden'));
    document.getElementById('btn-patient-modal-close2').addEventListener('click', () => document.getElementById('modal-patient-overlay').classList.add('hidden'));

    // ─── Admin: Relative Access Management ───────────────────────────────────
    let selectedPatientIdForRel = null;

    function renderRelativeMgmt() {
        renderPatientSelectList('');
    }

    function renderPatientSelectList(filter) {
        const patients = DB.Patients.findAll().filter(p =>
            !filter ||
            p.name.toLowerCase().includes(filter.toLowerCase()) ||
            p.patient_code.toLowerCase().includes(filter.toLowerCase())
        );
        const list = document.getElementById('rel-patient-list');
        list.innerHTML = patients.map(p => `
            <div class="patient-select-item ${p.id === selectedPatientIdForRel ? 'selected' : ''}"
                 data-id="${p.id}">
                <i class="fas fa-bed-pulse"></i>
                <div>
                    <strong>${p.name}</strong>
                    <div style="font-size:11px;color:var(--text-muted)">${p.patient_code} · ${p.ward}</div>
                </div>
                <span class="badge badge-${p.status.toLowerCase()}">${p.status}</span>
            </div>`
        ).join('');

        list.querySelectorAll('.patient-select-item').forEach(item => {
            item.addEventListener('click', function () {
                selectedPatientIdForRel = this.dataset.id;
                renderLinkedRelativesForPatient(selectedPatientIdForRel);
                const p = DB.Patients.findById(selectedPatientIdForRel);
                document.getElementById('rel-selected-patient-name').textContent = p.name;
                document.getElementById('rel-selected-patient-meta').textContent = `${p.patient_code} · ${p.ward}`;
                document.getElementById('rel-selected-patient-badge').classList.remove('hidden');
                document.getElementById('rel-patient-list').innerHTML = '';
                document.getElementById('rel-mgmt-step2').classList.remove('hidden');
                document.getElementById('rel-linked-table-card').classList.remove('hidden');
                document.getElementById('rel-linked-patient-label').textContent = p.name;
            });
        });
    }

    document.getElementById('rel-patient-search').addEventListener('input', function () {
        renderPatientSelectList(this.value);
    });

    document.getElementById('btn-rel-clear-patient').addEventListener('click', () => {
        selectedPatientIdForRel = null;
        document.getElementById('rel-selected-patient-badge').classList.add('hidden');
        document.getElementById('rel-mgmt-step2').classList.add('hidden');
        document.getElementById('rel-linked-table-card').classList.add('hidden');
        renderPatientSelectList('');
    });

    function renderLinkedRelativesForPatient(patientId) {
        const rels = DB.PatientRelatives.findByPatient(patientId);
        const tbody = document.getElementById('rel-linked-table-body');
        const empty = document.getElementById('rel-linked-empty');
        if (rels.length === 0) {
            tbody.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');
        tbody.innerHTML = rels.map(r => {
            const u = DB.Users.findById(r.relative_user_id);
            if (!u) return '';
            return `<tr>
                <td>${u.full_name}</td>
                <td class="mono" style="font-size:12px">${u.email}</td>
                <td>${new Date(r.linked_at).toLocaleDateString('en-GB')}</td>
                <td><span class="badge badge-stable">Active</span></td>
                <td>
                    <button class="btn-icon danger" title="Revoke Access"
                        onclick="adminRevokeRelative('${patientId}','${u.id}','${u.full_name}')">
                        <i class="fas fa-user-minus"></i>
                    </button>
                </td>
            </tr>`;
        }).join('');
    }

    document.getElementById('btn-link-relative').addEventListener('click', async () => {
        try { Security.RBAC.requireAdmin(); } catch { showToast('Not authorised.', 'error'); return; }
        if (!selectedPatientIdForRel) { showToast('Please select a patient first.', 'warning'); return; }
        const emailInput = document.getElementById('rel-email-input').value.trim().toLowerCase();
        const feedbackEl = document.getElementById('rel-email-feedback');
        const errorEl    = document.getElementById('rel-email-error');
        feedbackEl.classList.add('hidden');
        errorEl.classList.add('hidden');

        if (!Security.Validate.email(emailInput)) {
            errorEl.className = 'validation-feedback error';
            errorEl.innerHTML = '<i class="fas fa-times-circle"></i> Please enter a valid email address.';
            errorEl.classList.remove('hidden');
            return;
        }

        showLoading('Validating relative account…');
        // Synchronize latest registered users from server
        await DB.syncFromServer();
        await delay(300);

        let relUser = DB.Users.findVerifiedRelativeByEmail(emailInput);
        if (!relUser) {
            hideLoading();
            errorEl.className = 'validation-feedback error';
            errorEl.innerHTML = `<i class="fas fa-times-circle"></i>
                No verified relative account found for <strong>${emailInput}</strong>.
                The relative must register and verify their email first.`;
            errorEl.classList.remove('hidden');
            return;
        }

        try {
            // Save link on server database & trigger SSE
            await fetch('/api/relatives/link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ patientId: selectedPatientIdForRel, email: emailInput, adminId: adminSession.userId })
            }).catch(e => console.warn('Server link sync:', e.message));

            DB.PatientRelatives.link(selectedPatientIdForRel, relUser.id, adminSession.userId);
            const patient = DB.Patients.findById(selectedPatientIdForRel);
            DB.AuditLogs.log(adminSession.userId, 'admin', 'LINK_RELATIVE', 'patient_relative',
                selectedPatientIdForRel, { relative_email: emailInput });
            DB.Notifications.notifyRelativesOfPatient(
                selectedPatientIdForRel, 'info',
                `You have been granted access to view health updates for ${patient.name}.`,
                patient.name
            );
            hideLoading();
            feedbackEl.className = 'validation-feedback success';
            feedbackEl.innerHTML = `<i class="fas fa-check-circle"></i>
                <strong>${relUser.full_name}</strong> has been linked to ${patient.name} successfully.`;
            feedbackEl.classList.remove('hidden');
            document.getElementById('rel-email-input').value = '';
            renderLinkedRelativesForPatient(selectedPatientIdForRel);
            renderAdminOverview();
            renderAdminNotifications();
            showToast(`${relUser.full_name} linked to patient.`, 'success');
        } catch (err) {
            hideLoading();
            errorEl.className = 'validation-feedback error';
            errorEl.innerHTML = `<i class="fas fa-times-circle"></i> ${err.message === 'RELATIONSHIP_ALREADY_EXISTS'
                ? 'This relative is already linked to this patient.'
                : 'Failed to link relative: ' + err.message}`;
            errorEl.classList.remove('hidden');
        }
    });

    window.adminRevokeRelative = function (patientId, relUserId, relName) {
        showConfirm(
            'Revoke Access',
            `Remove ${relName}'s access to this patient? They will no longer receive updates.`,
            async () => {
                try { Security.RBAC.requireAdmin(); } catch { return; }
                await fetch('/api/relatives/revoke', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ patientId, relativeUserId: relUserId, adminId: adminSession.userId })
                }).catch(e => console.warn('Server revoke sync:', e.message));

                DB.PatientRelatives.revoke(patientId, relUserId);
                const patient = DB.Patients.findById(patientId);
                DB.AuditLogs.log(adminSession.userId, 'admin', 'REVOKE_RELATIVE', 'patient_relative',
                    patientId, { relative_user_id: relUserId });
                renderLinkedRelativesForPatient(patientId);
                showToast(`Access revoked for ${relName}.`, 'warning');
            }
        );
    };

    // ─── Admin: Doctors Panel ─────────────────────────────────────────────────
    function renderAdminDoctors() {
        const doctors = DB.Users.findAll().filter(u => u.role === 'doctor');
        const tbody   = document.getElementById('admin-doctors-table-body');
        tbody.innerHTML = doctors.map(d => {
            const patient = d.assigned_patient_id ? DB.Patients.findById(d.assigned_patient_id) : null;
            const [, spec] = d.full_name.split('(');
            return `<tr>
                <td><strong>${d.full_name.split('(')[0].trim()}</strong></td>
                <td class="mono" style="font-size:12px">${d.email}</td>
                <td>${spec ? spec.replace(')','') : 'General'}</td>
                <td>${patient ? patient.name : '<span class="text-muted">Unassigned</span>'}</td>
                <td class="mono" style="font-size:12px">Doc@123!</td>
            </tr>`;
        }).join('');
    }

    // Doctor provisioning modal
    document.getElementById('btn-provision-doctor').addEventListener('click', () => {
        const select = document.getElementById('prov-patient');
        select.innerHTML = '<option value="">Select patient…</option>' +
            DB.Patients.findAll().map(p => `<option value="${p.id}">${p.name}</option>`).join('');
        document.getElementById('modal-doctor-overlay').classList.remove('hidden');
    });
    document.getElementById('btn-doctor-modal-close').addEventListener('click', () =>
        document.getElementById('modal-doctor-overlay').classList.add('hidden'));
    document.getElementById('btn-doctor-modal-cancel').addEventListener('click', () =>
        document.getElementById('modal-doctor-overlay').classList.add('hidden'));

    document.getElementById('form-provision-doctor').addEventListener('submit', async e => {
        e.preventDefault();
        const name   = Security.Validate.sanitize(document.getElementById('prov-name').value);
        const email  = document.getElementById('prov-email').value.trim().toLowerCase();
        const pid    = document.getElementById('prov-patient').value;
        const pass   = document.getElementById('prov-pass').value;
        let ok = true;
        if (!Security.Validate.name(name))  { setFieldError('prov-name-err', 'Required.'); ok = false; }
        if (!Security.Validate.email(email)){ setFieldError('prov-email-err','Valid email required.'); ok = false; }
        if (!pid)                           { setFieldError('prov-patient-err','Select a patient.'); ok = false; }
        if (!ok) return;
        try { Security.RBAC.requireAdmin(); } catch { return; }
        if (DB.Users.findByEmail(email)) { setFieldError('prov-email-err','Email already registered.'); return; }
        showLoading('Provisioning doctor…');
        await delay(400);
        const { hash, salt } = await Security.hashPassword(pass);
        DB.Users.create({
            full_name: name,
            email,
            password_hash: hash,
            password_salt: salt,
            phone: null,
            verification_token: null,
            verification_expires: null
        });
        // Patch role to doctor and set assigned patient (Users.create forces 'relative', so update manually via direct localStorage)
        const users = JSON.parse(localStorage.getItem('biocloud_users') || '[]');
        const idx = users.findIndex(u => u.email === email);
        if (idx !== -1) {
            users[idx].role = 'doctor';
            users[idx].assigned_patient_id = pid;
            users[idx].email_verified = true;
            localStorage.setItem('biocloud_users', JSON.stringify(users));
        }
        DB.AuditLogs.log(adminSession.userId, 'admin', 'PROVISION_DOCTOR', 'user', email, { assigned_patient: pid });
        hideLoading();
        document.getElementById('modal-doctor-overlay').classList.add('hidden');
        renderAdminDoctors();
        showToast(`Doctor account created for ${name}.`, 'success');
    });

    // ─── Admin: Audit Log ─────────────────────────────────────────────────────
    function renderAuditLog(filter = '', roleFilter = '') {
        let logs = DB.AuditLogs.findAll();
        if (filter) {
            const f = filter.toLowerCase();
            logs = logs.filter(l =>
                l.action.toLowerCase().includes(f) ||
                l.actor_id.toLowerCase().includes(f) ||
                l.target_type.toLowerCase().includes(f)
            );
        }
        if (roleFilter) logs = logs.filter(l => l.actor_role === roleFilter);

        const tbody = document.getElementById('audit-table-body');
        const empty = document.getElementById('audit-empty');
        if (!logs.length) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }
        empty.classList.add('hidden');
        tbody.innerHTML = logs.map(l => {
            const actor = DB.Users.findById(l.actor_id);
            return `<tr>
                <td class="mono" style="font-size:11px">${new Date(l.timestamp).toLocaleString('en-GB')}</td>
                <td>${actor ? actor.full_name : l.actor_id}</td>
                <td><span class="badge badge-${l.actor_role === 'admin' ? 'critical' : l.actor_role === 'doctor' ? 'monitored' : 'stable'}">${l.actor_role}</span></td>
                <td><code style="font-size:12px;color:var(--amber)">${l.action}</code></td>
                <td style="font-size:12px">${l.target_type}: ${l.target_id.substring(0,20)}</td>
            </tr>`;
        }).join('');
    }

    document.getElementById('audit-search').addEventListener('input', function () {
        renderAuditLog(this.value, document.getElementById('audit-role-filter').value);
    });
    document.getElementById('audit-role-filter').addEventListener('change', function () {
        renderAuditLog(document.getElementById('audit-search').value, this.value);
    });
    document.getElementById('btn-export-audit').addEventListener('click', () => {
        const logs = DB.AuditLogs.findAll();
        const csv  = ['Timestamp,Actor,Role,Action,Target']
            .concat(logs.map(l => `"${l.timestamp}","${l.actor_id}","${l.actor_role}","${l.action}","${l.target_type}:${l.target_id}"`))
            .join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = 'audit_log.csv'; a.click();
        URL.revokeObjectURL(url);
    });

    // ─── Admin: Notifications Panel ────────────────────────────────────────────
    function renderAdminNotifications() {
        const notifs = DB.Notifications.findAll();
        const tbody  = document.getElementById('admin-notif-table-body');
        const empty  = document.getElementById('admin-notif-empty');
        if (!notifs.length) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }
        empty.classList.add('hidden');
        tbody.innerHTML = notifs.map(n => {
            const u = DB.Users.findById(n.relative_user_id);
            return `<tr>
                <td class="mono" style="font-size:11px">${new Date(n.created_at).toLocaleString('en-GB')}</td>
                <td>${u ? u.full_name : 'Unknown'}</td>
                <td>${n.patient_name || ''}</td>
                <td><span class="badge badge-${n.type === 'critical' ? 'critical' : n.type === 'update' ? 'monitored' : 'stable'}">${n.type}</span></td>
                <td style="max-width:280px;font-size:12px">${n.message}</td>
                <td><span class="badge badge-stable">${n.delivery_status}</span></td>
                <td>${n.read ? '<i class="fas fa-check text-success"></i>' : '<i class="fas fa-clock text-muted"></i>'}</td>
            </tr>`;
        }).join('');
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  DOCTOR DASHBOARD
    // ═════════════════════════════════════════════════════════════════════════
    let docSession = null;
    let ecgInterval = null;
    let vitalsInterval = null;
    let anomalyState = 'NONE';
    let ecgPhase = 0;
    let ecgGain  = 1.0;
    let ecgSpeed = 2.5;
    let showGrid = true;
    let ecgData  = new Array(300).fill(0);
    let ecgChart = null;

    function initDoctor(session) {
        docSession = session;
        document.getElementById('doc-session-name').textContent = session.name;
        setupDoctorNav();

        const patientId = session.assignedPatientId;
        if (!patientId) {
            document.getElementById('doc-patient-detail-card').innerHTML =
                `<div class="empty-state"><i class="fas fa-bed"></i><p>No patient assigned.</p></div>`;
            return;
        }
        const patient = DB.Patients.findById(patientId);
        if (!patient) return;

        renderDocPatient(patient);
        startVitals(patient);
        setupECG();
        startECG();
        setupAnomalyButtons(patientId, patient.name);
        renderDocNotes(patient);
    }

    function setupDoctorNav() {
        document.querySelectorAll('#doctor-sidebar .nav-item').forEach(btn => {
            btn.addEventListener('click', function () {
                document.querySelectorAll('#doctor-sidebar .nav-item').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                document.querySelectorAll('#doctor-main .dashboard-panel').forEach(p => p.classList.remove('active'));
                document.getElementById(this.dataset.panel).classList.add('active');
                document.getElementById('doc-topbar-title').textContent = this.querySelector('span').textContent.trim();
            });
        });
    }

    function renderDocPatient(patient) {
        document.getElementById('doc-patient-detail-card').innerHTML = `
            <div class="patient-detail-field"><span class="label">Name</span><span class="value">${patient.name}</span></div>
            <div class="patient-detail-field"><span class="label">Code</span><span class="value mono">${patient.patient_code}</span></div>
            <div class="patient-detail-field"><span class="label">Age / Gender</span><span class="value">${patient.age}y · ${patient.gender}</span></div>
            <div class="patient-detail-field"><span class="label">Ward / Bed</span><span class="value">${patient.ward} / ${patient.bed}</span></div>
            <div class="patient-detail-field"><span class="label">Diagnosis</span><span class="value">${patient.diagnosis}</span></div>
            <div class="patient-detail-field"><span class="label">Status</span><span class="value"><span class="badge badge-${patient.status.toLowerCase()}">${patient.status}</span></span></div>
            <div class="patient-detail-field"><span class="label">Blood Group</span><span class="value">${patient.blood_group}</span></div>
            <div class="patient-detail-field"><span class="label">IoT Topic</span><span class="value mono" style="font-size:12px">${patient.iot_topic}</span></div>
        `;
        document.getElementById('doc-vitals-strip').style.display = 'grid';
    }

    // ─── Vitals Simulation ─────────────────────────────────────────────────
    function startVitals(patient) {
        const base = patient.vitals_baseline;
        let bpm = base.bpm, spo2 = base.spo2, temp = base.tempC, accel = base.accelG;
        updateVitalDisplay(bpm, spo2, temp, accel);
        vitalsInterval = setInterval(() => {
            const anom = anomalyState;
            if (anom === 'TACHYCARDIA') {
                bpm  = jitter(130, 8);
                spo2 = jitter(94, 1.5);
                temp = jitter(37.2, 0.2);
            } else if (anom === 'HYPOXIA') {
                bpm  = jitter(95, 5);
                spo2 = jitter(85, 3);
                temp = jitter(36.8, 0.2);
            } else if (anom === 'FEVER') {
                bpm  = jitter(102, 6);
                spo2 = jitter(95, 1.5);
                temp = jitter(39.8, 0.4);
            } else if (anom === 'FALL') {
                accel = jitter(3.8, 0.8);
                bpm   = jitter(110, 8);
            } else if (anom === 'DISCONNECT') {
                updateVitalDisplay('--','--','--','--');
                return;
            } else {
                bpm   = jitter(base.bpm, 4);
                spo2  = jitter(base.spo2, 0.8);
                temp  = jitter(base.tempC, 0.15);
                accel = jitter(base.accelG, 0.08);
            }
            updateVitalDisplay(bpm, spo2, temp, accel);
        }, 1200);
    }

    function jitter(base, range) {
        return Math.round((base + (Math.random() - 0.5) * 2 * range) * 10) / 10;
    }

    function updateVitalDisplay(bpm, spo2, temp, accel) {
        const s = v => v === '--' ? '--' : v;
        document.getElementById('doc-bpm').textContent   = s(typeof bpm === 'number' ? bpm.toFixed(0) : bpm);
        document.getElementById('doc-spo2').textContent  = s(typeof spo2 === 'number' ? spo2.toFixed(1) : spo2);
        document.getElementById('doc-temp').textContent  = s(typeof temp === 'number' ? temp.toFixed(1) : temp);
        document.getElementById('doc-accel').textContent = s(typeof accel === 'number' ? accel.toFixed(2) : accel);
    }

    function stopVitals() { if (vitalsInterval) { clearInterval(vitalsInterval); vitalsInterval = null; } }

    // ─── ECG Engine ─────────────────────────────────────────────────────────
    function setupECG() {
        const canvas = document.getElementById('doc-ecg-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const resizeCanvas = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; };
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        ecgChart = { canvas, ctx };

        document.getElementById('doc-ecg-gain').addEventListener('change', function () { ecgGain  = parseFloat(this.value); });
        document.getElementById('doc-ecg-speed').addEventListener('change', function () { ecgSpeed = parseFloat(this.value); });
        document.getElementById('doc-ecg-grid').addEventListener('change', function () { showGrid = this.checked; });
    }

    function ecgSample(phase, anom) {
        const T = 1.0, P = 0.15, Q = 0.4, R = 0.45, S = 0.5, T2 = 0.7;
        const t = ((phase % T) + T) % T;
        let v = 0;
        v += gauss(t, P, 0.02) * 0.15;
        const rH = anom === 'TACHYCARDIA' ? 1.6 : anom === 'HYPOXIA' ? 0.7 : 1.0;
        v += gauss(t, Q, 0.005) * -0.15 * rH;
        v += gauss(t, R, 0.012) * rH;
        v += gauss(t, S, 0.005) * -0.18 * rH;
        v += gauss(t, T2, 0.04) * 0.25;
        if (anom === 'DISCONNECT') v += (Math.random() - 0.5) * 0.05;
        return v;
    }

    function gauss(x, mean, sigma) {
        return Math.exp(-0.5 * ((x - mean) / sigma) ** 2);
    }

    function startECG() {
        stopECG();
        const bpm = 75;
        const sampleRate = 60;
        ecgInterval = setInterval(() => {
            if (!ecgChart) return;
            const speedHz = bpm / 60 * ecgSpeed;
            ecgPhase += speedHz / sampleRate;
            const sample = ecgSample(ecgPhase, anomalyState) * ecgGain;
            ecgData.shift();
            ecgData.push(sample);
            drawECG();
        }, 1000 / sampleRate);
    }

    function stopECG() { if (ecgInterval) { clearInterval(ecgInterval); ecgInterval = null; } }

    function drawECG() {
        if (!ecgChart) return;
        const { canvas, ctx } = ecgChart;
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        // Background
        ctx.fillStyle = '#050d1e';
        ctx.fillRect(0, 0, W, H);

        // Grid
        if (showGrid) {
            ctx.strokeStyle = 'rgba(0,80,40,0.35)';
            ctx.lineWidth = 0.5;
            const gs = 20;
            for (let x = 0; x < W; x += gs) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
            for (let y = 0; y < H; y += gs) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
            ctx.strokeStyle = 'rgba(0,120,60,0.25)';
            ctx.lineWidth = 1;
            for (let x = 0; x < W; x += gs * 5) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
            for (let y = 0; y < H; y += gs * 5) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
        }

        // ECG trace
        const n = ecgData.length;
        const color = anomalyState === 'NONE' ? '#00e676' : anomalyState === 'DISCONNECT' ? '#506080' : '#ff4f4f';
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.shadowColor = color;
        ctx.shadowBlur = 6;
        for (let i = 0; i < n; i++) {
            const x = (i / n) * W;
            const y = H / 2 - ecgData[i] * H * 0.38;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    // ─── Anomaly Simulator ─────────────────────────────────────────────────
    function setupAnomalyButtons(patientId, patientName) {
        document.querySelectorAll('.anomaly-btn').forEach(btn => {
            btn.addEventListener('click', function () {
                document.querySelectorAll('.anomaly-btn').forEach(b => b.classList.remove('active'));
                const type = this.dataset.type;
                anomalyState = type;
                if (type !== 'NONE') this.classList.add('active');
                const labels = {
                    NONE: 'Status: <strong>Normal</strong>',
                    TACHYCARDIA: 'Status: <strong style="color:var(--red)">TACHYCARDIA DETECTED</strong>',
                    HYPOXIA: 'Status: <strong style="color:var(--red)">HYPOXIA DETECTED</strong>',
                    FEVER: 'Status: <strong style="color:var(--amber)">HIGH FEVER DETECTED</strong>',
                    FALL: 'Status: <strong style="color:var(--red)">FALL DETECTED</strong>',
                    DISCONNECT: 'Status: <strong style="color:var(--text-muted)">SENSOR DISCONNECTED</strong>'
                };
                document.getElementById('doc-anomaly-status').innerHTML = labels[type] || '';
                document.getElementById('doc-rhythm-val').textContent =
                    type === 'TACHYCARDIA' ? 'Tachycardia (>120 BPM)' :
                    type === 'HYPOXIA'     ? 'Low Oxygen (SpO₂ < 90%)' :
                    type === 'FEVER'       ? 'High Fever (>38.5°C)' :
                    type === 'FALL'        ? 'Fall Detected (High G-Force)' :
                    type === 'DISCONNECT'  ? 'Sensor Disconnected' : 'Normal Sinus';

                // Trigger relative notification for critical events
                if (['TACHYCARDIA','HYPOXIA','FALL'].includes(type)) {
                    DB.Notifications.notifyRelativesOfPatient(
                        patientId, 'critical',
                        `⚠️ CRITICAL ALERT: ${type} detected for ${patientName}. Medical staff have been notified.`,
                        patientName
                    );
                    triggerCriticalAlertForRelatives(patientId);
                    showToast(`Critical anomaly (${type}) — relatives notified!`, 'warning');
                    DB.AuditLogs.log(docSession.userId, 'doctor', `ANOMALY_${type}`, 'patient', patientId);
                } else if (type === 'FEVER') {
                    DB.sendTelemetry({ deviceId: 'SIM-ESP32-BED01', patientId, temperature: 38.7, unit: 'C', sensorStatus: 'OK' });
                    fetch('/api/alerts/broadcast', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ patientId, temperature: 38.7 })
                    }).catch(() => {});
                    showToast(`High Fever (38.7 °C) simulated for ${patientName} — Mobile relative alarm ringing!`, 'error');
                }
            });
        });
    }

    // ─── Clinical Notes ────────────────────────────────────────────────────
    function renderDocNotes(patient) {
        const notes = [...(patient.treatment_notes || [])].reverse();
        const list = document.getElementById('doc-notes-list');
        list.innerHTML = notes.length
            ? notes.map(n => `<div class="note-item"><div class="note-meta">${n.date} · ${n.added_by}</div><div class="note-text">${n.note}</div></div>`).join('')
            : `<div class="empty-state"><i class="fas fa-notes-medical"></i><p>No clinical notes yet.</p></div>`;
    }

    document.getElementById('btn-doc-add-note').addEventListener('click', () => {
        const textarea = document.getElementById('doc-note-input');
        const note = Security.Validate.sanitize(textarea.value.trim());
        if (!note) { showToast('Please enter a note first.', 'warning'); return; }
        try { Security.RBAC.requireClinical(); } catch { return; }
        const pid = docSession.assignedPatientId;
        DB.Patients.addTreatmentNote(pid, note, docSession.email);
        DB.AuditLogs.log(docSession.userId, 'doctor', 'ADD_CLINICAL_NOTE', 'patient', pid);
        const patient = DB.Patients.findById(pid);
        DB.Notifications.notifyRelativesOfPatient(pid, 'update', `New clinical update for ${patient.name}: "${note.substring(0,80)}…"`, patient.name);
        textarea.value = '';
        renderDocNotes(patient);
        showToast('Clinical note saved and relatives notified.', 'success');
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  RELATIVE DASHBOARD
    // ═════════════════════════════════════════════════════════════════════════
    let relSession = null;

    async function initRelative(session) {
        relSession = session;
        document.getElementById('rel-session-name').textContent = session.name;
        setupRelNav();
        startBackgroundSyncWorker();
        knownLinkedPatientIds = DB.PatientRelatives.findByRelative(relSession.userId).map(r => r.patient_id).sort();
        await renderRelativePatients();
        renderRelativeNotifications();
        updateRelNotifBadge();
        // Fetch any latest patient-relative links from backend
        try {
            await DB.syncFromServer();
            await renderRelativePatients();
            renderRelativeNotifications();
        } catch (e) {}

        // Wire up test alarm button on Relative Dashboard
        const testBtn = document.getElementById('btn-rel-test-alarm');
        if (testBtn) {
            testBtn.onclick = () => {
                if (!alarmContext) alarmContext = new (window.AudioContext || window.webkitAudioContext)();
                if (alarmContext && alarmContext.state === 'suspended') alarmContext.resume();
                const linked = DB.PatientRelatives.findByRelative(relSession.userId);
                const pId = linked[0]?.patient_id || 'p1';
                const p = DB.Patients.findById(pId);
                triggerCriticalAlertForRelatives(pId, 38.8, 38.0,
                    `🚨 TEST ALARM: Siren & mobile alarm test for ${p ? p.name : 'patient'}. Sound and vibration verified!`);
            };
        }

        // Wire up manual sync button on empty state
        const syncCheckBtn = document.getElementById('btn-rel-sync-check');
        if (syncCheckBtn) {
            syncCheckBtn.onclick = async () => {
                showLoading('Checking hospital records…');
                try {
                    await DB.syncFromServer();
                    await renderRelativePatients();
                    hideLoading();
                    showToast('Patient link check completed!', 'info');
                } catch (err) {
                    hideLoading();
                    showToast('Could not sync with hospital server.', 'error');
                }
            };
        }

        // Check if any linked patient is currently critical or high fever
        checkActivePatientAlertsForRelative();
    }

    function checkActivePatientAlertsForRelative() {
        if (!relSession || relSession.role !== 'relative') return;
        const linked = DB.PatientRelatives.findByRelative(relSession.userId);
        for (const rel of linked) {
            const p = DB.Patients.findById(rel.patient_id);
            if (!p) continue;
            const tempVal = p.vitals_baseline?.tempC || 36.8;
            const critThresh = p.temp_threshold_critical || 38.0;
            if (p.status === 'Critical' || tempVal >= critThresh) {
                const msg = `URGENT: Patient ${p.name} (${p.patient_code}) is in CRITICAL condition with elevated temperature of ${tempVal.toFixed(1)} °C. Please contact the hospital care team immediately for guidance.`;
                triggerCriticalAlertForRelatives(p.id, tempVal, critThresh, msg);
                break;
            }
        }
    }

    function setupRelNav() {
        document.querySelectorAll('#rel-sidebar .nav-item').forEach(btn => {
            btn.addEventListener('click', function () {
                document.querySelectorAll('#rel-sidebar .nav-item').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                document.querySelectorAll('#rel-main .dashboard-panel').forEach(p => p.classList.remove('active'));
                document.getElementById(this.dataset.panel).classList.add('active');
                document.getElementById('rel-topbar-title').textContent = this.querySelector('span').textContent.trim();
                if (this.dataset.panel === 'rel-panel-notifications') {
                    DB.Notifications.markAllRead(relSession.userId);
                    updateRelNotifBadge();
                }
            });
        });
    }

    async function renderRelativePatients() {
        if (!relSession) return;
        const grid    = document.getElementById('rel-patient-grid');
        const noAccess= document.getElementById('rel-no-patients-state');
        const emailEl = document.getElementById('rel-empty-email');
        const chartCard = document.getElementById('rel-temp-chart-card');
        if (emailEl) emailEl.textContent = relSession.email;

        let patients = [];

        // 1. Authoritative check: fetch directly from BioCloud Cloud API
        try {
            const query = new URLSearchParams({
                userId: relSession.userId || '',
                email: relSession.email || ''
            });
            const res = await fetch(`/api/relatives/my-patients?${query.toString()}`);
            if (res.ok) {
                patients = await res.json();
            }
        } catch (e) {
            console.warn('[Relative] Server fetch error, falling back to local DB cache:', e);
        }

        // 2. Fallback: local client DB cache if offline
        if (!patients || patients.length === 0) {
            const rels = DB.PatientRelatives.findByRelative(relSession.userId);
            patients = rels
                .filter(r => DB.PatientRelatives.isAuthorized(r.patient_id, relSession.userId))
                .map(r => DB.Patients.findById(r.patient_id))
                .filter(Boolean);
        }

        if (!patients || patients.length === 0) {
            noAccess.style.display = 'block';
            grid.innerHTML = '';
            if (chartCard) chartCard.style.display = 'none';
            return;
        }
        noAccess.style.display = 'none';
        if (chartCard) chartCard.style.display = 'block';

        grid.innerHTML = patients.map(p => {
            const v = p.vitals_baseline || { bpm: '--', spo2: '--', tempC: 36.8, accelG: 1.0 };
            const tempVal = v.tempC || 36.8;
            const tempStatusClass = tempVal >= (p.temp_threshold_critical || 38.0) ? 'badge-critical' : tempVal >= (p.temp_threshold_warning || 37.5) ? 'badge-warning' : 'badge-stable';

            return `<div class="rel-patient-card status-${p.status}">
                <div class="patient-card-header">
                    <div>
                        <div class="patient-card-name">${p.name}</div>
                        <div class="patient-card-id">${p.patient_code}</div>
                        <div class="patient-card-meta">${p.age}y · ${p.ward} · ${p.bed}</div>
                    </div>
                    <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
                        <span class="badge badge-${(p.status || 'stable').toLowerCase()}">${p.status}</span>
                        <span class="threshold-badge-pill"><i class="fas fa-bell"></i> Alert &ge; ${p.temp_threshold_critical || 38.0} °C</span>
                    </div>
                </div>
                <div class="rel-vitals-grid">
                    <div class="rel-vital-chip temp">
                        <i class="fas fa-temperature-half"></i>
                        <div><span class="rel-vital-v" id="rel-temp-val-${p.id}">${typeof tempVal === 'number' ? tempVal.toFixed(1) : tempVal}</span> <span class="rel-vital-u">°C</span><br/><span class="rel-vital-l">Body Temp</span></div>
                    </div>
                    <div class="rel-vital-chip bpm">
                        <i class="fas fa-heart-pulse"></i>
                        <div><span class="rel-vital-v">${v.bpm}</span> <span class="rel-vital-u">BPM</span><br/><span class="rel-vital-l">Heart Rate</span></div>
                    </div>
                    <div class="rel-vital-chip spo2">
                        <i class="fas fa-lungs"></i>
                        <div><span class="rel-vital-v">${v.spo2}</span> <span class="rel-vital-u">%</span><br/><span class="rel-vital-l">SpO₂</span></div>
                    </div>
                    <div class="rel-vital-chip motion">
                        <i class="fas fa-person-walking"></i>
                        <div><span class="rel-vital-v">${v.accelG}</span> <span class="rel-vital-u">g</span><br/><span class="rel-vital-l">Motion</span></div>
                    </div>
                </div>
                <div class="patient-card-footer">
                    <small class="text-muted"><i class="fas fa-user-doctor"></i> ${p.assigned_doctor_name || 'Assigned Physician'}</small>
                    <small class="text-muted"><i class="fas fa-microchip"></i> ${p.last_reading?.deviceId || 'ESP32-DS18B20'}</small>
                </div>
                <div class="last-updated">Last reading: ${p.last_reading?.recordedAt ? new Date(p.last_reading.recordedAt).toLocaleTimeString('en-GB') : new Date().toLocaleTimeString('en-GB')} · Status: <strong style="color:var(--green)">${p.sensor_status || 'OK'}</strong></div>
            </div>`;
        }).join('');

        // Initialize Real-Time Temperature History Chart for the first authorized patient
        if (patients[0]) {
            initRelativeTempChart(patients[0].id);
        }
    }

    async function initRelativeTempChart(patientId) {
        const canvas = document.getElementById('rel-temp-chart');
        if (!canvas || !window.Chart) return;
        const ctx = canvas.getContext('2d');

        // Fetch history from server
        const history = await DB.getTelemetryHistory(patientId);
        let labels = history.map(h => new Date(h.recordedAt || h.receivedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        let temps = history.map(h => h.temperatureCelsius);

        if (labels.length === 0) {
            const p = DB.Patients.findById(patientId);
            const baseTemp = p?.vitals_baseline?.tempC || 36.8;
            for (let i = 5; i >= 0; i--) {
                const t = new Date(Date.now() - i * 15000);
                labels.push(t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
                temps.push(baseTemp);
            }
        }

        if (relTempChart) {
            relTempChart.destroy();
            relTempChart = null;
        }

        relTempChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Patient Body Temperature (°C)',
                    data: temps,
                    borderColor: '#00d4ff',
                    backgroundColor: 'rgba(0, 212, 255, 0.1)',
                    borderWidth: 2.5,
                    tension: 0.35,
                    fill: true,
                    pointBackgroundColor: '#00d4ff',
                    pointRadius: 3
                }, {
                    label: 'Critical Threshold (38.0 °C)',
                    data: labels.map(() => 38.0),
                    borderColor: 'rgba(255, 79, 79, 0.8)',
                    borderDash: [5, 5],
                    borderWidth: 1.5,
                    pointRadius: 0,
                    fill: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                scales: {
                    x: {
                        ticks: { color: '#8892b0', font: { size: 10 } },
                        grid: { color: 'rgba(255, 255, 255, 0.05)' }
                    },
                    y: {
                        min: 35.0,
                        max: 41.0,
                        ticks: { color: '#8892b0', font: { size: 11 }, callback: v => v + ' °C' },
                        grid: { color: 'rgba(255, 255, 255, 0.08)' }
                    }
                },
                plugins: {
                    legend: {
                        labels: { color: '#ccd6f6', font: { size: 11 } }
                    }
                }
            }
        });
    }

    function renderRelativeNotifications() {
        const notifs = DB.Notifications.forRelative(relSession.userId);
        const list   = document.getElementById('rel-notif-list');
        const empty  = document.getElementById('rel-notif-empty');
        if (!notifs.length) {
            list.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');
        list.innerHTML = notifs.map(n => {
            const icons = { critical: 'fa-triangle-exclamation', update: 'fa-circle-info', info: 'fa-bell' };
            return `<div class="notif-item ${n.read ? '' : 'unread'} ${n.type}" data-id="${n.id}">
                <i class="fas ${icons[n.type] || 'fa-bell'} notif-icon"></i>
                <div class="notif-body">
                    <div class="notif-title">${n.patient_name || 'Patient Update'}</div>
                    <div class="notif-msg">${n.message}</div>
                    <div class="notif-time">${new Date(n.created_at).toLocaleString('en-GB')}</div>
                </div>
                ${!n.read ? '<div class="unread-dot"></div>' : ''}
            </div>`;
        }).join('');

        list.querySelectorAll('.notif-item').forEach(item => {
            item.addEventListener('click', function () {
                DB.Notifications.markRead(this.dataset.id, relSession.userId);
                this.classList.remove('unread');
                this.querySelector('.unread-dot')?.remove();
                updateRelNotifBadge();
            });
        });
    }

    function updateRelNotifBadge() {
        if (!relSession) return;
        const count = DB.Notifications.unreadCount(relSession.userId);
        const badge = document.getElementById('rel-nav-notif-badge');
        if (!badge) return;
        if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
        else           { badge.classList.add('hidden'); }
    }

    document.getElementById('btn-rel-mark-all-read').addEventListener('click', () => {
        DB.Notifications.markAllRead(relSession.userId);
        renderRelativeNotifications();
        updateRelNotifBadge();
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  CRITICAL ALARM (sound + visual overlay for relatives)
    // ═════════════════════════════════════════════════════════════════════════
    let alarmContext = null;
    let alarmInterval = null;
    let alarmAudioEl = null;

    function initUserAudioGesture() {
        const unlock = () => {
            try {
                if (!alarmContext) alarmContext = new (window.AudioContext || window.webkitAudioContext)();
                if (alarmContext && alarmContext.state === 'suspended') {
                    alarmContext.resume().catch(() => {});
                }
                if (typeof SIREN_AUDIO_URI !== 'undefined' && !alarmAudioEl) {
                    alarmAudioEl = new Audio(SIREN_AUDIO_URI);
                    alarmAudioEl.loop = true;
                    alarmAudioEl.volume = 1.0;
                    // Pre-warm audio element on mobile user interaction
                    const p = alarmAudioEl.play();
                    if (p !== undefined) {
                        p.then(() => {
                            alarmAudioEl.pause();
                            alarmAudioEl.currentTime = 0;
                        }).catch(() => {});
                    }
                }
            } catch (_) {}
        };
        ['click', 'touchstart', 'touchend', 'pointerdown', 'keydown'].forEach(evt => {
            window.addEventListener(evt, unlock, { passive: true, once: false });
        });
    }
    initUserAudioGesture();

    // ═════════════════════════════════════════════════════════════════════════
    //  CRITICAL ALARM & MUTE ENGINE
    // ═════════════════════════════════════════════════════════════════════════
    let acknowledgedAlarms = {};
    let currentAlarmPatientId = 'p1';
    let currentAlarmTemp = 38.0;

    function isAlertMuted(patientId, temp) {
        const pId = patientId || currentAlarmPatientId || 'p1';
        let rec = acknowledgedAlarms[pId];
        if (!rec) {
            try {
                const stored = sessionStorage.getItem('muted_alarm_' + pId);
                if (stored) rec = JSON.parse(stored);
            } catch (_) {}
        }
        if (!rec || !rec.isMuted) return false;

        // If temperature spikes significantly (+0.6°C higher than muted temp), re-alarm
        const currentT = typeof temp === 'number' ? temp : parseFloat(temp) || 38.0;
        if (rec.temp && (currentT - rec.temp >= 0.6)) {
            clearMuteAlert(pId);
            return false;
        }
        return true;
    }

    function muteAlertForPatient(patientId, temp) {
        const pId = patientId || currentAlarmPatientId || 'p1';
        const t = typeof temp === 'number' ? temp : (currentAlarmTemp || 38.0);
        acknowledgedAlarms[pId] = {
            isMuted: true,
            temp: t,
            timestamp: Date.now()
        };
        try {
            sessionStorage.setItem('muted_alarm_' + pId, JSON.stringify(acknowledgedAlarms[pId]));
        } catch (_) {}
    }

    function clearMuteAlert(patientId) {
        if (patientId) {
            delete acknowledgedAlarms[patientId];
            try { sessionStorage.removeItem('muted_alarm_' + patientId); } catch (_) {}
        } else {
            acknowledgedAlarms = {};
            try {
                Object.keys(sessionStorage).forEach(k => {
                    if (k.startsWith('muted_alarm_')) sessionStorage.removeItem(k);
                });
            } catch (_) {}
        }
    }

    function stopAlarmSound() {
        if (alarmAudioEl) {
            try {
                alarmAudioEl.pause();
                alarmAudioEl.currentTime = 0;
            } catch (_) {}
        }
        if (alarmInterval) {
            clearInterval(alarmInterval);
            alarmInterval = null;
        }
        if (navigator.vibrate) {
            try { navigator.vibrate(0); } catch (_) {}
        }
    }

    function triggerCriticalAlertForRelatives(patientId, temp = 38.6, threshold = 38.0, customMsg = null) {
        // Only show if current session is relative
        const session = Security.Session.get();
        if (!session || session.role !== 'relative') return;

        // If alert was acknowledged and muted by user, do not ring or popup
        if (isAlertMuted(patientId, temp)) {
            return;
        }

        currentAlarmPatientId = patientId;
        currentAlarmTemp = typeof temp === 'number' ? temp : parseFloat(temp) || 38.0;

        const patient = DB.Patients.findById(patientId);
        const patientName = patient ? patient.name : 'John Doe';
        const patientCode = patient ? patient.patient_code : '#PT-89421';

        const labelEl = document.getElementById('alarm-patient-label');
        if (labelEl) labelEl.textContent = `${patientName} (${patientCode})`;

        const msgEl = document.getElementById('alarm-message-text');
        if (msgEl) {
            msgEl.textContent = customMsg ||
                `HIGH FEVER ALERT: Patient body temperature is ${typeof temp === 'number' ? temp.toFixed(1) : temp} °C (Threshold: ${threshold.toFixed(1)} °C). Please contact the hospital care team immediately for guidance.`;
        }

        const overlay = document.getElementById('critical-alarm-overlay');
        if (overlay) overlay.classList.remove('hidden');

        // Play continuous loud siren alarm across dual mobile channels (HTML5 Audio + Web Audio)
        playAlarmSound();

        // Vibrate mobile device if supported
        if (navigator.vibrate) {
            try { navigator.vibrate([800, 300, 800, 300, 800, 300, 1200]); } catch (_) {}
        }
    }

    function playAlarmSound() {
        try {
            // Channel 1: HTML5 Audio with embedded base64 siren (highly reliable on mobile browsers)
            if (typeof SIREN_AUDIO_URI !== 'undefined') {
                if (!alarmAudioEl) {
                    alarmAudioEl = new Audio(SIREN_AUDIO_URI);
                    alarmAudioEl.loop = true;
                    alarmAudioEl.volume = 1.0;
                }
                alarmAudioEl.currentTime = 0;
                const playPromise = alarmAudioEl.play();
                if (playPromise !== undefined) {
                    playPromise.catch(e => {
                        console.warn('[Alarm] HTML5 Audio autoplay paused by mobile browser:', e.message);
                    });
                }
            }

            // Channel 2: Web Audio API Oscillator
            if (!alarmContext) alarmContext = new (window.AudioContext || window.webkitAudioContext)();
            if (alarmContext.state === 'suspended') {
                alarmContext.resume().catch(() => {});
            }
            const ctx = alarmContext;

            function playSirenBurst() {
                if (!alarmContext) return;
                try {
                    if (alarmContext.state === 'suspended') {
                        alarmContext.resume().catch(() => {});
                    }
                    const now = ctx.currentTime;
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.type = 'sawtooth';
                    osc.frequency.setValueAtTime(880, now);
                    osc.frequency.exponentialRampToValueAtTime(580, now + 0.35);
                    gain.gain.setValueAtTime(0.5, now);
                    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
                    osc.start(now);
                    osc.stop(now + 0.35);
                } catch (_) {}
            }

            playSirenBurst();
            if (alarmInterval) clearInterval(alarmInterval);
            alarmInterval = setInterval(playSirenBurst, 500);

        } catch (e) {
            console.warn('[Alarm] Audio playback error:', e);
        }
    }

    // Acknowledge & Mute button listener for both Touch and Click
    const ackAlarmBtn = document.getElementById('btn-ack-alarm');
    if (ackAlarmBtn) {
        const executeAcknowledgeAndMute = async (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }

            // 1. Immediately silence audio and cancel mobile vibration
            stopAlarmSound();

            // 2. Hide overlay immediately
            const overlay = document.getElementById('critical-alarm-overlay');
            if (overlay) overlay.classList.add('hidden');

            // 3. Mark alert as muted locally
            const targetPatientId = currentAlarmPatientId || 'p1';
            muteAlertForPatient(targetPatientId, currentAlarmTemp);

            // 4. Notify backend server
            const session = Security.Session.get() || relSession;
            const uId = session ? (session.userId || session.email) : 'relative';

            try {
                await fetch('/api/alerts/acknowledge', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        patientId: targetPatientId,
                        userId: uId,
                        temperature: currentAlarmTemp
                    })
                });
            } catch (_) {}

            if (typeof DB !== 'undefined' && DB.ackAlert) {
                try { DB.ackAlert('alt-latest', uId); } catch (_) {}
            }

            showToast('Critical alert acknowledged and muted.', 'info');
        };

        ackAlarmBtn.addEventListener('click', executeAcknowledgeAndMute);
        ackAlarmBtn.addEventListener('touchend', executeAcknowledgeAndMute);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  HELPERS
    // ═════════════════════════════════════════════════════════════════════════
    function setFieldError(id, msg) {
        const el = document.getElementById(id);
        if (el) el.textContent = msg;
    }
    function clearFieldErrors(...ids) {
        ids.forEach(id => { const el = document.getElementById(id); if (el) el.textContent = ''; });
    }
    function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

    // Expose globals needed by inline onclick
    window.showLoading  = showLoading;
    window.hideLoading  = hideLoading;

    // ─────────────────────────────────────────────────────────────────────────
    //  START
    // ─────────────────────────────────────────────────────────────────────────
    route();
});

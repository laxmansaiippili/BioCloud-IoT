/* ==========================================================================
   BioCloud IoT — Security Engine (security.js)
   - SHA-256 + salt password hashing (Web Crypto API)
   - Session token management (UUID, 8-hour expiry, sessionStorage)
   - RBAC middleware
   - Rate limiter (5 attempts / 60s sliding window)
   - Email verification token generator
   ========================================================================== */

const Security = (() => {

    // ------------------------------------------------------------------ //
    //  CONSTANTS
    // ------------------------------------------------------------------ //
    const SESSION_KEY     = 'biocloud_session';
    const RATE_LIMIT_KEY  = 'biocloud_rate_limits';
    const SESSION_TTL_MS  = 8 * 60 * 60 * 1000;   // 8 hours
    const RATE_WINDOW_MS  = 60 * 1000;             // 60 seconds
    const RATE_MAX        = 5;                     // max 5 attempts per window

    // ------------------------------------------------------------------ //
    //  UTILITY
    // ------------------------------------------------------------------ //
    function uid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    function buf2hex(buffer) {
        return Array.from(new Uint8Array(buffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    // ------------------------------------------------------------------ //
    //  PASSWORD HASHING — SHA-256 + 16-byte random salt
    // ------------------------------------------------------------------ //
    async function hashPassword(password) {
        const salt = buf2hex(crypto.getRandomValues(new Uint8Array(16)));
        const msgBuffer = new TextEncoder().encode(salt + password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        return { hash: buf2hex(hashBuffer), salt };
    }

    async function verifyPassword(password, storedHash, storedSalt) {
        const msgBuffer = new TextEncoder().encode(storedSalt + password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        return buf2hex(hashBuffer) === storedHash;
    }

    // ------------------------------------------------------------------ //
    //  EMAIL VERIFICATION TOKEN — 6-digit code, 15-min expiry
    // ------------------------------------------------------------------ //
    function generateVerificationToken() {
        const token = String(Math.floor(100000 + Math.random() * 900000));
        const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min
        return { token, expires };
    }

    // ------------------------------------------------------------------ //
    //  PASSWORD RESET TOKEN — UUID, 1-hour expiry
    // ------------------------------------------------------------------ //
    function generateResetToken() {
        const token = uid();
        const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        return { token, expires };
    }

    // ------------------------------------------------------------------ //
    //  RATE LIMITER
    // ------------------------------------------------------------------ //
    const RateLimiter = {
        _read() {
            try { return JSON.parse(localStorage.getItem(RATE_LIMIT_KEY) || '{}'); } catch { return {}; }
        },
        _write(data) { localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(data)); },
        /**
         * Check if a key (e.g. email address) is allowed to proceed.
         * Returns { allowed: bool, remaining: number, resetIn: seconds }
         */
        check(key) {
            const now = Date.now();
            const data = this._read();
            if (!data[key]) data[key] = [];
            // Slide window: drop attempts outside the window
            data[key] = data[key].filter(ts => now - ts < RATE_WINDOW_MS);
            const remaining = RATE_MAX - data[key].length;
            const allowed = remaining > 0;
            this._write(data);
            return {
                allowed,
                remaining: Math.max(0, remaining),
                resetIn: data[key].length > 0
                    ? Math.ceil((data[key][0] + RATE_WINDOW_MS - now) / 1000)
                    : 0
            };
        },
        /**
         * Record an attempt for the given key.
         */
        record(key) {
            const data = this._read();
            const now = Date.now();
            if (!data[key]) data[key] = [];
            data[key] = data[key].filter(ts => now - ts < RATE_WINDOW_MS);
            data[key].push(now);
            this._write(data);
        },
        reset(key) {
            const data = this._read();
            delete data[key];
            this._write(data);
        }
    };

    // ------------------------------------------------------------------ //
    //  SESSION MANAGEMENT
    // ------------------------------------------------------------------ //
    const Session = {
        create(user) {
            const token = uid();
            const session = {
                token,
                userId: user.id,
                email: user.email,
                role: user.role,
                name: user.full_name,
                assignedPatientId: user.assigned_patient_id || null,
                createdAt: Date.now(),
                expiresAt: Date.now() + SESSION_TTL_MS
            };
            sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
            return session;
        },
        get() {
            try {
                const raw = sessionStorage.getItem(SESSION_KEY);
                if (!raw) return null;
                const session = JSON.parse(raw);
                if (Date.now() > session.expiresAt) {
                    this.destroy();
                    return null;
                }
                return session;
            } catch {
                return null;
            }
        },
        destroy() {
            sessionStorage.removeItem(SESSION_KEY);
        },
        isAuthenticated() {
            return this.get() !== null;
        },
        requireRole(...roles) {
            const s = this.get();
            if (!s) return { ok: false, error: 'NOT_AUTHENTICATED' };
            if (!roles.includes(s.role)) return { ok: false, error: 'FORBIDDEN', role: s.role };
            return { ok: true, session: s };
        }
    };

    // ------------------------------------------------------------------ //
    //  RBAC MIDDLEWARE — call before any privileged operation
    // ------------------------------------------------------------------ //
    const RBAC = {
        /**
         * Only admin can perform admin-only operations.
         */
        requireAdmin() {
            const check = Session.requireRole('admin');
            if (!check.ok) throw new Error(check.error === 'NOT_AUTHENTICATED' ? 'NOT_AUTHENTICATED' : 'FORBIDDEN_ADMIN_ONLY');
            return check.session;
        },
        /**
         * Admin or doctor can access clinical data.
         */
        requireClinical() {
            const check = Session.requireRole('admin', 'doctor');
            if (!check.ok) throw new Error(check.error === 'NOT_AUTHENTICATED' ? 'NOT_AUTHENTICATED' : 'FORBIDDEN');
            return check.session;
        },
        /**
         * Any authenticated user.
         */
        requireAuth() {
            const check = Session.requireRole('admin', 'doctor', 'relative');
            if (!check.ok) throw new Error('NOT_AUTHENTICATED');
            return check.session;
        },
        /**
         * Object-level authorization: verify that the current relative is linked to this patient.
         */
        requireRelativePatientAccess(patientId) {
            const check = Session.requireRole('relative');
            if (!check.ok) throw new Error('FORBIDDEN');
            const isLinked = DB.PatientRelatives.isAuthorized(patientId, check.session.userId);
            if (!isLinked) throw new Error('FORBIDDEN_OBJECT_LEVEL');
            return check.session;
        }
    };

    // ------------------------------------------------------------------ //
    //  INPUT VALIDATION / SANITISATION
    // ------------------------------------------------------------------ //
    const Validate = {
        email(val) {
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((val || '').trim());
        },
        password(val) {
            // Min 8 chars, at least: 1 uppercase, 1 lowercase, 1 digit, 1 special char
            return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^()\-_+=])[A-Za-z\d@$!%*?&#^()\-_+=]{8,}$/.test(val || '');
        },
        name(val) {
            return (val || '').trim().length >= 2 && (val || '').trim().length <= 100;
        },
        phone(val) {
            return !val || /^[+\d\s\-().]{7,20}$/.test(val);
        },
        /**
         * Basic XSS sanitisation — strip HTML tags.
         */
        sanitize(val) {
            if (typeof val !== 'string') return val;
            return val.replace(/<[^>]*>/g, '').trim();
        }
    };

    // ------------------------------------------------------------------ //
    //  PUBLIC API
    // ================================================================== //
    return {
        hashPassword,
        verifyPassword,
        generateVerificationToken,
        generateResetToken,
        RateLimiter,
        Session,
        RBAC,
        Validate
    };

})();

if (typeof window !== 'undefined') {
    window.Security = Security;
}

const express = require('express');
const router = express.Router();
const { admin, db, adminAuth } = require('../lib/firebase');

/**
 * Premium "Garage Staff" endpoints: employee accounts and job-card push
 * notifications. Employee accounts are regular Firebase Auth users carrying
 * the custom claims { role: 'employee', garageId } — firestore.rules uses
 * those claims to scope an employee to the job cards assigned to them.
 */

// Same expiry rule the app uses (GarageUser.isSubscriptionActive).
function isSubscriptionActive(subscription) {
    if (!subscription || subscription.status !== 'active') return false;
    const expiry = subscription.expiryDate;
    if (!expiry) return false;
    const expiryDate = typeof expiry.toDate === 'function' ? expiry.toDate() : new Date(expiry);
    return expiryDate > new Date();
}

/** Verifies the Firebase ID token and attaches it as req.caller. */
async function requireUser(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!idToken) {
        return res.status(401).json({ error: 'Missing Authorization header.' });
    }

    try {
        req.caller = await adminAuth.verifyIdToken(idToken);
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token.' });
    }
}

/** Caller must be a garage owner with an active subscription. */
async function requirePremiumOwner(req, res, next) {
    if (req.caller.role === 'employee' || req.caller.role === 'admin') {
        return res.status(403).json({ error: 'Only garage owners can manage staff.' });
    }

    try {
        const garageSnap = await db.collection('garages').doc(req.caller.uid).get();
        if (!garageSnap.exists) {
            return res.status(403).json({ error: 'Garage not found for this account.' });
        }
        if (!isSubscriptionActive(garageSnap.data().subscription)) {
            return res.status(402).json({ error: 'This feature is available for premium subscribers only.' });
        }

        req.garage = { id: garageSnap.id, ...garageSnap.data() };
        next();
    } catch (err) {
        console.error('[staff/requirePremiumOwner]', err);
        return res.status(500).json({ error: 'Failed to verify subscription.' });
    }
}

function employeeRef(garageId, employeeId) {
    return db.collection('garages').doc(garageId).collection('employees').doc(employeeId);
}

/** Sends one push + writes it to the garage's in-app inbox (owner only). */
async function sendPush({ token, title, body, data }) {
    if (!token) return false;
    try {
        await admin.messaging().send({
            token,
            notification: { title, body },
            data: { click_action: 'FLUTTER_NOTIFICATION_CLICK', ...data },
            android: { notification: { sound: 'default', clickAction: 'FLUTTER_NOTIFICATION_CLICK' } },
            apns: { payload: { aps: { sound: 'default' } } },
        });
        return true;
    } catch (err) {
        console.warn('[staff] FCM send failed:', err.code || err.message);
        return false;
    }
}

const INBOX_TTL_MS = 24 * 24 * 60 * 60 * 1000; // matches AppNotification (24 days)

/**
 * POST /api/staff/employees
 * Body: { name, email, phone, password }
 * Creates an employee login for the calling (premium) garage owner.
 */
router.post('/employees', requireUser, requirePremiumOwner, async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        const email = (req.body.email || '').trim().toLowerCase();
        const phone = (req.body.phone || '').trim();
        const password = req.body.password || '';

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'name, email and password are required.' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        }

        let userRecord;
        try {
            userRecord = await adminAuth.createUser({
                email,
                password,
                displayName: name,
                emailVerified: true,
            });
        } catch (err) {
            if (err.code === 'auth/email-already-exists') {
                return res.status(409).json({ error: 'An account with this email already exists.' });
            }
            if (err.code === 'auth/invalid-email') {
                return res.status(400).json({ error: 'Invalid email address.' });
            }
            throw err;
        }

        const garageId = req.garage.id;
        await adminAuth.setCustomUserClaims(userRecord.uid, { role: 'employee', garageId });

        const employee = {
            id: userRecord.uid,
            garageId,
            garageName: req.garage.garageName || '',
            currency: req.garage.currency || 'INR',
            name,
            email,
            phone,
            isActive: true,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await employeeRef(garageId, userRecord.uid).set(employee);

        console.log(`[staff] employee created uid=${userRecord.uid} garage=${garageId}`);
        return res.json({ success: true, employee: { ...employee, createdAt: new Date().toISOString() } });
    } catch (err) {
        console.error('[staff/create]', err);
        return res.status(500).json({ error: err.message || 'Failed to create employee.' });
    }
});

/**
 * POST /api/staff/employees/:employeeId/remove
 * Deletes the employee's login. Their job cards stay so the owner can
 * reassign them.
 */
router.post('/employees/:employeeId/remove', requireUser, async (req, res) => {
    try {
        const { employeeId } = req.params;
        const garageId = req.caller.uid;
        const ref = employeeRef(garageId, employeeId);
        const snap = await ref.get();
        if (!snap.exists) {
            return res.status(404).json({ error: 'Employee not found.' });
        }

        try {
            await adminAuth.deleteUser(employeeId);
        } catch (err) {
            if (err.code !== 'auth/user-not-found') throw err;
        }
        await ref.delete();

        console.log(`[staff] employee removed uid=${employeeId} garage=${garageId}`);
        return res.json({ success: true });
    } catch (err) {
        console.error('[staff/remove]', err);
        return res.status(500).json({ error: err.message || 'Failed to remove employee.' });
    }
});

/**
 * POST /api/staff/employees/:employeeId/reset-password
 * Body: { password }
 */
router.post('/employees/:employeeId/reset-password', requireUser, requirePremiumOwner, async (req, res) => {
    try {
        const { employeeId } = req.params;
        const password = req.body.password || '';
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        }

        const snap = await employeeRef(req.garage.id, employeeId).get();
        if (!snap.exists) {
            return res.status(404).json({ error: 'Employee not found.' });
        }

        await adminAuth.updateUser(employeeId, { password });
        await adminAuth.revokeRefreshTokens(employeeId);
        return res.json({ success: true });
    } catch (err) {
        console.error('[staff/reset-password]', err);
        return res.status(500).json({ error: err.message || 'Failed to reset password.' });
    }
});

/**
 * POST /api/staff/jobs/:jobId/notify
 * Body: { event }   event = "completed" | "assigned"
 *
 * "completed": called by the assigned employee after marking the job done —
 *   pushes to the owner and adds an entry to the owner's in-app inbox.
 * "assigned":  called by the owner after creating / reassigning a job —
 *   pushes to the assigned employee.
 */
router.post('/jobs/:jobId/notify', requireUser, async (req, res) => {
    try {
        const { jobId } = req.params;
        const { event } = req.body;
        const isEmployee = req.caller.role === 'employee';
        const garageId = isEmployee ? req.caller.garageId : req.caller.uid;

        if (!garageId) {
            return res.status(403).json({ error: 'No garage associated with this account.' });
        }

        const garageRef = db.collection('garages').doc(garageId);
        const jobSnap = await garageRef.collection('jobCards').doc(jobId).get();
        if (!jobSnap.exists) {
            return res.status(404).json({ error: 'Job card not found.' });
        }
        const job = jobSnap.data();
        const jobLabel = job.jobNumber || jobId.substring(0, 6).toUpperCase();
        const vehicle = [job.vehicleModel, job.registrationNumber].filter(Boolean).join(' • ');

        if (event === 'completed') {
            if (!isEmployee || job.assignedEmployeeId !== req.caller.uid) {
                return res.status(403).json({ error: 'Only the assigned employee can report completion.' });
            }
            if (job.status !== 'completed') {
                return res.status(400).json({ error: 'Job card is not marked as completed.' });
            }

            const title = `Job ${jobLabel} completed`;
            const body = `${job.assignedEmployeeName || 'Your employee'} finished ${vehicle || 'the job'}. Tap to generate the invoice.`;

            const now = Date.now();
            await garageRef.collection('notifications').add({
                title,
                body,
                type: 'job_completed',
                jobId,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                expireAt: admin.firestore.Timestamp.fromMillis(now + INBOX_TTL_MS),
            });

            const garageSnap = await garageRef.get();
            const pushed = await sendPush({
                token: garageSnap.data()?.fcmToken,
                title,
                body,
                data: { type: 'job_completed', jobId },
            });
            return res.json({ success: true, pushed });
        }

        if (event === 'assigned') {
            if (isEmployee) {
                return res.status(403).json({ error: 'Only the garage owner can assign jobs.' });
            }
            if (!job.assignedEmployeeId) {
                return res.status(400).json({ error: 'Job card has no assigned employee.' });
            }

            const empSnap = await employeeRef(garageId, job.assignedEmployeeId).get();
            const pushed = await sendPush({
                token: empSnap.data()?.fcmToken,
                title: `New job ${jobLabel} assigned`,
                body: `${vehicle || 'A vehicle'}${job.complaint ? ` — ${job.complaint}` : ''}`,
                data: { type: 'job_assigned', jobId },
            });
            return res.json({ success: true, pushed });
        }

        return res.status(400).json({ error: 'event must be "completed" or "assigned".' });
    } catch (err) {
        console.error('[staff/notify]', err);
        return res.status(500).json({ error: err.message || 'Failed to send notification.' });
    }
});

module.exports = router;

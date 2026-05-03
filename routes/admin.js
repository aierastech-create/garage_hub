const express = require('express');
const router = express.Router();
const { adminAuth } = require('../lib/firebase');

/**
 * Middleware: verify the request carries a valid Firebase ID token
 * with role === 'admin'. Only existing admins can promote other users.
 */
async function requireAdminToken(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!idToken) {
        return res.status(401).json({ error: 'Missing Authorization header.' });
    }

    try {
        const decoded = await adminAuth.verifyIdToken(idToken);
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden: caller is not an admin.' });
        }
        req.caller = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token.' });
    }
}

/**
 * POST /api/admin/set-claim
 * Body: { uid, role }   role = "admin" | "user"
 *
 * Sets a custom claim on a Firebase user. Must be called by an existing admin.
 * Example: curl -X POST /api/admin/set-claim \
 *   -H "Authorization: Bearer <admin-id-token>" \
 *   -H "Content-Type: application/json" \
 *   -d '{ "uid": "<target-uid>", "role": "admin" }'
 */
router.post('/set-claim', requireAdminToken, async (req, res) => {
    try {
        const { uid, role } = req.body;

        if (!uid || !role) {
            return res.status(400).json({ error: 'uid and role are required.' });
        }

        const allowedRoles = ['admin', 'user'];
        if (!allowedRoles.includes(role)) {
            return res.status(400).json({ error: `role must be one of: ${allowedRoles.join(', ')}` });
        }

        await adminAuth.setCustomUserClaims(uid, { role });

        console.log(`[set-claim] uid=${uid} role=${role} set by ${req.caller.uid}`);

        return res.json({
            success: true,
            message: `Custom claim role="${role}" set for uid="${uid}". User must re-login for changes to take effect.`,
        });
    } catch (err) {
        console.error('[set-claim]', err);
        return res.status(500).json({ error: err.message || 'Failed to set custom claim.' });
    }
});

/**
 * POST /api/admin/set-claim-direct
 * Body: { uid, role, secret }
 *
 * One-time bootstrap endpoint (no caller auth required) — protected by a
 * shared secret in env. Use ONLY to promote the very FIRST admin account.
 * Set ADMIN_BOOTSTRAP_SECRET in .env, then disable this route afterwards.
 */
router.post('/set-claim-direct', async (req, res) => {
    try {
        const { uid, role, secret } = req.body;

        const bootstrapSecret = process.env.ADMIN_BOOTSTRAP_SECRET;
        if (!bootstrapSecret) {
            return res.status(404).json({ error: 'Bootstrap endpoint is disabled.' });
        }

        if (secret !== bootstrapSecret) {
            return res.status(403).json({ error: 'Invalid secret.' });
        }

        if (!uid || !role) {
            return res.status(400).json({ error: 'uid and role are required.' });
        }

        await adminAuth.setCustomUserClaims(uid, { role });

        console.log(`[set-claim-direct] uid=${uid} role=${role} via bootstrap`);

        return res.json({
            success: true,
            message: `role="${role}" set for uid="${uid}". Remove ADMIN_BOOTSTRAP_SECRET from .env now.`,
        });
    } catch (err) {
        console.error('[set-claim-direct]', err);
        return res.status(500).json({ error: err.message || 'Failed.' });
    }
});

/**
 * GET /api/admin/user/:uid
 * Returns the custom claims for a Firebase user. Admin-only.
 */
router.get('/user/:uid', requireAdminToken, async (req, res) => {
    try {
        const { uid } = req.params;
        const userRecord = await adminAuth.getUser(uid);
        return res.json({
            uid: userRecord.uid,
            email: userRecord.email,
            displayName: userRecord.displayName,
            customClaims: userRecord.customClaims || {},
        });
    } catch (err) {
        console.error('[get-user]', err);
        return res.status(500).json({ error: err.message || 'Failed to fetch user.' });
    }
});

module.exports = router;

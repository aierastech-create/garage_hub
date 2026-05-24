const express = require('express');
const router = express.Router();
const { admin, db, adminAuth } = require('../lib/firebase');

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

/**
 * Helper: check if subscription is currently active or in grace period
 */
function isSubscriptionActive(subscription) {
    if (!subscription) return false;

    const status = subscription.status;
    if (status !== 'active' && status !== 'grace_period') {
        return false;
    }

    if (subscription.expiryDate) {
        let expiryDate;
        if (subscription.expiryDate.toDate) {
            expiryDate = subscription.expiryDate.toDate();
        } else {
            expiryDate = new Date(subscription.expiryDate);
        }

        if (expiryDate < new Date()) {
            return false; // Expired
        }
    }

    return true; // Active
}

/**
 * GET /api/admin/inactive-plan-users
 * Returns a list of garages whose subscriptions are not active.
 */
router.get('/inactive-plan-users', requireAdminToken, async (req, res) => {
    try {
        const snap = await db.collection('garages').get();
        const inactiveGarages = [];

        snap.forEach((doc) => {
            const data = doc.data();
            const subscription = data.subscription;
            
            if (!isSubscriptionActive(subscription)) {
                inactiveGarages.push({
                    id: doc.id,
                    garageName: data.garageName || 'Unnamed Garage',
                    ownerName: data.ownerName || '—',
                    email: data.email || '—',
                    phone: data.phone || '—',
                    hasFcmToken: !!data.fcmToken,
                    fcmToken: data.fcmToken || null,
                    subscription: subscription ? {
                        status: subscription.status || 'inactive',
                        planName: subscription.planName || 'N/A',
                        expiryDate: subscription.expiryDate
                            ? (subscription.expiryDate.toDate ? subscription.expiryDate.toDate().toISOString() : new Date(subscription.expiryDate).toISOString())
                            : null
                    } : null
                });
            }
        });

        return res.json({
            success: true,
            count: inactiveGarages.length,
            garages: inactiveGarages
        });
    } catch (err) {
        console.error('[get-inactive-plan-users]', err);
        return res.status(500).json({ error: err.message || 'Failed to fetch inactive users.' });
    }
});

/**
 * POST /api/admin/send-push-inactive-plans
 * Body: { title, body }
 * Sends a push notification to all garages with inactive subscriptions and registered FCM tokens.
 */
router.post('/send-push-inactive-plans', requireAdminToken, async (req, res) => {
    try {
        const { title, body } = req.body;

        if (!title || !body) {
            return res.status(400).json({ error: 'title and body are required.' });
        }

        const snap = await db.collection('garages').get();
        const fcmTokens = [];
        const tokenToGarageId = {};
        const targetedGarages = [];

        snap.forEach((doc) => {
            const data = doc.data();
            const subscription = data.subscription;
            
            if (!isSubscriptionActive(subscription)) {
                if (data.fcmToken) {
                    fcmTokens.push(data.fcmToken);
                    tokenToGarageId[data.fcmToken] = doc.id;
                    targetedGarages.push({
                        id: doc.id,
                        garageName: data.garageName || 'Unnamed Garage'
                    });
                }
            }
        });

        if (fcmTokens.length === 0) {
            return res.json({
                success: true,
                message: 'No inactive plan users have registered FCM tokens. No notifications were sent.',
                successCount: 0,
                failureCount: 0
            });
        }

        // Chunk tokens into arrays of 500 (FCM multicast size limit)
        const chunkArray = (arr, size) => {
            const chunks = [];
            for (let i = 0; i < arr.length; i += size) {
                chunks.push(arr.slice(i, i + size));
            }
            return chunks;
        };

        const tokenChunks = chunkArray(fcmTokens, 500);
        let successCount = 0;
        let failureCount = 0;

        for (const chunk of tokenChunks) {
            const response = await admin.messaging().sendEachForMulticast({
                tokens: chunk,
                notification: {
                    title,
                    body,
                },
                data: {
                    click_action: 'FLUTTER_NOTIFICATION_CLICK',
                    type: 'inactive_plan_reminder'
                },
                android: {
                    notification: {
                        sound: 'default',
                        clickAction: 'FLUTTER_NOTIFICATION_CLICK'
                    }
                },
                apns: {
                    payload: {
                        aps: {
                            sound: 'default'
                        }
                    }
                }
            });

            successCount += response.successCount;
            failureCount += response.failureCount;

            if (response.failureCount > 0) {
                const batch = db.batch();
                let hasUpdates = false;

                response.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        const token = chunk[idx];
                        const garageId = tokenToGarageId[token];
                        console.warn(`[send-push-inactive-plans] FCM failure for token ${token}:`, resp.error);

                        const errorCode = resp.error?.code;
                        if (
                            errorCode === 'messaging/registration-token-not-registered' ||
                            errorCode === 'messaging/invalid-argument'
                        ) {
                            if (garageId) {
                                console.log(`[send-push-inactive-plans] Queueing removal of invalid/unregistered FCM token for garage: ${garageId}`);
                                const docRef = db.collection('garages').doc(garageId);
                                batch.update(docRef, { fcmToken: admin.firestore.FieldValue.delete() });
                                hasUpdates = true;
                            }
                        }
                    }
                });

                if (hasUpdates) {
                    await batch.commit();
                    console.log('[send-push-inactive-plans] Stale/invalid FCM tokens successfully removed from Firestore');
                }
            }
        }

        console.log(`[send-push-inactive-plans] Multicast sent. success=${successCount} failure=${failureCount} by admin=${req.caller.uid}`);

        return res.json({
            success: true,
            message: `Push notification dispatched. Success: ${successCount}, Failures: ${failureCount}`,
            successCount,
            failureCount,
            targetedCount: targetedGarages.length
        });

    } catch (err) {
        console.error('[send-push-inactive-plans]', err);
        return res.status(500).json({ error: err.message || 'Failed to dispatch push notifications.' });
    }
});

module.exports = router;

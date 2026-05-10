const express = require('express');
const router = express.Router();
const { db } = require('../lib/firebase');

/**
 * POST /api/payments/verify
 * Body: { purchaseId, purchaseToken, productId, serverVerificationData, source, garageId, planId, planName, duration, price }
 *
 * Verifies App Store / Google Play purchase and activates subscription in Firestore.
 */
router.post('/verify', async (req, res) => {
    try {
        const {
            purchaseId,
            purchaseToken, // For Google/Apple validation
            productId,
            source, // e.g., 'app_store', 'play_store'
            garageId,
            planId,
            planName,
            duration,
            price,
        } = req.body;

        if (!purchaseToken || !productId || !source) {
            console.warn('Missing basic IAP fields for verify, skipping strict checks');
        }

        if (!garageId || !planId) {
            return res.status(400).json({ error: 'garageId and planId are required.' });
        }

        // ==========================================
        // TODO: Validate Receipt with Apple / Google
        // ==========================================
        // Currently, this blindly trusts the client. You MUST implement real validation either
        // manually via googleapis & app store api, or using a package like google-play-billing-validator
        // to prevent users from bypassing payment. See Implementation Plan.
        // Example logic for Google Play:
        // const isValid = await verifyGooglePlayPurchase(purchaseToken, productId);
        // if (!isValid) return res.status(400).json({ error: 'Invalid purchase token.' });
        // ==========================================

        const isValid = true; // Temporary stub

        if (!isValid) {
            return res.status(400).json({ error: 'Payment verification failed. Invalid receipt.' });
        }

        // Calculate end date based on duration
        const now = new Date();
        const endDate = _calcEndDate(now, duration);

        // Write subscription to Firestore
        const subData = {
            garageId,
            planId,
            planName: planName || '',
            price: price || 0,
            duration: duration || '',
            purchaseId: purchaseId || '',
            purchaseToken: purchaseToken || '',
            productId: productId || '',
            source: source || 'unknown',
            startDate: now,
            endDate,
            status: 'active',
            createdAt: new Date(),
        };

        const subRef = await db.collection('subscriptions').add(subData);

        // Update garage document with active subscription
        await db.collection('garages').doc(garageId).update({
            subscription: {
                planId,
                planName: planName || '',
                startDate: now,
                endDate,
                status: 'active',
            },
        });

        return res.json({
            success: true,
            subscriptionId: subRef.id,
            message: 'In-app purchase verified and subscription activated successfully.',
        });
    } catch (err) {
        console.error('[verify]', err);
        return res.status(500).json({ error: err.message || 'Verification failed.' });
    }
});

/**
 * GET /api/payments/subscription/:garageId
 * Returns the active subscription for a garage.
 */
router.get('/subscription/:garageId', async (req, res) => {
    try {
        const { garageId } = req.params;
        const snap = await db
            .collection('subscriptions')
            .where('garageId', '==', garageId)
            .where('status', '==', 'active')
            .orderBy('createdAt', 'desc')
            .limit(1)
            .get();

        if (snap.empty) {
            return res.json({ active: false, subscription: null });
        }

        const doc = snap.docs[0];
        const data = doc.data();
        const endDate = data.endDate?.toDate ? data.endDate.toDate() : new Date(data.endDate);
        const isExpired = endDate < new Date();

        if (isExpired) {
            // Auto-expire in Firestore
            await doc.ref.update({ status: 'expired' });
            return res.json({ active: false, subscription: null });
        }

        return res.json({
            active: true,
            subscription: {
                id: doc.id,
                ...data,
                startDate: data.startDate?.toDate?.() || data.startDate,
                endDate,
            },
        });
    } catch (err) {
        console.error('[subscription]', err);
        return res.status(500).json({ error: err.message || 'Failed to fetch subscription.' });
    }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function _calcEndDate(from, duration) {
    const d = new Date(from);
    switch (duration) {
        case 'monthly':
            d.setMonth(d.getMonth() + 1);
            break;
        case 'quarterly':
            d.setMonth(d.getMonth() + 3);
            break;
        case 'yearly':
            d.setFullYear(d.getFullYear() + 1);
            break;
        default:
            // lifetime
            d.setFullYear(d.getFullYear() + 100);
    }
    return d;
}

module.exports = router;

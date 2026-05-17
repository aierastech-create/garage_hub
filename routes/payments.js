'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../lib/firebase');
const {
    verifySubscriptionPurchase,
    acknowledgeSubscriptionPurchase,
} = require('../lib/googlePlay').default;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/verify
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Body: {
 *   purchaseId, purchaseToken, productId, serverVerificationData,
 *   source, garageId, planId, planName, price
 * }
 *
 * Verifies a Google Play subscription (subscriptionsv2) and activates it.
 * basePlanId and expiryDate are extracted directly from Google's response.
 */
router.post('/verify', async (req, res) => {
    try {
        const {
            purchaseId,
            purchaseToken,
            productId,
            source,
            garageId,
            planId,
            planName,
            price,
        } = req.body;

        // ── Basic input validation ────────────────────────────────────────────
        if (!garageId) {
            return res.status(400).json({ error: 'garageId is required.' });
        }
        if (!purchaseToken) {
            return res.status(400).json({ error: 'purchaseToken is required.' });
        }

        // ── Google Play verification (subscriptionsv2) ────────────────────────
        let googleData = null;
        if (source === 'play_store') {
            // verifySubscriptionPurchase now only needs the token.
            // It returns { subscriptionId, basePlanId, expiryDate, active, autoRenew, acknowledgementState }
            googleData = await verifySubscriptionPurchase(purchaseToken);
            // Throws if the token is invalid, inactive, or expired.
        }

        // ── Resolve subscription metadata ─────────────────────────────────────
        // For play_store, trust Google's data. For other sources, use what was sent.
        const subscriptionId = googleData?.subscriptionId || productId || '';
        const basePlanId = googleData?.basePlanId || '';
        const expiryDate = googleData?.expiryDate
            ? new Date(googleData.expiryDate)
            : null;
        const autoRenew = googleData?.autoRenew ?? false;
        const subscriptionState = googleData?.subscriptionState || '';
        const acknowledgementState = googleData?.acknowledgementState || '';

        // ── Persist subscription ──────────────────────────────────────────────
        const now = new Date();

        const subData = {
            garageId,
            planId: planId || subscriptionId,
            planName: planName || '',
            price: price || 0,
            subscriptionId,
            basePlanId,
            purchaseId: purchaseId || '',
            purchaseToken: purchaseToken || '',
            productId: productId || subscriptionId,
            source: source || 'unknown',
            startDate: now,
            expiryDate,
            autoRenew,
            subscriptionState,
            acknowledgementState,
            status: 'active',
            createdAt: now,
        };

        const subRef = await db.collection('subscriptions').add(subData);

        // Update the garage's embedded subscription summary
        await db.collection('garages').doc(garageId).update({
            subscription: {
                planId: planId || subscriptionId,
                planName: planName || '',
                subscriptionId,
                basePlanId,
                startDate: now,
                expiryDate,
                autoRenew,
                status: 'active',
            },
        });

        // ── Acknowledge so Google doesn't auto-refund after 3 days ───────────
        if (source === 'play_store') {
            if (acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') {
                await acknowledgeSubscriptionPurchase(purchaseToken);
            }
        }

        return res.json({
            success: true,
            subscriptionId: subRef.id,
            basePlanId,
            expiryDate: expiryDate?.toISOString() || null,
            message: 'Subscription verified and activated successfully.',
        });
    } catch (err) {
        console.error('[verify]', err);
        const msg =
            err.message?.includes('invalid') || err.message?.includes('expired') ||
                err.message?.includes('not active') || err.message?.includes('No subscription')
                ? err.message
                : err.message || 'Verification failed.';
        return res.status(400).json({ error: msg });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/subscription/:garageId
// ─────────────────────────────────────────────────────────────────────────────
/**
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

        // Resolve expiryDate from either the new field or the legacy endDate
        const expiryRaw = data.expiryDate ?? data.endDate;
        const expiryDate = expiryRaw?.toDate ? expiryRaw.toDate() : new Date(expiryRaw);
        const isExpired = expiryDate < new Date();

        if (isExpired) {
            await doc.ref.update({ status: 'expired' });
            return res.json({ active: false, subscription: null });
        }

        return res.json({
            active: true,
            subscription: {
                id: doc.id,
                ...data,
                startDate: data.startDate?.toDate?.() || data.startDate,
                expiryDate,
                // expose basePlanId so the app knows monthly vs yearly
                basePlanId: data.basePlanId || '',
                subscriptionId: data.subscriptionId || '',
                autoRenew: data.autoRenew ?? false,
            },
        });
    } catch (err) {
        console.error('[subscription]', err);
        return res.status(500).json({ error: err.message || 'Failed to fetch subscription.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/rtdn-webhook
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Receives Real-Time Developer Notifications (RTDN) from Google Pub/Sub.
 *
 * Set up:
 *  1. Create a Pub/Sub topic in Google Cloud Console.
 *  2. In Play Console → Monetization → Real-Time Dev Notifications, set the topic.
 *  3. Create a push subscription pointing to:
 *     https://<your-backend-domain>/api/payments/rtdn-webhook
 *
 * Ref: https://developer.android.com/google/play/billing/rtdn-reference
 */
router.post('/rtdn-webhook', async (req, res) => {
    // Always respond 200 first; Pub/Sub re-delivers on non-2xx.
    res.sendStatus(200);

    try {
        const body = req.body;

        // Pub/Sub wraps the payload in { message: { data: '<base64>' } }
        const b64 = body?.message?.data;
        if (!b64) {
            console.warn('[rtdn-webhook] No message.data in payload');
            return;
        }

        let notification;
        try {
            const json = Buffer.from(b64, 'base64').toString('utf8');
            notification = JSON.parse(json);
        } catch {
            console.warn('[rtdn-webhook] Failed to decode Pub/Sub message');
            return;
        }

        const subNotification = notification?.subscriptionNotification;
        if (!subNotification) {
            // Could be a test notification or other type – ignore silently
            return;
        }

        const { notificationType, purchaseToken } = subNotification;

        console.log(`[rtdn-webhook] type=${notificationType}`);

        // Notification type reference:
        // 1  SUBSCRIPTION_RECOVERED        – recovered from account hold
        // 2  SUBSCRIPTION_RENEWED          – renewed
        // 3  SUBSCRIPTION_CANCELED         – voluntarily canceled
        // 4  SUBSCRIPTION_PURCHASED        – new purchase (handled via /verify)
        // 5  SUBSCRIPTION_ON_HOLD          – entered account hold
        // 6  SUBSCRIPTION_IN_GRACE_PERIOD  – in grace period
        // 7  SUBSCRIPTION_RESTARTED        – restarted from canceled state
        // 12 SUBSCRIPTION_EXPIRED          – fully expired
        // 13 SUBSCRIPTION_REVOKED          – revoked immediately

        switch (notificationType) {
            case 1: // RECOVERED
            case 2: // RENEWED
            case 7: // RESTARTED
                await _handleRenewal(purchaseToken);
                break;

            case 3:  // CANCELED
            case 5:  // ON_HOLD
            case 6:  // GRACE_PERIOD (still usable – mark as grace_period)
            case 12: // EXPIRED
            case 13: // REVOKED
                await _handleCancellation(purchaseToken, notificationType);
                break;

            default:
                console.log(`[rtdn-webhook] Unhandled notificationType: ${notificationType}`);
        }
    } catch (err) {
        console.error('[rtdn-webhook] Error processing notification:', err);
    }
});

// ── RTDN helpers ─────────────────────────────────────────────────────────────

/**
 * Re-verify with Google Play (subscriptionsv2) and extend the subscription
 * expiryDate in Firestore.
 */
async function _handleRenewal(purchaseToken) {
    let googleData;
    try {
        googleData = await verifySubscriptionPurchase(purchaseToken);
    } catch (err) {
        console.warn('[rtdn-webhook] Renewal verification failed:', err.message);
        return;
    }

    const newExpiryDate = googleData.expiryDate ? new Date(googleData.expiryDate) : null;

    // Find matching subscription document(s) by purchaseToken
    const snap = await db
        .collection('subscriptions')
        .where('purchaseToken', '==', purchaseToken)
        .get();

    if (snap.empty) {
        console.warn('[rtdn-webhook] No Firestore subscription found for token (renewal)');
        return;
    }

    const batch = db.batch();
    snap.docs.forEach((doc) => {
        batch.update(doc.ref, {
            status: 'active',
            basePlanId: googleData.basePlanId || doc.data().basePlanId || '',
            autoRenew: googleData.autoRenew ?? true,
            subscriptionState: googleData.subscriptionState || '',
            ...(newExpiryDate ? { expiryDate: newExpiryDate } : {}),
            updatedAt: new Date(),
        });

        // Update the parent garage doc too
        const garageId = doc.data().garageId;
        if (garageId) {
            batch.update(db.collection('garages').doc(garageId), {
                'subscription.status': 'active',
                'subscription.autoRenew': googleData.autoRenew ?? true,
                ...(newExpiryDate ? { 'subscription.expiryDate': newExpiryDate } : {}),
            });
        }
    });
    await batch.commit();
    console.log('[rtdn-webhook] Renewal synced to Firestore');
}

/**
 * Mark subscription as canceled/expired in Firestore.
 */
async function _handleCancellation(purchaseToken, notificationType) {
    const status = notificationType === 6 ? 'grace_period' : 'canceled';

    const snap = await db
        .collection('subscriptions')
        .where('purchaseToken', '==', purchaseToken)
        .get();

    if (snap.empty) {
        console.warn('[rtdn-webhook] No Firestore subscription found for token (cancellation)');
        return;
    }

    const batch = db.batch();
    snap.docs.forEach((doc) => {
        batch.update(doc.ref, { status, updatedAt: new Date() });

        const garageId = doc.data().garageId;
        if (garageId) {
            batch.update(db.collection('garages').doc(garageId), {
                'subscription.status': status,
            });
        }
    });
    await batch.commit();
    console.log(`[rtdn-webhook] Subscription status set to '${status}' in Firestore`);
}

module.exports = router;

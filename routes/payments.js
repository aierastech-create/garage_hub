const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getRazorpay } = require('../lib/razorpay');
const { db } = require('../lib/firebase');

/**
 * POST /api/payments/create-order
 * Body: { planId, garageId, amount, currency? }
 *
 * Creates a Razorpay order and returns the order details to the client.
 * The client (Flutter app) uses these details to open the Razorpay checkout UI.
 */
router.post('/create-order', async (req, res) => {
    try {
        const { planId, garageId, amount, currency = 'INR', planName, duration } = req.body;

        if (!planId || !garageId || !amount) {
            return res.status(400).json({ error: 'planId, garageId and amount are required.' });
        }

        if (typeof amount !== 'number' || amount <= 0) {
            return res.status(400).json({ error: 'amount must be a positive number in paise.' });
        }

        const razorpay = getRazorpay();

        const order = await razorpay.orders.create({
            amount: Math.round(amount), // amount in paise
            currency,
            receipt: `gh_${garageId.substring(0, 8)}_${Date.now()}`,
            notes: {
                garageId,
                planId,
                planName: planName || '',
                duration: duration || '',
            },
        });

        return res.json({
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            keyId: process.env.RAZORPAY_KEY_ID,
        });
    } catch (err) {
        console.error('[create-order]', err);
        return res.status(500).json({ error: err.message || 'Failed to create order.' });
    }
});

/**
 * POST /api/payments/verify
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature,
 *          garageId, planId, planName, duration, price }
 *
 * Verifies HMAC signature and activates subscription in Firestore.
 */
router.post('/verify', async (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            garageId,
            planId,
            planName,
            duration,
            price,
        } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Missing payment verification fields.' });
        }

        if (!garageId || !planId) {
            return res.status(400).json({ error: 'garageId and planId are required.' });
        }

        // Verify HMAC signature
        const body = `${razorpay_order_id}|${razorpay_payment_id}`;
        const expectedSig = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body)
            .digest('hex');

        if (expectedSig !== razorpay_signature) {
            return res.status(400).json({ error: 'Payment verification failed. Invalid signature.' });
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
            razorpayOrderId: razorpay_order_id,
            razorpayPaymentId: razorpay_payment_id,
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
            message: 'Payment verified and subscription activated successfully.',
        });
    } catch (err) {
        console.error('[verify]', err);
        return res.status(500).json({ error: err.message || 'Verification failed.' });
    }
});

/**
 * POST /api/payments/webhook
 * Razorpay sends payment events here. Validate webhook signature.
 * Header: x-razorpay-signature
 */
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    try {
        const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
        const body = req.body;
        const signature = req.headers['x-razorpay-signature'];

        const expectedSig = crypto
            .createHmac('sha256', secret)
            .update(body)
            .digest('hex');

        if (expectedSig !== signature) {
            return res.status(400).json({ error: 'Invalid webhook signature.' });
        }

        const event = JSON.parse(body.toString());
        console.log('[webhook] Event received:', event.event);

        // Handle specific events (extend as needed)
        switch (event.event) {
            case 'payment.captured':
                console.log('[webhook] Payment captured:', event.payload.payment.entity.id);
                break;
            case 'payment.failed':
                console.warn('[webhook] Payment failed:', event.payload.payment.entity.id);
                break;
            case 'refund.created':
                console.log('[webhook] Refund created:', event.payload.refund?.entity?.id);
                break;
            default:
                console.log('[webhook] Unhandled event:', event.event);
        }

        return res.json({ status: 'ok' });
    } catch (err) {
        console.error('[webhook]', err);
        return res.status(500).json({ error: 'Webhook processing failed.' });
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

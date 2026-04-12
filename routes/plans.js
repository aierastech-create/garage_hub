const express = require('express');
const router = express.Router();
const { db } = require('../lib/firebase');

/**
 * GET /api/plans
 * Returns all active subscription plans from Firestore.
 */
router.get('/', async (req, res) => {
    try {
        const snap = await db
            .collection('subscription_plans')
            .where('isActive', '==', true)
            .get();

        const plans = snap.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
        }));

        return res.json({ plans });
    } catch (err) {
        console.error('[GET /plans]', err);
        return res.status(500).json({ error: 'Failed to fetch plans.' });
    }
});

/**
 * GET /api/plans/:planId
 * Returns a single subscription plan.
 */
router.get('/:planId', async (req, res) => {
    try {
        const doc = await db.collection('subscription_plans').doc(req.params.planId).get();
        if (!doc.exists) {
            return res.status(404).json({ error: 'Plan not found.' });
        }
        return res.json({ id: doc.id, ...doc.data() });
    } catch (err) {
        console.error('[GET /plans/:planId]', err);
        return res.status(500).json({ error: 'Failed to fetch plan.' });
    }
});

module.exports = router;

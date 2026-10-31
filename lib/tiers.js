'use strict';

const { db } = require('./firebase');

/**
 * Subscription tiers. Each Google Play subscription product maps to one tier
 * through the `tier` field of its `subscription_plans` docs:
 *
 *   premium – the original plan (unlimited invoices, no ads, ...)
 *   pro     – everything in premium + job cards, employees, signed invoices
 *
 * Garages subscribed before tiers existed have no `tier` and count as premium.
 */
const TIER_PREMIUM = 'premium';
const TIER_PRO = 'pro';
const TIER_RANK = { [TIER_PREMIUM]: 1, [TIER_PRO]: 2 };

/**
 * What each tier unlocks. Admins edit this in the admin panel
 * (Subscriptions → Tier features), stored at `app_config/tiers`. These
 * defaults apply until that doc exists, and fill in missing fields.
 * The app (TierConfigService) and firestore.rules use the same defaults.
 */
const FEATURE_DEFAULTS = {
    [TIER_PREMIUM]: { jobCards: false, employees: false, maxEmployees: 0, signedInvoice: false },
    [TIER_PRO]: { jobCards: true, employees: true, maxEmployees: 10, signedInvoice: true },
};
const NO_FEATURES = { jobCards: false, employees: false, maxEmployees: 0, signedInvoice: false };

const CONFIG_TTL_MS = 60 * 1000;
let configCache = null;
let configLoadedAt = 0;

async function loadFeatureConfig() {
    if (configCache && Date.now() - configLoadedAt < CONFIG_TTL_MS) return configCache;
    const snap = await db.collection('app_config').doc('tiers').get();
    const data = snap.exists ? snap.data() : {};
    configCache = {
        [TIER_PREMIUM]: { ...FEATURE_DEFAULTS[TIER_PREMIUM], ...(data[TIER_PREMIUM] || {}) },
        [TIER_PRO]: { ...FEATURE_DEFAULTS[TIER_PRO], ...(data[TIER_PRO] || {}) },
    };
    configLoadedAt = Date.now();
    return configCache;
}

/** Features of the garage's current plan (none when not subscribed). */
async function featuresFor(subscription) {
    if (!isSubscriptionActive(subscription)) return NO_FEATURES;
    const config = await loadFeatureConfig();
    return config[subscriptionTier(subscription)];
}

// Same expiry rule the app uses (GarageUser.isSubscriptionActive).
function isSubscriptionActive(subscription) {
    if (!subscription || subscription.status !== 'active') return false;
    const expiry = subscription.expiryDate;
    if (!expiry) return false;
    const expiryDate = typeof expiry.toDate === 'function' ? expiry.toDate() : new Date(expiry);
    return expiryDate > new Date();
}

function subscriptionTier(subscription) {
    return subscription?.tier === TIER_PRO ? TIER_PRO : TIER_PREMIUM;
}

/** True when the subscription is active and at least [tier]. */
function hasTier(subscription, tier) {
    if (!isSubscriptionActive(subscription)) return false;
    return TIER_RANK[subscriptionTier(subscription)] >= TIER_RANK[tier];
}

/**
 * Resolves the tier of a Play subscription product from the plans an admin
 * configured in Firestore. Never trust a tier sent by the client.
 */
async function resolveTier(subscriptionId) {
    if (!subscriptionId) return TIER_PREMIUM;
    const snap = await db
        .collection('subscription_plans')
        .where('subscriptionId', '==', subscriptionId)
        .limit(1)
        .get();
    if (snap.empty) return TIER_PREMIUM;
    return snap.docs[0].data().tier === TIER_PRO ? TIER_PRO : TIER_PREMIUM;
}

module.exports = {
    TIER_PREMIUM,
    TIER_PRO,
    isSubscriptionActive,
    featuresFor,
    subscriptionTier,
    hasTier,
    resolveTier,
};

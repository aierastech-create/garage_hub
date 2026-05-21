'use strict';

/**
 * lib/googlePlay.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Google Play Developer API helpers (subscriptionsv2)
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  – full JSON content of the service-account key file
 *   GOOGLE_PLAY_PACKAGE_NAME     – e.g. "com.aieras.garageinvoice.app"
 *
 * Service account must have the "View financial data, orders, and cancellation
 * survey responses" role granted in the Play Console (Users & permissions).
 */

import { google } from 'googleapis';

const PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME || '';

/**
 * Lazily create an authenticated Google API client.
 * We parse the service-account JSON from the env var once.
 */
let _androidPublisher = null;

function _getAndroidPublisher() {
    if (_androidPublisher) return _androidPublisher;

    const jsonRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!jsonRaw) {
        throw new Error(
            'GOOGLE_SERVICE_ACCOUNT_JSON env var is not set. ' +
            'Add the service-account key JSON as a single-line env var.'
        );
    }

    let credentials;
    try {
        credentials = JSON.parse(jsonRaw);
    } catch {
        throw new Error(
            'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. ' +
            'Make sure to stringify the entire key file content.'
        );
    }

    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });

    _androidPublisher = google.androidpublisher({ version: 'v3', auth });
    return _androidPublisher;
}

/**
 * verifySubscriptionPurchase
 * Calls the Play Developer API (subscriptionsv2) to verify a subscription
 * purchase token. Does NOT require the subscriptionId – Google tells us
 * which plan was purchased via lineItems.
 *
 * @param {string} purchaseToken  – The server verification data from in_app_purchase
 * @returns {object}              – Structured subscription info
 * @throws                        – If the token is invalid or subscription is inactive/expired
 */
async function verifySubscriptionPurchase(purchaseToken) {
    if (!PACKAGE_NAME) {
        throw new Error('GOOGLE_PLAY_PACKAGE_NAME env var is not set.');
    }
    const publisher = _getAndroidPublisher();

    const result = await publisher.purchases.subscriptionsv2.get({
        packageName: PACKAGE_NAME,
        token: purchaseToken,
    });

    const purchase = result.data;

    // Extract first lineItem (the purchased base plan)
    const lineItem = purchase.lineItems?.[0];
    if (!lineItem) {
        throw new Error('No subscription line item found in Google response.');
    }

    const expiryDate = new Date(lineItem.expiryTime);
    if (expiryDate.getTime() < Date.now()) {
        throw new Error('Subscription has already expired.');
    }

    const isActive =
        purchase.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE' ||
        purchase.subscriptionState === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD';

    if (!isActive) {
        throw new Error(
            `Subscription is not active. State: ${purchase.subscriptionState}`
        );
    }

    // ── Detect free-trial offer ───────────────────────────────────────────────
    // When a user is in a free-trial offer phase, Google returns
    // lineItem.offerDetails.offerPhases[0].offerTag or the prepaid plan cycle
    // state.  More reliably, we check if the subscription started recently
    // and the prepaid/autoRenewing plan has a trial phase.
    //
    // The clearest signal available via subscriptionsV2 API:
    // purchase.subscriptionState === SUBSCRIPTION_STATE_ACTIVE and the
    // expiryTime is within the trial window AND the offer ID is set.
    const offerId = lineItem.offerDetails?.offerId || null; // e.g. "free-trial-7d"
    const basePlanId = lineItem.offerDetails?.basePlanId;   // e.g. "monthly"

    // Determine whether the user is currently in a FREE TRIAL phase.
    // Google embeds trial info in prepaidPlan or latestOrderId prefix.
    // The most reliable way: check if offerId is set AND the subscription
    // state is ACTIVE and started very recently (within 7 days).
    let isInTrial = false;
    let trialEndDate = null;

    // If Google returns offer phase information (newer API versions)
    const lineItemOfferPhases = lineItem.offerDetails?.offerPhases || [];
    const trialPhase = lineItemOfferPhases.find(
        (p) => p.phaseType === 'FREE_TRIAL' || p.recurrenceMode === 'ONE_TIME'
    );
    if (trialPhase) {
        isInTrial = true;
        trialEndDate = lineItem.expiryTime; // during trial, expiryTime = trial end
    }

    // Fallback: if offerId is present, assume the user received an offer
    // (trial or introductory). Mark isInTrial=true while within it.
    if (!isInTrial && offerId) {
        // Heuristic: subscription started less than 8 days ago
        const startTime = purchase.startTime ? new Date(purchase.startTime) : null;
        const daysSinceStart = startTime
            ? (Date.now() - startTime.getTime()) / (1000 * 60 * 60 * 24)
            : 999;
        if (daysSinceStart < 8) {
            isInTrial = true;
            trialEndDate = lineItem.expiryTime;
        }
    }

    return {
        subscriptionId: lineItem.productId,  // e.g. "premium"
        basePlanId,                          // e.g. "monthly" | "yearly"
        offerId,                             // e.g. "free-trial-7d" or null
        expiryDate: lineItem.expiryTime,     // ISO string
        trialEndDate,                        // ISO string or null
        isInTrial,                           // boolean
        active: isActive,
        autoRenew: !!lineItem.autoRenewingPlan,
        acknowledgementState: purchase.acknowledgementState,
        subscriptionState: purchase.subscriptionState,
    };
}

/**
 * acknowledgeSubscriptionPurchase
 * Acknowledges the purchase so Google won't auto-refund after 3 days.
 * Uses subscriptionsv2 acknowledge – no subscriptionId required.
 *
 * @param {string} purchaseToken
 */
async function acknowledgeSubscriptionPurchase(purchaseToken) {
    if (!PACKAGE_NAME) return;
    try {
        const publisher = _getAndroidPublisher();
        await publisher.purchases.subscriptionsv2.acknowledge({
            packageName: PACKAGE_NAME,
            token: purchaseToken,
            requestBody: {},
        });
    } catch (err) {
        // Log but don't throw – acknowledge is best-effort if Firestore write succeeded
        console.warn('[googlePlay] acknowledge failed (non-fatal):', err.message);
    }
}

export default { verifySubscriptionPurchase, acknowledgeSubscriptionPurchase };

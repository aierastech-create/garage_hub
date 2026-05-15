'use strict';

/**
 * lib/googlePlay.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Google Play Developer API helpers
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
 * Calls the Play Developer API to verify a subscription purchase token.
 *
 * @param {string} productId      – The subscription product ID (e.g. "garagehub_monthly")
 * @param {string} purchaseToken  – The server verification data from in_app_purchase
 * @returns {object}              – The raw SubscriptionPurchase resource from Google
 * @throws                        – If the token is invalid or expired
 */
async function verifySubscriptionPurchase(productId, purchaseToken) {
    if (!PACKAGE_NAME) {
        throw new Error('GOOGLE_PLAY_PACKAGE_NAME env var is not set.');
    }
    const publisher = _getAndroidPublisher();

    const result = await publisher.purchases.subscriptions.get({
        packageName: PACKAGE_NAME,
        subscriptionId: productId,
        token: purchaseToken,
    });

    const purchase = result.data;

    // paymentState: 0 = pending, 1 = received, 2 = free trial, 3 = deferred upgrade/downgrade
    // cancelReason: present means the sub was canceled
    if (purchase.paymentState === undefined || purchase.paymentState === 0) {
        throw new Error('Purchase payment is still pending.');
    }

    // expiryTimeMillis: must be in the future for an active subscription
    const expiry = parseInt(purchase.expiryTimeMillis || '0', 10);
    if (expiry > 0 && expiry < Date.now()) {
        throw new Error('Subscription has already expired.');
    }

    return purchase;
}

/**
 * acknowledgeSubscriptionPurchase
 * Acknowledges the purchase so Google won't auto-refund after 3 days.
 * Should be called once after successfully saving the subscription to Firestore.
 *
 * @param {string} productId
 * @param {string} purchaseToken
 */
async function acknowledgeSubscriptionPurchase(productId, purchaseToken) {
    if (!PACKAGE_NAME) return;
    try {
        const publisher = _getAndroidPublisher();
        await publisher.purchases.subscriptions.acknowledge({
            packageName: PACKAGE_NAME,
            subscriptionId: productId,
            token: purchaseToken,
            requestBody: {},
        });
    } catch (err) {
        // Log but don't throw – acknowledge is best-effort if Firestore write succeeded
        console.warn('[googlePlay] acknowledge failed (non-fatal):', err.message);
    }
}

export default { verifySubscriptionPurchase, acknowledgeSubscriptionPurchase };

const admin = require('firebase-admin');

let isInitialized = false;

function initFirebase() {
    if (isInitialized) return;

    if (process.env.FIREBASE_PRIVATE_KEY) {
        // Production / Vercel: credentials come from environment variables
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }),
        });
        isInitialized = true;
    } else {
        // Local dev: use serviceAccountKey.json if present
        try {
            const serviceAccount = require('../serviceAccountKey.json');
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            isInitialized = true;
        } catch {
            // Neither env vars nor local key file found — fail loudly so Vercel
            // logs show the real problem instead of a cryptic "no-app" crash.
            throw new Error(
                '[Firebase] No credentials found. ' +
                'Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY ' +
                'in your Vercel environment variables.'
            );
        }
    }
}

initFirebase();

// Only reached when initializeApp() succeeded above
const db = admin.firestore();

module.exports = { admin, db };

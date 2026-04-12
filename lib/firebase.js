const admin = require('firebase-admin');

let isInitialized = false;

function initFirebase() {
    if (isInitialized) return;

    // In Vercel/production: use env vars
    // In local: use serviceAccountKey.json if available
    if (process.env.FIREBASE_PRIVATE_KEY) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }),
        });
    } else {
        // Local dev: place serviceAccountKey.json in backend/
        try {
            const serviceAccount = require('../serviceAccountKey.json');
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        } catch {
            console.warn('[Firebase] No credentials found. Firestore writes will fail.');
        }
    }

    isInitialized = true;
}

initFirebase();

const db = admin.firestore();

module.exports = { admin, db };

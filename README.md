# GarageHub Payment Server

Express.js backend for handling **Google Play in-app purchases and subscriptions** for the GarageHub application. Deployable to Vercel in one command.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/` | Health check |
| `GET`  | `/api/plans` | List all active subscription plans |
| `GET`  | `/api/plans/:planId` | Get a specific plan |
| `POST` | `/api/payments/verify` | Verify Google Play purchase & activate subscription |
| `POST` | `/api/payments/rtdn-webhook` | Google RTDN Pub/Sub webhook (auto-renewals / cancellations) |
| `GET`  | `/api/payments/subscription/:garageId` | Get active subscription for a garage |

---

## Local Development

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment

Create a `.env` file in the `backend/` directory with these variables:

```env
# Firebase Admin SDK
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# Google Play Developer API
# Paste the entire service-account JSON key file content as a single JSON string
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}
GOOGLE_PLAY_PACKAGE_NAME=com.aieras.garageinvoice.app

# CORS (comma-separated or *)
ALLOWED_ORIGINS=*
```

### 3. Start the server
```bash
npm run dev
```
Server runs at `http://localhost:3000`.

---

## 🚀 Deploy to Vercel

### 1. Install Vercel CLI (if not installed)
```bash
npm install -g vercel
```

### 2. Login and deploy from the backend folder
```bash
cd backend
vercel
```

### 3. Set Environment Variables in Vercel Dashboard

Go to **Vercel Project → Settings → Environment Variables** and add:

| Variable | Description |
|----------|-------------|
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Firebase service account email |
| `FIREBASE_PRIVATE_KEY` | Full private key (with `\n` for newlines) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full Play Console service-account JSON (stringified) |
| `GOOGLE_PLAY_PACKAGE_NAME` | `com.aieras.garageinvoice.app` |
| `ALLOWED_ORIGINS` | Comma-separated allowed CORS origins |

> **`GOOGLE_SERVICE_ACCOUNT_JSON`**: In Vercel, paste the entire JSON key file as a single-line string (use `JSON.stringify` or `jq -c . key.json` to collapse it).

---

## Google Play Setup

### Service Account (for purchase verification)
1. Go to **Play Console → Users and permissions → Invite new users**.
2. Add your Google Cloud service account email.
3. Grant: **"View financial data, orders, and cancellation survey responses"**.
4. Download the JSON key from **Google Cloud Console → IAM → Service Accounts**.
5. Paste the key content into `GOOGLE_SERVICE_ACCOUNT_JSON`.

### RTDN Webhook (for auto-renewals / cancellations)
1. Create a **Pub/Sub topic** in Google Cloud Console.
2. Go to **Play Console → Monetization → Real-Time Developer Notifications**.
3. Set the topic ARN.
4. Create a **push subscription** pointing to:
   ```
   https://<your-vercel-domain>/api/payments/rtdn-webhook
   ```
5. Grant Pub/Sub SA the `pubsub.topics.publish` permission on the topic.

### Supported RTDN Notification Types

| Type | Action |
|------|--------|
| `SUBSCRIPTION_RENEWED` (2) | Extend endDate, set status → `active` |
| `SUBSCRIPTION_RECOVERED` (1) | Same as renewed |
| `SUBSCRIPTION_RESTARTED` (7) | Same as renewed |
| `SUBSCRIPTION_CANCELED` (3) | Set status → `canceled` |
| `SUBSCRIPTION_EXPIRED` (12) | Set status → `canceled` |
| `SUBSCRIPTION_REVOKED` (13) | Set status → `canceled` |
| `SUBSCRIPTION_ON_HOLD` (5) | Set status → `canceled` |
| `SUBSCRIPTION_IN_GRACE_PERIOD` (6) | Set status → `grace_period` |

---

## Flutter Integration Flow

```
Flutter App                    Payment Server              Google Play API
    │                                │                          │
    │   User taps Subscribe          │                          │
    ├─ in_app_purchase.buyNonConsumable() ──────────────────────►
    │                                │  Play billing dialog     │
    │◄── PurchaseStatus.purchased ───┤                          │
    │    (purchaseToken available)   │                          │
    │                                │                          │
    ├─ POST /api/payments/verify ────►                          │
    │  { purchaseToken, productId,   │                          │
    │    garageId, planId, ... }     │                          │
    │                                ├─ purchases.subscriptions.get() ─►
    │                                │◄── SubscriptionPurchase ─┤
    │                                │  (validates token)       │
    │                                │                          │
    │                                │ Write Firestore          │
    │                                ├─ purchases.acknowledge() ─►
    │◄── { success, subscriptionId } ┤                          │
    │  Snackbar: "Subscribed!"       │                          │


Google RTDN Pub/Sub            Payment Server              Firestore
    │                                │                          │
    ├─ POST /api/payments/rtdn-webhook►                         │
    │  { subscriptionNotification }  │                          │
    │                                │ Decode & verify          │
    │◄── 200 OK ─────────────────────┤                          │
    │                                ├─ Update subscription ────►
    │                                │  status / endDate        │
```

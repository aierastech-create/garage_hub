# GarageHub Payment Server

Express.js backend for handling **Razorpay payments and subscriptions** for the GarageHub application. Deployable to Vercel in one command.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Health check |
| `GET` | `/api/plans` | List all active subscription plans |
| `GET` | `/api/plans/:planId` | Get a specific plan |
| `POST` | `/api/payments/create-order` | Create Razorpay order |
| `POST` | `/api/payments/verify` | Verify payment & activate subscription |
| `POST` | `/api/payments/webhook` | Razorpay webhook receiver |
| `GET` | `/api/payments/subscription/:garageId` | Get active subscription for a garage |

---

## Local Development

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Edit `.env` and fill in your Razorpay and Firebase credentials.

Optionally, for local Firebase access, copy `serviceAccountKey.json` from the admin panel into the `backend/` directory.

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
| `RAZORPAY_KEY_ID` | Your Razorpay Key ID (`rzp_live_...` or `rzp_test_...`) |
| `RAZORPAY_KEY_SECRET` | Your Razorpay Key Secret |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook secret from Razorpay Dashboard |
| `FIREBASE_PROJECT_ID` | `garagehub-4a484` |
| `FIREBASE_CLIENT_EMAIL` | Service account email |
| `FIREBASE_PRIVATE_KEY` | Full private key (with `\n` for newlines) |
| `ALLOWED_ORIGINS` | Comma-separated allowed CORS origins |

> **Important for `FIREBASE_PRIVATE_KEY`**: Paste the full PEM key including `-----BEGIN PRIVATE KEY-----` header and footer. Vercel handles multi-line strings correctly.

### 4. Configure Razorpay Webhook

In Razorpay Dashboard → **Webhooks → Add Webhook**:
- URL: `https://your-vercel-domain.vercel.app/api/payments/webhook`
- Secret: same as `RAZORPAY_WEBHOOK_SECRET`
- Events: `payment.captured`, `payment.failed`

---

## Flutter Integration Flow

```
Flutter App                    Payment Server                Razorpay
    │                                │                          │
    ├─ POST /api/payments/create-order ──────────────────────────►
    │                                │ Creates Razorpay Order   │
    │◄── { orderId, amount, keyId } ──┤                          │
    │                                                            │
    │  Opens Razorpay checkout (flutter_razorpay)                │
    │◄─────────────── Payment success callback ──────────────────┤
    │  { razorpay_payment_id, razorpay_order_id, razorpay_signature }
    │                                │
    ├─ POST /api/payments/verify ────►
    │                                │ Verifies HMAC signature
    │                                │ Writes subscription to Firestore
    │◄── { success, subscriptionId } ┤
```

## Request/Response Examples

### Create Order
```json
POST /api/payments/create-order
{
  "planId": "abc123",
  "garageId": "garage_uid_456",
  "amount": 49900,
  "planName": "Pro",
  "duration": "monthly"
}
```
> Note: `amount` is in **paise** (₹499 = 49900 paise)

### Verify Payment
```json
POST /api/payments/verify
{
  "razorpay_order_id": "order_xxx",
  "razorpay_payment_id": "pay_xxx",
  "razorpay_signature": "sig_xxx",
  "garageId": "garage_uid_456",
  "planId": "abc123",
  "planName": "Pro",
  "duration": "monthly",
  "price": 499
}
```

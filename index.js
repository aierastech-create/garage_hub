require('dotenv').config();
const express = require('express');
const cors = require('cors');

const paymentsRouter = require('./routes/payments');
const plansRouter = require('./routes/plans');

const app = express();

// ── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

app.use(
    cors({
        origin: (origin, callback) => {
            // Allow server-to-server (no origin) and configured origins
            if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
                return callback(null, true);
            }
            callback(new Error(`CORS: origin '${origin}' not allowed.`));
        },
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'x-razorpay-signature'],
    })
);

// ── Body Parsers ───────────────────────────────────────────────────────────
// Raw body needed for webhook verification — mount BEFORE json() middleware
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/', (_req, res) =>
    res.json({ service: 'GarageHub Payment Server', status: 'ok', version: '1.0.0' })
);

app.use('/api/payments', paymentsRouter);
app.use('/api/plans', plansRouter);

// ── 404 & Error handlers ───────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found.' }));

app.use((err, _req, res, _next) => {
    console.error('[global-error]', err);
    res.status(500).json({ error: err.message || 'Internal server error.' });
});

// ── Start (for local dev) ──────────────────────────────────────────────────
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`[GarageHub] Payment server running on http://localhost:${PORT}`));
}

// Export for Vercel serverless
module.exports = app;

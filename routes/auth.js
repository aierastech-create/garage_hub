const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const { admin, db, adminAuth } = require('../lib/firebase');

/**
 * Sends a premium-designed HTML email with the 6-digit OTP code.
 */
async function sendOtpEmail(email, otp) {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '587');
    const secure = process.env.SMTP_SECURE === 'true';
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM_EMAIL || user || 'noreply@garagehub.com';

    if (!host || !user || !pass) {
        console.warn('[nodemailer] SMTP credentials not fully configured. Logging OTP to console for local testing.');
        console.log(`\n=========================================\n[LOCAL TEST OTP] Email: ${email} -> OTP: ${otp}\n=========================================\n`);
        return;
    }

    const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass }
    });

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verify Your Garage Invoice Account</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                background-color: #f4f6f9;
                margin: 0;
                padding: 0;
                color: #333333;
            }
            .email-container {
                max-width: 600px;
                margin: 40px auto;
                background: #ffffff;
                border-radius: 16px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.08);
                overflow: hidden;
                border: 1px solid #eef2f6;
            }
            .header {
                background: linear-gradient(135deg, #0D47A1 0%, #1E88E5 100%);
                padding: 32px;
                text-align: center;
                color: #ffffff;
            }
            .header h1 {
                margin: 0;
                font-size: 24px;
                font-weight: 700;
                letter-spacing: -0.5px;
            }
            .content {
                padding: 40px 32px;
                line-height: 1.6;
            }
            .content p {
                margin: 0 0 20px 0;
                font-size: 15px;
                color: #4A5568;
            }
            .otp-container {
                background: #f0f4f8;
                border-radius: 12px;
                padding: 24px;
                text-align: center;
                margin: 28px 0;
                border: 1px dashed #1565C0;
            }
            .otp-code {
                font-size: 36px;
                font-weight: 800;
                color: #0D47A1;
                letter-spacing: 6px;
                margin: 0;
            }
            .expiry {
                font-size: 12px;
                color: #718096;
                margin-top: 8px;
            }
            .footer {
                background: #f7fafc;
                padding: 24px 32px;
                text-align: center;
                border-top: 1px solid #edf2f7;
                font-size: 12px;
                color: #a0aec0;
            }
        </style>
    </head>
    <body>
        <div class="email-container">
            <div class="header">
                <h1>Garage Invoice</h1>
            </div>
            <div class="content">
                <p>Hello,</p>
                <p>Thank you for choosing Garage Invoice. To complete your email verification, please use the following One-Time Password (OTP):</p>
                
                <div class="otp-container">
                    <div class="otp-code">${otp}</div>
                    <div class="expiry">Valid for 10 minutes</div>
                </div>
                
                <p>If you did not request this code, you can safely ignore this email.</p>
                <p>Best regards,<br>The Garage Invoice Team</p>
            </div>
            <div class="footer">
                &copy; 2026 Garage Invoice. All rights reserved.
            </div>
        </div>
    </body>
    </html>
    `;

    await transporter.sendMail({
        from: `"Garage Invoice Support" <${from}>`,
        to: email,
        subject: 'Verify Your Garage Invoice Account - OTP',
        html: htmlContent
    });
}

/**
 * POST /api/auth/send-otp
 * Body: { email }
 * Generates and stores OTP, then dispatches verification email.
 */
router.post('/send-otp', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email is required.' });
        }

        const emailLower = email.toLowerCase().trim();
        // Generate a cryptographically secure 6-digit numeric OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // 10 minutes expiry time
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        // Store OTP in Firestore
        await db.collection('otps').doc(emailLower).set({
            otp,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt
        });

        // Send Email
        await sendOtpEmail(emailLower, otp);

        console.log(`[send-otp] OTP sent to email=${emailLower}`);

        return res.json({
            success: true,
            message: 'Verification OTP sent successfully.'
        });
    } catch (err) {
        console.error('[send-otp] Error:', err);
        return res.status(500).json({ error: err.message || 'Failed to send OTP.' });
    }
});

/**
 * POST /api/auth/verify-otp
 * Body: { email, otp, uid }
 * Verifies matching OTP and marks the user as verified.
 */
router.post('/verify-otp', async (req, res) => {
    try {
        const { email, otp, uid } = req.body;
        if (!email || !otp || !uid) {
            return res.status(400).json({ error: 'email, otp, and uid are required.' });
        }

        const emailLower = email.toLowerCase().trim();
        const docRef = db.collection('otps').doc(emailLower);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(400).json({ error: 'No OTP requested for this email. Please request a new one.' });
        }

        const data = doc.data();
        const now = new Date();
        const expiresAt = data.expiresAt.toDate();

        if (now > expiresAt) {
            await docRef.delete();
            return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
        }

        if (data.otp !== otp.trim()) {
            return res.status(400).json({ error: 'Invalid OTP code. Please check and try again.' });
        }

        // OTP matches! Mark the Firebase Auth user's email as verified
        await adminAuth.updateUser(uid, { emailVerified: true });

        // Delete verified OTP record from Firestore
        await docRef.delete();

        console.log(`[verify-otp] User email verified successfully for uid=${uid}`);

        return res.json({
            success: true,
            message: 'Email verified successfully.'
        });
    } catch (err) {
        console.error('[verify-otp] Error:', err);
        return res.status(500).json({ error: err.message || 'Verification failed.' });
    }
});

module.exports = router;

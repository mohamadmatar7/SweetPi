const express = require('express');
const cors = require('cors');
const { createMollieClient } = require('@mollie/api-client');
const gpio = require('./gpio');
const game = require('./game');

const {
    createIntent,
    attachPaymentToIntent,
    getIntent,
    getDonationByPaymentId,
    getDonationByToken,
    listQueue,
} = require('./db');

const app = express();

/**
 * CORS (production-safe)
 * - Allow only your web domain + localhost for dev
 * - Always answer preflight OPTIONS correctly
 */
const allowedOrigins = [
    'https://sweet-web.sweetcontrol.be',
    'https://sweetcontrol.be',
    'https://www.sweetcontrol.be',
    'http://localhost:3000',
];
const corsOptions = {
    origin: (origin, cb) => {
        // Allow non-browser requests (curl, Mollie webhook)
        if (!origin) return cb(null, true);
        if (allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: false,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // preflight support

// Mollie webhook uses x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const mollie = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });

/**
 * Create a Mollie payment (Intent-first)
 * Body: { name, amountEuros, email? }
 */
app.post('/api/donations/create', async (req, res) => {
    try {
        const { name, amountEuros, email } = req.body;

        if (!name || !amountEuros) {
            return res.status(400).json({ error: 'name and amountEuros are required' });
        }

        const amountRequestedEur = Number(amountEuros);
        if (Number.isNaN(amountRequestedEur) || amountRequestedEur <= 0) {
            return res.status(400).json({ error: 'amountEuros must be a positive number' });
        }

        // 1) Create intent first (saved in SQLite)
        const { intentId } = createIntent({
            name: name.trim(),
            email: email?.trim() || null,
            amountRequestedEur,
        });

        // 2) Create Mollie payment tied to intentId
        const payment = await mollie.payments.create({
            amount: { currency: 'EUR', value: amountRequestedEur.toFixed(2) },
            description: `SweetControl donation by ${name}`,
            redirectUrl: `${process.env.PUBLIC_WEB_URL}/play?intent=${intentId}`,
            webhookUrl: `${process.env.PUBLIC_API_URL}/api/mollie/webhook`,
            metadata: { intentId },
        });

        // 3) Attach Mollie payment id to intent
        attachPaymentToIntent(intentId, payment.id);

        return res.json({
            checkoutUrl: payment.getCheckoutUrl(),
            intentId,
        });
    } catch (err) {
        console.error('Create payment error:', err);
        return res.status(500).json({ error: 'payment_create_failed' });
    }
});

/**
 * Mollie webhook (source of truth)
 * Mollie sends: id=tr_xxx
 */
app.post('/api/mollie/webhook', async (req, res) => {
    try {
        const paymentId = req.body.id;
        if (!paymentId) return res.status(400).send('missing id');

        const payment = await mollie.payments.get(paymentId);
        const intentId = payment.metadata?.intentId;

        // If no intentId, ignore safely
        if (!intentId) return res.status(200).send('ok');

        // Idempotency: ignore if already processed
        const existing = getDonationByPaymentId(paymentId);
        if (existing && existing.status !== 'created') {
            return res.status(200).send('ok');
        }

        if (payment.status === 'paid' || payment.status === 'authorized') {
            const amountEur = Number(payment.amount.value);

            game.handlePaidDonation({
                intentId,
                molliePaymentId: paymentId,
                amountEur,
            });
        }


        return res.status(200).send('ok');
    } catch (err) {
        console.error('Webhook error:', err);
        return res.status(500).send('error');
    }
});

/**
 * Claim a play session using intentId
 * Body: { intentId }
 * - If paid already => returns token
 * - If webhook late => fallback checks Mollie status
 * - If still not paid => pending (202)
 */
app.post('/api/play/claim', async (req, res) => {
    try {
        const { intentId } = req.body;
        if (!intentId) return res.status(400).json({ error: 'intentId required' });

        let donation = getIntent(intentId);
        if (!donation) return res.status(403).json({ error: 'not_found' });

        // Fallback: if webhook didn’t arrive yet, re-check Mollie
        if (donation.status === 'created' && donation.mollie_payment_id) {
            const payment = await mollie.payments.get(donation.mollie_payment_id);
            if (payment.status === 'paid' || payment.status === 'authorized') {
                const amountEur = Number(payment.amount.value);

                game.handlePaidDonation({
                    intentId,
                    molliePaymentId: donation.mollie_payment_id,
                    amountEur,
                });

                donation = getIntent(intentId);
            }

        }

        if (donation.status === 'created') {
            return res.status(202).json({ ok: false, status: 'pending' });
        }

        const creditsRemaining = donation.credits_total - donation.credits_used;

        return res.json({
            ok: true,
            token: donation.session_token,
            creditsRemaining,
        });
    } catch (err) {
        console.error('Claim error:', err);
        return res.status(500).json({ error: 'claim_failed' });
    }
});

/**
 * Queue state for UI (+ active state for refresh sync)
 */
app.get('/api/queue', (req, res) => {
    const queue = listQueue().map((d, idx) => ({
        id: d.id,
        name: d.name,
        creditsRemaining: d.credits_total - d.credits_used,
        status: d.status,
        position: idx + 1,
    }));

    const activeState = game.getActiveState();

    return res.json({
        queue,
        ...activeState,
    });
});


/**
 * Control press (hold direction)
 * Body: { token, direction } direction: up|down|left|right
 */
app.post('/api/control/press', (req, res) => {
    const { token, direction } = req.body;
    const donation = getDonationByToken(token);

    if (!game.isActiveTokenDonation(donation)) {
        return res.status(403).json({ error: 'not_active_player' });
    }

    if (!['up', 'down', 'left', 'right'].includes(direction)) {
        return res.status(400).json({ error: 'invalid_direction' });
    }

    // Timer starts on first movement
    game.startCreditTimerIfNeeded();
    gpio.hold(direction);

    return res.json({ ok: true });
});


/**
 * Control release (stop hold)
 * Body: { token, direction }
 */
app.post('/api/control/release', (req, res) => {
    const { token, direction } = req.body;
    const donation = getDonationByToken(token);

    if (!game.isActiveTokenDonation(donation)) {
        return res.status(403).json({ error: 'not_active_player' });
    }

    if (!['up', 'down', 'left', 'right'].includes(direction)) {
        return res.status(400).json({ error: 'invalid_direction' });
    }

    gpio.release(direction);
    return res.json({ ok: true });
});


/**
 * Grab = one per credit, ends credit early
 * Body: { token }
 */
app.post('/api/control/grab', (req, res) => {
    const { token } = req.body;
    const donation = getDonationByToken(token);

    if (!game.isActiveTokenDonation(donation)) {
        return res.status(403).json({ error: 'not_active_player' });
    }

    const result = game.handleGrabIfAllowed();

    if (!result.ok) {
        return res.status(403).json({ error: result.error });
    }

    return res.json({ ok: true });
});

/**
 * Get current player by token
 * Query: ?token=xxx
 */
app.get('/api/me', (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'token required' });

    const donation = getDonationByToken(token);
    if (!donation) return res.status(404).json({ error: 'not_found' });

    const creditsRemaining = donation.credits_total - donation.credits_used;

    return res.json({
        id: donation.id,
        name: donation.name,
        status: donation.status,
        creditsTotal: donation.credits_total,
        creditsUsed: donation.credits_used,
        creditsRemaining,
    });
});


const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`API listening on port ${PORT}`);
    game.maybeStartNext();
});

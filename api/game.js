const gpio = require('./gpio');
const Pusher = require('pusher');

const {
    markIntentPaid,
    listQueue,
    setDonationStatus,
    useOneCredit,
    requeueToEnd,
    markCreditsPulsed,
    db, // use db only for boot recovery
} = require('./db');

const pusher = new Pusher({
    appId: process.env.SOKETI_APP_ID,
    key: process.env.SOKETI_APP_KEY,
    secret: process.env.SOKETI_APP_SECRET,
    host: 'sweetpi-soketi',
    port: 6001,
    useTLS: false,
});

const CREDIT_MS = 35 * 1000;       // 35s per credit
const FIRST_MOVE_MS = 15 * 1000;  // must move within 15s if others are waiting
const GRAB_FINISH_MS = 7 * 1000;  // after grab, wait 7s then end credit

let active = null;
// {
//   donationId,
//   creditsRemaining,
//   timer,
//   timerStarted,
//   creditEndsAt,
//   firstMoveDeadline,
//   firstMoveTimer,
//   hasMoved,
//   grabUsed
// }

/**
 * Boot recovery:
 * - If server restarts while someone was active, DB still says active.
 *   We move them back to waiting to avoid "ghost active" blocking queue.
 * - Also mark waiting rows with 0 credits as done.
 */
function recoverAfterRestart() {
    try {
        const actives = db.prepare(`SELECT id FROM donations WHERE status = 'active'`).all();
        for (const a of actives) {
            setDonationStatus(a.id, 'waiting');
        }

        const waitings = db.prepare(`
            SELECT id, credits_total, credits_used
            FROM donations
            WHERE status = 'waiting'
        `).all();

        for (const w of waitings) {
            const remaining = (w.credits_total || 0) - (w.credits_used || 0);
            if (remaining <= 0) {
                setDonationStatus(w.id, 'done');
            }
        }
    } catch (err) {
        console.error('recoverAfterRestart error:', err);
    }
}
recoverAfterRestart();

/**
 * Broadcast queue + active state for realtime UI.
 */
function broadcastQueue() {
    const queue = listQueue().map((d, idx) => ({
        id: d.id,
        name: d.name,
        creditsRemaining: d.credits_total - d.credits_used,
        status: d.status,
        position: idx + 1,
    }));

    pusher.trigger('public-chat', 'queue-update', {
        activeDonationId: active?.donationId || null,
        creditEndsAt: active?.creditEndsAt || null,
        firstMoveDeadline: active?.firstMoveDeadline || null,
        queue,
    });
}

/**
 * Start next waiting player if no one is active.
 * Credits are pulsed ONCE per donation.
 */
function maybeStartNext() {
    if (active) return;

    // Cleanup any waiting rows with no credits left
    const queueNow = listQueue();
    for (const q of queueNow) {
        const remaining = q.credits_total - q.credits_used;
        if (q.status === 'waiting' && remaining <= 0) {
            setDonationStatus(q.id, 'done');
        }
    }

    const freshQueue = listQueue();
    const next = freshQueue.find(q => q.status === 'waiting');

    if (!next) {
        broadcastQueue();
        return;
    }

    const creditsRemaining = next.credits_total - next.credits_used;

    active = {
        donationId: next.id,
        creditsRemaining,
        timer: null,
        timerStarted: false,
        creditEndsAt: null,
        firstMoveDeadline: Date.now() + FIRST_MOVE_MS,
        firstMoveTimer: null,
        hasMoved: false,
        grabUsed: false,
    };

    setDonationStatus(next.id, 'active');

    // Pulse credits only once per donation
    if (!next.credits_pulsed && creditsRemaining > 0) {
        for (let i = 0; i < creditsRemaining; i++) {
            setTimeout(() => gpio.pulse('credit', 200), i * 400);
        }
        markCreditsPulsed(next.id);
    }

    scheduleFirstMoveTimeout();
    broadcastQueue();

    pusher.trigger('public-chat', 'player-start', {
        donationId: next.id,
        name: next.name,
        creditsRemaining,
        firstMoveDeadline: active.firstMoveDeadline,
    });
}

/**
 * If player doesn't move within FIRST_MOVE_MS while others wait,
 * requeue them to the end.
 */
function scheduleFirstMoveTimeout() {
    if (!active) return;

    if (active.firstMoveTimer) clearTimeout(active.firstMoveTimer);

    active.firstMoveDeadline = Date.now() + FIRST_MOVE_MS;

    active.firstMoveTimer = setTimeout(() => {
        if (!active) return;
        if (active.hasMoved) return;

        const queueNow = listQueue();
        const someoneWaiting = queueNow.some(
            q => q.status === 'waiting' && q.id !== active.donationId
        );

        if (someoneWaiting) {
            requeueToEnd(active.donationId);

            pusher.trigger('public-chat', 'player-timeout', {
                donationId: active.donationId,
                reason: 'no_first_move',
            });

            active = null;
            broadcastQueue();
            maybeStartNext();
            return;
        }

        // Nobody waiting => keep active and re-check later
        scheduleFirstMoveTimeout();
        broadcastQueue();
    }, FIRST_MOVE_MS);
}

/**
 * Start the 35s credit timer on FIRST real action.
 */
function startCreditTimerIfNeeded() {
    if (!active || active.timerStarted) return;

    active.hasMoved = true;

    if (active.firstMoveTimer) {
        clearTimeout(active.firstMoveTimer);
        active.firstMoveTimer = null;
    }

    active.timerStarted = true;
    active.creditEndsAt = Date.now() + CREDIT_MS;

    pusher.trigger('public-chat', 'credit-start', {
        donationId: active.donationId,
        creditEndsAt: active.creditEndsAt,
        creditsRemaining: active.creditsRemaining,
    });

    // Normal credit timeout
    active.timer = setTimeout(finishCreditNormally, CREDIT_MS);
}

/**
 * Called when credit ends normally by timeout (35s).
 */
function finishCreditNormally() {
    if (!active) return;

    useOneCredit(active.donationId);
    active.creditsRemaining -= 1;

    if (active.creditsRemaining > 0) {
        // Prepare next credit
        active.timerStarted = false;
        active.creditEndsAt = null;
        active.hasMoved = false;
        active.grabUsed = false;

        scheduleFirstMoveTimeout();
    } else {
        endActivePlayer();
    }

    broadcastQueue();
}

/**
 * Grab handler:
 * - Only one grab per credit.
 * - After grab, shorten remaining time to GRAB_FINISH_MS,
 *   then end the credit automatically.
 */
function handleGrabIfAllowed() {
    if (!active) return { ok: false, error: 'no_active' };
    if (active.grabUsed) return { ok: false, error: 'grab_already_used' };

    // If timer not started yet, this counts as first move
    if (!active.timerStarted) {
        startCreditTimerIfNeeded(); // starts 35s timer & cancels first-move timeout
    }

    // Override current credit timer to end after grab finish
    if (active.timer) clearTimeout(active.timer);

    active.grabUsed = true;
    active.creditEndsAt = Date.now() + GRAB_FINISH_MS;

    // Tell frontend to sync timer to 7s
    pusher.trigger('public-chat', 'credit-start', {
        donationId: active.donationId,
        creditEndsAt: active.creditEndsAt,
        creditsRemaining: active.creditsRemaining,
    });

    // Pulse grab on machine
    gpio.pulse('grab', 300);

    // End credit after claw finishes movement
    active.timer = setTimeout(() => {
        if (!active) return;

        useOneCredit(active.donationId);
        active.creditsRemaining -= 1;

        if (active.creditsRemaining > 0) {
            active.timerStarted = false;
            active.creditEndsAt = null;
            active.hasMoved = false;
            active.grabUsed = false;

            scheduleFirstMoveTimeout();
        } else {
            endActivePlayer();
        }

        broadcastQueue();
    }, GRAB_FINISH_MS);

    return { ok: true };
}

/**
 * End the active player session and start next.
 */
function endActivePlayer() {
    if (!active) return;

    if (active.timer) clearTimeout(active.timer);
    if (active.firstMoveTimer) clearTimeout(active.firstMoveTimer);

    gpio.releaseAll();

    setDonationStatus(active.donationId, 'done');
    pusher.trigger('public-chat', 'player-end', { donationId: active.donationId });

    active = null;
    maybeStartNext();
}

function isActiveTokenDonation(donation) {
    return active && donation && donation.id === active.donationId;
}

function getActiveState() {
    return active
        ? {
            activeDonationId: active.donationId,
            creditEndsAt: active.creditEndsAt,
            firstMoveDeadline: active.firstMoveDeadline,
        }
        : {
            activeDonationId: null,
            creditEndsAt: null,
            firstMoveDeadline: null,
        };
}

/**
 * Called when Mollie confirms payment.
 */
function handlePaidDonation({ intentId, molliePaymentId, amountEur }) {
    const creditsTotal = Math.min(5, Math.floor(amountEur));

    markIntentPaid({
        intentId,
        molliePaymentId,
        amountEur,
        creditsTotal,
    });

    maybeStartNext();
    broadcastQueue();

    return { creditsTotal };
}

module.exports = {
    handlePaidDonation,
    maybeStartNext,
    startCreditTimerIfNeeded,
    handleGrabIfAllowed,
    isActiveTokenDonation,
    broadcastQueue,
    getActiveState,
};

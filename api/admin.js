const express = require('express');
const {
    listAllDonations,
    adjustCredits,
    setCreditsTotal,
    setCreditsUsed,
    deleteDonationById,
    deleteAllDonations,
    requeueToEnd,
    setDonationStatus,
} = require('./db');

/**
 * Admin router factory
 * @param {object} game - game module instance
 */
function createAdminRouter(game) {
    const router = express.Router();

    /**
     * Admin auth middleware:
     * - Supports Authorization: Bearer <token>
     * - Also supports x-admin-token header for simplicity
     * - Token is stored ONLY on backend in ADMIN_TOKEN env var
     */
    function requireAdmin(req, res, next) {
        const bearer = req.headers.authorization?.startsWith('Bearer ')
            ? req.headers.authorization.slice(7)
            : null;

        const headerToken = req.headers['x-admin-token'];
        const token = bearer || headerToken || req.query.adminToken;

        if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
            return res.status(403).json({ error: 'forbidden' });
        }

        next();
    }

    /**
     * Helper: safe end active player without crashing if game.forceEndActive isn't implemented.
     */
    function safeForceEndActive(reason = 'admin') {
        if (typeof game.forceEndActive === 'function') {
            game.forceEndActive(reason);
            return;
        }

        // fallback (no gpio timers access here)
        const activeId = game.getActiveState?.().activeDonationId;
        if (activeId) {
            setDonationStatus(Number(activeId), 'done');
        }
        game.maybeStartNext?.();
        game.broadcastQueue?.();
    }

    /**
     * GET /api/admin/donations
     * List all donations (created/waiting/active/done).
     */
    router.get('/donations', requireAdmin, (req, res) => {
        const rows = listAllDonations();
        const activeDonationId = game.getActiveState?.().activeDonationId || null;
        return res.json({ donations: rows, activeDonationId });
    });

    /**
     * POST /api/admin/credits/add
     * Body: { id, delta }
     */
    router.post('/credits/add', requireAdmin, (req, res) => {
        const { id, delta } = req.body;
        if (!id || typeof delta !== 'number') {
            return res.status(400).json({ error: 'id and numeric delta required' });
        }

        const updated = adjustCredits(Number(id), delta);
        game.maybeStartNext?.();
        game.broadcastQueue?.();

        return res.json({ ok: true, donation: updated });
    });

    /**
     * POST /api/admin/credits/set-total
     * Body: { id, creditsTotal }
     */
    router.post('/credits/set-total', requireAdmin, (req, res) => {
        const { id, creditsTotal } = req.body;
        if (!id || typeof creditsTotal !== 'number') {
            return res.status(400).json({ error: 'id and numeric creditsTotal required' });
        }

        const updated = setCreditsTotal(Number(id), creditsTotal);
        game.maybeStartNext?.();
        game.broadcastQueue?.();

        return res.json({ ok: true, donation: updated });
    });

    /**
     * POST /api/admin/credits/set-used
     * Body: { id, creditsUsed }
     */
    router.post('/credits/set-used', requireAdmin, (req, res) => {
        const { id, creditsUsed } = req.body;
        if (!id || typeof creditsUsed !== 'number') {
            return res.status(400).json({ error: 'id and numeric creditsUsed required' });
        }

        const updated = setCreditsUsed(Number(id), creditsUsed);
        game.maybeStartNext?.();
        game.broadcastQueue?.();

        return res.json({ ok: true, donation: updated });
    });

    /**
     * POST /api/admin/requeue
     * Body: { id }
     */
    router.post('/requeue', requireAdmin, (req, res) => {
        const { id } = req.body;
        if (!id) return res.status(400).json({ error: 'id required' });

        requeueToEnd(Number(id));
        game.maybeStartNext?.();
        game.broadcastQueue?.();

        return res.json({ ok: true });
    });

    /**
     * POST /api/admin/status/set
     * Body: { id, status }
     * status: created | waiting | active | done
     */
    router.post('/status/set', requireAdmin, (req, res) => {
        const { id, status } = req.body;
        if (!id || !status) {
            return res.status(400).json({ error: 'id and status required' });
        }

        const allowed = ['created', 'waiting', 'active', 'done'];
        if (!allowed.includes(status)) {
            return res.status(400).json({ error: 'invalid status' });
        }

        const numericId = Number(id);

        if (status === 'active') {
            // Try to use game forceActivate if exists
            if (typeof game.forceActivateDonation === 'function') {
                const ok = game.forceActivateDonation(numericId);
                if (!ok) return res.status(404).json({ error: 'not_found' });
            } else {
                // fallback: set waiting then let engine pick it normally
                setDonationStatus(numericId, 'waiting');
                game.maybeStartNext?.();
            }
        } else {
            // If moving away from active and that player is active, end them safely.
            const activeId = game.getActiveState?.().activeDonationId;
            if (activeId === numericId) {
                safeForceEndActive('admin_status_change');
            }
            setDonationStatus(numericId, status);
            game.maybeStartNext?.();
        }

        game.broadcastQueue?.();
        return res.json({ ok: true });
    });

    /**
     * POST /api/admin/player/end-active
     */
    router.post('/player/end-active', requireAdmin, (req, res) => {
        safeForceEndActive('admin_end');
        return res.json({ ok: true });
    });

    /**
     * POST /api/admin/player/start-next
     */
    router.post('/player/start-next', requireAdmin, (req, res) => {
        game.maybeStartNext?.();
        game.broadcastQueue?.();
        return res.json({ ok: true });
    });

    /**
     * DELETE /api/admin/donations/:id
     */
    router.delete('/donations/:id', requireAdmin, (req, res) => {
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'invalid id' });

        const activeId = game.getActiveState?.().activeDonationId;
        if (activeId === id) {
            safeForceEndActive('admin_delete_active');
        }

        deleteDonationById(id);
        game.maybeStartNext?.();
        game.broadcastQueue?.();

        return res.json({ ok: true });
    });

    /**
     * DELETE /api/admin/donations
     */
    router.delete('/donations', requireAdmin, (req, res) => {
        safeForceEndActive('admin_delete_all');
        deleteAllDonations();
        game.broadcastQueue?.();
        return res.json({ ok: true });
    });

    return router;
}

module.exports = createAdminRouter;

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Pusher from 'pusher-js';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

const SOKETI_KEY = process.env.NEXT_PUBLIC_SOKETI_APP_KEY || process.env.NEXT_PUBLIC_SOKETI_KEY;
const WS_HOST = process.env.NEXT_PUBLIC_SOKETI_WS_HOST;
const WS_PORT = Number(process.env.NEXT_PUBLIC_SOKETI_WS_PORT || 443);
const FORCE_TLS = process.env.NEXT_PUBLIC_SOKETI_FORCE_TLS === 'true';

// Admin token is never hardcoded.
// It is entered manually and stored locally for convenience.
const ADMIN_TOKEN_STORAGE_KEY = 'sweet_admin_token';

const STATUS_OPTIONS = ['created', 'waiting', 'active', 'done'];

function ConfirmModal({
    open,
    title,
    text,
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    onConfirm,
    onCancel,
}) {
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-700 shadow-xl p-5">
                <h3 className="text-lg font-bold text-slate-100 mb-2">{title}</h3>
                <p className="text-sm text-slate-300 mb-5 whitespace-pre-line">{text}</p>

                <div className="flex items-center justify-end gap-2">
                    <button
                        className="px-4 py-2 rounded-xl bg-slate-700 text-slate-100 hover:bg-slate-600"
                        onClick={onCancel}
                    >
                        {cancelText}
                    </button>
                    <button
                        className="px-4 py-2 rounded-xl bg-red-600 text-white hover:bg-red-500 font-semibold"
                        onClick={onConfirm}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function AdminPage() {
    const [adminToken, setAdminToken] = useState('');
    const [isAuthed, setIsAuthed] = useState(false);

    const [donations, setDonations] = useState([]);
    const [activeDonationId, setActiveDonationId] = useState(null);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);

    const [confirmState, setConfirmState] = useState({
        open: false,
        title: '',
        text: '',
        onConfirm: null,
    });

    const pusherRef = useRef(null);
    const channelRef = useRef(null);
    const noticeTimerRef = useRef(null);

    function showNotice(type, text, ms = 3500) {
        setNotice({ type, text });
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = setTimeout(() => setNotice(null), ms);
    }

    function authHeaders(tokenOverride) {
        return {
            'Content-Type': 'application/json',
            'x-admin-token': tokenOverride ?? adminToken,
        };
    }

    /**
     * Verify token against backend before entering admin mode.
     * If invalid, clear local storage and stay on login screen.
     */
    async function verifyToken(tokenToCheck) {
        if (!tokenToCheck) return false;

        try {
            const res = await fetch(`${API_BASE_URL}/api/admin/donations?t=${Date.now()}`, {
                headers: authHeaders(tokenToCheck),
                cache: 'no-store',
            });

            if (!res.ok) return false;

            // Token is valid
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Load admin-controlled state ONLY when authenticated.
     */
    async function fetchAdminState({ silent = false } = {}) {
        if (!isAuthed || !adminToken) return;
        if (!silent) setLoading(true);
        setError(null);

        try {
            const res = await fetch(`${API_BASE_URL}/api/admin/donations?t=${Date.now()}`, {
                headers: authHeaders(),
                cache: 'no-store',
            });

            if (!res.ok) {
                // If auth expired/invalid, force logout and show login form
                if (res.status === 403) {
                    logout();
                    setError('Invalid admin token.');
                    return;
                }
                setError('Failed to load admin data.');
                return;
            }

            const data = await res.json();
            setDonations(data.donations || []);
            setActiveDonationId(data.activeDonationId || null);
        } catch {
            setError('Network error while loading admin data.');
        } finally {
            if (!silent) setLoading(false);
        }
    }

    /**
     * On mount: load token from localStorage (if any) and validate it.
     * We do NOT auto-auth until backend confirms it's valid.
     */
    useEffect(() => {
        const saved = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
        if (!saved) return;

        (async () => {
            setAdminToken(saved);
            const ok = await verifyToken(saved);
            if (ok) {
                setIsAuthed(true);
                showNotice('ok', 'Admin token verified.');
            } else {
                localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
                setAdminToken('');
                setIsAuthed(false);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * Realtime updates from game channel when authenticated.
     */
    useEffect(() => {
        if (!isAuthed) return;

        pusherRef.current = new Pusher(SOKETI_KEY, {
            wsHost: WS_HOST,
            wsPort: WS_PORT,
            wssPort: WS_PORT,
            forceTLS: FORCE_TLS,
            enabledTransports: ['ws', 'wss'],
            cluster: 'mt1',
        });

        channelRef.current = pusherRef.current.subscribe('public-chat');

        // Any queue update can affect admin view, so refresh silently
        const refresh = () => fetchAdminState({ silent: true });

        channelRef.current.bind('queue-update', refresh);
        channelRef.current.bind('player-start', refresh);
        channelRef.current.bind('player-end', refresh);
        channelRef.current.bind('player-timeout', refresh);
        channelRef.current.bind('credit-start', refresh);

        return () => {
            channelRef.current?.unbind_all();
            pusherRef.current?.disconnect();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthed]);

    /**
     * Backup polling for worst-case networks.
     */
    useEffect(() => {
        if (!isAuthed) return;
        fetchAdminState();
        const poll = setInterval(() => fetchAdminState({ silent: true }), 7000);
        return () => clearInterval(poll);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthed]);

    async function saveToken() {
        const tok = adminToken.trim();
        if (!tok) {
            showNotice('error', 'Please enter a token.');
            return;
        }

        const ok = await verifyToken(tok);
        if (!ok) {
            showNotice('error', 'Invalid admin token.');
            return;
        }

        localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, tok);
        setAdminToken(tok);
        setIsAuthed(true);
        showNotice('ok', 'Admin token saved & verified.');
    }

    function logout() {
        localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
        setIsAuthed(false);
        setAdminToken('');
        setDonations([]);
        setActiveDonationId(null);
    }

    async function adminPost(path, body) {
        const res = await fetch(`${API_BASE_URL}${path}`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify(body || {}),
        });
        if (!res.ok) {
            if (res.status === 403) logout();
            throw new Error('admin_post_failed');
        }
        return res.json().catch(() => ({}));
    }

    async function adminDelete(path) {
        const res = await fetch(`${API_BASE_URL}${path}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });
        if (!res.ok) {
            if (res.status === 403) logout();
            throw new Error('admin_delete_failed');
        }
        return res.json().catch(() => ({}));
    }

    async function handleAddCredits(id, delta) {
        try {
            await adminPost('/api/admin/credits/add', { id, delta });
            showNotice('ok', delta > 0 ? `Added ${delta} credit(s).` : `Removed ${Math.abs(delta)} credit(s).`);
            fetchAdminState({ silent: true });
        } catch {
            showNotice('error', 'Failed to adjust credits.');
        }
    }

    async function handleSetTotal(id) {
        const val = prompt('Set TOTAL credits to:', '');
        if (val === null) return;
        const creditsTotal = Number(val);
        if (Number.isNaN(creditsTotal)) {
            showNotice('error', 'Invalid number.');
            return;
        }
        try {
            await adminPost('/api/admin/credits/set-total', { id, creditsTotal });
            showNotice('ok', 'Total credits updated.');
            fetchAdminState({ silent: true });
        } catch {
            showNotice('error', 'Failed to set total credits.');
        }
    }

    async function handleSetUsed(id) {
        const val = prompt('Set USED credits to:', '');
        if (val === null) return;
        const creditsUsed = Number(val);
        if (Number.isNaN(creditsUsed)) {
            showNotice('error', 'Invalid number.');
            return;
        }
        try {
            await adminPost('/api/admin/credits/set-used', { id, creditsUsed });
            showNotice('ok', 'Used credits updated.');
            fetchAdminState({ silent: true });
        } catch {
            showNotice('error', 'Failed to set used credits.');
        }
    }

    async function handleRequeue(id) {
        try {
            await adminPost('/api/admin/requeue', { id });
            showNotice('ok', 'Player moved to end of queue.');
            fetchAdminState({ silent: true });
        } catch {
            showNotice('error', 'Failed to requeue player.');
        }
    }

    async function handleSetStatus(id, status) {
        try {
            await adminPost('/api/admin/status/set', { id, status });
            showNotice('ok', `Status set to ${status}.`);
            fetchAdminState({ silent: true });
        } catch {
            showNotice('error', 'Failed to set status.');
        }
    }

    async function handleForceStartNext() {
        try {
            await adminPost('/api/admin/player/start-next');
            showNotice('ok', 'Started next player.');
            fetchAdminState({ silent: true });
        } catch {
            showNotice('error', 'Failed to start next player.');
        }
    }

    async function handleForceEndActive() {
        try {
            await adminPost('/api/admin/player/end-active');
            showNotice('ok', 'Ended active player.');
            fetchAdminState({ silent: true });
        } catch {
            showNotice('error', 'Failed to end active player.');
        }
    }

    function confirmDeleteOne(id, name) {
        setConfirmState({
            open: true,
            title: 'Delete player?',
            text: `You are about to permanently delete:\n\n#${id} - ${name}\n\nThis cannot be undone.`,
            onConfirm: async () => {
                setConfirmState(s => ({ ...s, open: false }));
                try {
                    await adminDelete(`/api/admin/donations/${id}`);
                    showNotice('ok', 'Player deleted.');
                    fetchAdminState({ silent: true });
                } catch {
                    showNotice('error', 'Failed to delete player.');
                }
            },
        });
    }

    function confirmDeleteAll() {
        setConfirmState({
            open: true,
            title: 'Delete ALL data?',
            text: `This will permanently delete ALL donations and queue data.\n\nThis cannot be undone.`,
            onConfirm: async () => {
                setConfirmState(s => ({ ...s, open: false }));
                try {
                    await adminDelete('/api/admin/donations');
                    showNotice('ok', 'All donations deleted.');
                    fetchAdminState({ silent: true });
                } catch {
                    showNotice('error', 'Failed to delete all data.');
                }
            },
        });
    }

    const visibleDonations = useMemo(() => donations || [], [donations]);

    // ========= LOGIN SCREEN =========
    if (!isAuthed) {
        return (
            <main className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-4">
                <div className="w-full max-w-md bg-slate-800 rounded-2xl p-6 border border-slate-700">
                    <h1 className="text-xl font-extrabold mb-2">Admin Panel</h1>
                    <p className="text-sm text-slate-300 mb-4">
                        Enter the admin token to access realtime controls.
                    </p>

                    <input
                        type="password"
                        className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-sm mb-3"
                        placeholder="Admin token"
                        value={adminToken}
                        onChange={(e) => setAdminToken(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') saveToken();
                        }}
                    />

                    <button
                        className="w-full rounded-xl px-4 py-2 bg-emerald-600 hover:bg-emerald-500 font-semibold"
                        onClick={saveToken}
                    >
                        Enter Admin
                    </button>

                    {notice && (
                        <div className={`mt-3 text-sm ${notice.type === 'error' ? 'text-red-300' : 'text-emerald-300'}`}>
                            {notice.text}
                        </div>
                    )}
                </div>
            </main>
        );
    }

    // ========= ADMIN SCREEN =========
    return (
        <main className="min-h-screen bg-slate-900 text-slate-100 px-4 py-6">
            <ConfirmModal
                open={confirmState.open}
                title={confirmState.title}
                text={confirmState.text}
                confirmText="Delete"
                cancelText="Cancel"
                onCancel={() => setConfirmState(s => ({ ...s, open: false }))}
                onConfirm={confirmState.onConfirm}
            />

            {notice && (
                <div
                    className={`max-w-6xl mx-auto mb-4 p-3 rounded-xl text-sm font-semibold border
                    ${notice.type === 'error'
                            ? 'bg-red-600/20 border-red-500 text-red-200'
                            : 'bg-emerald-700/20 border-emerald-500 text-emerald-200'
                        }`}
                >
                    {notice.text}
                </div>
            )}

            <header className="max-w-6xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6">
                <div>
                    <h1 className="text-2xl font-extrabold">🛠️ Admin Control</h1>
                    <div className="text-xs text-slate-400 mt-1">
                        Realtime queue + player management
                    </div>
                </div>

                <div className="flex flex-wrap gap-2">
                    <button
                        className="px-3 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-sm"
                        onClick={() => fetchAdminState()}
                    >
                        Refresh
                    </button>
                    <button
                        className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold"
                        onClick={handleForceStartNext}
                    >
                        Start Next
                    </button>
                    <button
                        className="px-3 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-sm font-semibold text-black"
                        onClick={handleForceEndActive}
                    >
                        End Active
                    </button>
                    <button
                        className="px-3 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-sm font-semibold"
                        onClick={confirmDeleteAll}
                    >
                        Delete All
                    </button>
                    <button
                        className="px-3 py-2 rounded-xl bg-slate-800 border border-slate-700 text-sm"
                        onClick={logout}
                    >
                        Logout
                    </button>
                </div>
            </header>

            <section className="max-w-6xl mx-auto">
                <div className="flex items-center justify-between mb-3">
                    <h2 className="text-lg font-bold">Players / Donations</h2>
                    <div className="text-xs text-slate-400">
                        Total: {visibleDonations.length} | Active ID: {activeDonationId ?? '—'}
                    </div>
                </div>

                {error && (
                    <div className="mb-3 text-sm text-red-300">
                        {error}
                    </div>
                )}

                {loading && (
                    <div className="mb-3 text-sm text-slate-300">
                        Loading…
                    </div>
                )}

                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto bg-slate-800 rounded-2xl border border-slate-700">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-900/60 text-slate-300">
                            <tr>
                                <th className="text-left p-3">ID</th>
                                <th className="text-left p-3">Name</th>
                                <th className="text-left p-3">Status</th>
                                <th className="text-left p-3">Credits</th>
                                <th className="text-left p-3">Payment</th>
                                <th className="text-left p-3">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {visibleDonations.map((d) => {
                                const remaining = (d.credits_total || 0) - (d.credits_used || 0);
                                const isActiveRow = d.id === activeDonationId || d.status === 'active';

                                return (
                                    <tr key={d.id} className={`border-t border-slate-700 ${isActiveRow ? 'bg-emerald-700/10' : ''}`}>
                                        <td className="p-3 font-semibold">{d.id}</td>
                                        <td className="p-3">
                                            <div className="font-semibold">{d.name}</div>
                                            {d.email && <div className="text-xs text-slate-400">{d.email}</div>}
                                        </td>
                                        <td className="p-3">
                                            <select
                                                className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs"
                                                value={d.status}
                                                onChange={(e) => handleSetStatus(d.id, e.target.value)}
                                            >
                                                {STATUS_OPTIONS.map(s => (
                                                    <option key={s} value={s}>{s}</option>
                                                ))}
                                            </select>
                                        </td>
                                        <td className="p-3">
                                            <div className="text-xs text-slate-300">
                                                total: <b>{d.credits_total}</b> / used: <b>{d.credits_used}</b> / remaining: <b>{remaining}</b>
                                            </div>
                                        </td>
                                        <td className="p-3 text-xs text-slate-300">
                                            req: {d.amount_requested_eur ?? '—'}€
                                            <br />
                                            paid: {d.amount_eur ?? '—'}€
                                        </td>
                                        <td className="p-3">
                                            <div className="flex flex-wrap gap-1">
                                                <button
                                                    className="px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold"
                                                    onClick={() => handleAddCredits(d.id, 1)}
                                                >
                                                    +1
                                                </button>
                                                <button
                                                    className="px-2 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-xs font-semibold"
                                                    onClick={() => handleAddCredits(d.id, 5)}
                                                >
                                                    +5
                                                </button>
                                                <button
                                                    className="px-2 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs"
                                                    onClick={() => handleAddCredits(d.id, -1)}
                                                >
                                                    -1
                                                </button>
                                                <button
                                                    className="px-2 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs"
                                                    onClick={() => handleSetTotal(d.id)}
                                                >
                                                    Set Total
                                                </button>
                                                <button
                                                    className="px-2 py-1 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs"
                                                    onClick={() => handleSetUsed(d.id)}
                                                >
                                                    Set Used
                                                </button>
                                                <button
                                                    className="px-2 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-semibold"
                                                    onClick={() => handleRequeue(d.id)}
                                                >
                                                    Requeue
                                                </button>
                                                <button
                                                    className="px-2 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-xs font-semibold"
                                                    onClick={() => confirmDeleteOne(d.id, d.name)}
                                                >
                                                    Delete
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                            {visibleDonations.length === 0 && (
                                <tr>
                                    <td colSpan={6} className="p-4 text-center text-slate-400">
                                        No donations yet.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>

                {/* Mobile cards */}
                <div className="md:hidden space-y-3">
                    {visibleDonations.map((d) => {
                        const remaining = (d.credits_total || 0) - (d.credits_used || 0);
                        const isActiveRow = d.id === activeDonationId || d.status === 'active';

                        return (
                            <div
                                key={d.id}
                                className={`bg-slate-800 border border-slate-700 rounded-2xl p-4 ${isActiveRow ? 'ring-1 ring-emerald-500' : ''}`}
                            >
                                <div className="flex items-start justify-between">
                                    <div>
                                        <div className="text-sm font-bold">
                                            #{d.id} — {d.name}
                                        </div>
                                        {d.email && (
                                            <div className="text-xs text-slate-400 mt-0.5">{d.email}</div>
                                        )}
                                    </div>
                                    <select
                                        className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs"
                                        value={d.status}
                                        onChange={(e) => handleSetStatus(d.id, e.target.value)}
                                    >
                                        {STATUS_OPTIONS.map(s => (
                                            <option key={s} value={s}>{s}</option>
                                        ))}
                                    </select>
                                </div>

                                <div className="text-xs text-slate-300 mt-2">
                                    Credits: total <b>{d.credits_total}</b> / used <b>{d.credits_used}</b> / remaining <b>{remaining}</b>
                                </div>
                                <div className="text-xs text-slate-300 mt-1">
                                    Payment: req {d.amount_requested_eur ?? '—'}€ / paid {d.amount_eur ?? '—'}€
                                </div>

                                <div className="flex flex-wrap gap-2 mt-3">
                                    <button
                                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold"
                                        onClick={() => handleAddCredits(d.id, 1)}
                                    >
                                        +1
                                    </button>
                                    <button
                                        className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-xs font-semibold"
                                        onClick={() => handleAddCredits(d.id, 5)}
                                    >
                                        +5
                                    </button>
                                    <button
                                        className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs"
                                        onClick={() => handleAddCredits(d.id, -1)}
                                    >
                                        -1
                                    </button>
                                    <button
                                        className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs"
                                        onClick={() => handleSetTotal(d.id)}
                                    >
                                        Set Total
                                    </button>
                                    <button
                                        className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs"
                                        onClick={() => handleSetUsed(d.id)}
                                    >
                                        Set Used
                                    </button>
                                    <button
                                        className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-semibold"
                                        onClick={() => handleRequeue(d.id)}
                                    >
                                        Requeue
                                    </button>
                                    <button
                                        className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-xs font-semibold"
                                        onClick={() => confirmDeleteOne(d.id, d.name)}
                                    >
                                        Delete
                                    </button>
                                </div>
                            </div>
                        );
                    })}

                    {visibleDonations.length === 0 && (
                        <div className="text-center text-sm text-slate-400 py-8">
                            No donations yet.
                        </div>
                    )}
                </div>
            </section>
        </main>
    );
}

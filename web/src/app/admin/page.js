'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Pusher from 'pusher-js';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

const SOKETI_KEY = process.env.NEXT_PUBLIC_SOKETI_KEY;
const WS_HOST = process.env.NEXT_PUBLIC_SOKETI_WS_HOST;
const WS_PORT = Number(process.env.NEXT_PUBLIC_SOKETI_WS_PORT || 443);
const FORCE_TLS = process.env.NEXT_PUBLIC_SOKETI_FORCE_TLS === 'true';

const ADMIN_TOKEN_KEY = 'super-secret-admin-token-4213456478201';

export default function AdminPage() {
    const [adminToken, setAdminToken] = useState('');
    const [donations, setDonations] = useState([]);
    const [activeDonationId, setActiveDonationId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [q, setQ] = useState('');

    const fetchState = async (token = adminToken) => {
        if (!token) return;
        setLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/admin/state`, {
                headers: {
                    'x-admin-token': token,
                },
            });
            if (!res.ok) throw new Error('unauthorized');

            const data = await res.json();
            setDonations(data.donations || []);
            setActiveDonationId(data.activeDonationId || null);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    // Load token from localStorage
    useEffect(() => {
        const t = localStorage.getItem(ADMIN_TOKEN_KEY) || '';
        setAdminToken(t);
        if (t) fetchState(t);
    }, []);

    // Realtime updates via Pusher
    useEffect(() => {
        if (!adminToken) return;

        const pusher = new Pusher(SOKETI_KEY, {
            wsHost: WS_HOST,
            wsPort: WS_PORT,
            wssPort: WS_PORT,
            forceTLS: FORCE_TLS,
            enabledTransports: ['ws', 'wss'],
            cluster: 'mt1',
        });

        const channel = pusher.subscribe('public-chat');

        const refresh = () => fetchState(adminToken);

        channel.bind('queue-update', refresh);
        channel.bind('player-start', refresh);
        channel.bind('player-end', refresh);
        channel.bind('player-timeout', refresh);
        channel.bind('credit-start', refresh);

        return () => {
            channel.unbind_all();
            pusher.disconnect();
        };
    }, [adminToken]);

    const filtered = useMemo(() => {
        if (!q.trim()) return donations;
        const s = q.toLowerCase();
        return donations.filter(d =>
            String(d.id).includes(s) ||
            d.name?.toLowerCase().includes(s) ||
            d.email?.toLowerCase().includes(s) ||
            d.status?.toLowerCase().includes(s)
        );
    }, [donations, q]);

    const callAdmin = async (path, body) => {
        const res = await fetch(`${API_BASE_URL}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-token': adminToken,
            },
            body: JSON.stringify(body || {}),
        });
        if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            alert(j.error || 'Admin action failed');
            return null;
        }
        return res.json();
    };

    return (
        <main className="min-h-screen bg-slate-900 text-slate-100 p-6">
            <header className="max-w-6xl mx-auto flex flex-col md:flex-row gap-3 md:items-center md:justify-between mb-6">
                <h1 className="text-2xl font-extrabold">🛠️ Admin Dashboard</h1>

                <div className="flex gap-2">
                    <input
                        className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-sm w-64"
                        placeholder="Admin Token"
                        value={adminToken}
                        onChange={(e) => setAdminToken(e.target.value)}
                    />
                    <button
                        className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-bold"
                        onClick={() => {
                            localStorage.setItem(ADMIN_TOKEN_KEY, adminToken);
                            fetchState(adminToken);
                        }}
                    >
                        Save & Load
                    </button>
                </div>
            </header>

            <div className="max-w-6xl mx-auto mb-4 flex items-center justify-between gap-3">
                <input
                    className="flex-1 px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-sm"
                    placeholder="Search by id / name / email / status"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                />

                <button
                    className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm"
                    onClick={() => fetchState()}
                >
                    Refresh
                </button>

                <button
                    className="px-3 py-2 rounded-lg bg-red-600/80 hover:bg-red-500 text-sm font-bold"
                    onClick={() => {
                        if (confirm('Release ALL GPIO now?')) {
                            callAdmin('/api/admin/gpio/release-all');
                        }
                    }}
                >
                    Emergency Stop
                </button>
            </div>

            <section className="max-w-6xl mx-auto bg-slate-800 rounded-2xl p-4">
                {loading && <div className="text-slate-300 text-sm">Loading…</div>}

                {!loading && filtered.length === 0 && (
                    <div className="text-slate-400 text-sm">No donations.</div>
                )}

                {!loading && filtered.length > 0 && (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="text-slate-300">
                                <tr className="border-b border-slate-700">
                                    <th className="text-left p-2">ID</th>
                                    <th className="text-left p-2">Name</th>
                                    <th className="text-left p-2">Status</th>
                                    <th className="text-left p-2">Credits</th>
                                    <th className="text-left p-2">Remaining</th>
                                    <th className="text-left p-2">Last Activity</th>
                                    <th className="text-left p-2">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((d) => {
                                    const remaining = d.creditsRemaining;
                                    const isActive = d.id === activeDonationId;

                                    return (
                                        <tr
                                            key={d.id}
                                            className="border-b border-slate-700/70 hover:bg-slate-900/40"
                                        >
                                            <td className="p-2 font-mono">{d.id}</td>
                                            <td className="p-2 font-semibold">{d.name}</td>
                                            <td className="p-2">
                                                <span
                                                    className={`px-2 py-1 rounded-md text-xs font-bold ${isActive
                                                        ? 'bg-emerald-700/40 text-emerald-200'
                                                        : d.status === 'waiting'
                                                            ? 'bg-slate-700 text-slate-200'
                                                            : d.status === 'hold'
                                                                ? 'bg-amber-700/40 text-amber-200'
                                                                : d.status === 'done'
                                                                    ? 'bg-red-700/40 text-red-200'
                                                                    : 'bg-slate-600 text-white'
                                                        }`}
                                                >
                                                    {isActive ? 'ACTIVE' : d.status}
                                                </span>
                                            </td>
                                            <td className="p-2">
                                                {d.credits_used}/{d.credits_total}
                                            </td>
                                            <td className="p-2 font-bold">{remaining}</td>
                                            <td className="p-2 text-xs text-slate-400">
                                                {d.last_activity_at || '—'}
                                            </td>
                                            <td className="p-2">
                                                <div className="flex flex-wrap gap-2">
                                                    <button
                                                        className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs"
                                                        onClick={() =>
                                                            callAdmin(`/api/admin/donations/${d.id}/move`, {
                                                                target: 'front',
                                                            })
                                                        }
                                                    >
                                                        To Front
                                                    </button>

                                                    <button
                                                        className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs"
                                                        onClick={() =>
                                                            callAdmin(`/api/admin/donations/${d.id}/move`, {
                                                                target: 'end',
                                                            })
                                                        }
                                                    >
                                                        To End
                                                    </button>

                                                    <button
                                                        className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-xs font-bold"
                                                        onClick={() =>
                                                            callAdmin(`/api/admin/active/start`, { id: d.id })
                                                        }
                                                    >
                                                        Make Active
                                                    </button>

                                                    <button
                                                        className="px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 text-xs"
                                                        onClick={() =>
                                                            callAdmin(`/api/admin/donations/${d.id}/status`, {
                                                                status: 'hold',
                                                            })
                                                        }
                                                    >
                                                        Hold
                                                    </button>

                                                    <button
                                                        className="px-2 py-1 rounded bg-red-600 hover:bg-red-500 text-xs"
                                                        onClick={() =>
                                                            callAdmin(`/api/admin/donations/${d.id}/status`, {
                                                                status: 'done',
                                                            })
                                                        }
                                                    >
                                                        Done
                                                    </button>

                                                    <button
                                                        className="px-2 py-1 rounded bg-slate-600 hover:bg-slate-500 text-xs"
                                                        onClick={() =>
                                                            callAdmin(`/api/admin/donations/${d.id}/credits`, {
                                                                delta: +1,
                                                            })
                                                        }
                                                    >
                                                        +1 Credit
                                                    </button>

                                                    <button
                                                        className="px-2 py-1 rounded bg-slate-600 hover:bg-slate-500 text-xs"
                                                        onClick={() =>
                                                            callAdmin(`/api/admin/donations/${d.id}/credits`, {
                                                                delta: -1,
                                                            })
                                                        }
                                                    >
                                                        -1 Credit
                                                    </button>

                                                    <button
                                                        className="px-2 py-1 rounded bg-slate-600 hover:bg-slate-500 text-xs"
                                                        onClick={() => {
                                                            const used = prompt(
                                                                'Set credits_used to:',
                                                                String(d.credits_used)
                                                            );
                                                            if (used === null) return;
                                                            callAdmin(
                                                                `/api/admin/donations/${d.id}/credits-used`,
                                                                { used: Number(used) }
                                                            );
                                                        }}
                                                    >
                                                        Set Used
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            <section className="max-w-6xl mx-auto mt-5 flex gap-3">
                <button
                    className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm"
                    onClick={() =>
                        callAdmin('/api/admin/active/stop', { status: 'waiting' })
                    }
                >
                    Stop Active (to waiting)
                </button>

                <button
                    className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-sm"
                    onClick={() =>
                        callAdmin('/api/admin/active/stop', { status: 'hold' })
                    }
                >
                    Stop Active (hold)
                </button>

                <button
                    className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-sm font-bold"
                    onClick={() =>
                        callAdmin('/api/admin/active/stop', { status: 'done' })
                    }
                >
                    Stop Active (done)
                </button>

                <button
                    className="ml-auto px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-sm font-bold"
                    onClick={() => {
                        if (confirm('CLEAR ALL DONATIONS? This is irreversible.')) {
                            callAdmin('/api/admin/db/clear');
                        }
                    }}
                >
                    Clear DB
                </button>
            </section>
        </main>
    );
}

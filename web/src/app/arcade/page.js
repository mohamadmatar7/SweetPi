'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Pusher from 'pusher-js';
import Controls from '../components/Controls';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

const SOKETI_KEY = process.env.NEXT_PUBLIC_SOKETI_KEY;
const WS_HOST = process.env.NEXT_PUBLIC_SOKETI_WS_HOST;
const WS_PORT = Number(process.env.NEXT_PUBLIC_SOKETI_WS_PORT || 443);
const FORCE_TLS = process.env.NEXT_PUBLIC_SOKETI_FORCE_TLS === 'true';

const TOKEN_KEY = 'sweet_token';
const CREDIT_SECONDS = 35;

export default function ArcadePage() {
    const router = useRouter();

    const [token, setToken] = useState(null);
    const [me, setMe] = useState(null);
    const [queue, setQueue] = useState([]);

    const [activeDonationId, setActiveDonationId] = useState(null);
    const [firstMoveDeadline, setFirstMoveDeadline] = useState(null);

    // Notice banner for the user (re-queued, etc.)
    const [notice, setNotice] = useState(null); // { type: 'error'|'info', text: string }

    // Credit timer synced to server creditEndsAt (survives refresh)
    const [secondsLeft, setSecondsLeft] = useState(CREDIT_SECONDS);
    const [timerRunning, setTimerRunning] = useState(false);
    const timerRef = useRef(null);
    const endsAtRef = useRef(null);

    // First-move countdown (15s) shown while waiting for the first move of a credit
    const [firstMoveSecondsLeft, setFirstMoveSecondsLeft] = useState(null);
    const firstMoveIntervalRef = useRef(null);

    // Detect credits drop to reset UI between credits
    const prevCreditsRef = useRef(null);

    // Auto-dismiss notice
    const noticeTimerRef = useRef(null);

    // Keep latest me.id in a ref to avoid stale closures in socket handlers
    const meIdRef = useRef(null);
    useEffect(() => {
        meIdRef.current = me?.id ?? null;
    }, [me?.id]);

    // Read token on mount
    useEffect(() => {
        const t = localStorage.getItem(TOKEN_KEY);
        if (!t) {
            router.replace('/');
            return;
        }
        setToken(t);
    }, [router]);

    /**
     * Start (or re-sync) the 35s credit timer from server deadline.
     */
    function startTimerWithEndsAt(endsAt) {
        if (!endsAt) return;

        endsAtRef.current = endsAt;

        if (timerRef.current) clearInterval(timerRef.current);

        setTimerRunning(true);

        timerRef.current = setInterval(() => {
            const left = Math.max(0, Math.ceil((endsAtRef.current - Date.now()) / 1000));
            setSecondsLeft(left);
            if (left <= 0) stopTimer();
        }, 1000);

        // Update instantly
        const leftNow = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
        setSecondsLeft(leftNow);
    }

    function stopTimer() {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        endsAtRef.current = null;
        setTimerRunning(false);
    }

    function showNotice(type, text, ms = 5000) {
        setNotice({ type, text });
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = setTimeout(() => setNotice(null), ms);
    }

    /**
     * Am I currently the active player?
     */
    const isActive = useMemo(() => {
        return me && me.status === 'active' && activeDonationId === me.id;
    }, [me, activeDonationId]);

    /**
     * Maintain a live 15s countdown while:
     * - I'm active
     * - credit timer has NOT started yet
     * - a firstMoveDeadline exists
     */
    useEffect(() => {
        // Clear any existing interval
        if (firstMoveIntervalRef.current) {
            clearInterval(firstMoveIntervalRef.current);
            firstMoveIntervalRef.current = null;
        }

        if (!isActive || timerRunning || !firstMoveDeadline) {
            setFirstMoveSecondsLeft(null);
            return;
        }

        const update = () => {
            const left = Math.max(
                0,
                Math.ceil((firstMoveDeadline - Date.now()) / 1000)
            );
            setFirstMoveSecondsLeft(left);
        };

        update();
        firstMoveIntervalRef.current = setInterval(update, 1000);

        return () => {
            if (firstMoveIntervalRef.current) {
                clearInterval(firstMoveIntervalRef.current);
                firstMoveIntervalRef.current = null;
            }
        };
    }, [isActive, timerRunning, firstMoveDeadline]);

    /**
     * Load initial state + connect realtime sockets.
     */
    useEffect(() => {
        if (!token) return;

        let pusher;
        let channel;

        async function loadInitial() {
            // Get current player by token
            const meRes = await fetch(`${API_BASE_URL}/api/me?token=${token}`);
            if (!meRes.ok) {
                localStorage.removeItem(TOKEN_KEY);
                router.replace('/');
                return;
            }

            const meData = await meRes.json();
            setMe(meData);
            prevCreditsRef.current = meData.creditsRemaining;

            // Get queue + active state for refresh sync
            const qRes = await fetch(`${API_BASE_URL}/api/queue`);
            const qData = await qRes.json();

            setQueue(qData.queue || []);
            setActiveDonationId(qData.activeDonationId || null);
            setFirstMoveDeadline(qData.firstMoveDeadline || null);

            // If I'm active and credit already started, re-sync timer on refresh
            if (meData.status === 'active' && qData.activeDonationId === meData.id) {
                if (qData.creditEndsAt) {
                    startTimerWithEndsAt(qData.creditEndsAt);
                }
            }
        }

        loadInitial();

        // Setup Pusher client for Soketi
        pusher = new Pusher(SOKETI_KEY, {
            wsHost: WS_HOST,
            wsPort: WS_PORT,
            wssPort: WS_PORT,
            forceTLS: FORCE_TLS,
            enabledTransports: ['ws', 'wss'],
            cluster: 'mt1', // dummy cluster required by pusher-js
        });

        channel = pusher.subscribe('public-chat');

        channel.bind('queue-update', (payload) => {
            setQueue(payload.queue || []);
            setActiveDonationId(payload.activeDonationId || null);
            setFirstMoveDeadline(payload.firstMoveDeadline || null);

            // Sync my status/credits from queue
            setMe((prev) => {
                if (!prev) return prev;
                const mine = (payload.queue || []).find(x => x.id === prev.id);
                if (!mine) return prev;

                const updated = {
                    ...prev,
                    status: mine.status,
                    creditsRemaining: mine.creditsRemaining,
                };

                // If credits dropped while active => reset UI for next credit
                if (
                    updated.status === 'active' &&
                    prevCreditsRef.current !== null &&
                    mine.creditsRemaining < prevCreditsRef.current
                ) {
                    setSecondsLeft(CREDIT_SECONDS);
                    stopTimer();
                }

                prevCreditsRef.current = mine.creditsRemaining;
                return updated;
            });
        });

        channel.bind('player-start', (payload) => {
            setActiveDonationId(payload.donationId);
            setFirstMoveDeadline(payload.firstMoveDeadline || null);

            // If I'm starting, reset UI + clear any notice
            setMe((prev) => {
                if (!prev) return prev;
                if (payload.donationId === prev.id) {
                    setSecondsLeft(CREDIT_SECONDS);
                    stopTimer();
                    setNotice(null);
                }
                return prev;
            });
        });

        channel.bind('credit-start', (payload) => {
            // Server is the source of truth for credit timers
            if (payload.donationId === meIdRef.current) {
                startTimerWithEndsAt(payload.creditEndsAt);
            }
        });

        channel.bind('player-timeout', (payload) => {
            if (payload.donationId === meIdRef.current) {
                stopTimer();
                showNotice(
                    'error',
                    'You were moved back to the queue because you did not move in time.'
                );
            }
        });

        channel.bind('player-end', (payload) => {
            if (payload.donationId === meIdRef.current) {
                stopTimer();
                localStorage.removeItem(TOKEN_KEY);
                setTimeout(() => router.replace('/'), 2500);
            }
        });

        return () => {
            channel?.unbind_all();
            pusher?.disconnect();
            stopTimer();

            if (firstMoveIntervalRef.current) {
                clearInterval(firstMoveIntervalRef.current);
                firstMoveIntervalRef.current = null;
            }

            if (noticeTimerRef.current) {
                clearTimeout(noticeTimerRef.current);
                noticeTimerRef.current = null;
            }
        };
    }, [token, router]);

    const myQueuePosition = useMemo(() => {
        if (!me) return null;
        const idx = queue.findIndex(q => q.id === me.id);
        return idx >= 0 ? idx + 1 : null;
    }, [me, queue]);

    if (!me) {
        return (
            <main className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center">
                Loading…
            </main>
        );
    }

    return (
        <main className="min-h-screen bg-slate-900 text-slate-100 px-4 py-6">
            {/* Notice banner */}
            {notice && (
                <div
                    className={`max-w-5xl mx-auto mb-4 p-3 rounded-xl text-sm font-semibold
                    ${notice.type === 'error'
                            ? 'bg-red-600/20 border border-red-500 text-red-200'
                            : 'bg-slate-700/40 border border-slate-500 text-slate-100'
                        }`}
                >
                    {notice.text}
                </div>
            )}

            <header className="max-w-5xl mx-auto flex items-center justify-between mb-6">
                <h1 className="text-2xl font-extrabold">🕹️ Live Arcade</h1>
                <div className="text-sm text-slate-300">
                    Player: <span className="font-bold">{me.name}</span>
                </div>
            </header>

            <div className="max-w-5xl mx-auto grid md:grid-cols-2 gap-6">
                {/* Left: Queue */}
                <section className="bg-slate-800 rounded-2xl p-5">
                    <h2 className="text-lg font-bold mb-3">Queue</h2>

                    <div className="space-y-2">
                        {queue.length === 0 && (
                            <div className="text-slate-400 text-sm">No players yet.</div>
                        )}

                        {queue.map((p) => (
                            <div
                                key={p.id}
                                className={`flex items-center justify-between p-3 rounded-xl ${p.status === 'active'
                                    ? 'bg-emerald-700/30 border border-emerald-500'
                                    : 'bg-slate-900'
                                    }`}
                            >
                                <div>
                                    <div className="font-semibold">
                                        {p.position}. {p.name}
                                    </div>
                                    <div className="text-xs text-slate-400">
                                        Credits: {p.creditsRemaining}
                                    </div>
                                </div>

                                <div className="text-xs">
                                    {p.status === 'active' ? 'PLAYING' : 'WAITING'}
                                </div>
                            </div>
                        ))}
                    </div>

                    {!isActive && (
                        <div className="mt-4 text-sm text-slate-300">
                            {myQueuePosition
                                ? `You are in position #${myQueuePosition}. Please wait for your turn.`
                                : 'You are not in the queue.'}
                        </div>
                    )}
                </section>

                {/* Right: Controls / Status */}
                <section className="bg-slate-800 rounded-2xl p-5 flex flex-col items-center justify-center gap-4">
                    {!isActive && (
                        <>
                            <h2 className="text-lg font-bold">Waiting…</h2>
                            <p className="text-sm text-slate-300 text-center">
                                Controls will unlock automatically when it’s your turn.
                            </p>
                        </>
                    )}

                    {isActive && (
                        <>
                            <div className="text-center space-y-1">
                                <div className="text-lg font-bold text-emerald-400">
                                    Your turn! 🎯
                                </div>

                                <div className="text-sm text-slate-300">
                                    Credits remaining: <b>{me.creditsRemaining}</b>
                                </div>

                                <div className="text-sm text-slate-300">
                                    Time left this credit: <b>{secondsLeft}s</b>
                                </div>

                                {!timerRunning && (
                                    <div className="text-xs text-slate-400">
                                        Timer starts on your first move.
                                        {firstMoveSecondsLeft !== null && (
                                            <>
                                                {' '}
                                                Move within <b>{firstMoveSecondsLeft}s</b> or you may be re-queued.
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>

                            <Controls
                                token={token}
                                onFirstAction={() => {
                                    /**
                                     * Optimistic local UX start.
                                     * Server will send "credit-start" with exact deadline anyway.
                                     * This makes UI feel instant.
                                     */
                                    if (!timerRunning && !endsAtRef.current) {
                                        startTimerWithEndsAt(Date.now() + CREDIT_SECONDS * 1000);
                                    }
                                }}
                            />
                        </>
                    )}
                </section>
            </div>
        </main>
    );
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;
const TOKEN_KEY = 'sweet_token';

export default function PlayClaimPage() {
    const router = useRouter();
    const searchParams = useSearchParams();

    // New param: /play?intent=XXXX
    const intentId = searchParams.get('intent');

    const [status, setStatus] = useState('claiming'); // claiming | success | error
    const [error, setError] = useState('');

    useEffect(() => {
        let intervalId = null;
        let stopped = false;

        async function claimOnce() {
            try {
                if (!API_BASE_URL) {
                    setStatus('error');
                    setError('Missing NEXT_PUBLIC_API_BASE_URL in env.');
                    return true; // stop polling
                }

                if (!intentId) {
                    setStatus('error');
                    setError('Missing intent id.');
                    return true; // stop polling
                }

                const res = await fetch(`${API_BASE_URL}/api/play/claim`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ intentId }),
                });

                const data = await res.json();

                // Pending (webhook not arrived yet) => keep polling
                if (res.status === 202 && data.status === 'pending') {
                    setStatus('claiming');
                    return false;
                }

                if (!res.ok) {
                    setStatus('error');
                    setError(data?.error || 'Claim failed.');
                    return true; // stop polling
                }

                // Success
                localStorage.setItem(TOKEN_KEY, data.token);
                setStatus('success');

                setTimeout(() => router.replace('/arcade'), 800);
                return true; // stop polling
            } catch (err) {
                console.error(err);
                setStatus('error');
                setError('Network error while claiming.');
                return true; // stop polling
            }
        }

        // First try immediately
        claimOnce().then((done) => {
            if (done || stopped) return;

            // Poll every 2 seconds until paid
            intervalId = setInterval(async () => {
                if (stopped) return;
                const finished = await claimOnce();
                if (finished && intervalId) clearInterval(intervalId);
            }, 2000);
        });

        return () => {
            stopped = true;
            if (intervalId) clearInterval(intervalId);
        };
    }, [intentId, router]);

    return (
        <main className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center px-4">
            <div className="w-full max-w-md bg-slate-800 p-6 rounded-2xl shadow-lg text-center space-y-3">
                {status === 'claiming' && (
                    <>
                        <h1 className="text-2xl font-bold">Processing your payment…</h1>
                        <p className="text-slate-300 text-sm">
                            Please wait while we verify your donation.
                        </p>
                    </>
                )}

                {status === 'success' && (
                    <>
                        <h1 className="text-2xl font-bold text-emerald-400">Payment confirmed ✅</h1>
                        <p className="text-slate-300 text-sm">
                            Redirecting you to the arcade…
                        </p>
                    </>
                )}

                {status === 'error' && (
                    <>
                        <h1 className="text-2xl font-bold text-red-400">Oops ❌</h1>
                        <p className="text-slate-300 text-sm">{error}</p>
                        <button
                            onClick={() => router.replace('/')}
                            className="mt-3 px-4 py-2 rounded-lg bg-emerald-500 text-sm font-semibold"
                        >
                            Back to Home
                        </button>
                    </>
                )}
            </div>
        </main>
    );
}

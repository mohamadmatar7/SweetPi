'use client';

import { useState } from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

export default function DonateForm() {
    const [name, setName] = useState('');
    const [amountEuros, setAmountEuros] = useState(1);
    const [email, setEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    async function handleSubmit(e) {
        e.preventDefault();
        setError('');

        if (!API_BASE_URL) {
            setError('Missing NEXT_PUBLIC_API_BASE_URL in env.');
            return;
        }

        if (!name.trim()) {
            setError('Name is required.');
            return;
        }

        const amount = Number(amountEuros);
        if (Number.isNaN(amount) || amount <= 0) {
            setError('Amount must be a positive number.');
            return;
        }

        try {
            setLoading(true);

            const res = await fetch(`${API_BASE_URL}/api/donations/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name.trim(),
                    amountEuros: amount,
                    email: email.trim() || undefined, // optional
                }),
            });

            const data = await res.json();

            if (!res.ok) {
                setError(data?.error || 'Payment creation failed.');
                return;
            }

            // Redirect user to Mollie checkout
            window.location.href = data.checkoutUrl;
        } catch (err) {
            console.error(err);
            setError('Network error. Please try again.');
        } finally {
            setLoading(false);
        }
    }

    return (
        <form
            onSubmit={handleSubmit}
            className="w-full max-w-md bg-slate-800 p-6 rounded-2xl shadow-lg space-y-4"
        >
            <div>
                <label className="block text-sm mb-1">Name *</label>
                <input
                    className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-sm"
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={40}
                    required
                />
            </div>

            <div>
                <label className="block text-sm mb-1">Email (optional)</label>
                <input
                    className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-sm"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    type="email"
                />
                <p className="text-xs text-slate-400 mt-1">
                    We will email you later if you provide it.
                </p>
            </div>

            <div>
                <label className="block text-sm mb-1">Amount in EUR *</label>
                <input
                    className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-sm"
                    type="number"
                    min="1"
                    step="0.5"
                    value={amountEuros}
                    onChange={(e) => setAmountEuros(e.target.value)}
                    required
                />
                <p className="text-xs text-slate-400 mt-1">
                    1€ = 1 credit (max 5 credits per player).
                </p>
            </div>

            {error && (
                <div className="text-sm text-red-400 bg-red-950/40 p-3 rounded-lg">
                    {error}
                </div>
            )}

            <button
                type="submit"
                disabled={loading}
                className="w-full py-2 rounded-lg bg-emerald-500 font-semibold text-sm disabled:opacity-60"
            >
                {loading ? 'Redirecting to payment...' : 'Donate & Play'}
            </button>
        </form>
    );
}

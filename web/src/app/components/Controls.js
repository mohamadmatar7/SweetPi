'use client';

import { useEffect, useRef } from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

/**
 * Arcade controls:
 * - Directions are "hold" while pressed
 * - Grab is allowed once per credit
 */
export default function Controls({ token, onFirstAction, creditSeq }) {
    const startedRef = useRef(false);
    const grabUsedRef = useRef(false);

    // Reset per-credit state whenever a new credit starts
    useEffect(() => {
        startedRef.current = false;
        grabUsedRef.current = false;
    }, [creditSeq]);

    async function press(direction) {
        if (!startedRef.current) {
            startedRef.current = true;
            onFirstAction?.();
        }

        await fetch(`${API_BASE_URL}/api/control/press`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, direction }),
        });
    }

    async function release(direction) {
        await fetch(`${API_BASE_URL}/api/control/release`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, direction }),
        });
    }

    async function grab() {
        // Local lock: only one grab per credit
        if (grabUsedRef.current) return;

        grabUsedRef.current = true;

        if (!startedRef.current) {
            startedRef.current = true;
            onFirstAction?.();
        }

        const res = await fetch(`${API_BASE_URL}/api/control/grab`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
        });

        if (!res.ok) {
            // If backend rejected (e.g. not active / already used),
            // unlock locally so user can try again next credit.
            grabUsedRef.current = false;
        }
    }

    function HoldButton({ direction, children }) {
        return (
            <button
                className="select-none w-24 h-24 rounded-2xl bg-slate-700 active:bg-emerald-600 font-bold text-lg"
                style={{ touchAction: 'none' }}
                onPointerDown={(e) => {
                    e.preventDefault();
                    press(direction);
                }}
                onPointerUp={(e) => {
                    e.preventDefault();
                    release(direction);
                }}
                onPointerLeave={() => release(direction)}
                onPointerCancel={() => release(direction)}
            >
                {children}
            </button>
        );
    }

    return (
        <div className="flex flex-col items-center gap-4">
            <HoldButton direction="up">↑</HoldButton>

            <div className="flex gap-4">
                <HoldButton direction="left">←</HoldButton>

                <button
                    className="select-none w-24 h-24 rounded-2xl bg-amber-500 active:bg-amber-600 font-bold text-lg disabled:opacity-50"
                    onClick={grab}
                    disabled={grabUsedRef.current}
                >
                    GRAB
                </button>

                <HoldButton direction="right">→</HoldButton>
            </div>

            <HoldButton direction="down">↓</HoldButton>
        </div>
    );
}

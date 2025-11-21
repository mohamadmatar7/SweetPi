'use client';

import { useRef } from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

/**
 * Arcade controls:
 * - Directions are "hold" while pressed
 * - Grab is a short pulse
 */
export default function Controls({ token, onFirstAction }) {
    const startedRef = useRef(false);

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
        if (!startedRef.current) {
            startedRef.current = true;
            onFirstAction?.();
        }

        await fetch(`${API_BASE_URL}/api/control/grab`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
        });
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
                    className="select-none w-24 h-24 rounded-2xl bg-amber-500 active:bg-amber-600 font-bold text-lg"
                    onClick={grab}
                >
                    GRAB
                </button>

                <HoldButton direction="right">→</HoldButton>
            </div>

            <HoldButton direction="down">↓</HoldButton>
        </div>
    );
}

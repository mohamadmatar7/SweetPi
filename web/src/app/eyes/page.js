'use client';

import { useEffect, useRef, useState } from 'react';

export default function EyesPage() {
    const [supported, setSupported] = useState(true);
    const [connecting, setConnecting] = useState(false);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState(null);
    const [openLevel, setOpenLevel] = useState(1); // 1 = fully open, 0 = fully closed
    const [lastValue, setLastValue] = useState(null);

    const portRef = useRef(null);
    const readerRef = useRef(null);
    const abortControllerRef = useRef(null);

    useEffect(() => {
        // Check if Web Serial API is available in this browser
        if (typeof navigator === 'undefined' || !('serial' in navigator)) {
            setSupported(false);
        }
    }, []);

    async function handleConnect() {
        setError(null);

        if (!supported) return;

        try {
            setConnecting(true);

            // Request a serial port from the user (USB from the other Pi)
            const port = await navigator.serial.requestPort();

            // Open port with a baud rate matching your other Pi (adjust if needed)
            await port.open({ baudRate: 9600 });

            portRef.current = port;
            setConnected(true);

            // Start reading loop
            const textDecoder = new TextDecoder();
            const abortController = new AbortController();
            abortControllerRef.current = abortController;

            const reader = port.readable.getReader();
            readerRef.current = reader;

            // Simple read loop: expects numeric values like "0", "1", "0.5\n", "75\n" etc.
            (async () => {
                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        if (!value) continue;

                        const chunk = textDecoder.decode(value);
                        const trimmed = chunk.trim();

                        if (!trimmed) continue;

                        // Try to parse a number from the incoming text
                        const num = parseFloat(trimmed);
                        if (Number.isNaN(num)) {
                            continue;
                        }

                        // If the sender uses 0–100, normalize to 0–1
                        let level = num;
                        if (num > 1) {
                            level = num / 100;
                        }

                        // Clamp between 0 and 1
                        level = Math.max(0, Math.min(1, level));

                        setOpenLevel(level);
                        setLastValue(trimmed);
                    }
                } catch (err) {
                    if (!abortController.signal.aborted) {
                        console.error('Serial read error:', err);
                        setError('Serial read error: ' + (err?.message || String(err)));
                    }
                } finally {
                    try {
                        await reader.releaseLock();
                    } catch {
                        // ignore
                    }
                }
            })();
        } catch (err) {
            console.error('Serial connect error:', err);
            setError('Could not open serial port: ' + (err?.message || String(err)));
            setConnected(false);
        } finally {
            setConnecting(false);
        }
    }

    async function handleDisconnect() {
        setError(null);

        try {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }

            if (readerRef.current) {
                try {
                    await readerRef.current.cancel();
                } catch {
                    // ignore
                }
                readerRef.current = null;
            }

            if (portRef.current) {
                try {
                    await portRef.current.close();
                } catch {
                    // ignore
                }
                portRef.current = null;
            }
        } finally {
            setConnected(false);
        }
    }

    // Simple eye rendering based on openLevel (0–1)
    function Eye() {
        // Eyelid offset: 0 = fully open, 1 = fully closed
        const lidOffset = 1 - openLevel;

        return (
            <div className="relative w-32 h-32 sm:w-40 sm:h-40">
                {/* Eyeball */}
                <div className="absolute inset-0 bg-slate-100 rounded-full flex items-center justify-center">
                    {/* Iris */}
                    <div className="w-14 h-14 sm:w-16 sm:h-16 bg-sky-700 rounded-full flex items-center justify-center">
                        {/* Pupil */}
                        <div className="w-8 h-8 sm:w-9 sm:h-9 bg-slate-900 rounded-full" />
                    </div>
                </div>

                {/* Upper eyelid */}
                <div
                    className="absolute inset-0 bg-slate-900 rounded-t-full origin-top transition-transform duration-150"
                    style={{
                        transform: `translateY(${lidOffset * 100}%)`,
                    }}
                />

                {/* Lower eyelid (optional subtle movement) */}
                <div
                    className="absolute inset-0 bg-slate-900 rounded-b-full origin-bottom transition-transform duration-150"
                    style={{
                        transform: `translateY(-${(1 - openLevel) * 30}%)`,
                    }}
                />
            </div>
        );
    }

    return (
        <main className="min-h-screen bg-slate-900 text-slate-100 flex flex-col items-center justify-center px-4 py-10">
            <div className="w-full max-w-xl space-y-6">
                <header className="text-center space-y-2">
                    <h1 className="text-3xl sm:text-4xl font-extrabold">👀 SweetControl Eyes</h1>
                    <p className="text-slate-300 text-sm">
                        This page listens to a serial port (USB) and opens/closes the eyes based on the
                        values received from another Raspberry Pi.
                    </p>
                    {!supported && (
                        <p className="text-xs text-red-300 mt-2">
                            Web Serial API is not supported in this browser. Please use Chrome or Edge on
                            desktop.
                        </p>
                    )}
                </header>

                <section className="flex flex-col items-center gap-6">
                    {/* Eyes */}
                    <div className="flex items-center justify-center gap-6 sm:gap-10">
                        <Eye />
                        <Eye />
                    </div>

                    {/* Info row */}
                    <div className="text-xs text-slate-400 text-center space-y-1">
                        <div>
                            Open level: <span className="font-mono">{openLevel.toFixed(2)}</span>
                        </div>
                        {lastValue !== null && (
                            <div>
                                Last raw value from serial:{' '}
                                <span className="font-mono text-slate-200">{lastValue}</span>
                            </div>
                        )}
                    </div>

                    {/* Controls */}
                    <div className="flex flex-col items-center gap-3">
                        <div className="flex gap-3">
                            <button
                                type="button"
                                onClick={handleConnect}
                                disabled={!supported || connected || connecting}
                                className={`px-4 py-2 rounded-xl text-sm font-semibold
                  ${connected
                                        ? 'bg-emerald-700/40 border border-emerald-500 text-emerald-200 cursor-default'
                                        : 'bg-sky-600 hover:bg-sky-500 border border-sky-400 text-white disabled:bg-slate-700 disabled:border-slate-600 disabled:text-slate-400'}
                `}
                            >
                                {connected
                                    ? 'Connected'
                                    : connecting
                                        ? 'Connecting...'
                                        : 'Connect serial'}
                            </button>

                            <button
                                type="button"
                                onClick={handleDisconnect}
                                disabled={!connected}
                                className="px-4 py-2 rounded-xl text-sm font-semibold bg-slate-700 border border-slate-500 text-slate-100 disabled:opacity-40"
                            >
                                Disconnect
                            </button>
                        </div>

                        <p className="text-[11px] text-slate-500 max-w-sm text-center">
                            Expected numeric values over serial, for example <code>0</code>,{' '}
                            <code>1</code>, <code>0.5</code>, or <code>75</code>. Values above 1 are
                            treated as percentages (0–100) and normalized to 0–1.
                        </p>

                        {error && (
                            <div className="mt-2 px-3 py-2 rounded-lg text-xs bg-red-600/20 border border-red-500 text-red-200 max-w-sm text-center">
                                {error}
                            </div>
                        )}
                    </div>
                </section>
            </div>
        </main>
    );
}

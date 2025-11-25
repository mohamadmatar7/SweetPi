'use client';

import { useEffect, useRef, useState } from 'react';

export default function GraphicPage() {
    const [supported, setSupported] = useState(true);
    const [connecting, setConnecting] = useState(false);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState(null);

    const [sugarValue, setSugarValue] = useState(null); // e.g. mg/dL or %
    const [lastRaw, setLastRaw] = useState(null);

    const portRef = useRef(null);
    const readerRef = useRef(null);
    const abortControllerRef = useRef(null);
    const bufferRef = useRef(''); // accumulate partial chunks into full lines

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
            bufferRef.current = '';

            (async () => {
                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        if (!value) continue;

                        const chunk = textDecoder.decode(value);
                        bufferRef.current += chunk;

                        // Split by newline to handle partial chunks properly
                        const lines = bufferRef.current.split(/\r?\n/);
                        bufferRef.current = lines.pop() || '';

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed) continue;

                            // Example expected formats:
                            // "120", "135.5", "SUGAR: 145", "BG=110"
                            // We extract the first number from the line.
                            const match = trimmed.match(/-?\d+(\.\d+)?/);
                            if (!match) continue;

                            const num = parseFloat(match[0]);
                            if (Number.isNaN(num)) continue;

                            setSugarValue(num);
                            setLastRaw(trimmed);
                        }
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

    // Determine sugar status and color based on the value
    function getStatusAndColor(value) {
        if (value == null) {
            return { label: 'No data', color: 'text-slate-400', bg: 'bg-slate-800' };
        }

        // You can adjust these thresholds to your medical logic:
        // Example (mg/dL):
        // < 70 -> LOW
        // 70–140 -> NORMAL
        // > 140 -> HIGH
        if (value < 70) {
            return {
                label: 'LOW',
                color: 'text-sky-300',
                bg: 'bg-sky-900/40',
            };
        } else if (value <= 140) {
            return {
                label: 'NORMAL',
                color: 'text-emerald-300',
                bg: 'bg-emerald-900/40',
            };
        } else if (value <= 200) {
            return {
                label: 'ELEVATED',
                color: 'text-yellow-300',
                bg: 'bg-yellow-900/40',
            };
        } else {
            return {
                label: 'HIGH',
                color: 'text-red-300',
                bg: 'bg-red-900/40',
            };
        }
    }

    const { label: statusLabel, color: statusColor, bg: statusBg } =
        getStatusAndColor(sugarValue);

    // Normalize sugar level to 0–1 for the bar (assuming 0–300 mg/dL)
    const normalized =
        sugarValue == null ? 0 : Math.max(0, Math.min(1, sugarValue / 300));

    return (
        <main className="min-h-screen bg-slate-900 text-slate-100 flex flex-col items-center justify-center px-4 py-10">
            <div className="w-full max-w-2xl space-y-6">
                <header className="text-center space-y-2">
                    <h1 className="text-3xl sm:text-4xl font-extrabold">📊 SweetControl Graphic</h1>
                    <p className="text-slate-300 text-sm">
                        This page listens to a serial port (USB) and visualizes sugar level data received
                        from another Raspberry Pi.
                    </p>
                    {!supported && (
                        <p className="text-xs text-red-300 mt-2">
                            Web Serial API is not supported in this browser. Please use Chrome or Edge on
                            desktop.
                        </p>
                    )}
                </header>

                {/* Main card */}
                <section className="bg-slate-800/60 border border-slate-700 rounded-2xl p-5 sm:p-6 space-y-6">
                    {/* Status + number */}
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                        <div>
                            <div className="text-xs uppercase tracking-widest text-slate-400">
                                Current sugar level
                            </div>
                            <div className="mt-1 flex items-baseline gap-2">
                                <span className="text-4xl sm:text-5xl font-extrabold tabular-nums">
                                    {sugarValue != null ? sugarValue.toFixed(1) : '--.-'}
                                </span>
                                <span className="text-sm text-slate-400">mg/dL</span>
                            </div>
                        </div>

                        <div
                            className={`inline-flex flex-col items-center px-4 py-2 rounded-xl border text-xs font-semibold ${statusBg} ${statusColor} border-slate-600`}
                        >
                            <span className="uppercase tracking-widest">{statusLabel}</span>
                            {sugarValue != null && (
                                <span className="mt-1 text-[10px] text-slate-300">
                                    Based on thresholds: &lt;70 low, 70–140 normal, &gt;140 high
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Bar visualization */}
                    <div className="space-y-2">
                        <div className="flex justify-between text-[11px] text-slate-500">
                            <span>0</span>
                            <span>150</span>
                            <span>300 mg/dL</span>
                        </div>
                        <div className="h-4 rounded-full bg-slate-900 overflow-hidden border border-slate-700">
                            <div
                                className="h-full rounded-full transition-all duration-200"
                                style={{
                                    width: `${normalized * 100}%`,
                                    background:
                                        'linear-gradient(to right, #22c55e, #eab308, #ef4444)', // ok -> warning -> high
                                }}
                            />
                        </div>
                    </div>

                    {/* Last raw reading */}
                    <div className="text-xs text-slate-400">
                        <div>Last raw line from serial:</div>
                        <div className="mt-1 font-mono text-slate-200 bg-slate-900/60 rounded-lg px-3 py-2 min-h-[2.25rem]">
                            {lastRaw != null ? lastRaw : 'No data yet'}
                        </div>
                    </div>

                    {/* Controls */}
                    <div className="flex flex-col items-center gap-3 pt-2 border-t border-slate-700/60">
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
                            Expected text lines over serial containing a numeric value, for example{' '}
                            <code>120</code>, <code>135.5</code>, <code>SUGAR: 145</code>, or{' '}
                            <code>BG=110</code>. The first number in each line will be parsed as the sugar
                            level (mg/dL).
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

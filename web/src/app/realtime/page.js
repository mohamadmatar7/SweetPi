'use client';

import { useEffect, useState } from 'react';
import Pusher from 'pusher-js';

Pusher.logToConsole = true;

const PUSHER_KEY = process.env.NEXT_PUBLIC_PUSHER_KEY;
const WS_HOST = process.env.NEXT_PUBLIC_PUSHER_WS_HOST;
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

export default function RealtimePage() {
    const [messages, setMessages] = useState([]);
    const [username, setUsername] = useState('Sam');
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);

    useEffect(() => {
        if (!PUSHER_KEY || !WS_HOST) {
            console.error('Missing Pusher env vars');
            return;
        }

        const pusher = new Pusher(PUSHER_KEY, {
            wsHost: WS_HOST,
            wsPort: 443,
            wssPort: 443,
            forceTLS: true,
            enabledTransports: ['ws', 'wss'],
            cluster: 'mt1',
            disableStats: true,
        });

        const channel = pusher.subscribe('public-chat');

        channel.bind('new-message', (data) => {
            setMessages((prev) => [...prev, data]);
        });

        return () => {
            channel.unbind_all();
            channel.unsubscribe();
            pusher.disconnect();
        };
    }, []);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!text.trim() || !API_BASE_URL) return;

        try {
            setSending(true);
            await fetch(`${API_BASE_URL}/api/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    username,
                    text,
                }),
            });
            setText('');
        } catch (err) {
            console.error('Error sending message', err);
            alert('Error sending message, check console');
        } finally {
            setSending(false);
        }
    };

    return (
        <main className="min-h-screen bg-slate-900 text-slate-100 flex flex-col items-center pt-10">
            <div className="w-full max-w-xl px-4">
                <h1 className="text-2xl font-bold mb-4 text-center">
                    🔴 Realtime Chat (Soketi + Next.js)
                </h1>

                <form
                    onSubmit={handleSubmit}
                    className="mb-4 flex flex-col gap-3 bg-slate-800 p-4 rounded-2xl"
                >
                    <div className="flex gap-2">
                        <input
                            className="flex-1 px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-sm"
                            placeholder="Your name"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                        />
                    </div>
                    <div className="flex gap-2">
                        <input
                            className="flex-1 px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-sm"
                            placeholder="Type a message..."
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                        />
                        <button
                            type="submit"
                            disabled={sending}
                            className="px-4 py-2 rounded-lg bg-emerald-500 text-sm font-semibold disabled:opacity-50"
                        >
                            {sending ? 'Sending...' : 'Send'}
                        </button>
                    </div>
                </form>

                <div className="bg-slate-800 rounded-2xl p-4 h-[400px] overflow-y-auto space-y-2">
                    {messages.length === 0 && (
                        <p className="text-sm text-slate-400">
                            No messages yet. Open this page in two tabs and send something 👀
                        </p>
                    )}

                    {messages.map((msg) => (
                        <div
                            key={msg.id ?? msg.ts}
                            className="flex flex-col bg-slate-900/60 rounded-xl px-3 py-2 text-sm"
                        >
                            <div className="flex justify-between mb-1">
                                <span className="font-semibold text-emerald-400">
                                    {msg.username}
                                </span>
                                <span className="text-[10px] text-slate-500">
                                    {msg.ts && new Date(msg.ts).toLocaleTimeString()}
                                </span>
                            </div>
                            <p className="text-slate-100 break-words">{msg.text}</p>
                        </div>
                    ))}
                </div>
            </div>
        </main>
    );
}

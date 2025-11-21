import { Suspense } from 'react';
import PlayClient from './PlayClient';

export const dynamic = 'force-dynamic';

export default function PlayPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center px-4">
        <div className="w-full max-w-md bg-slate-800 p-6 rounded-2xl shadow-lg text-center space-y-3">
          <h1 className="text-2xl font-bold">Processing your payment…</h1>
          <p className="text-slate-300 text-sm">
            Please wait while we verify your donation.
          </p>
        </div>
      </main>
    }>
      <PlayClient />
    </Suspense>
  );
}

import DonateForm from './components/DonateForm';

export default function HomePage() {
  return (
    <main className="min-h-screen bg-slate-900 text-slate-100 flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-2xl text-center space-y-3 mb-8">
        <h1 className="text-4xl font-extrabold">
          🎁 SweetControl Arcade Claw
        </h1>
        <p className="text-slate-300">
          Donate to play the claw machine live.
        </p>
        <p className="text-slate-400 text-sm">
          Each 1€ gives you 1 credit. Maximum credits per player: 5.
        </p>
      </div>

      <DonateForm />

      <div className="mt-8 text-xs text-slate-500 text-center max-w-md">
        After successful payment you will be redirected to the arcade page.
        If you try to enter without paying, you will be sent back here.
      </div>
    </main>
  );
}

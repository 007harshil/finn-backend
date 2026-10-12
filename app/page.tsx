export default function Home() {
  return (
    <main className="mx-auto flex min-h-full max-w-2xl flex-col gap-4 px-6 py-24 font-sans">
      <h1 className="text-2xl font-semibold">FiNN API</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Backend for the FiNN personal finance app. FiNN records finances; it never moves money. The API lives under{' '}
        <code className="rounded bg-black/[.06] px-1 dark:bg-white/[.08]">/api/v1</code> and requires a Supabase Auth
        access token.
      </p>
    </main>
  );
}

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | FiNN",
  description: "How the FiNN personal finance app collects, uses and protects your data.",
};

const link = "underline underline-offset-2";
const h2 = "mt-6 text-lg font-semibold";
const body = "text-zinc-700 dark:text-zinc-300";

export default function PrivacyPage() {
  return (
    <main className="mx-auto flex min-h-full max-w-2xl flex-col gap-3 px-6 py-16 font-sans leading-relaxed">
      <h1 className="text-2xl font-semibold">FiNN Privacy Policy</h1>
      <p className={body}>Effective date: 19 October 2026. App: FiNN (Android package app.finn.money).</p>
      <p className={body}>
        FiNN is a personal finance tracker. It records the finances you enter and never moves money. This page explains
        what data FiNN handles, why, and the choices you have.
      </p>

      <h2 className={h2}>Your account</h2>
      <p className={body}>
        You sign in with your email address only. FiNN emails you a one-time code to confirm it is you. There are no
        passwords. Codes are sent through Gmail SMTP from finn.team007@gmail.com.
      </p>

      <h2 className={h2}>Data we store</h2>
      <ul className={`list-disc pl-6 ${body}`}>
        <li>Your email address.</li>
        <li>
          Finance records you enter: transactions, accounts (cash, bank, cards), budgets, goals, loans, subscriptions,
          and pending or shared items.
        </li>
        <li>Your profile and preferences, and your FiNN ID, which friends use to find you.</li>
        <li>Friend requests and items you share with friends. A friend can see the items you share with them.</li>
        <li>
          Assistant history: for requests where the assistant proposed changes, the request text (up to 500 characters)
          and the outcome, so you can review it. Entries older than 180 days are removed automatically. History is not
          sent back to the AI model.
        </li>
        <li>The app also keeps an offline cache of your data on your device.</li>
      </ul>

      <h2 className={h2}>AI assistant and voice input</h2>
      <p className={body}>
        When you use the assistant, the text of your request, and the app data it needs to answer, is sent through our
        server to OpenAI to plan actions. If content moderation is enabled, the same text is also checked with
        OpenAI&apos;s moderation service. When you use the voice button, your device&apos;s built-in speech recognition
        (for example Google on Android or Apple on iOS) turns your speech into text. The audio never reaches our
        servers; only the resulting text is sent, as if you had typed it.
      </p>
      <p className={body}>
        We do not store your voice requests on our servers, and we do not write prompts or transcripts to our logs. The providers process the data under their own terms. The assistant only proposes changes; you
        confirm them.
      </p>

      <h2 className={h2}>Where data is kept</h2>
      <p className={body}>
        Your data is stored in a Supabase Postgres database in Singapore (ap-southeast-1). The API runs on Vercel. Data
        travels between the app and our servers over HTTPS.
      </p>

      <h2 className={h2}>What we do not do</h2>
      <ul className={`list-disc pl-6 ${body}`}>
        <li>No ads.</li>
        <li>No analytics or tracking SDKs.</li>
        <li>We do not sell your data or share it for marketing.</li>
      </ul>

      <h2 className={h2}>Service providers</h2>
      <p className={body}>
        We use Supabase (database), Vercel (hosting), Google (email delivery), and OpenAI (assistant). Voice input
        uses the speech recognition service of your device&apos;s operating system. They process data only to provide those services. Hosting and infrastructure providers may keep
        routine technical logs (such as request time and status) for a limited period.
      </p>

      <h2 className={h2}>Android permissions</h2>
      <ul className={`list-disc pl-6 ${body}`}>
        <li>Internet: to sync with our servers.</li>
        <li>Microphone: only while you hold or tap the voice button for the assistant.</li>
      </ul>

      <h2 className={h2}>Deleting your data</h2>
      <p className={body}>
        You can delete your account and all its data at any time. See{" "}
        <a className={link} href="/delete-account">
          how to delete your account
        </a>
        .
      </p>

      <h2 className={h2}>Children</h2>
      <p className={body}>
        FiNN is a finance app and is not directed to anyone under 18. We do not knowingly collect data from children.
      </p>

      <h2 className={h2}>Changes</h2>
      <p className={body}>If this policy changes, we will update this page and its effective date.</p>

      <h2 className={h2}>Contact</h2>
      <p className={body}>
        Questions or requests:{" "}
        <a className={link} href="mailto:finn.team007@gmail.com">
          finn.team007@gmail.com
        </a>
        .
      </p>
    </main>
  );
}

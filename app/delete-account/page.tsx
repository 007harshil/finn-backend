import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Delete your FiNN account",
  description: "How to delete your FiNN account and its data, in the app or by email.",
};

const link = "underline underline-offset-2";
const h2 = "mt-6 text-lg font-semibold";
const body = "text-zinc-700 dark:text-zinc-300";

export default function DeleteAccountPage() {
  return (
    <main className="mx-auto flex min-h-full max-w-2xl flex-col gap-3 px-6 py-16 font-sans leading-relaxed">
      <h1 className="text-2xl font-semibold">Delete your FiNN account</h1>
      <p className={body}>
        This page is for the FiNN app (Android package app.finn.money). Deleting your account removes your data and
        cannot be undone.
      </p>

      <h2 className={h2}>Option 1: in the app (immediate)</h2>
      <ol className={`list-decimal pl-6 ${body}`}>
        <li>Open FiNN and go to Profile, then Security, then Delete account.</li>
        <li>FiNN emails a one-time code to your account email. Enter it to confirm.</li>
        <li>Your account and data are deleted immediately.</li>
      </ol>

      <h2 className={h2}>Option 2: by email (no app needed)</h2>
      <p className={body}>
        Send an email to{" "}
        <a className={link} href="mailto:finn.team007@gmail.com?subject=Delete%20my%20FiNN%20account">
          finn.team007@gmail.com
        </a>{" "}
        from the email address of your FiNN account, with the subject &quot;Delete my FiNN account&quot;. We will delete
        the account and reply to confirm within 30 days.
      </p>

      <h2 className={h2}>What is deleted</h2>
      <ul className={`list-disc pl-6 ${body}`}>
        <li>Your account and email address.</li>
        <li>
          All your finance data: transactions, accounts, budgets, goals, loans, subscriptions, and pending items.
        </li>
        <li>Your profile, preferences, FiNN ID, sign-in sessions and friend connections.</li>
        <li>Your assistant history.</li>
      </ul>

      <h2 className={h2}>What is kept</h2>
      <ul className={`list-disc pl-6 ${body}`}>
        <li>
          Items another FiNN user shared with you remain in that user&apos;s own records. They are no longer linked to
          your account.
        </li>
        <li>Hosting and infrastructure providers may keep routine technical logs for a limited period.</li>
        <li>Data stored only on your device is removed when you uninstall the app or clear its data.</li>
      </ul>

      <p className={`mt-6 ${body}`}>
        See the{" "}
        <a className={link} href="/privacy">
          Privacy Policy
        </a>{" "}
        for more.
      </p>
    </main>
  );
}

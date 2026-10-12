// Email bodies. Plain text is always included; HTML is minimal inline-styled
// markup so it renders the same in every client.

import type { MailMessage } from './mailer';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#1d2433">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px" cellspacing="0" cellpadding="0"><tr><td>
<p style="margin:0 0 16px;font-size:20px;font-weight:bold">${escapeHtml(title)}</p>
${bodyHtml}
<p style="margin:32px 0 0;font-size:12px;color:#6b7280">FiNN</p>
</td></tr></table></td></tr></table></body></html>`;
}

/** Sign-in code. */
export function otpEmail(to: string, code: string, ttlMinutes: number): MailMessage {
  const subject = `${code} is your FiNN sign-in code`;
  const text = [
    `Your FiNN sign-in code is ${code}.`,
    '',
    `It expires in ${ttlMinutes} minutes and can be used once.`,
    "If you didn't try to sign in, you can ignore this email.",
  ].join('\n');
  const html = layout(
    'Your sign-in code',
    `<p style="margin:0 0 16px;font-size:15px">Enter this code in FiNN to sign in:</p>
<p style="margin:0 0 16px;font-size:32px;letter-spacing:8px;font-weight:bold">${escapeHtml(code)}</p>
<p style="margin:0;font-size:14px;color:#4b5563">It expires in ${ttlMinutes} minutes and can be used once. If you didn't try to sign in, you can ignore this email.</p>`,
  );
  return { to, subject, text, html };
}

/** Generic notice (alerts, reminders and other account email). */
export function noticeEmail(to: string, subject: string, paragraphs: string[]): MailMessage {
  const text = paragraphs.join('\n\n');
  const html = layout(subject, paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:15px">${escapeHtml(p)}</p>`).join('\n'));
  return { to, subject, text, html };
}

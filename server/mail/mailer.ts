// Outgoing email over SMTP with nodemailer (Gmail by default: smtp.gmail.com
// with an App Password). One pooled transport per server instance. Every mail
// the API sends (sign-in codes, notices) goes through sendMail().

import nodemailer, { type Transporter } from 'nodemailer';
import { mailEnv } from '../env';
import { AppFailure } from '../core/failure';
import { logger } from '../http/logger';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Delivers one message. Replaceable in tests. */
export type MailSender = (message: MailMessage) => Promise<void>;

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (transport) return transport;
  const e = mailEnv();
  transport = nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_SECURE,
    requireTLS: !e.SMTP_SECURE,
    auth: { user: e.SMTP_USER, pass: e.SMTP_PASS },
    pool: true,
    maxConnections: 2,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transport;
}

export const smtpSender: MailSender = async (message) => {
  let from: string;
  let t: Transporter;
  try {
    from = mailEnv().MAIL_FROM;
    t = getTransport();
  } catch (err) {
    logger.error('mail.config', { error: err instanceof Error ? err.message : String(err) });
    throw new AppFailure('unavailable', 'Email is not configured on this server.', { retryable: false });
  }
  try {
    await t.sendMail({ from, to: message.to, subject: message.subject, text: message.text, html: message.html });
  } catch (err) {
    // Never log the recipient or body: they may carry a sign-in code.
    logger.error('mail.send', { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    throw AppFailure.unavailable('We could not send the email. Please try again in a moment.');
  }
};

let sender: MailSender = smtpSender;

export function sendMail(message: MailMessage): Promise<void> {
  return sender(message);
}

/** Test hook: capture mail instead of sending it. */
export function setMailSender(s: MailSender | null): void {
  sender = s ?? smtpSender;
}

// libs/mailer/src/mailer.ts
//
// Corven's outgoing email over SMTP (any provider: Gmail/Google Workspace,
// Zoho, Mailgun, SES SMTP, Brevo, your own server...). Shared by the
// services that need to email people; Corven Connect uses it for sign-in
// codes.
//
// Settings:
//   SMTP_HOST      e.g. smtp.gmail.com (email is off when unset)
//   SMTP_PORT      587 (STARTTLS, default) or 465 (TLS)
//   SMTP_SECURE    true for port 465; defaults to true when SMTP_PORT=465
//   SMTP_USER      login, usually the mailbox address
//   SMTP_PASS      password or app password (Gmail needs an app password)
//   MAIL_FROM      "Corven <no-reply@corvanide.space>"; defaults to SMTP_USER
//   MAIL_REPLY_TO  optional

import { createTransport, type Transporter } from 'nodemailer';

export interface MailMessage {
    to: string;
    subject: string;
    text: string;
    html?: string;
    /** Overrides MAIL_FROM's display name, keeping its address. */
    fromName?: string;
}

export interface MailerConfig {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    pass?: string;
    from: string;
    replyTo?: string;
}

export class MailerError extends Error { }

export function mailerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MailerConfig | null {
    const host = env.SMTP_HOST?.trim();
    if (!host) return null;

    const port = Number(env.SMTP_PORT || 587);
    if (!Number.isInteger(port) || port <= 0) throw new MailerError('SMTP_PORT must be a port number.');

    const secure = env.SMTP_SECURE ? /^(1|true|yes)$/i.test(env.SMTP_SECURE) : port === 465;
    const user = env.SMTP_USER?.trim() || undefined;
    const from = env.MAIL_FROM?.trim() || user;
    if (!from) throw new MailerError('Set MAIL_FROM (or SMTP_USER) to the address emails come from.');

    return { host, port, secure, user, pass: env.SMTP_PASS, from, replyTo: env.MAIL_REPLY_TO?.trim() || undefined };
}

/** "Corven <no-reply@x.io>" + "Kisumu Market" -> "Kisumu Market <no-reply@x.io>" */
export function withDisplayName(from: string, name: string): string {
    const address = /<([^>]+)>/.exec(from)?.[1] ?? from.trim();
    const safe = name.replace(/["<>\r\n]/g, '').trim().slice(0, 60);
    return safe ? `"${safe}" <${address}>` : from;
}

export class Mailer {
    private readonly transport: Transporter;

    constructor(
        readonly config: MailerConfig,
        transport?: Transporter,
    ) {
        this.transport =
            transport ??
            createTransport({
                host: config.host,
                port: config.port,
                secure: config.secure,
                auth: config.user ? { user: config.user, pass: config.pass ?? '' } : undefined,
                // Plain-text SMTP only to localhost (dev catchers like Mailpit).
                requireTLS: !config.secure && !['localhost', '127.0.0.1'].includes(config.host),
                connectionTimeout: 10_000,
                greetingTimeout: 10_000,
                socketTimeout: 20_000,
            });
    }

    async send(message: MailMessage): Promise<void> {
        try {
            await this.transport.sendMail({
                from: message.fromName ? withDisplayName(this.config.from, message.fromName) : this.config.from,
                replyTo: this.config.replyTo,
                to: message.to,
                subject: message.subject,
                text: message.text,
                html: message.html,
            });
        } catch (error) {
            throw new MailerError(`SMTP send failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    /** Checks the SMTP login works. */
    async verify(): Promise<void> {
        await this.transport.verify();
    }
}

export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer | null {
    const config = mailerConfigFromEnv(env);
    return config ? new Mailer(config) : null;
}

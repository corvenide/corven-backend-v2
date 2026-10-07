import { codeEmail, Mailer, mailerConfigFromEnv, withDisplayName } from './index';

describe('mailerConfigFromEnv', () => {
    it('is off without SMTP_HOST', () => {
        expect(mailerConfigFromEnv({})).toBeNull();
    });

    it('defaults to STARTTLS on 587 and from = user', () => {
        expect(mailerConfigFromEnv({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'me@example.com', SMTP_PASS: 'x' })).toMatchObject({
            port: 587,
            secure: false,
            from: 'me@example.com',
        });
    });

    it('uses TLS on 465', () => {
        expect(mailerConfigFromEnv({ SMTP_HOST: 'h', SMTP_PORT: '465', MAIL_FROM: 'a@b.co' })!.secure).toBe(true);
    });

    it('needs a from address', () => {
        expect(() => mailerConfigFromEnv({ SMTP_HOST: 'h' })).toThrow(/MAIL_FROM/);
    });
});

describe('withDisplayName', () => {
    it('keeps the address and swaps the name', () => {
        expect(withDisplayName('Corven <no-reply@corvanide.space>', 'Kisumu Market')).toBe('"Kisumu Market" <no-reply@corvanide.space>');
        expect(withDisplayName('no-reply@corvanide.space', 'A "B" <c>')).toBe('"A B c" <no-reply@corvanide.space>');
    });
});

describe('Mailer', () => {
    it('sends through the transport', async () => {
        const sendMail = jest.fn().mockResolvedValue({});
        const mailer = new Mailer({ host: 'h', port: 587, secure: false, from: 'Corven <no-reply@x.io>' }, { sendMail } as never);
        await mailer.send({ to: 'u@x.io', subject: 's', text: 't', fromName: 'Demo' });
        expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'u@x.io', from: '"Demo" <no-reply@x.io>' }));
    });

    it('wraps transport errors', async () => {
        const mailer = new Mailer({ host: 'h', port: 587, secure: false, from: 'a@b.co' }, { sendMail: jest.fn().mockRejectedValue(new Error('535 auth')) } as never);
        await expect(mailer.send({ to: 'u@x.io', subject: 's', text: 't' })).rejects.toThrow(/535 auth/);
    });
});

describe('codeEmail', () => {
    it('puts the code in subject, text and html, and escapes the app name', () => {
        const mail = codeEmail({ code: '123456', appName: '<script>x', purpose: 'sign-in', minutesValid: 10 });
        expect(mail.subject).toContain('123456');
        expect(mail.text).toContain('123456');
        expect(mail.html).toContain('>123456</div>');
        expect(mail.html).not.toContain('<script>x');
    });
});

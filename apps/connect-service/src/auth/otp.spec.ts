import { ConsoleOtpProvider, otpProviderFromEnv, RoutingOtpProvider, SmtpEmailOtpProvider, TwilioVerifyProvider } from './otp';

describe('ConsoleOtpProvider', () => {
    it('accepts the sent code once', async () => {
        const otp = new ConsoleOtpProvider();
        await otp.send('+254712345678', 'sms');
        const code = otp.lastCode.get('+254712345678')!;
        expect(await otp.check('+254712345678', code === '000000' ? '111111' : '000000')).toBe(false);
        expect(await otp.check('+254712345678', code)).toBe(true);
        expect(await otp.check('+254712345678', code)).toBe(false);
    });

    it('locks out after too many wrong tries', async () => {
        const otp = new ConsoleOtpProvider();
        await otp.send('a@b.co', 'email');
        const code = otp.lastCode.get('a@b.co')!;
        const wrong = code === '000000' ? '111111' : '000000';
        for (let i = 0; i < 5; i++) await otp.check('a@b.co', wrong);
        expect(await otp.check('a@b.co', code)).toBe(false);
    });
});

describe('TwilioVerifyProvider', () => {
    const response = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;

    it('sends with basic auth and form body', async () => {
        const fetchMock = jest.fn().mockResolvedValue(response(201, { status: 'pending' }));
        await new TwilioVerifyProvider('AC1', 'tok', 'VA1', fetchMock).send('+254712345678', 'whatsapp');

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://verify.twilio.com/v2/Services/VA1/Verifications');
        expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('AC1:tok').toString('base64')}`);
        expect(init.body).toBe('To=%2B254712345678&Channel=whatsapp');
    });

    it('maps Twilio errors to friendly ones', async () => {
        const fetchMock = jest.fn().mockResolvedValue(response(429, { code: 60203 }));
        await expect(new TwilioVerifyProvider('AC1', 'tok', 'VA1', fetchMock).send('+254712345678', 'sms')).rejects.toMatchObject({ status: 429 });
    });

    it('checks codes', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(response(200, { status: 'approved' }))
            .mockResolvedValueOnce(response(200, { status: 'pending' }))
            .mockResolvedValueOnce(response(404, {}));
        const otp = new TwilioVerifyProvider('AC1', 'tok', 'VA1', fetchMock);
        expect(await otp.check('+254712345678', '123456')).toBe(true);
        expect(await otp.check('+254712345678', '123456')).toBe(false);
        expect(await otp.check('+254712345678', '123456')).toBe(false);
        expect(fetchMock.mock.calls[0][0]).toBe('https://verify.twilio.com/v2/Services/VA1/VerificationCheck');
    });
});

describe('otpProviderFromEnv', () => {
    it('picks Twilio when configured', () => {
        expect(otpProviderFromEnv({ TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b', TWILIO_VERIFY_SERVICE_SID: 'c' }).name).toBe('twilio');
    });
    it('refuses console codes in production', () => {
        expect(() => otpProviderFromEnv({ NODE_ENV: 'production', CONNECT_OTP_PROVIDER: 'console' })).toThrow(/development only/);
    });
    it('needs all Twilio settings', () => {
        expect(() => otpProviderFromEnv({ CONNECT_OTP_PROVIDER: 'twilio' })).toThrow(/TWILIO_ACCOUNT_SID/);
    });
});

describe('email codes over SMTP', () => {
    const smtpEnv = { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'no-reply@corvanide.space', SMTP_PASS: 'x', MAIL_FROM: 'Corven <no-reply@corvanide.space>' };

    it('routes email to SMTP and phone to Twilio', () => {
        const otp = otpProviderFromEnv({ ...smtpEnv, TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b', TWILIO_VERIFY_SERVICE_SID: 'c' });
        expect(otp.name).toBe('phone:twilio, email:smtp');
    });

    it('can keep email on Twilio', () => {
        const otp = otpProviderFromEnv({ ...smtpEnv, CONNECT_EMAIL_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b', TWILIO_VERIFY_SERVICE_SID: 'c' });
        expect(otp.name).toBe('twilio');
    });

    it('needs SMTP settings when asked for smtp', () => {
        expect(() => otpProviderFromEnv({ CONNECT_EMAIL_PROVIDER: 'smtp' })).toThrow(/SMTP_HOST/);
    });

    it('emails the code it later accepts', async () => {
        const send = jest.fn().mockResolvedValue(undefined);
        const otp = new SmtpEmailOtpProvider({ send } as never);
        await otp.send('amani@example.com', 'email', { appName: 'Kisumu Market' });

        const mail = send.mock.calls[0][0];
        expect(mail).toMatchObject({ to: 'amani@example.com', fromName: 'Kisumu Market' });
        const code = /(\d{6}) is your Kisumu Market sign-in code/.exec(mail.subject)![1];
        expect(mail.text).toContain(code);
        expect(await otp.check('amani@example.com', code)).toBe(true);
        expect(await otp.check('amani@example.com', code)).toBe(false);
    });

    it('turns SMTP failures into a friendly 502', async () => {
        const otp = new SmtpEmailOtpProvider({ send: jest.fn().mockRejectedValue(new Error('535 bad login')) } as never);
        await expect(otp.send('a@b.co', 'email')).rejects.toMatchObject({ status: 502 });
    });

    it('routing checks email codes with the email provider', async () => {
        const phone = new ConsoleOtpProvider();
        const email = new ConsoleOtpProvider();
        const otp = new RoutingOtpProvider(phone, email);
        await otp.send('a@b.co', 'email');
        await otp.send('+254712345678', 'sms');
        expect(email.lastCode.has('a@b.co')).toBe(true);
        expect(phone.lastCode.has('+254712345678')).toBe(true);
        expect(await otp.check('a@b.co', email.lastCode.get('a@b.co')!)).toBe(true);
        expect(await otp.check('+254712345678', phone.lastCode.get('+254712345678')!)).toBe(true);
    });
});

import { ConsoleOtpProvider, otpProviderFromEnv, TwilioVerifyProvider } from './otp';

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

import { connectJwtSecret, mainnetDailyLimitCkb } from './config';

describe('connect config', () => {
    it('needs its own long secret', () => {
        expect(() => connectJwtSecret({})).toThrow(/at least 32/);
        const s = 'x'.repeat(40);
        expect(() => connectJwtSecret({ CONNECT_JWT_SECRET: s, JWT_SECRET: s })).toThrow(/different/);
        expect(connectJwtSecret({ CONNECT_JWT_SECRET: s, JWT_SECRET: 'y'.repeat(40) })).toBe(s);
    });

    it('reads the mainnet limit', () => {
        expect(mainnetDailyLimitCkb({})).toBe(1000n);
        expect(mainnetDailyLimitCkb({ CONNECT_MAINNET_DAILY_LIMIT_CKB: '0' })).toBe(0n);
        expect(mainnetDailyLimitCkb({ CONNECT_MAINNET_DAILY_LIMIT_CKB: '250.7' })).toBe(250n);
    });
});

import { maskEmail, maskPhone, normalizeEmail, normalizePhone } from './destinations';

describe('normalizePhone', () => {
    it.each([
        ['+254 712 345 678', '+254712345678'],
        ['0712345678', '+254712345678'],
        ['254712345678', '+254712345678'],
        ['712345678', '+254712345678'],
        ['(0712) 345-678', '+254712345678'],
        ['00254712345678', '+254712345678'],
        ['+1 415 555 0100', '+14155550100'],
    ])('%s -> %s', (input, expected) => {
        expect(normalizePhone(input, '254')).toBe(expected);
    });

    it.each(['', 'abc', '+0123', '+2547', '0712-34x-678'])('rejects %p', (input) => {
        expect(() => normalizePhone(input, '254')).toThrow();
    });

    it('uses the given default country', () => {
        expect(normalizePhone('0803 123 4567', '234')).toBe('+2348031234567');
    });
});

describe('normalizeEmail', () => {
    it('lowercases and trims', () => {
        expect(normalizeEmail('  Amani@Example.COM ')).toBe('amani@example.com');
    });
    it.each(['', 'nope', 'a@b', 'a b@c.com'])('rejects %p', (input) => {
        expect(() => normalizeEmail(input)).toThrow();
    });
});

describe('masking', () => {
    it('masks a Kenyan number like the modal shows it', () => {
        expect(maskPhone('+254712345678')).toBe('+254 712 ••• 678');
    });
    it('masks an email', () => {
        expect(maskEmail('amani@example.com')).toBe('am•••@example.com');
    });
});

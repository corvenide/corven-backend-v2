// Colours for the modal, the same tokens as the Corven Connect designs.

export type ThemeMode = 'dark' | 'light';

export interface Tokens {
    accent: string;
    accentText: string;
    backdrop: string;
    bg: string;
    surface: string;
    surface2: string;
    border: string;
    borderStrong: string;
    text: string;
    muted: string;
    faint: string;
    shadow: string;
    chipBg: string;
    chipText: string;
    accentSoft: string;
    accentInk: string;
    warnBg: string;
    warnBorder: string;
    warnText: string;
    okText: string;
    dangerText: string;
    dangerBorder: string;
}

export function tokens(mode: ThemeMode, accent = '#3cc68a'): Tokens {
    const light = mode === 'light';
    const hex = /^#?[0-9a-f]{6}$/i.test(accent) ? accent.replace('#', '') : '3cc68a';
    const n = parseInt(hex, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const soft = `rgba(${r},${g},${b},${light ? 0.14 : 0.13})`;
    const ink = light ? `rgb(${Math.round(r * 0.42)},${Math.round(g * 0.42)},${Math.round(b * 0.42)})` : `#${hex}`;
    // Dark text on light accents, white on dark ones.
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const accentText = luminance > 0.55 ? '#06140c' : '#ffffff';

    const common = { accent: `#${hex}`, accentText, accentSoft: soft, accentInk: ink };
    return light
        ? {
            ...common,
            backdrop: 'rgba(20,24,22,0.38)',
            bg: '#ffffff',
            surface: '#f6f7f5',
            surface2: '#eaece8',
            border: 'rgba(16,20,24,0.09)',
            borderStrong: 'rgba(16,20,24,0.16)',
            text: '#14171b',
            muted: '#575d65',
            faint: '#6a7078',
            shadow: '0 1px 2px rgba(16,24,20,0.06), 0 24px 60px rgba(16,24,20,0.18)',
            chipBg: '#14171b',
            chipText: '#ffffff',
            warnBg: '#fff7e0',
            warnBorder: '#f0d48a',
            warnText: '#6e4c00',
            okText: ink,
            dangerText: '#b4232c',
            dangerBorder: 'rgba(180,35,44,0.3)',
        }
        : {
            ...common,
            backdrop: 'rgba(3,4,6,0.66)',
            bg: '#0f1114',
            surface: '#16191e',
            surface2: '#20242b',
            border: 'rgba(255,255,255,0.08)',
            borderStrong: 'rgba(255,255,255,0.14)',
            text: '#eceae5',
            muted: '#a1a7af',
            faint: '#7c838c',
            shadow: '0 1px 0 rgba(255,255,255,0.04) inset, 0 30px 80px rgba(0,0,0,0.55)',
            chipBg: '#eceae5',
            chipText: '#0f1114',
            warnBg: 'rgba(240,180,41,0.08)',
            warnBorder: 'rgba(240,180,41,0.35)',
            warnText: '#f3dfaa',
            okText: `#${hex}`,
            dangerText: '#f4a3a8',
            dangerBorder: 'rgba(240,113,120,0.35)',
        };
}

/** CSS custom properties on the modal root; the stylesheet reads these. */
export function cssVars(t: Tokens): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const [key, value] of Object.entries(t)) vars[`--cc-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = value;
    return vars;
}

export const FONT = "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
export const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

import type { ReactNode } from 'react';

function Svg({ size = 16, width = 2, children }: { size?: number; width?: number; children: ReactNode }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {children}
        </svg>
    );
}

export const Close = () => <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const Back = () => <Svg><path d="M15 18l-6-6 6-6" /></Svg>;
export const Chevron = ({ size = 12 }: { size?: number }) => <Svg size={size} width={2.4}><path d="M6 9l6 6 6-6" /></Svg>;
export const ChevronRight = () => <Svg size={14} width={2.2}><path d="M9 6l6 6-6 6" /></Svg>;
export const Copy = () => <Svg size={15}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></Svg>;
export const Check = ({ size = 15 }: { size?: number }) => <Svg size={size} width={2.6}><path d="M5 12l5 5 9-10" /></Svg>;
export const Phone = ({ size = 30 }: { size?: number }) => <Svg size={size} width={1.8}><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M10 6h4M11 18h2" /></Svg>;
export const Mail = ({ size = 30 }: { size?: number }) => <Svg size={size} width={1.8}><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3.5 7l8.5 6 8.5-6" /></Svg>;
export const Key = ({ size = 18 }: { size?: number }) => <Svg size={size}><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2L20 3M16 7l3 3" /></Svg>;
export const Passkey = ({ size = 18 }: { size?: number }) => <Svg size={size}><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 11-5.7" /><circle cx="18" cy="15" r="2.5" /><path d="M18 17.5V22M18 20h2" /></Svg>;
export const Send = () => <Svg size={18} width={2.2}><path d="M7 17L17 7M8 7h9v9" /></Svg>;
export const Receive = () => <Svg size={18}><path d="M17 7L7 17M16 17H7V8" /></Svg>;
export const Plus = ({ size = 18 }: { size?: number }) => <Svg size={size}><path d="M12 5v14M5 12h14" /></Svg>;
export const Cube = ({ size = 16 }: { size?: number }) => <Svg size={size}><path d="M12 2l9 5v10l-9 5-9-5V7z" /><path d="M3 7l9 5 9-5M12 12v10" /></Svg>;
export const Shield = () => <Svg><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></Svg>;
export const Lock = () => <Svg><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></Svg>;
export const Warn = () => <Svg><path d="M12 3l10 18H2z" /><path d="M12 10v4M12 17h.01" /></Svg>;
export const Ok = () => <Svg width={2.2}><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></Svg>;
export const Trash = () => <Svg size={15}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></Svg>;
export const External = () => <Svg size={13}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Svg>;
export const Wallet = ({ size = 18 }: { size?: number }) => <Svg size={size}><rect x="3" y="6" width="18" height="14" rx="3" /><path d="M3 10h18M16 15h2" /></Svg>;

export const GoogleG = () => (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
);

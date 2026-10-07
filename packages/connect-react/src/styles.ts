// The modal's stylesheet, injected once. Everything is scoped under
// .cc-root and coloured through the --cc-* variables from theme.ts.

import { FONT, MONO } from './theme';

const CSS = `
.cc-root,.cc-root *{box-sizing:border-box}
.cc-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--cc-backdrop);animation:cc-fade .16s ease-out}
.cc-card{position:relative;width:440px;max-width:100%;max-height:min(780px,calc(100vh - 32px));overflow:auto;background:var(--cc-bg);color:var(--cc-text);border:1px solid var(--cc-border);border-radius:24px;box-shadow:var(--cc-shadow);padding:22px 24px 18px;display:flex;flex-direction:column;font-family:${FONT};font-size:14px;line-height:1.45;animation:cc-rise .2s cubic-bezier(.2,.8,.2,1)}
@media (max-width:480px){.cc-overlay{align-items:flex-end;padding:0}.cc-card{width:100%;border-radius:22px 22px 0 0;max-height:92vh}}
.cc-root button{font-family:inherit;cursor:pointer}
.cc-root button:disabled{cursor:not-allowed}
.cc-root input{font-family:inherit}
.cc-root :focus-visible{outline:2px solid var(--cc-accent);outline-offset:2px}
.cc-mono{font-family:${MONO}}
.cc-row{display:flex;align-items:center}
.cc-between{display:flex;align-items:center;justify-content:space-between}
.cc-icon-btn{width:36px;height:36px;border-radius:10px;border:1px solid var(--cc-border);background:transparent;color:var(--cc-muted);display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0}
.cc-icon-btn:hover{color:var(--cc-text);border-color:var(--cc-border-strong)}
.cc-btn{height:50px;border-radius:14px;border:0;font-size:14.5px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:8px;width:100%;transition:filter .12s,background .12s}
.cc-btn-primary{background:var(--cc-accent);color:var(--cc-accent-text)}
.cc-btn-primary:hover:not(:disabled){filter:brightness(1.06)}
.cc-btn-primary:disabled{background:var(--cc-surface2);color:var(--cc-faint)}
.cc-btn-secondary{background:transparent;color:var(--cc-text);border:1px solid var(--cc-border-strong);font-weight:500}
.cc-btn-secondary:hover:not(:disabled){background:var(--cc-surface)}
.cc-btn-small{height:44px;border-radius:12px;font-size:13px;font-weight:500;background:transparent;color:var(--cc-text);border:1px solid var(--cc-border)}
.cc-btn-small:hover:not(:disabled){background:var(--cc-surface)}
.cc-btn-small:disabled{color:var(--cc-faint)}
.cc-field{height:52px;border-radius:14px;border:1px solid var(--cc-border-strong);background:var(--cc-surface);display:flex;align-items:center;overflow:hidden}
.cc-field:focus-within{border-color:var(--cc-accent);box-shadow:0 0 0 4px var(--cc-accent-soft)}
.cc-field input,.cc-field select{height:100%;border:0;background:transparent;color:var(--cc-text);font-size:15px;outline:none;min-width:0}
.cc-field select{appearance:none;padding:0 26px 0 14px;font-family:${MONO};font-size:14px;cursor:pointer}
.cc-field option{color:#14171b}
.cc-tabs{display:grid;grid-template-columns:1fr 1fr;padding:4px;border-radius:12px;background:var(--cc-surface);border:1px solid var(--cc-border)}
.cc-tab{height:36px;border-radius:9px;border:0;background:transparent;color:var(--cc-muted);font-size:13.5px;font-weight:500}
.cc-tab[aria-selected=true]{background:var(--cc-bg);color:var(--cc-text);box-shadow:0 1px 2px rgba(0,0,0,.12)}
.cc-utabs{display:flex;gap:18px;border-bottom:1px solid var(--cc-border)}
.cc-utab{padding:0 0 10px;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;background:transparent;color:var(--cc-muted);font-size:13.5px;font-weight:500}
.cc-utab[aria-selected=true]{border-bottom-color:var(--cc-text);color:var(--cc-text);font-weight:600}
.cc-otp{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}
.cc-otp input{height:60px;min-width:0;border-radius:14px;border:1px solid var(--cc-border-strong);background:var(--cc-surface);color:var(--cc-text);font:500 25px ${MONO};text-align:center;outline:none;caret-color:var(--cc-accent)}
.cc-otp input:focus{border-color:var(--cc-accent);box-shadow:0 0 0 4px var(--cc-accent-soft)}
.cc-otp[data-error=true] input{border-color:var(--cc-danger-border)}
.cc-error{margin-top:10px;padding:10px 12px;border-radius:12px;border:1px solid var(--cc-danger-border);color:var(--cc-danger-text);font-size:13px}
.cc-note{padding:12px 14px;border-radius:14px;background:var(--cc-surface);border:1px solid var(--cc-border);display:flex;gap:10px;font-size:12.5px;line-height:1.5;color:var(--cc-muted)}
.cc-warn{padding:12px 14px;border-radius:14px;background:var(--cc-warn-bg);border:1px solid var(--cc-warn-border);display:flex;gap:10px;font-size:13px;line-height:1.5;color:var(--cc-warn-text)}
.cc-card-surface{padding:18px;border-radius:18px;background:var(--cc-surface);border:1px solid var(--cc-border)}
.cc-dl{margin:0;padding:4px 18px;border-radius:18px;border:1px solid var(--cc-border);font-size:13.5px}
.cc-dl>div{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--cc-border)}
.cc-dl>div:last-child{border-bottom:0}
.cc-dl dt{color:var(--cc-muted)}
.cc-dl dd{margin:0;font-family:${MONO};text-align:right;overflow-wrap:anywhere}
.cc-action{height:64px;border-radius:14px;border:1px solid var(--cc-border);background:var(--cc-surface);color:var(--cc-text);font-size:12.5px;font-weight:500;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px}
.cc-action:hover:not(:disabled){border-color:var(--cc-border-strong)}
.cc-action:disabled{color:var(--cc-faint)}
.cc-action-primary{background:var(--cc-accent);color:var(--cc-accent-text);border:0;font-weight:600}
.cc-list{list-style:none;margin:4px 0 0;padding:0}
.cc-list li{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--cc-border)}
.cc-list li:last-child{border-bottom:0}
.cc-tile{width:34px;height:34px;border-radius:10px;background:var(--cc-surface);color:var(--cc-muted);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.cc-link{background:none;border:0;padding:0;color:var(--cc-accent-ink);font-weight:500;font-size:inherit}
.cc-link:hover{text-decoration:underline}
.cc-dots{display:flex;gap:6px}
.cc-dots span{width:18px;height:4px;border-radius:2px;background:var(--cc-border-strong)}
.cc-dots span[data-on=true]{background:var(--cc-accent)}
.cc-spin{width:16px;height:16px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:cc-spin .7s linear infinite}
.cc-ring{width:136px;height:136px;border-radius:50%;border:3px solid var(--cc-border);border-top-color:var(--cc-accent);border-right-color:var(--cc-accent);animation:cc-spin 1.2s linear infinite}
.cc-skel{height:10px;border-radius:5px;background:var(--cc-surface2);animation:cc-pulse 1.2s ease-in-out infinite}
.cc-pill{height:28px;padding:0 10px;border-radius:999px;border:1px solid var(--cc-border-strong);background:var(--cc-bg);color:var(--cc-text);font:500 12px ${MONO};display:flex;align-items:center;gap:6px}
.cc-dot{width:7px;height:7px;border-radius:50%;background:var(--cc-accent);flex-shrink:0}
.cc-copy{margin-top:14px;width:100%;height:40px;padding:0 12px;border-radius:11px;background:var(--cc-bg);color:var(--cc-muted);gap:8px;border:1px solid var(--cc-border);display:flex;align-items:center}
.cc-copy:hover{border-color:var(--cc-border-strong)}
.cc-copy-wide{margin-top:10px;height:46px}
.cc-wallet-row{width:100%;display:flex;align-items:center;gap:12px;padding:10px 4px;border:0;background:transparent;color:var(--cc-text);border-radius:12px;font-family:inherit}
.cc-wallet-row:hover:not(:disabled){background:var(--cc-surface)}
.cc-section-label{font-size:12px;color:var(--cc-faint);margin:6px 0 2px;text-transform:uppercase;letter-spacing:.06em}
.cc-connect-btn{height:42px;padding:0 16px;border-radius:12px;border:0;font:600 14px ${FONT};display:inline-flex;align-items:center;gap:8px;cursor:pointer}
@keyframes cc-spin{to{transform:rotate(360deg)}}
@keyframes cc-fade{from{opacity:0}}
@keyframes cc-rise{from{opacity:0;transform:translateY(10px) scale(.985)}}
@keyframes cc-pulse{50%{opacity:.5}}
@media (prefers-reduced-motion:reduce){.cc-root *{animation:none!important}}
`;

let injected = false;

export function injectStyles(loadFonts: boolean): void {
    if (injected || typeof document === 'undefined') return;
    injected = true;

    const style = document.createElement('style');
    style.setAttribute('data-corven-connect', '');
    style.textContent = CSS;
    document.head.appendChild(style);

    if (loadFonts && !document.querySelector('link[data-corven-connect-fonts]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap';
        link.setAttribute('data-corven-connect-fonts', '');
        document.head.appendChild(link);
    }
}

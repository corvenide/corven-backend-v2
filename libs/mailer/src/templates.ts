// libs/mailer/src/templates.ts
//
// Email templates. Table layout and inline styles, because many email
// clients ignore <style> and modern CSS.

const escape = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface CodeEmailOptions {
    code: string;
    /** The app the person is signing in to. */
    appName: string;
    purpose: 'sign-in' | 'confirm';
    minutesValid: number;
    accent?: string;
}

export function codeEmail({ code, appName, purpose, minutesValid, accent = '#3cc68a' }: CodeEmailOptions) {
    const app = escape(appName);
    const subject = purpose === 'sign-in' ? `${code} is your ${appName} sign-in code` : `${code} is your ${appName} confirmation code`;
    const lead =
        purpose === 'sign-in'
            ? `Use this code to sign in to <strong>${app}</strong>.`
            : `Use this code to confirm a sensitive action in <strong>${app}</strong>, like signing a mainnet transaction or exporting your key.`;

    const text = [
        purpose === 'sign-in' ? `Your ${appName} sign-in code: ${code}` : `Your ${appName} confirmation code: ${code}`,
        '',
        `It expires in ${minutesValid} minutes.`,
        `If you didn't ask for it, ignore this email. Never share this code: ${appName} and Corven will never ask you for it.`,
        '',
        'Secured by Corven Connect',
    ].join('\n');

    const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:#f2f3f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#14171b">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${escape(code)} is your code. It expires in ${minutesValid} minutes.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f1;padding:32px 12px">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e3e5e1;border-radius:20px">
      <tr><td style="padding:28px 28px 8px">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="width:28px;height:28px;border-radius:8px;background:#14171b;color:#ffffff;font-weight:700;font-size:14px;text-align:center;vertical-align:middle">${escape(appName.slice(0, 1).toUpperCase())}</td>
          <td style="padding-left:10px;font-size:14px;color:#575d65">${app}</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:16px 28px 0">
        <h1 style="margin:0 0 8px;font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-0.02em;color:#14171b">${purpose === 'sign-in' ? 'Your sign-in code' : 'Confirm it’s you'}</h1>
        <p style="margin:0;font-size:15px;line-height:1.55;color:#575d65">${lead}</p>
      </td></tr>
      <tr><td style="padding:22px 28px">
        <div style="background:#f6f7f5;border:1px solid #e3e5e1;border-radius:14px;padding:18px 12px;text-align:center;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:34px;font-weight:600;letter-spacing:10px;padding-left:22px;color:#14171b">${escape(code)}</div>
        <p style="margin:12px 0 0;font-size:13px;color:#6a7078;text-align:center">Expires in ${minutesValid} minutes</p>
      </td></tr>
      <tr><td style="padding:0 28px 26px">
        <div style="border-left:3px solid ${escape(accent)};padding:2px 0 2px 12px;font-size:13px;line-height:1.55;color:#575d65">Never share this code. ${app} and Corven will never ask you for it. If you didn’t request it, you can ignore this email.</div>
      </td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:12px;color:#8a9097">Secured by <strong style="color:#575d65">Corven Connect</strong></p>
  </td></tr>
</table>
</body>
</html>`;

    return { subject, text, html };
}

export interface InviteEmailOptions {
    appName: string;
    inviterName: string;
    role: string;
    link: string;
    daysValid: number;
}

/** "You've been invited to manage <app> on Corven Connect." */
export function inviteEmail({ appName, inviterName, role, link, daysValid }: InviteEmailOptions) {
    const app = escape(appName);
    const who = escape(inviterName);
    const roleText = role === 'OWNER' ? 'an owner' : role === 'ADMIN' ? 'an admin' : 'a viewer';
    const subject = `${inviterName} invited you to manage ${appName} on Corven Connect`;
    const text = [
        `${inviterName} invited you to join ${appName} on Corven Connect as ${roleText}.`,
        '',
        `Accept the invite: ${link}`,
        '',
        `The link works for ${daysValid} days. Sign in to Corven with any account to accept it.`,
    ].join('\n');

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:#f2f3f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#14171b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f1;padding:32px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#ffffff;border:1px solid #e3e5e1;border-radius:20px">
    <tr><td style="padding:28px 28px 0">
      <div style="width:36px;height:36px;border-radius:10px;background:#14171b;color:#fff;font-weight:700;font-size:16px;line-height:36px;text-align:center">${escape(appName.slice(0, 1).toUpperCase())}</div>
      <h1 style="margin:18px 0 8px;font-size:21px;line-height:1.3;font-weight:600;letter-spacing:-0.02em">Join ${app} on Corven Connect</h1>
      <p style="margin:0;font-size:15px;line-height:1.55;color:#575d65"><strong style="color:#14171b">${who}</strong> invited you to help manage <strong style="color:#14171b">${app}</strong> as ${roleText}.</p>
    </td></tr>
    <tr><td style="padding:24px 28px">
      <a href="${escape(link)}" style="display:inline-block;background:#3cc68a;color:#06140c;text-decoration:none;font-weight:600;font-size:15px;padding:13px 22px;border-radius:12px">Accept invite</a>
      <p style="margin:14px 0 0;font-size:12.5px;line-height:1.5;color:#6a7078">The link works for ${daysValid} days. Sign in to Corven with any account to accept it. If you weren't expecting this, ignore the email.</p>
    </td></tr>
  </table>
  <p style="margin:16px 0 0;font-size:12px;color:#8a9097">Corven Connect</p>
</td></tr></table>
</body></html>`;

    return { subject, text, html };
}

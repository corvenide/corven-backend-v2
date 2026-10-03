// apps/api-gateway/src/preview-proxy.ts
//
// Lets the IDE show a dev server running inside a workspace.
//
// The IDE asks for a preview of (workspace, port) with its normal bearer
// token and gets back a signed, expiring URL:
//
//   /api/preview/<token>/<path>
//
// An <iframe> can't send an Authorization header, so the token in the URL
// is the credential. It is bound to one user, workspace and port, and every
// request re-checks through the runtime service that the workspace is still
// the user's and running. The proxy forwards HTTP and WebSocket traffic
// (Vite hot reload) to the container port published on the Docker host.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { NextFunction, Request, Response } from 'express';

import type { ApiGatewayService } from './api-gateway.service';

export const PREVIEW_PATH = '/api/preview';

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const TARGET_CACHE_MS = 15 * 1000;

interface PreviewClaims {
    u: string; // user id
    w: string; // workspace id
    p: number; // container port
    e: number; // expiry, ms since epoch
}

let fallbackSecret: string | null = null;

function secret(): string {
    const configured = process.env.PREVIEW_SECRET || process.env.JWT_SECRET;
    if (configured) return configured;

    // Tokens then die with the process, which is acceptable for a preview.
    fallbackSecret ??= randomBytes(32).toString('hex');
    return fallbackSecret;
}

function sign(body: string): string {
    return createHmac('sha256', secret()).update(body).digest('base64url');
}

export function createPreviewToken(userId: string, workspaceId: string, port: number): string {
    const claims: PreviewClaims = { u: userId, w: workspaceId, p: port, e: Date.now() + TOKEN_TTL_MS };
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${body}.${sign(body)}`;
}

export function readPreviewToken(token: string): PreviewClaims | null {
    const [body, signature] = token.split('.');
    if (!body || !signature) return null;

    const expected = Buffer.from(sign(body));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

    try {
        const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as PreviewClaims;
        if (!claims.u || !claims.w || !Number.isInteger(claims.p) || claims.e < Date.now()) return null;
        return claims;
    } catch {
        return null;
    }
}

/** Splits `/<token>/rest?query` into the token and the path to forward. */
function splitUrl(url: string): { token: string; path: string } | null {
    const match = /^\/([^/?#]+)(\/[^#]*|\?[^#]*)?/.exec(url);
    if (!match) return null;

    const rest = match[2] ?? '/';
    return { token: match[1], path: rest.startsWith('?') ? `/${rest}` : rest };
}

export function createPreviewProxy(gateway: ApiGatewayService) {
    const targets = new Map<string, { host: string; port: number; at: number }>();

    async function targetFor(claims: PreviewClaims) {
        const key = `${claims.u}:${claims.w}:${claims.p}`;
        const cached = targets.get(key);
        if (cached && Date.now() - cached.at < TARGET_CACHE_MS) return cached;

        const target = (await gateway.resolvePreview(claims.u, claims.w, claims.p)) as { host: string; port: number };
        const entry = { ...target, at: Date.now() };

        if (targets.size > 500) targets.clear();
        targets.set(key, entry);

        return entry;
    }

    function fail(res: Response, status: number, message: string) {
        if (res.headersSent) {
            res.end();
            return;
        }
        res.status(status).type('text/plain').send(message);
    }

    /** Express middleware, mounted at PREVIEW_PATH. `req.url` is the rest. */
    async function handleHttp(req: Request, res: Response, next: NextFunction) {
        const parts = splitUrl(req.url);
        if (!parts) return next();

        const claims = readPreviewToken(parts.token);
        if (!claims) return fail(res, 401, 'This preview link is invalid or has expired. Reopen it from the IDE.');

        let target: { host: string; port: number };
        try {
            target = await targetFor(claims);
        } catch (error) {
            const status = (error as { getStatus?: () => number }).getStatus?.() ?? 502;
            const message = error instanceof Error ? error.message : 'Preview unavailable';
            return fail(res, status, message);
        }

        const prefix = `${PREVIEW_PATH}/${parts.token}`;

        const headers = { ...req.headers };
        delete headers.cookie;
        delete headers.authorization;
        headers.host = `127.0.0.1:${claims.p}`;
        // Keep the body plain so root-relative links in HTML can be rewritten.
        headers['accept-encoding'] = 'identity';
        delete headers.origin;
        delete headers.referer;

        const upstream = http.request(
            { host: target.host, port: target.port, method: req.method, path: parts.path, headers },
            (upstreamRes) => {
                const responseHeaders = { ...upstreamRes.headers };

                // The page is shown in an iframe on another origin.
                delete responseHeaders['x-frame-options'];
                delete responseHeaders['content-security-policy'];
                delete responseHeaders['set-cookie'];

                // The iframe is sandboxed (opaque origin), so module scripts
                // and fetches need CORS to read their own responses.
                responseHeaders['access-control-allow-origin'] = '*';

                const location = responseHeaders.location;
                if (typeof location === 'string' && location.startsWith('/') && !location.startsWith('//')) {
                    responseHeaders.location = `${prefix}${location}`;
                }

                const isHtml = String(responseHeaders['content-type'] ?? '').includes('text/html');

                if (!isHtml) {
                    res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
                    upstreamRes.pipe(res);
                    return;
                }

                const chunks: Buffer[] = [];
                upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk));
                upstreamRes.on('end', () => {
                    const html = Buffer.concat(chunks)
                        .toString('utf8')
                        .replace(/(\s(?:src|href|action|poster)\s*=\s*["'])\/(?!\/)/gi, `$1${prefix}/`);

                    delete responseHeaders['transfer-encoding'];
                    delete responseHeaders['etag'];
                    responseHeaders['content-length'] = String(Buffer.byteLength(html));
                    res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
                    res.end(html);
                });
                upstreamRes.on('error', () => res.destroy());
            },
        );

        upstream.setTimeout(30_000, () => upstream.destroy(new Error('timeout')));
        upstream.on('error', (error) => {
            const refused = (error as NodeJS.ErrnoException).code === 'ECONNREFUSED';
            fail(
                res,
                502,
                refused
                    ? `Nothing is listening on port ${claims.p} in your workspace yet.\n` +
                          `Start your server in the terminal and bind to 0.0.0.0 (for example: python3 -m http.server ${claims.p} --bind 0.0.0.0).`
                    : `Couldn't reach your workspace: ${error.message}`,
            );
        });

        req.pipe(upstream);
    }

    /** `upgrade` handler on the HTTP server, for hot-reload sockets. */
    async function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
        const url = req.url ?? '';
        if (!url.startsWith(`${PREVIEW_PATH}/`)) return false;

        const parts = splitUrl(url.slice(PREVIEW_PATH.length));
        const claims = parts && readPreviewToken(parts.token);

        if (!parts || !claims) {
            socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
            return true;
        }

        try {
            const target = await targetFor(claims);
            const upstream = net.connect(target.port, target.host, () => {
                const headers = { ...req.headers, host: `127.0.0.1:${claims.p}` };
                delete headers.cookie;
                delete headers.authorization;
                delete headers.origin;

                const lines = Object.entries(headers).flatMap(([name, value]) =>
                    Array.isArray(value) ? value.map((v) => `${name}: ${v}`) : [`${name}: ${value}`],
                );

                upstream.write(`${req.method} ${parts.path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
                if (head.length) upstream.write(head);
                upstream.pipe(socket);
                socket.pipe(upstream);
            });

            upstream.on('error', () => socket.destroy());
            socket.on('error', () => upstream.destroy());
            socket.on('close', () => upstream.destroy());
        } catch {
            socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }

        return true;
    }

    return { handleHttp, handleUpgrade };
}

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createPreviewProxy, createPreviewToken, PREVIEW_PATH, readPreviewToken } from './preview-proxy';

function listen(server: http.Server): Promise<number> {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

function get(port: number, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path }, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        }).on('error', reject);
    });
}

describe('preview token', () => {
    it('round-trips and rejects tampering', () => {
        const token = createPreviewToken('u1', 'w1', 5173);
        expect(readPreviewToken(token)).toMatchObject({ u: 'u1', w: 'w1', p: 5173 });
        expect(readPreviewToken(`${token}x`)).toBeNull();
        expect(readPreviewToken(`x${token}`)).toBeNull();
        expect(readPreviewToken('nope')).toBeNull();
    });
});

describe('preview proxy', () => {
    let dev: http.Server;
    let gateway: http.Server;
    let gatewayPort: number;
    let resolved: { userId: string; workspaceId: string; port: number } | null = null;

    beforeAll(async () => {
        dev = http.createServer((req, res) => {
            if (req.url === '/redirect') {
                res.writeHead(302, { location: '/home' });
                return res.end();
            }
            res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' });
            res.end(`<script src="/app.js"></script><a href="//cdn.example/x">x</a><p>${req.url}</p>`);
        });
        const devPort = await listen(dev);

        const app = express();
        const proxy = createPreviewProxy({
            resolvePreview: async (userId: string, workspaceId: string, port: number) => {
                resolved = { userId, workspaceId, port };
                return { host: '127.0.0.1', port: devPort };
            },
        } as never);
        app.use(PREVIEW_PATH, (req, res, next) => void proxy.handleHttp(req, res, next));
        gateway = http.createServer(app);
        gatewayPort = await listen(gateway);
    });

    afterAll(() => {
        dev.close();
        gateway.close();
    });

    it('proxies, rewrites root-relative links and drops frame blocking', async () => {
        const token = createPreviewToken('u1', 'w1', 5173);
        const res = await get(gatewayPort, `${PREVIEW_PATH}/${token}/some/page?x=1`);

        expect(resolved).toEqual({ userId: 'u1', workspaceId: 'w1', port: 5173 });
        expect(res.status).toBe(200);
        expect(res.headers['x-frame-options']).toBeUndefined();
        expect(res.headers['access-control-allow-origin']).toBe('*');
        expect(res.body).toContain(`src="${PREVIEW_PATH}/${token}/app.js"`);
        expect(res.body).toContain('href="//cdn.example/x"');
        expect(res.body).toContain('/some/page?x=1');
    });

    it('serves the root and prefixes redirects', async () => {
        const token = createPreviewToken('u1', 'w1', 5173);

        expect((await get(gatewayPort, `${PREVIEW_PATH}/${token}`)).body).toContain('<p>/</p>');
        expect((await get(gatewayPort, `${PREVIEW_PATH}/${token}/redirect`)).headers.location).toBe(
            `${PREVIEW_PATH}/${token}/home`,
        );
    });

    it('rejects a bad token', async () => {
        expect((await get(gatewayPort, `${PREVIEW_PATH}/bad.token/`)).status).toBe(401);
    });
});

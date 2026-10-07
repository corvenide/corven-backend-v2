#!/usr/bin/env node
// scripts/dev.mjs
//
// Runs every backend service in one terminal.
//
//   pnpm dev                      all services except cell- and connect-service
//   pnpm dev --all                everything, including cell- and connect-service
//   pnpm dev auth api-gateway     only the services you name
//   pnpm dev connect              only Corven Connect (needs CONNECT_* in .env)
//
// One `tsc --watch` compiles the whole monorepo into dist-dev/. Each
// service runs as a plain Node process from that output and restarts only
// when its own compiled files change (or everything restarts when a
// shared library changes). That uses far less memory than one
// `nest start --watch` compiler per service.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, watch } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-dev');
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Services. `portEnv` is only used for the startup port check.
// ---------------------------------------------------------------------------

const SERVICES = [
    { name: 'auth-service', short: 'auth', color: 35, portEnv: 'AUTH_SERVICE_PORT', port: 8001 },
    { name: 'workspace-service', short: 'workspace', color: 34, portEnv: 'WORKSPACE_SERVICE_PORT', port: 8002 },
    { name: 'runtime-service', short: 'runtime', color: 33, portEnv: 'RUNTIME_SERVICE_PORT', port: 8003 },
    { name: 'terminal-service', short: 'terminal', color: 36, portEnv: 'TERMINAL_SERVICE_PORT', port: 8004 },
    { name: 'file-service', short: 'file', color: 32, portEnv: 'FILE_SERVICE_PORT', port: 8005 },
    { name: 'cell-service', short: 'cell', color: 90, portEnv: 'CELL_SERVICE_PORT', port: 8006, optional: true },
    { name: 'connect-service', short: 'connect', color: 95, portEnv: 'CONNECT_SERVICE_PORT', port: 8007, optional: true },
    // Last, so its TCP clients find the others already listening.
    { name: 'api-gateway', short: 'gateway', color: 97, portEnv: 'API_GATEWAY_PORT', port: 8000 },
];

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const width = Math.max(...SERVICES.map((s) => s.short.length), 'dev'.length);

function log(label, color, text) {
    const prefix = paint(color, `${label.padEnd(width)} │`);
    for (const line of String(text).replace(/\s+$/, '').split('\n')) {
        process.stdout.write(`${prefix} ${line}\n`);
    }
}

const say = (text) => log('dev', 90, text);
const warn = (text) => log('dev', 33, text);

function pipe(stream, label, color) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) log(label, color, line);
    });
    stream.on('end', () => buffer && log(label, color, buffer));
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const wantsAll = args.includes('--all');
const named = args.filter((arg) => !arg.startsWith('--'));

const unknown = named.filter(
    (arg) => !SERVICES.some((s) => s.name === arg || s.short === arg),
);

if (unknown.length) {
    warn(`Unknown service: ${unknown.join(', ')}`);
    warn(`Available: ${SERVICES.map((s) => s.short).join(', ')}`);
    process.exit(1);
}

const selected = named.length
    ? SERVICES.filter((s) => named.includes(s.name) || named.includes(s.short))
    : SERVICES.filter((s) => wantsAll || !s.optional);

// ---------------------------------------------------------------------------
// Environment: load .env so every service (and the port check) sees the
// same values, including code that reads process.env before Nest's
// ConfigModule has loaded.
// ---------------------------------------------------------------------------

const envFile = path.join(ROOT, '.env');

if (existsSync(envFile)) {
    require('dotenv').config({ path: envFile, quiet: true });
} else {
    warn('No .env file found in the backend folder. Services will use defaults.');
}

const childEnv = {
    ...process.env,
    // Resolve the tsconfig path aliases (@app/prisma, libs/…, src/…)
    // against the compiled output instead of the TypeScript sources.
    TS_NODE_BASEURL: OUT,
    NODE_ENV: process.env.NODE_ENV || 'development',
    FORCE_COLOR: useColor ? '1' : '0',
};

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

function portInUse(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(true));
        server.once('listening', () => server.close(() => resolve(false)));
        server.listen(port, '127.0.0.1');
    });
}

async function preflight() {
    const busy = [];

    for (const service of selected) {
        const port = Number(process.env[service.portEnv]) || service.port;
        if (await portInUse(port)) busy.push(`${service.short} (:${port})`);
    }

    if (busy.length) {
        warn(`Port already in use: ${busy.join(', ')}. Is another copy running?`);
        process.exit(1);
    }

    const needsDocker = selected.some((s) =>
        ['runtime-service', 'terminal-service', 'file-service'].includes(s.name),
    );

    const socket = (process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock').replace(/^unix:\/\//, '');

    if (needsDocker && !existsSync(socket)) {
        warn(`Docker socket not found at ${socket}.`);
        warn('Start Docker first (e.g. `colima start fiberdev`). Runtime, terminal and file services need it.');
    }

    if (selected.some((s) => s.name === 'auth-service')) {
        const secret = process.env.JWT_SECRET || '';
        if (secret.length < 32) {
            warn('JWT_SECRET is missing or shorter than 32 characters; auth-service will refuse to start.');
            warn('Generate one with: openssl rand -base64 48');
        }
    }

    if (!process.env.DATABASE_URL) {
        warn('DATABASE_URL is not set.');
    }
}

// ---------------------------------------------------------------------------
// Service processes
// ---------------------------------------------------------------------------

const running = new Map(); // name -> ChildProcess
let shuttingDown = false;

function entryFor(service) {
    return path.join(OUT, 'apps', service.name, 'src', 'main.js');
}

function start(service) {
    const child = spawn(
        process.execPath,
        ['--enable-source-maps', '-r', 'tsconfig-paths/register', entryFor(service)],
        { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    running.set(service.name, child);
    pipe(child.stdout, service.short, service.color);
    pipe(child.stderr, service.short, service.color);

    child.on('exit', (code, signal) => {
        if (running.get(service.name) === child) running.delete(service.name);
        if (shuttingDown || child.restarting) return;

        warn(
            `${service.short} exited (${signal ?? `code ${code}`}). ` +
                'It will start again on your next save.',
        );
    });
}

function stop(service) {
    const child = running.get(service.name);
    if (!child) return Promise.resolve();

    return new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        child.restarting = true;
        child.kill('SIGTERM');
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startAll(services) {
    for (const service of services) {
        start(service);
        // Stagger start-up so two cores aren't hit by seven boots at once.
        await sleep(400);
    }
}

async function restart(services) {
    if (!services.length) return;
    say(`restarting ${services.map((s) => s.short).join(', ')}`);
    await Promise.all(services.map(stop));
    await startAll(services);
}

// ---------------------------------------------------------------------------
// Compiler + change tracking
// ---------------------------------------------------------------------------

const changed = new Set(); // relative paths under dist-dev written since last compile

function trackOutput() {
    try {
        watch(OUT, { recursive: true }, (_event, file) => {
            if (file && file.endsWith('.js')) changed.add(file.split(path.sep).join('/'));
        });
    } catch {
        // Recursive fs.watch isn't available everywhere (older Linux Node).
        // Fall back to restarting everything on each successful compile.
        return false;
    }
    return true;
}

function affectedServices(canTrack) {
    if (!canTrack) return selected;

    const files = [...changed];
    changed.clear();

    if (!files.length) return [];

    // Anything outside apps/<service>/ (libs/, src/generated/) is shared.
    if (files.some((file) => !file.startsWith('apps/'))) return selected;

    return selected.filter((service) =>
        files.some((file) => file.startsWith(`apps/${service.name}/`)),
    );
}

function runCompiler() {
    const tsc = require.resolve('typescript/bin/tsc');

    const child = spawn(
        process.execPath,
        [tsc, '-p', 'tsconfig.dev.json', '--watch', '--preserveWatchOutput', '--pretty', String(useColor)],
        { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let firstBuild = true;
    let canTrack = false;
    let buffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', async (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
            const clean = line.replace(/\x1b\[[0-9;]*m/g, '');

            if (/Starting (incremental )?compilation|File change detected/.test(clean)) continue;

            const done = clean.match(/Found (\d+) errors?\./);

            if (!done) {
                if (clean.trim()) log('tsc', 31, line);
                continue;
            }

            const errors = Number(done[1]);

            if (errors > 0) {
                warn(`${errors} TypeScript error${errors === 1 ? '' : 's'}. Services keep running the last good build.`);
                changed.clear();
                continue;
            }

            if (firstBuild) {
                firstBuild = false;
                changed.clear();
                canTrack = trackOutput();

                const missing = selected.filter((s) => !existsSync(entryFor(s)));
                if (missing.length) {
                    warn(`No compiled entry for: ${missing.map((s) => s.short).join(', ')}`);
                }

                say(`compiled, starting ${selected.map((s) => s.short).join(', ')}`);
                await startAll(selected.filter((s) => !missing.includes(s)));
                continue;
            }

            // Let the output watcher catch up with the files tsc just wrote.
            await sleep(150);
            await restart(affectedServices(canTrack));
        }
    });

    pipe(child.stderr, 'tsc', 31);

    child.on('exit', (code) => {
        if (!shuttingDown) {
            warn(`TypeScript compiler exited (code ${code}).`);
            void shutdown(1);
        }
    });

    return child;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let compiler;

async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    say('stopping…');
    compiler?.kill('SIGTERM');
    await Promise.all(selected.map(stop));
    process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
say(`${pkg.name ?? 'backend'} — ${selected.map((s) => s.short).join(', ')}`);

await preflight();
say('compiling…');
compiler = runCompiler();

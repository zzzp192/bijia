import net from 'node:net';
import fs from 'node:fs/promises';
import { defaultProfileName, socketPath, pidFile, daemonVersionFile, ensureRoot, ensureProfileRuntimeDir, } from '../session/paths.js';
import { getSharedContext, getSharedContextStatus, releaseSharedContext, runOnSharedCtx, } from '../session/shared.js';
import { loadExecutor } from '../session/dispatch.js';
import { CliError } from '../io/errors.js';
import { throttle } from './throttle.js';
import pkg from '../../package.json' with { type: 'json' };
const stats = {
    profile: 'default',
    version: pkg.version,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    commandCount: 0,
    lastRequestAt: null,
    lastError: null,
    health: {
        lastPageState: null,
        lastFailureKind: null,
        lastRecoveryAction: null,
        consecutiveFailures: 0,
        consecutiveRateLimits: 0,
        lastSuccessfulActionAt: null,
        contextRecreatedAt: null,
        pausedUntil: null,
    },
};
const DAEMON_BLOCKED_COMMANDS = new Set(['checkout-confirm']);
let activeClients = 0;
let lastActivityMs = Date.now();
let server = null;
let shuttingDown = false;
export async function start(opts = {}) {
    const profile = defaultProfileName(opts.profile);
    const idleMs = opts.idleTimeoutMs ?? 30 * 60 * 1000;
    await ensureRoot();
    await ensureProfileRuntimeDir(profile);
    stats.profile = profile;
    // Clean any stale socket. If pidfile points to a live process, refuse.
    await refuseIfAlive(profile);
    // Windows named pipes have no filesystem entry — skip the unlink.
    if (process.platform !== 'win32') {
        try {
            await fs.unlink(socketPath(profile));
        }
        catch {
            /* not present, fine */
        }
    }
    await fs.writeFile(pidFile(profile), String(process.pid));
    await fs.writeFile(daemonVersionFile(profile), pkg.version);
    log(`profile ${profile}, pid ${process.pid}, socket ${socketPath(profile)}`);
    if (opts.prewarm) {
        log('prewarming Chromium...');
        await getSharedContext(profile);
        log('Chromium ready');
    }
    server = net.createServer((sock) => handleClient(sock));
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath(profile), () => {
            server.off('error', reject);
            resolve();
        });
    });
    log('listening');
    const idleTimer = setInterval(() => {
        if (!shuttingDown &&
            activeClients === 0 &&
            Date.now() - lastActivityMs > idleMs) {
            log(`idle for ${Math.round(idleMs / 60000)}min — shutting down`);
            void shutdown(profile);
        }
    }, 10_000);
    idleTimer.unref();
    for (const sig of ['SIGTERM', 'SIGINT']) {
        process.on(sig, () => {
            log(`received ${sig}`);
            void shutdown(profile);
        });
    }
}
function handleClient(sock) {
    activeClients++;
    lastActivityMs = Date.now();
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line)
                continue;
            let req;
            try {
                req = JSON.parse(line);
            }
            catch {
                sock.write(JSON.stringify({
                    id: '?',
                    ok: false,
                    exitCode: 1,
                    code: 'BAD_REQUEST',
                    message: 'invalid JSON',
                }) + '\n');
                continue;
            }
            void handleRequest(req).then((resp) => {
                if (!sock.writable)
                    return;
                sock.write(JSON.stringify(resp) + '\n');
            });
        }
    });
    sock.on('error', () => {
        /* swallow client errors */
    });
    sock.on('close', () => {
        activeClients--;
        lastActivityMs = Date.now();
    });
}
async function handleRequest(req) {
    lastActivityMs = Date.now();
    stats.lastRequestAt = new Date().toISOString();
    stats.commandCount++;
    try {
        if (req.cmd === 'status') {
            const browser = await getSharedContextStatus();
            return {
                id: req.id,
                ok: true,
                data: {
                    ...stats,
                    uptimeMs: Date.now() - new Date(stats.startedAt).getTime(),
                    activeClients,
                    browser,
                },
            };
        }
        if (req.cmd === 'shutdown') {
            setTimeout(() => void shutdown(stats.profile), 50);
            return { id: req.id, ok: true, data: { stopping: true } };
        }
        if (DAEMON_BLOCKED_COMMANDS.has(req.cmd)) {
            throw new CliError(20, 'DAEMON_COMMAND_DISABLED', `${req.cmd} must run through the CLI confirmation path, not the daemon socket.`);
        }
        await enforceHealthPause();
        await throttle(req.cmd);
        const fn = await loadExecutor(req.cmd);
        const data = await runOnSharedCtx((ctx) => fn(ctx, req.args), {
            requestId: req.id,
            cmd: req.cmd,
            args: req.args,
        }, stats.profile);
        recordSuccess();
        return { id: req.id, ok: true, data };
    }
    catch (e) {
        stats.lastError = e.message ?? String(e);
        recordFailure(e);
        if (e instanceof CliError) {
            return {
                id: req.id,
                ok: false,
                exitCode: e.exitCode,
                code: e.code,
                message: e.message,
                details: e.details,
            };
        }
        return {
            id: req.id,
            ok: false,
            exitCode: 1,
            code: 'INTERNAL',
            message: e.message ?? String(e),
        };
    }
}
async function enforceHealthPause() {
    const pausedUntil = stats.health.pausedUntil;
    if (!pausedUntil)
        return;
    const until = new Date(pausedUntil).getTime();
    if (!Number.isFinite(until) || Date.now() >= until) {
        stats.health.pausedUntil = null;
        return;
    }
    throw new CliError(9, 'DAEMON_PAUSED', `Daemon for profile "${stats.profile}" is paused until ${pausedUntil} after repeated 1688 failures.`, {
        category: 'daemon_health',
        recoverHint: `Wait for the pause to expire, or run \`1688 daemon reload --profile ${stats.profile}\` after manually resolving login/risk-control issues.`,
        retryable: true,
        pausedUntil,
        failureKind: stats.health.lastFailureKind,
        recoveryAction: stats.health.lastRecoveryAction,
    });
}
function recordSuccess() {
    stats.health.consecutiveFailures = 0;
    stats.health.consecutiveRateLimits = 0;
    stats.health.lastSuccessfulActionAt = new Date().toISOString();
    stats.health.pausedUntil = null;
}
function detailString(e, key) {
    if (!(e instanceof CliError))
        return null;
    const v = e.details[key];
    return typeof v === 'string' ? v : null;
}
function recordFailure(e) {
    if (e instanceof CliError && e.code === 'DAEMON_PAUSED')
        return;
    stats.health.consecutiveFailures++;
    const pageState = detailString(e, 'pageState');
    const failureKind = detailString(e, 'failureKind');
    const recoveryAction = detailString(e, 'recoveryAction');
    if (pageState)
        stats.health.lastPageState = pageState;
    if (failureKind)
        stats.health.lastFailureKind = failureKind;
    if (recoveryAction)
        stats.health.lastRecoveryAction = recoveryAction;
    if (failureKind === 'rate_limited' || (e instanceof CliError && e.code === 'RATE_LIMITED')) {
        stats.health.consecutiveRateLimits++;
    }
    else if (failureKind && failureKind !== 'rate_limited') {
        stats.health.consecutiveRateLimits = 0;
    }
    const now = Date.now();
    if (failureKind === 'rate_limited' && stats.health.consecutiveRateLimits >= 2) {
        stats.health.pausedUntil = new Date(now + 5 * 60_000).toISOString();
    }
    else if (failureKind === 'risk_challenge' || failureKind === 'not_logged_in') {
        stats.health.pausedUntil = new Date(now + 10 * 60_000).toISOString();
    }
    else if (stats.health.consecutiveFailures >= 5) {
        stats.health.pausedUntil = new Date(now + 2 * 60_000).toISOString();
    }
}
async function refuseIfAlive(profile) {
    let pidStr;
    try {
        pidStr = await fs.readFile(pidFile(profile), 'utf8');
    }
    catch {
        return;
    }
    const pid = parseInt(pidStr.trim(), 10);
    if (!Number.isInteger(pid))
        return;
    try {
        process.kill(pid, 0); // probe — throws if not alive
        throw new CliError(5, 'DAEMON_RUNNING', `Daemon already running for profile "${profile}" (pid ${pid}). Use \`1688 daemon stop --profile ${profile}\` first.`);
    }
    catch (e) {
        if (e.code === 'DAEMON_RUNNING')
            throw e;
        // ESRCH — stale pidfile, ignore.
    }
}
async function shutdown(profile = stats.profile) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    log(`shutting down profile ${profile}`);
    if (server) {
        await new Promise((r) => server.close(() => r()));
    }
    await releaseSharedContext();
    if (process.platform !== 'win32') {
        try {
            await fs.unlink(socketPath(profile));
        }
        catch {
            /* ignore */
        }
    }
    try {
        await fs.unlink(pidFile(profile));
    }
    catch {
        /* ignore */
    }
    try {
        await fs.unlink(daemonVersionFile(profile));
    }
    catch {
        /* ignore */
    }
    log('bye');
    process.exit(0);
}
function log(msg) {
    process.stderr.write(`[daemon ${new Date().toISOString()}] ${msg}\n`);
}
//# sourceMappingURL=server.js.map
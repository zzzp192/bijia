import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultProfileName, pidFile, socketPath, daemonLogFile, daemonVersionFile, ensureRoot, ensureProfileRuntimeDir, lockFile, } from '../session/paths.js';
import { daemonCall, isDaemonReachable } from './client.js';
import { CliError } from '../io/errors.js';
import { waitUntil } from '../session/wait.js';
import pkg from '../../package.json' with { type: 'json' };
export async function status(profile) {
    const profileName = defaultProfileName(profile);
    const pid = await readPid(profileName);
    const version = await readDaemonVersion(profileName);
    const expectedVersion = pkg.version;
    if (pid === null) {
        return {
            profile: profileName,
            running: false,
            version,
            expectedVersion,
            versionMatches: version === expectedVersion,
        };
    }
    const alive = isProcessAlive(pid);
    if (!alive) {
        return {
            profile: profileName,
            running: false,
            version,
            expectedVersion,
            versionMatches: version === expectedVersion,
        };
    }
    const reachable = await isDaemonReachable(profileName);
    let stats = undefined;
    if (reachable) {
        try {
            stats = await daemonCall('status', {}, undefined, profileName);
        }
        catch {
            /* ignore */
        }
    }
    const statsVersion = stats && typeof stats === 'object'
        ? stats.version
        : undefined;
    const resolvedVersion = typeof statsVersion === 'string' ? statsVersion : version;
    return {
        profile: profileName,
        running: true,
        pid,
        reachable,
        version: resolvedVersion,
        expectedVersion,
        versionMatches: resolvedVersion === expectedVersion,
        stats,
    };
}
export async function start(profile) {
    const profileName = defaultProfileName(profile);
    await ensureRoot();
    await ensureProfileRuntimeDir(profileName);
    const existing = await status(profileName);
    if (existing.running) {
        if (existing.versionMatches === false) {
            await stop(profileName);
        }
        else {
            throw new CliError(5, 'DAEMON_RUNNING', `Daemon already running for profile "${profileName}" (pid ${existing.pid}).`);
        }
    }
    // Locate the CLI entrypoint to re-exec as "1688 serve".
    // When installed via npm link, this module sits at dist/daemon/manager.js,
    // and the CLI is at dist/cli.js.
    const here = fileURLToPath(import.meta.url);
    const cliPath = path.join(path.dirname(here), '..', 'cli.js');
    // Detach from the parent; redirect output to a log file.
    const logFd = await fs.open(daemonLogFile(profileName), 'a');
    const child = spawn(process.execPath, [cliPath, 'serve', '--profile', profileName], {
        detached: true,
        stdio: ['ignore', logFd.fd, logFd.fd],
        env: { ...process.env, BB1688_DAEMON_BG: '1' },
    });
    child.unref();
    await logFd.close();
    const reachable = await waitUntil(() => isDaemonReachable(profileName), {
        timeoutMs: 15000,
        intervalMs: 250,
    });
    if (reachable) {
        const pid = (await readPid(profileName)) ?? child.pid ?? -1;
        return { pid, profile: profileName };
    }
    throw new CliError(9, 'DAEMON_START_TIMEOUT', `Daemon for profile "${profileName}" did not start within 15s. Check ${daemonLogFile(profileName)}.`);
}
export async function ensureFreshDaemon(profile) {
    const profileName = defaultProfileName(profile);
    const existing = await status(profileName);
    if (!existing.running) {
        const started = await start(profileName);
        return { ...started, restarted: false };
    }
    if (existing.versionMatches === false) {
        await stop(profileName);
        const started = await start(profileName);
        return { ...started, restarted: true };
    }
    return { pid: existing.pid ?? -1, profile: profileName, restarted: false };
}
export async function stop(profile) {
    const profileName = defaultProfileName(profile);
    const pid = await readPid(profileName);
    if (pid === null || !isProcessAlive(pid)) {
        await cleanupArtifacts(profileName);
        return { stopped: false, profile: profileName };
    }
    // Prefer asking via socket; fall back to SIGTERM.
    if (await isDaemonReachable(profileName)) {
        try {
            await daemonCall('shutdown', {}, undefined, profileName);
        }
        catch {
            /* will fall through to SIGTERM */
        }
    }
    else {
        try {
            process.kill(pid, 'SIGTERM');
        }
        catch {
            /* already dead */
        }
    }
    await waitUntil(() => !isProcessAlive(pid), {
        timeoutMs: 10000,
        intervalMs: 200,
    });
    if (isProcessAlive(pid)) {
        try {
            process.kill(pid, 'SIGKILL');
        }
        catch {
            /* ignore */
        }
    }
    await cleanupArtifacts(profileName);
    return { stopped: true, profile: profileName };
}
export async function cleanupLock(profile) {
    await fs.rm(lockFile(profile) + '.lock', { recursive: true, force: true });
}
async function cleanupArtifacts(profile) {
    const profileName = defaultProfileName(profile);
    // Windows named pipes have no filesystem entry — skip the socket path.
    const targets = process.platform === 'win32'
        ? [pidFile(profileName), daemonVersionFile(profileName)]
        : [
            socketPath(profileName),
            pidFile(profileName),
            daemonVersionFile(profileName),
        ];
    for (const p of targets) {
        try {
            await fs.unlink(p);
        }
        catch {
            /* ignore */
        }
    }
}
async function readPid(profile) {
    try {
        const s = await fs.readFile(pidFile(profile), 'utf8');
        const n = parseInt(s.trim(), 10);
        return Number.isInteger(n) ? n : null;
    }
    catch {
        return null;
    }
}
async function readDaemonVersion(profile) {
    try {
        const s = await fs.readFile(daemonVersionFile(profile), 'utf8');
        return s.trim() || null;
    }
    catch {
        return null;
    }
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=manager.js.map
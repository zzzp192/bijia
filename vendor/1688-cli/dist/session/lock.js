import fs from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { defaultProfileName, ensureProfileRuntimeDir, lockFile, pidFile, } from './paths.js';
import { CliError } from '../io/errors.js';
export async function acquireLock(profile) {
    const profileName = defaultProfileName(profile);
    await ensureProfileRuntimeDir(profileName);
    const target = lockFile(profileName);
    // proper-lockfile requires the target file to exist
    await fs.writeFile(target, '', { flag: 'a' });
    const lockOpts = { retries: 0, stale: 5 * 60 * 1000 };
    try {
        return await lockfile.lock(target, lockOpts);
    }
    catch (e) {
        if (e.code !== 'ELOCKED')
            throw e;
        // Lock is held. Probe whether it's a real holder (daemon alive) or
        // a stale dir left over by an abruptly-killed process (Ctrl+C in
        // --headed flow, SIGKILL on the daemon, etc.). If no daemon is running,
        // we can safely clean up and retry — the dead process can't be using it.
        if (await daemonIsAlive(profileName)) {
            throw new CliError(5, 'LOCK_BUSY', `Another 1688 command is running for profile "${profileName}". Close it and retry.`);
        }
        await fs.rm(target + '.lock', { recursive: true, force: true });
        try {
            return await lockfile.lock(target, lockOpts);
        }
        catch {
            throw new CliError(5, 'LOCK_BUSY', `Another 1688 command is running for profile "${profileName}". Close it and retry.`);
        }
    }
}
async function daemonIsAlive(profile) {
    try {
        const pid = parseInt((await fs.readFile(pidFile(profile), 'utf8')).trim(), 10);
        if (!Number.isFinite(pid) || pid <= 0)
            return false;
        try {
            process.kill(pid, 0); // signal 0 = existence check, no signal sent
            return true;
        }
        catch {
            return false;
        }
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=lock.js.map
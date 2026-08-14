import net from 'node:net';
import fs from 'node:fs/promises';
import { defaultProfileName, socketPath } from '../session/paths.js';
import { CliError } from '../io/errors.js';
import { makeRequestId } from './protocol.js';
const PING_TIMEOUT_MS = 800;
const CALL_TIMEOUT_MS = 5 * 60 * 1000;
export async function isDaemonReachable(profile) {
    const profileName = defaultProfileName(profile);
    const sockPath = socketPath(profileName);
    // On Unix the socket is a file we can stat; on Windows the named pipe
    // (`\\.\pipe\...`) has no filesystem entry, so skip the existence check
    // and just try to connect.
    if (process.platform !== 'win32') {
        try {
            await fs.access(sockPath);
        }
        catch {
            return false;
        }
    }
    return new Promise((resolve) => {
        const sock = net.createConnection(sockPath);
        const timer = setTimeout(() => {
            sock.destroy();
            resolve(false);
        }, PING_TIMEOUT_MS);
        sock.once('connect', () => {
            clearTimeout(timer);
            sock.end();
            resolve(true);
        });
        sock.once('error', () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}
export async function daemonCall(cmd, args, requestId = makeRequestId(), profile) {
    const profileName = defaultProfileName(profile);
    const sockPath = socketPath(profileName);
    return new Promise((resolve, reject) => {
        const sock = net.createConnection(sockPath);
        let buf = '';
        let settled = false;
        const timer = setTimeout(() => {
            fail(new Error('daemon call timed out'));
        }, CALL_TIMEOUT_MS);
        function succeed(data) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            sock.end();
            resolve(data);
        }
        function fail(e) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            sock.destroy();
            reject(e);
        }
        sock.on('connect', () => {
            const req = { id: requestId, cmd, args };
            sock.write(JSON.stringify(req) + '\n');
        });
        sock.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            const nl = buf.indexOf('\n');
            if (nl === -1)
                return;
            const line = buf.slice(0, nl);
            let resp;
            try {
                resp = JSON.parse(line);
            }
            catch (e) {
                fail(new Error('daemon: malformed response'));
                return;
            }
            if (resp.ok) {
                succeed(resp.data);
            }
            else {
                fail(new CliError(resp.exitCode, resp.code, resp.message, resp.details));
            }
        });
        sock.on('error', (e) => {
            fail(e);
        });
    });
}
//# sourceMappingURL=client.js.map
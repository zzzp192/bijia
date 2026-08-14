import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
export function root() {
    return process.env.BB1688_HOME ?? path.join(os.homedir(), '.1688');
}
export function profilesDir() {
    return path.join(root(), 'profiles');
}
export function defaultProfileName(profile) {
    const name = profile?.trim();
    return name ? name : 'default';
}
export function profileRuntimeDir(profile) {
    const name = defaultProfileName(profile);
    return name === 'default' ? root() : profilePath(name);
}
export function stateFile(profile) {
    return path.join(profileRuntimeDir(profile), 'state.json');
}
export function lockFile(profile) {
    return path.join(profileRuntimeDir(profile), '.lock');
}
export function socketPath(profile) {
    return socketPathForPlatform(process.platform, root(), profile);
}
export function socketPathForPlatform(platform, rootPath, profile) {
    const name = defaultProfileName(profile);
    // Windows: Node's net.listen()/createConnection() can't bind a Unix-style
    // filesystem path on win32 (EACCES). Use a named pipe instead. Include a
    // stable root hash so different users and BB1688_HOME values do not collide,
    // and include the profile hash so profiles under one root can run together.
    if (platform === 'win32') {
        const base = `\\\\.\\pipe\\1688-cli-daemon-${rootHash(rootPath)}`;
        return name === 'default' ? base : `${base}-${profileHash(name)}`;
    }
    const dir = name === 'default' ? rootPath : path.join(rootPath, 'profiles', name);
    return path.join(dir, 'daemon.sock');
}
export function rootHash(rootPath) {
    return crypto
        .createHash('sha1')
        .update(path.resolve(rootPath).toLowerCase())
        .digest('hex')
        .slice(0, 12);
}
export function profileHash(profile) {
    return crypto
        .createHash('sha1')
        .update(defaultProfileName(profile).toLowerCase())
        .digest('hex')
        .slice(0, 12);
}
export function pidFile(profile) {
    return path.join(profileRuntimeDir(profile), 'daemon.pid');
}
export function daemonVersionFile(profile) {
    return path.join(profileRuntimeDir(profile), 'daemon.version');
}
export function daemonLogFile(profile) {
    return path.join(profileRuntimeDir(profile), 'daemon.log');
}
export function runsDir() {
    return path.join(root(), 'runs');
}
export function eventsFile() {
    return path.join(root(), 'events.jsonl');
}
export function configFile() {
    return path.join(root(), 'config.json');
}
export function loginQrFile() {
    return path.join(root(), 'login-qr.png');
}
export function profilePath(name = 'default') {
    return path.join(profilesDir(), defaultProfileName(name));
}
export async function ensureRoot() {
    await fs.mkdir(root(), { recursive: true });
}
export async function ensureProfileRuntimeDir(profile) {
    await fs.mkdir(profileRuntimeDir(profile), { recursive: true });
}
//# sourceMappingURL=paths.js.map
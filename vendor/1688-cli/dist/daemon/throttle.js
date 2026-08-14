// Per-command-type rate limiter + jittered minimum gap between operations.
// Keeps daemon behavior from looking like a hammering bot.
import { sleep } from '../session/wait.js';
const lastInvokedAt = new Map();
const MIN_GAP_MS = 1200;
const JITTER_MS = 1800;
export async function throttle(cmd) {
    const last = lastInvokedAt.get(cmd) ?? 0;
    const minNextAt = last + MIN_GAP_MS;
    const jitter = Math.floor(Math.random() * JITTER_MS);
    const targetAt = minNextAt + jitter;
    const wait = targetAt - Date.now();
    if (wait > 0) {
        await sleep(wait);
    }
    lastInvokedAt.set(cmd, Date.now());
}
//# sourceMappingURL=throttle.js.map
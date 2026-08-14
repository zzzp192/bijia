// Routes a command either through the selected profile daemon (fast) or inline
// (slow but self-contained). Headed mode stays inline.
import { withSession } from './context.js';
import { isDaemonReachable, daemonCall } from '../daemon/client.js';
import { makeRequestId } from '../daemon/protocol.js';
import { info } from '../io/output.js';
import { defaultProfileName } from './paths.js';
import { appendEventBestEffort, endEvent, eventFromError, startEvent, } from './events.js';
// Lazy-imported registry of command executors. Each entry must export `execute`.
// login/logout are deliberately omitted — they have interactive flows (QR render,
// stdin confirmation) that don't transit cleanly through a socket; they stay inline.
const REGISTRY = {
    search: () => import('../commands/search.js').then((m) => m.execute),
    whoami: () => import('../commands/whoami.js').then((m) => m.execute),
    'order-list': () => import('../commands/order-list.js').then((m) => m.execute),
    'order-get': () => import('../commands/order-get.js').then((m) => m.execute),
    'order-logistics': () => import('../commands/order-logistics.js').then((m) => m.execute),
    offer: () => import('../commands/offer.js').then((m) => m.execute),
    'image-search': () => import('../commands/image-search.js').then((m) => m.execute),
    'cart-list': () => import('../commands/cart-list.js').then((m) => m.execute),
    'cart-remove': () => import('../commands/cart-remove.js').then((m) => m.execute),
    'cart-add': () => import('../commands/cart-add.js').then((m) => m.execute),
    'checkout-prepare': () => import('../commands/checkout-prepare.js').then((m) => m.execute),
    'seller-chat': () => import('../commands/seller-chat.js').then((m) => m.execute),
    'seller-messages': () => import('../commands/seller-messages.js').then((m) => m.execute),
    inbox: () => import('../commands/inbox.js').then((m) => m.execute),
    'detail-feglobals': () => import('../commands/seller-inquire.js').then((m) => m.scrapeFeGlobals),
    similar: () => import('../commands/similar.js').then((m) => m.execute),
    'supplier-inspect': () => import('../commands/supplier-inspect.js').then((m) => m.execute),
    'supplier-search': () => import('../commands/supplier-search.js').then((m) => m.execute),
};
export async function loadExecutor(name) {
    const loader = REGISTRY[name];
    if (!loader)
        throw new Error(`Unknown command: ${name}`);
    return (await loader());
}
export async function dispatch(name, args, opts = {}) {
    const profile = defaultProfileName(opts.profile);
    const requestId = makeRequestId();
    const startedAt = Date.now();
    await appendEventBestEffort(startEvent({ requestId, cmd: name, profile }));
    const finishOk = async () => {
        await appendEventBestEffort(endEvent({ requestId, cmd: name, startedAt, profile }));
    };
    const finishError = async (error) => {
        await appendEventBestEffort(eventFromError({ requestId, cmd: name, startedAt, profile, error }));
    };
    const skipDaemon = opts.headed === true ||
        opts.noDaemon === true ||
        process.env.BB1688_NO_DAEMON === '1';
    if (!skipDaemon) {
        // Auto-start daemon if not running. Keeps the "warm browser" promise
        // after `npm i -g` (postinstall kills the daemon) without requiring the
        // user to re-run `1688 login` or `daemon start` manually.
        if (!(await isDaemonReachable(profile))) {
            try {
                const { ensureFreshDaemon } = await import('../daemon/manager.js');
                info(`Starting daemon for profile "${profile}" (one-time)...`);
                await ensureFreshDaemon(profile);
            }
            catch {
                // Couldn't start — fall through to inline.
            }
        }
        else {
            try {
                const { ensureFreshDaemon } = await import('../daemon/manager.js');
                const result = await ensureFreshDaemon(profile);
                if (result.restarted) {
                    info(`Restarted daemon for profile "${profile}" to match current CLI version.`);
                }
            }
            catch {
                // Couldn't refresh — fall through to the normal daemon/inline logic.
            }
        }
        if (await isDaemonReachable(profile)) {
            try {
                const data = await daemonCall(name, args, requestId, profile);
                await finishOk();
                return data;
            }
            catch (e) {
                const code = e.code;
                if (code && code !== 'ECONNREFUSED' && code !== 'ENOENT') {
                    await finishError(e);
                    throw e;
                }
            }
        }
    }
    // Inline path. If a daemon is alive, it holds the lock — we must pause it
    // for the duration so this inline call can grab the lock and open its own
    // browser context on the shared profile. Restart on exit.
    const daemonMgr = await maybePauseDaemon(profile);
    try {
        const fn = await loadExecutor(name);
        const data = await withSession({ headless: !opts.headed, profile }, (ctx) => fn(ctx, args), { requestId, cmd: name, args });
        await finishOk();
        return data;
    }
    catch (error) {
        await finishError(error);
        throw error;
    }
    finally {
        await daemonMgr.resume();
    }
}
async function maybePauseDaemon(profile) {
    try {
        const { status, stop, start } = await import('../daemon/manager.js');
        const st = await status(profile);
        if (!st.running)
            return { resume: async () => { } };
        info(`Pausing daemon for profile "${profile}" for inline run...`);
        await stop(profile);
        return {
            resume: async () => {
                try {
                    info(`Resuming daemon for profile "${profile}"...`);
                    await start(profile);
                }
                catch (e) {
                    info(`(Daemon resume failed for profile "${profile}": ${e.message})`);
                }
            },
        };
    }
    catch {
        return { resume: async () => { } };
    }
}
//# sourceMappingURL=dispatch.js.map
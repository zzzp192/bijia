// Long-lived shared BrowserContext for the daemon. Operations are serialized
// (one Playwright op at a time) so we look like a single, deliberate user
// rather than concurrent requests.
import fs from 'node:fs/promises';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { defaultProfileName, profilePath } from './paths.js';
import { acquireLock } from './lock.js';
import { CliError } from '../io/errors.js';
import { clearStaleSingleton } from './context.js';
import { enrichErrorWithArtifact, } from './artifacts.js';
import { detectPageState } from './page-state.js';
const stealthPlugin = stealth();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);
const LAUNCH_OPTS = {
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
};
let sharedCtx = null;
let lockRelease = null;
let opChain = Promise.resolve();
let sharedProfile = null;
export async function getSharedContext(profile) {
    const profileName = defaultProfileName(profile);
    if (sharedCtx) {
        if (sharedProfile !== profileName) {
            throw new CliError(5, 'DAEMON_PROFILE_MISMATCH', `Daemon shared context is bound to profile "${sharedProfile}", not "${profileName}".`);
        }
        return sharedCtx;
    }
    lockRelease = await acquireLock(profileName);
    const dir = profilePath(profileName);
    await fs.mkdir(dir, { recursive: true });
    await clearStaleSingleton(dir);
    sharedCtx = await launchPreferringChrome(dir, true);
    sharedProfile = profileName;
    await sharedCtx.addInitScript(() => {
        try {
            Object.defineProperty(navigator, 'languages', {
                get: () => ['zh-CN', 'zh', 'en'],
            });
        }
        catch {
            /* ignore */
        }
    });
    return sharedCtx;
}
export async function runOnSharedCtx(fn, meta, profile) {
    // Append to serial queue. Each op waits for the previous one to finish.
    const prev = opChain;
    let resolveOp;
    let rejectOp;
    const opPromise = new Promise((res, rej) => {
        resolveOp = res;
        rejectOp = rej;
    });
    opChain = prev.then(async () => {
        try {
            const ctx = await getSharedContext(profile);
            resolveOp(await fn(ctx));
        }
        catch (e) {
            const ctx = sharedCtx;
            if (ctx && meta) {
                rejectOp(await enrichErrorWithArtifact(ctx, meta, e));
            }
            else {
                rejectOp(e);
            }
        }
    });
    return opPromise;
}
export async function getSharedContextStatus() {
    if (!sharedCtx) {
        return {
            profile: sharedProfile,
            browserAlive: false,
            pageCount: 0,
            currentUrl: null,
            pageState: null,
            loggedIn: null,
        };
    }
    const pages = sharedCtx.pages().filter((p) => !p.isClosed());
    const page = pages.at(-1) ?? null;
    const pageState = page ? await detectPageState(page).catch(() => null) : null;
    return {
        profile: sharedProfile,
        browserAlive: true,
        pageCount: pages.length,
        currentUrl: page?.url() ?? null,
        pageState,
        loggedIn: pageState
            ? pageState.kind === 'normal_1688_page'
                ? true
                : pageState.kind === 'not_logged_in'
                    ? false
                    : null
            : null,
    };
}
export async function releaseSharedContext() {
    if (sharedCtx) {
        await sharedCtx.close().catch(() => { });
        sharedCtx = null;
    }
    sharedProfile = null;
    if (lockRelease) {
        await lockRelease().catch(() => { });
        lockRelease = null;
    }
}
async function launchPreferringChrome(dir, headless) {
    const useChrome = process.env.BB1688_FORCE_CHROMIUM !== '1';
    if (useChrome) {
        try {
            return (await chromium.launchPersistentContext(dir, {
                ...LAUNCH_OPTS,
                headless,
                channel: 'chrome',
            }));
        }
        catch (e) {
            const msg = e.message ?? '';
            if (!/Chromium\?|channel|Executable doesn't exist|chrome.*not found/i.test(msg)) {
                throw e;
            }
        }
    }
    try {
        return (await chromium.launchPersistentContext(dir, {
            ...LAUNCH_OPTS,
            headless,
        }));
    }
    catch (e) {
        const msg = e.message ?? '';
        if (/Executable doesn't exist/i.test(msg)) {
            throw new CliError(6, 'CHROMIUM_MISSING', 'Chromium not installed. Run: npx playwright install chromium');
        }
        throw e;
    }
}
//# sourceMappingURL=shared.js.map
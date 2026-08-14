import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { profilePath } from './paths.js';
import { acquireLock } from './lock.js';
import { CliError } from '../io/errors.js';
import { enrichErrorWithArtifact, } from './artifacts.js';
/**
 * Remove Chrome's stale SingletonLock / SingletonCookie / SingletonSocket files
 * from our profile dir. Safe because our `proper-lockfile` already guarantees
 * no other 1688 process is using this profile.
 */
export async function clearStaleSingleton(profileDir) {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        await fs.unlink(path.join(profileDir, name)).catch(() => { });
    }
}
// Apply stealth evasions once at module load.
// Disable a couple of evasions that can cause issues with newer Chromium.
const stealthPlugin = stealth();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);
const LAUNCH_OPTS = {
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
};
export async function withSession(opts, fn, meta) {
    const release = await acquireLock(opts.profile);
    const dir = profilePath(opts.profile);
    await fs.mkdir(dir, { recursive: true });
    await clearStaleSingleton(dir);
    let ctx = null;
    try {
        ctx = await launchContext(dir, opts.headless);
        // Stealth plugin defaults navigator.languages to en-US — override back to
        // Chinese so we look like a real CN user.
        await ctx.addInitScript(() => {
            try {
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['zh-CN', 'zh', 'en'],
                });
            }
            catch {
                /* ignore */
            }
        });
        return await fn(ctx);
    }
    catch (e) {
        if (ctx && meta) {
            throw await enrichErrorWithArtifact(ctx, meta, e);
        }
        throw e;
    }
    finally {
        if (ctx)
            await ctx.close().catch(() => { });
        await release().catch(() => { });
    }
}
async function launchContext(dir, headless) {
    // Prefer real Chrome — best fingerprint match (real UA, real GPU, real
    // plugins). Falls back to bundled Chromium if Chrome isn't installed.
    const preferChrome = process.env.BB1688_FORCE_CHROMIUM !== '1';
    if (preferChrome) {
        try {
            return (await chromium.launchPersistentContext(dir, {
                ...LAUNCH_OPTS,
                headless,
                channel: 'chrome',
            }));
        }
        catch (e) {
            const msg = e.message ?? '';
            // Re-throw unknown errors; only fall through if Chrome is missing.
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
//# sourceMappingURL=context.js.map
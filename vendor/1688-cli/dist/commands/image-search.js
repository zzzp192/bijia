import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { withRecovery } from '../session/recovery.js';
import { clickImageSearchButton, clickImageUploadButton, } from '../session/image-search-locators.js';
import { captureSearchOffersForAction } from '../session/search-capture.js';
const UPLOAD_PAGE = 'https://s.1688.com/youyuan/index.htm';
const RESULT_URL = (imageId) => `https://s.1688.com/selloffer/offer_search.htm?imageId=${imageId}`;
export async function execute(ctx, args) {
    try {
        await fs.access(args.imagePath, fs.constants.R_OK);
    }
    catch {
        throw new CliError(2, 'BAD_INPUT', `Cannot read image: ${args.imagePath}`);
    }
    return withRecovery(ctx, { cmd: 'image-search', args }, () => executeImageSearch(ctx, args), { headed: args.headed === true, maxRetries: 1 });
}
async function executeImageSearch(ctx, args) {
    info('Uploading image to 1688...');
    const imageId = await uploadAndGetImageId(ctx, args.imagePath);
    info(`Image uploaded (imageId=${imageId}). Fetching results...`);
    const offers = await searchByImageId(ctx, imageId);
    return {
        imageId,
        total: offers.length,
        offers: offers.slice(0, args.max),
    };
}
async function uploadAndGetImageId(ctx, imagePath) {
    const page = await ctx.newPage();
    try {
        page.on('filechooser', async (chooser) => {
            try {
                await chooser.setFiles(imagePath);
            }
            catch {
                /* ignore — handled by waitForURL timeout */
            }
        });
        await page.goto(UPLOAD_PAGE, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        if (/login\.1688\.com|login\.taobao\.com/.test(page.url())) {
            throw new CliError(3, 'NOT_LOGGED_IN', 'Session expired. Run `1688 login`.');
        }
        await clickImageUploadButton(page);
        await Promise.all([
            page
                .waitForURL(/imageId=\d+/, { timeout: 20000 })
                .catch(() => undefined),
            clickImageSearchButton(page),
        ]);
        const match = page.url().match(/imageId=(\d+)/);
        if (!match) {
            throw new CliError(13, 'UPLOAD_FAILED', 'No imageId in URL after upload. Try again or use --headed.');
        }
        return match[1];
    }
    finally {
        await page.close().catch(() => { });
    }
}
async function searchByImageId(ctx, imageId) {
    const page = await ctx.newPage();
    try {
        const captureResult = await captureSearchOffersForAction({ page, keep: 'largest' }, async () => {
            await page.goto(RESULT_URL(imageId), {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });
        }, {
            timeoutMs: 15000,
            isClosed: () => page.isClosed(),
            isBlocked: () => /\/punish|x5secdata=/.test(page.url()),
        });
        if (captureResult.status === 'browser_closed') {
            throw new CliError(130, 'CANCELED', 'Browser closed.');
        }
        return captureResult.offers;
    }
    finally {
        await page.close().catch(() => { });
    }
}
export async function run(opts) {
    if (!opts.imagePath) {
        throw new CliError(2, 'BAD_INPUT', 'Image path or URL required.');
    }
    const max = Math.max(1, parseInt(opts.max ?? '20', 10));
    let abs;
    let cleanup = null;
    if (/^https?:\/\//i.test(opts.imagePath)) {
        info(`Downloading image from URL...`);
        const t = await downloadToTemp(opts.imagePath);
        abs = t.path;
        cleanup = t.cleanup;
    }
    else {
        abs = path.resolve(opts.imagePath);
    }
    try {
        const data = await dispatch('image-search', { imagePath: abs, max, headed: opts.headed }, { headed: opts.headed, profile: opts.profile });
        emit({
            human: () => printResults(data),
            data,
        });
    }
    finally {
        if (cleanup)
            await cleanup().catch(() => { });
    }
}
async function downloadToTemp(url) {
    let res;
    try {
        res = await fetch(url);
    }
    catch (e) {
        throw new CliError(9, 'NETWORK_ERROR', `Failed to download image: ${e.message}`);
    }
    if (!res.ok) {
        throw new CliError(9, 'NETWORK_ERROR', `Download failed: HTTP ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
        throw new CliError(9, 'NETWORK_ERROR', 'Downloaded image is empty.');
    }
    if (buf.length > 20 * 1024 * 1024) {
        throw new CliError(2, 'BAD_INPUT', `Image too large (${(buf.length / 1024 / 1024).toFixed(1)}MB > 20MB).`);
    }
    const ext = guessExt(url, res.headers.get('content-type'));
    const tmpPath = path.join(os.tmpdir(), `bb1688-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    await fs.writeFile(tmpPath, buf);
    return {
        path: tmpPath,
        cleanup: () => fs.rm(tmpPath, { force: true }),
    };
}
function guessExt(url, contentType) {
    const m = url.match(/\.(jpe?g|png|webp|bmp)(\?|$|#)/i);
    if (m)
        return '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
    if (contentType) {
        if (/jpeg/i.test(contentType))
            return '.jpg';
        if (/png/i.test(contentType))
            return '.png';
        if (/webp/i.test(contentType))
            return '.webp';
        if (/bmp/i.test(contentType))
            return '.bmp';
    }
    return '.jpg';
}
function printResults(r) {
    if (r.offers.length === 0) {
        process.stdout.write(`No offers found (imageId=${r.imageId}).\n`);
        return;
    }
    process.stdout.write(`Image search (imageId=${r.imageId}):\n\n`);
    const w = String(r.offers.length).length;
    r.offers.forEach((o, i) => {
        const idx = String(i + 1).padStart(w, ' ');
        const price = o.price.text || '(n/a)';
        process.stdout.write(`${idx}. ${o.title}\n`);
        const pad = ' '.repeat(w + 2);
        process.stdout.write(`${pad}${price}`);
        if (o.turnover)
            process.stdout.write(`  ·  ${o.turnover}`);
        process.stdout.write('\n');
        const supplierBits = [
            o.supplier.name,
            o.supplier.years ? `${o.supplier.years}年` : null,
        ]
            .filter(Boolean)
            .join(' · ');
        if (supplierBits)
            process.stdout.write(`${pad}${supplierBits}\n`);
        process.stdout.write(`${pad}${o.url}\n`);
        if (i < r.offers.length - 1)
            process.stdout.write('\n');
    });
}
//# sourceMappingURL=image-search.js.map
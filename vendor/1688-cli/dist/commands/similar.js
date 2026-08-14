import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { withRecovery } from '../session/recovery.js';
import { sleep } from '../session/wait.js';
import { captureSearchOffersForAction } from '../session/search-capture.js';
import { extractOffers } from './search.js';
const SIMILAR_URL = (offerId) => `https://s.1688.com/selloffer/similar_search.html?offerIds=${encodeURIComponent(offerId)}&scene=similar_search`;
export async function execute(ctx, args) {
    if (!/^\d+$/.test(args.offerId)) {
        throw new CliError(2, 'BAD_INPUT', `Invalid offerId: ${args.offerId}`);
    }
    return withRecovery(ctx, { cmd: 'similar', args }, () => executeSimilar(ctx, args), { headed: args.headed === true, maxRetries: 1 });
}
async function executeSimilar(ctx, args) {
    const headed = args.headed === true;
    const page = await ctx.newPage();
    let succeeded = false;
    try {
        info('Warming up s.1688.com...');
        await page.goto('https://s.1688.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 20000,
        });
        await sleep(1500);
        const captureResult = await captureSearchOffersForAction({ page, keep: 'largest', allowUnscopedWirelessRecommend: true }, async () => {
            info(`Finding similar offers for ${args.offerId}...`);
            if (headed)
                info('A Chrome window has opened — switch focus to it now.');
            await page.goto(SIMILAR_URL(args.offerId), {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });
        }, {
            timeoutMs: headed ? 180000 : 15000,
            isClosed: () => page.isClosed(),
            isBlocked: () => !headed && /\/punish|x5secdata=/.test(page.url()),
        });
        if (captureResult.status === 'browser_closed') {
            throw new CliError(130, 'CANCELED', 'Browser closed.');
        }
        if (captureResult.status === 'blocked') {
            throw new CliError(4, 'RISK_CONTROL', '1688 risk-control page detected. Run once with --headed to solve the slider; subsequent calls work for hours.');
        }
        let captured = captureResult.offers;
        if (captured.length === 0) {
            await page
                .evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.8)))
                .catch(() => { });
            await sleep(800);
            captured = await extractOffers(page).catch(() => []);
        }
        if (captured.length === 0) {
            throw new CliError(1, 'SIMILAR_UNAVAILABLE', '1688 official similar-offer entry point did not return comparable offers. This command is currently unavailable until a stable same-product source is found.', {
                offerId: args.offerId,
                source: 'official-similar-page',
                category: 'similar_unavailable',
                failureKind: 'similar_unavailable',
                recoveryAction: 'none',
                retryable: false,
                recoverHint: '`1688 similar` only returns official same-product results and does not fall back to keyword or image search.',
            });
        }
        // Filter out the seed offer itself from the results.
        const filtered = captured.filter((o) => o.offerId !== args.offerId);
        const result = {
            offerId: args.offerId,
            total: filtered.length,
            offers: filtered.slice(0, args.max),
        };
        succeeded = true;
        return result;
    }
    finally {
        if (succeeded)
            await page.close().catch(() => { });
    }
}
export async function run(opts) {
    if (!opts.offerId) {
        throw new CliError(2, 'BAD_INPUT', 'offerId is required.');
    }
    const max = Math.max(1, parseInt(opts.max ?? '20', 10));
    const data = await dispatch('similar', { offerId: opts.offerId, max, headed: opts.headed }, { headed: opts.headed, profile: opts.profile });
    emit({
        human: () => printSimilar(data),
        data,
    });
}
function printSimilar(r) {
    if (r.offers.length === 0) {
        process.stdout.write(`No similar offers found for ${r.offerId}.\n`);
        return;
    }
    // Sort by price ascending for quick price-comparison view.
    const sorted = [...r.offers].sort((a, b) => {
        const ap = a.price.min ?? Number.POSITIVE_INFINITY;
        const bp = b.price.min ?? Number.POSITIVE_INFINITY;
        return ap - bp;
    });
    process.stdout.write(`Similar offers to ${r.offerId} (${sorted.length}, by price asc):\n\n`);
    const w = String(sorted.length).length;
    sorted.forEach((o, i) => {
        const idx = String(i + 1).padStart(w, ' ');
        const ad = o.isP4P ? ' [广告]' : '';
        const verified = o.verified.superFactory
            ? ' [超级工厂]'
            : o.verified.factory
                ? ' [验厂]'
                : '';
        process.stdout.write(`${idx}. ${o.price.text || '(n/a)'}${ad}${verified}  ${o.title.slice(0, 50)}\n`);
        const supplier = o.supplier.name ?? '?';
        const years = o.supplier.years ? ` · ${o.supplier.years}年` : '';
        const loc = [o.location.province, o.location.city]
            .filter(Boolean)
            .join(' ');
        process.stdout.write(`   ${supplier}${years}${loc ? ` · ${loc}` : ''}  (${o.offerId})\n`);
    });
}
//# sourceMappingURL=similar.js.map
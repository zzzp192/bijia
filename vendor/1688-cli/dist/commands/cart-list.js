import { appendFileSync } from 'node:fs';
import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { withRecovery } from '../session/recovery.js';
import { parseMtopJsonp } from '../session/mtop.js';
import { startResponseCapture } from '../session/response-capture.js';
import { debugTmpPath } from '../util/temp.js';
const CART_URL = 'https://cart.1688.com/';
const RENDER_API_RE = /mtop\.1688\.buycenter\.mtoppurchaseastoreservice\.render/i;
export async function execute(ctx, args) {
    return withRecovery(ctx, { cmd: 'cart-list', args }, () => executeRaw(ctx), { headed: args.headed === true, maxRetries: 1 });
}
export async function executeRaw(ctx) {
    const page = await ctx.newPage();
    const capture = startResponseCapture({
        page,
        timeoutMs: 25000,
        matcher: RENDER_API_RE,
        parse: async (resp) => {
            const parsed = parseMtopJsonp(await resp.text());
            if (typeof parsed?.data?.model !== 'string')
                return null;
            return JSON.parse(parsed.data.model);
        },
    });
    try {
        info('Loading cart...');
        const { response: model } = await capture.waitForAction(async () => {
            try {
                await page.goto(CART_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            }
            catch (e) {
                throw new CliError(9, 'NETWORK_ERROR', `Failed to load cart page: ${e.message}`);
            }
            if (/login\.1688\.com|login\.taobao\.com/.test(page.url())) {
                throw new CliError(3, 'NOT_LOGGED_IN', 'Session expired. Run `1688 login`.');
            }
        });
        if (!model) {
            throw new CliError(11, 'NO_CART_DATA', 'Cart response was not captured. The page may have changed or been risk-controlled.', {
                category: 'response_capture',
                retryable: true,
                responseCapture: capture.diagnostics(),
            });
        }
        return parseCart(model);
    }
    finally {
        capture.dispose();
        await page.close().catch(() => { });
    }
}
function parseCart(model) {
    const data = model.data ?? {};
    const items = [];
    // Build offerId → group (has title) and sellerId → shop maps
    const groupsByOffer = new Map();
    const shopsBySeller = new Map();
    for (const [k, comp] of Object.entries(data)) {
        if (/^item_group_\d+$/.test(k)) {
            const f = comp.fields;
            if (f?.offerId !== undefined)
                groupsByOffer.set(String(f.offerId), f);
        }
        else if (/^shop_top_\d+$/.test(k)) {
            const f = comp.fields;
            if (f?.sellerId !== undefined)
                shopsBySeller.set(String(f.sellerId), f);
        }
    }
    for (const [k, comp] of Object.entries(data)) {
        if (!/^item_\d+$/.test(k))
            continue;
        const f = comp.fields;
        if (!f)
            continue;
        if (process.env.BB1688_PROBE === '1') {
            try {
                appendFileSync(debugTmpPath('1688-cart-raw.json'), JSON.stringify({ k, fields: f }, null, 2) + '\n');
            }
            catch (e) {
                process.stderr.write(`[cart-probe] append failed: ${String(e)}\n`);
            }
        }
        const offerId = f.offerId !== undefined ? String(f.offerId) : '';
        const sellerId = f.sellerId !== undefined ? String(f.sellerId) : '';
        const group = groupsByOffer.get(offerId);
        const shop = shopsBySeller.get(sellerId);
        items.push({
            cartId: f.cartId !== undefined ? String(f.cartId) : '',
            offerId,
            skuId: f.skuId !== undefined ? String(f.skuId) : null,
            productTitle: group?.title ?? '',
            skuTitle: f.skuTitle ?? null,
            unit: f.unit ?? null,
            quantity: f.quantity ?? 0,
            // Prefer the integer `*Cent` fields (server-side authoritative);
            // fall back to the formatted string for older payloads.
            unitPrice: f.unitPriceCent !== undefined
                ? f.unitPriceCent / 100
                : parseFloatOrZero(f.unitPrice),
            amount: f.amountCent !== undefined
                ? f.amountCent / 100
                : parseFloatOrZero(f.amount),
            minQuantity: f.minQuantity ?? null,
            maxQuantity: f.maxQuantity ?? null,
            image: normalizeImage(f.pic),
            checked: f.checked ?? false,
            effective: f.effective ?? true,
            addedAt: f.addTime ?? null,
            seller: {
                sellerId,
                name: shop?.companyName ?? null,
                loginId: shop?.loginId ?? null,
            },
        });
    }
    // Sort by addedAt desc (newest first) when present
    items.sort((a, b) => (a.addedAt && b.addedAt ? b.addedAt.localeCompare(a.addedAt) : 0));
    return {
        total: items.length,
        selectedCount: items.filter((i) => i.checked).length,
        items,
    };
}
function parseFloatOrZero(s) {
    if (s === undefined)
        return 0;
    if (typeof s === 'number')
        return Number.isFinite(s) ? s : 0;
    // Strip currency symbols and thousand separators (1688 returns "2,094.00").
    const cleaned = s.replace(/[¥￥,\s]/g, '');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
}
function normalizeImage(pic) {
    if (!pic)
        return null;
    if (pic.startsWith('//'))
        return 'https:' + pic;
    return pic;
}
export async function run(opts) {
    const data = await dispatch('cart-list', { headed: opts.headed }, { headed: opts.headed, profile: opts.profile });
    emit({
        human: () => printCart(data),
        data,
    });
}
function printCart(r) {
    if (r.items.length === 0) {
        process.stdout.write('Cart is empty.\n');
        return;
    }
    process.stdout.write(`Cart: ${r.total} items (${r.selectedCount} selected)\n\n`);
    const w = String(r.items.length).length;
    r.items.forEach((it, i) => {
        const idx = String(i + 1).padStart(w, ' ');
        const check = it.checked ? '☑' : '☐';
        const eff = it.effective ? '' : ' [失效]';
        process.stdout.write(`${idx}. ${check} ${truncate(it.productTitle, 50)}${eff}\n`);
        const pad = ' '.repeat(w + 2);
        process.stdout.write(`${pad}${it.quantity}×¥${it.unitPrice.toFixed(2)} = ¥${it.amount.toFixed(2)}${it.unit ? ` /${it.unit}` : ''}\n`);
        if (it.skuTitle)
            process.stdout.write(`${pad}sku:    ${it.skuTitle}\n`);
        if (it.seller.name)
            process.stdout.write(`${pad}seller: ${it.seller.name}\n`);
        process.stdout.write(`${pad}cartId: ${it.cartId} · offerId: ${it.offerId}\n`);
        if (it.addedAt)
            process.stdout.write(`${pad}added:  ${it.addedAt}\n`);
        if (i < r.items.length - 1)
            process.stdout.write('\n');
    });
    const totalAmount = r.items
        .filter((i) => i.checked && i.effective)
        .reduce((s, i) => s + i.amount, 0);
    if (totalAmount > 0) {
        process.stdout.write(`\nSelected total: ¥${totalAmount.toFixed(2)}\n`);
    }
}
function truncate(s, n) {
    if (!s)
        return '(no title)';
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
//# sourceMappingURL=cart-list.js.map
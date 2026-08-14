import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { withRecovery } from '../session/recovery.js';
import { sleep } from '../session/wait.js';
import { clickCartCheckoutButton, clickCartRowCheckbox, uncheckAllCartRows, waitForAnyCartRowChecked, waitForCartItems, } from '../session/cart-locators.js';
import { executeRaw as cartListExecute } from './cart-list.js';
export async function execute(ctx, args) {
    if (!Array.isArray(args.cartIds) || args.cartIds.length === 0) {
        throw new CliError(2, 'BAD_INPUT', 'cartIds required.');
    }
    for (const id of args.cartIds) {
        if (!/^\d+$/.test(id)) {
            throw new CliError(2, 'BAD_INPUT', `Invalid cartId: ${id}`);
        }
    }
    return withRecovery(ctx, { cmd: 'checkout-prepare', args }, () => executeCheckoutPrepare(ctx, args), { headed: args.headed === true, maxRetries: 1 });
}
async function executeCheckoutPrepare(ctx, args) {
    // Verify cartIds exist in current cart.
    info('Verifying cart items...');
    const cart = await cartListExecute(ctx);
    const wanted = new Set(args.cartIds);
    const missing = args.cartIds.filter((id) => !cart.items.some((i) => i.cartId === id));
    if (missing.length > 0) {
        throw new CliError(12, 'CART_ITEM_NOT_FOUND', `cartId(s) not found: ${missing.join(', ')}`);
    }
    // Open cart page, uncheck all, check only the wanted items, click 结算.
    info('Selecting items in cart...');
    const page = await ctx.newPage();
    try {
        await page.goto('https://cart.1688.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        if (/login\.1688\.com|login\.taobao\.com/.test(page.url())) {
            throw new CliError(3, 'NOT_LOGGED_IN', 'Session expired. Run `1688 login`.');
        }
        await waitForCartItems(page);
        await sleep(1500);
        await uncheckAllCartRows(page);
        await sleep(1000);
        for (const cartId of args.cartIds) {
            const item = cart.items.find((i) => i.cartId === cartId);
            await clickCartRowCheckbox(page, item);
            await sleep(800);
        }
        await waitForAnyCartRowChecked(page);
        info('Clicking 结算...');
        const [_nav] = await Promise.all([
            page
                .waitForURL(/smart_make_order|order\.1688\.com\/order/i, {
                timeout: 25000,
            })
                .catch(() => undefined),
            clickCartCheckoutButton(page),
        ]);
        if (!/smart_make_order/i.test(page.url())) {
            // Sometimes the page renders inline rather than navigating.
            await sleep(3000);
        }
        if (!/order\.1688\.com/i.test(page.url())) {
            throw new CliError(18, 'PREVIEW_NAV_FAILED', `Did not reach checkout preview page. URL: ${page.url()}`);
        }
        info('Reading order preview...');
        await sleep(5000);
        const html = await page.content();
        return parsePreview(html, page.url());
    }
    finally {
        await page.close().catch(() => { });
    }
}
function parsePreview(rawHtml, url) {
    const match = rawHtml.match(/data-source="([^"]+sumPayment[^"]+)"/);
    if (!match) {
        throw new CliError(19, 'PREVIEW_NOT_FOUND', 'Could not locate preview data in page.');
    }
    const unescaped = decodeHtmlEntities(match[1]);
    let raw;
    try {
        raw = JSON.parse(unescaped);
    }
    catch (e) {
        throw new CliError(19, 'PREVIEW_PARSE_FAILED', `Could not parse preview JSON: ${e.message}`);
    }
    const orders = raw.orders ?? [];
    if (orders.length === 0) {
        throw new CliError(19, 'PREVIEW_EMPTY', 'No orders in preview.');
    }
    // Total = sum of per-seller order sums.
    let totalAmount = 0;
    let productAmount = 0;
    let shippingAmount = 0;
    let taxAmount = 0;
    const out = [];
    let firstAddress;
    for (const o of orders) {
        totalAmount += cents(o.sumPayment);
        productAmount += cents(o.sumPaymentNoCarriage);
        shippingAmount += cents(o.sumCarriage);
        taxAmount += cents(o.sumTaxAmount);
        if (!firstAddress)
            firstAddress = o.receiveAddress;
        const items = [];
        for (const cg of o.cargoGroupedByLogistics ?? []) {
            for (const cargo of cg.cargoList ?? []) {
                for (const oc of cargo.orderCargos ?? []) {
                    items.push({
                        cartId: oc.cartId !== undefined ? String(oc.cartId) : '',
                        offerId: cargo.offerId !== undefined ? String(cargo.offerId) : '',
                        productNumber: oc.cargoNumber ?? null,
                        skuNumber: oc.cargoSkuNumber ?? null,
                        quantity: oc.commonQuantity ?? 0,
                        unitPrice: oc.finalUnitPrice ?? 0,
                        amount: oc.amount ?? 0,
                    });
                }
            }
        }
        out.push({
            seller: {
                memberId: o.simpleSeller?.memberId ?? null,
                loginId: o.simpleSeller?.loginId ?? null,
                companyName: o.simpleSeller?.companyName ?? null,
            },
            totalAmount: cents(o.sumPayment),
            productAmount: cents(o.sumPaymentNoCarriage),
            shippingAmount: cents(o.sumCarriage),
            items,
        });
    }
    return {
        ok: true,
        url,
        totalAmount,
        productAmount,
        shippingAmount,
        taxAmount,
        receiveAddress: {
            fullName: firstAddress?.fullName ?? null,
            mobile: firstAddress?.mobile ?? null,
            address: firstAddress?.address ?? null,
            region: firstAddress?.addressCodeText ?? null,
        },
        orders: out,
    };
}
function cents(v) {
    if (v === undefined || v === null)
        return 0;
    return Math.round(v) / 100;
}
function decodeHtmlEntities(s) {
    return s
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}
export async function run(opts) {
    if (!opts.cartIds || opts.cartIds.length === 0) {
        throw new CliError(2, 'BAD_INPUT', 'At least one cartId is required.');
    }
    const data = await dispatch('checkout-prepare', { cartIds: opts.cartIds, headed: opts.headed }, { headed: opts.headed, profile: opts.profile });
    emit({
        human: () => printPreview(data),
        data,
    });
}
function printPreview(r) {
    process.stdout.write('=== Checkout Preview ===\n');
    process.stdout.write(`  total:   ¥${r.totalAmount.toFixed(2)}`);
    process.stdout.write(`  (items ¥${r.productAmount.toFixed(2)} + shipping ¥${r.shippingAmount.toFixed(2)}`);
    if (r.taxAmount > 0)
        process.stdout.write(` + tax ¥${r.taxAmount.toFixed(2)}`);
    process.stdout.write(')\n');
    if (r.receiveAddress.fullName) {
        process.stdout.write(`  ship to: ${r.receiveAddress.fullName} (${r.receiveAddress.mobile ?? '-'})\n           ${r.receiveAddress.region ?? ''} ${r.receiveAddress.address ?? ''}\n`);
    }
    process.stdout.write('\n');
    r.orders.forEach((o, i) => {
        process.stdout.write(`Seller ${i + 1}: ${o.seller.companyName ?? '?'} (${o.seller.loginId ?? '-'})\n`);
        process.stdout.write(`  subtotal: ¥${o.totalAmount.toFixed(2)} = items ¥${o.productAmount.toFixed(2)} + shipping ¥${o.shippingAmount.toFixed(2)}\n`);
        for (const it of o.items) {
            process.stdout.write(`    * cartId=${it.cartId}  ${it.quantity}×¥${it.unitPrice.toFixed(2)} = ¥${it.amount.toFixed(2)}\n`);
        }
    });
    process.stdout.write('\nThis is a PREVIEW only. To actually place the order, run `1688 checkout confirm` after reviewing the details.\n');
}
//# sourceMappingURL=checkout-prepare.js.map
import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { withRecovery } from '../session/recovery.js';
import { sleep } from '../session/wait.js';
import { clickCartDeleteButton, clickCartRowCheckbox, clickConfirmDialogButton, waitForCartItems, } from '../session/cart-locators.js';
import { executeRaw as cartListExecute, } from './cart-list.js';
export async function execute(ctx, args) {
    if (!/^\d+$/.test(args.cartId)) {
        throw new CliError(2, 'BAD_INPUT', `Invalid cartId: ${args.cartId}`);
    }
    return withRecovery(ctx, { cmd: 'cart-remove', args }, () => executeCartRemove(ctx, args), { headed: args.headed === true, maxRetries: 1 });
}
async function executeCartRemove(ctx, args) {
    // 1. Locate the target item in the current cart.
    info('Looking up cart item...');
    const before = await cartListExecute(ctx);
    const target = before.items.find((i) => i.cartId === args.cartId);
    if (!target) {
        throw new CliError(12, 'CART_ITEM_NOT_FOUND', `Cart item ${args.cartId} not found. Run \`1688 cart list\` to see current items.`);
    }
    // 2. Open cart page; check the matching row; click bulk-delete; confirm.
    //    NOTE: cart-remove stays on UI replay because the underlying API
    //    (mtop.1688.buycenter.MtopPurchaseAstoreService.async) uses 1688's
    //    compressed linkage protocol — payload is gzip+base64-encoded inside
    //    `queryParams`. Hijacking it would require decoding/re-encoding the
    //    linkage protocol (non-trivial), so we keep the UI flow that works.
    info(`Removing "${target.productTitle.slice(0, 30)}"...`);
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
        await clickCartRowCheckbox(page, target);
        // Give server time to ack the selection.
        await sleep(2000);
        await clickCartDeleteButton(page);
        await sleep(1500);
        await clickConfirmDialogButton(page);
        // Allow the server to process.
        await sleep(3000);
    }
    finally {
        await page.close().catch(() => { });
    }
    // 3. Verify removal by re-fetching cart.
    const after = await cartListExecute(ctx);
    if (after.items.some((i) => i.cartId === args.cartId)) {
        throw new CliError(16, 'REMOVE_NOT_REFLECTED', 'Item still present after delete. The UI flow may have failed silently.');
    }
    return { ok: true, removed: target };
}
export async function run(opts) {
    if (!opts.cartId) {
        throw new CliError(2, 'BAD_INPUT', 'cartId required.');
    }
    const data = await dispatch('cart-remove', { cartId: opts.cartId, headed: opts.headed }, { headed: opts.headed, profile: opts.profile });
    emit({
        human: () => {
            process.stdout.write(`Removed: ${data.removed.productTitle.slice(0, 60)}\n` +
                `  cartId: ${data.removed.cartId}\n` +
                `  was:    ${data.removed.quantity}×¥${data.removed.unitPrice.toFixed(2)} = ¥${data.removed.amount.toFixed(2)}\n`);
        },
        data,
    });
}
//# sourceMappingURL=cart-remove.js.map
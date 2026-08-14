import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { withRecovery } from '../session/recovery.js';
import { executeRaw as orderListExecute, } from './order-list.js';
const SCAN_PAGE_SIZE = 50;
const STATUS_LABELS = {
    waitbuyerpay: '待付款',
    waitsellersend: '待发货',
    waitbuyerreceive: '待收货',
    success: '已完成',
    cancel: '已取消',
};
export async function execute(ctx, args) {
    if (!/^\d+$/.test(args.orderId)) {
        throw new CliError(2, 'BAD_INPUT', `Invalid orderId: ${args.orderId}`);
    }
    return withRecovery(ctx, { cmd: 'order-get', args }, () => executeRaw(ctx, args), { headed: args.headed === true, maxRetries: 1 });
}
export async function executeRaw(ctx, args) {
    const status = args.statusHint ?? 'all';
    for (let p = 1; p <= args.maxScanPages; p++) {
        info(`Scanning page ${p} (tradeStatus=${status})...`);
        const listArgs = {
            status,
            page: p,
            pageSize: SCAN_PAGE_SIZE,
        };
        const result = await orderListExecute(ctx, listArgs);
        const match = result.orders.find((o) => o.orderId === args.orderId);
        if (match)
            return match;
        if (result.orders.length === 0)
            break;
        if (p >= result.totalPages)
            break;
    }
    throw new CliError(12, 'ORDER_NOT_FOUND', `Order ${args.orderId} not found in the most recent ${args.maxScanPages * SCAN_PAGE_SIZE} orders. Use --max-scan-pages to search deeper.`);
}
export async function run(opts) {
    const maxScanPages = Math.max(1, parseInt(opts.maxScanPages ?? '5', 10));
    const data = await dispatch('order-get', { orderId: opts.orderId, maxScanPages, statusHint: opts.status, headed: opts.headed }, { headed: opts.headed, profile: opts.profile });
    emit({
        human: () => printOrder(data),
        data,
    });
}
function printOrder(o) {
    const label = STATUS_LABELS[o.status] ?? o.statusLabel ?? o.status;
    process.stdout.write(`Order ${o.orderId}\n`);
    process.stdout.write(`  status:   ${label} (${o.status})\n`);
    process.stdout.write(`  created:  ${o.createdAt}\n`);
    if (o.paidAt)
        process.stdout.write(`  paid:     ${fmt(o.paidAt)}\n`);
    if (o.shippedAt)
        process.stdout.write(`  shipped:  ${fmt(o.shippedAt)}\n`);
    if (o.confirmGoodsTime)
        process.stdout.write(`  confirm:  ${fmt(o.confirmGoodsTime)}\n`);
    process.stdout.write(`  amount:   ¥${o.totalAmount.toFixed(2)} (goods ¥${o.productAmount.toFixed(2)} + shipping ¥${o.shipping.toFixed(2)})\n`);
    process.stdout.write(`  seller:   ${o.seller.name} (${o.seller.loginId})\n`);
    if (o.seller.shopUrl)
        process.stdout.write(`            ${o.seller.shopUrl}\n`);
    if (o.items.length) {
        process.stdout.write(`  items:\n`);
        for (const it of o.items) {
            process.stdout.write(`    * ${it.quantity}×¥${it.unitPrice.toFixed(2)} = ¥${it.amount.toFixed(2)} — ${it.productName}\n`);
            if (it.spec)
                process.stdout.write(`      spec:   ${it.spec}\n`);
            if (it.productNumber)
                process.stdout.write(`      no:     ${it.productNumber}\n`);
            if (it.image)
                process.stdout.write(`      img:    ${it.image}\n`);
        }
    }
}
function fmt(iso) {
    // Trim ms and Z for readability
    return iso.replace(/\.\d{3}Z$/, 'Z');
}
//# sourceMappingURL=order-get.js.map
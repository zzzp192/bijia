import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { withRecovery } from '../session/recovery.js';
import { startResponseCapture } from '../session/response-capture.js';
import { debugTmpPath } from '../util/temp.js';
const STATUS_LABELS = {
    all: '全部',
    waitbuyerpay: '待付款',
    waitsellersend: '待发货',
    waitbuyerreceive: '待收货',
    success: '已完成',
    cancel: '已取消',
};
const ORDER_LIST_URL = 'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html';
const MTOP_API_RE = /mtop\.1688\.trading\.dataline\.service/i;
export async function execute(ctx, args) {
    return withRecovery(ctx, { cmd: 'order-list', args }, () => executeRaw(ctx, args), { headed: args.headed === true, maxRetries: 1 });
}
export async function executeRaw(ctx, args) {
    const page = await ctx.newPage();
    const capture = startResponseCapture({
        page,
        timeoutMs: 25000,
        matcher: MTOP_API_RE,
        parse: async (resp) => {
            const text = await resp.text();
            const outer = JSON.parse(text);
            const resultStr = outer?.data?.data?.result;
            if (typeof resultStr !== 'string')
                return null;
            const inner = JSON.parse(resultStr);
            const list = inner?.data?.data;
            if (!Array.isArray(list))
                return null;
            const first = list[0];
            if (list.length > 0 && (first?.id ?? null) === null)
                return null;
            if (process.env.BB1688_PROBE === '1') {
                try {
                    const fs = await import('node:fs/promises');
                    const file = debugTmpPath('1688-order-list-raw.json');
                    await fs.writeFile(file, text);
                    process.stderr.write(`[probe] saved raw order-list response → ${file} (${text.length} bytes)\n`);
                }
                catch {
                    /* ignore */
                }
            }
            return inner;
        },
    });
    try {
        const url = `${ORDER_LIST_URL}?tradeStatus=${encodeURIComponent(args.status)}&page=${args.page}&pageSize=${args.pageSize}`;
        info(`Fetching orders (${args.status}, page ${args.page})...`);
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
        catch (e) {
            throw new CliError(9, 'NETWORK_ERROR', `Failed to load order page: ${e.message}`);
        }
        if (/login\.1688\.com|login\.taobao\.com/.test(page.url())) {
            throw new CliError(3, 'NOT_LOGGED_IN', 'Session expired. Run `1688 login`.');
        }
        // Wait up to 25s for the mtop response carrying the order array.
        const inner = await capture.wait();
        if (!inner) {
            throw new CliError(11, 'NO_ORDER_DATA', 'Order list response was not captured (page may have changed or risk-controlled).', {
                category: 'response_capture',
                retryable: true,
                responseCapture: capture.diagnostics(),
            });
        }
        return parseOrderList(inner, args);
    }
    finally {
        capture.dispose();
        await page.close().catch(() => { });
    }
}
function parseOrderList(inner, args) {
    const list = inner.data?.data ?? [];
    return {
        status: args.status,
        page: args.page,
        pageSize: inner.data?.pageSize ?? args.pageSize,
        totalPages: inner.data?.pages ?? 0,
        totalOrders: inner.data?.total ?? 0,
        orders: list.map(parseOrder),
    };
}
function parseOrder(o) {
    const firstStep = o.newStepOrders?.[0];
    return {
        orderId: o.idStr ?? String(o.id ?? ''),
        status: firstStep?.stepStatus ?? String(o.status ?? ''),
        statusLabel: o.statusLabel ?? '',
        bizType: o.bizType ?? null,
        createdAt: o.gmtCreate ?? '',
        paidAt: o.gmtPayment ? new Date(o.gmtPayment).toISOString() : null,
        shippedAt: firstStep?.gmtShip
            ? new Date(firstStep.gmtShip).toISOString()
            : null,
        confirmGoodsTime: o.confirmGoodsTime
            ? new Date(o.confirmGoodsTime).toISOString()
            : null,
        totalAmount: cents(o.sumPayment),
        productAmount: cents(o.sumProductPayment),
        shipping: cents(o.carriage),
        originalAmount: cents(o.originalSumPayment),
        discountAmount: cents(o.allPromotionFee),
        adjustment: cents(o.adjustFee),
        seller: {
            name: o.sellerInfo?.companyName ?? '',
            loginId: o.sellerInfo?.loginId ?? '',
            userId: o.sellerInfo?.userId ?? '',
            shopUrl: o.sellerInfo?.companyUrl ?? null,
        },
        steps: (o.newStepOrders ?? []).map(parseStep),
        items: (o.orderEntries ?? []).map(parseEntry),
        actions: (o.orderPermissions ?? []).map((p) => ({
            key: p.permissionKey ?? '',
            name: p.name ?? '',
            url: p.actionUrl ?? null,
            highlight: !!p.highlight,
        })),
        services: (o.serviceOrderList ?? []).map((s) => ({
            productName: s.productName ?? '',
            category: s.category ?? '',
            payer: s.payer ?? '',
            detailLink: s.detailLink ?? null,
        })),
        badges: (o.orderLogos ?? [])
            .map((l) => l.tips?.trim() ?? '')
            .filter((s) => !!s),
    };
}
function parseStep(s) {
    return {
        status: s.stepStatus ?? '',
        name: s.stepName ?? '',
        paid: cents(s.payFee),
        goods: cents(s.goodsFee),
        postage: cents(s.postFee),
    };
}
function parseEntry(e) {
    const spec = e.specInfo?.specItems
        ?.map((s) => `${s.specName ?? ''}: ${s.specValue ?? ''}`)
        .join(' / ') ?? '';
    return {
        entryId: String(e.entryId ?? ''),
        productName: e.productName ?? '',
        spec,
        quantity: e.quantity?.realAmount ?? Number(e.quantity?.realAmountStr ?? 0),
        unitPrice: cents(e.actualUnitPrice),
        amount: cents(e.amount),
        image: e.mainSummImageUrl ?? null,
        productNumber: e.productNumber ?? null,
    };
}
function cents(v) {
    if (v === undefined || v === null)
        return 0;
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return Number.isFinite(n) ? Math.round(n) / 100 : 0;
}
export async function run(opts) {
    const status = opts.status ?? 'all';
    if (!(status in STATUS_LABELS)) {
        throw new CliError(2, 'BAD_INPUT', `Unknown status "${status}". Valid: ${Object.keys(STATUS_LABELS).join(', ')}`);
    }
    const pageNum = Math.max(1, parseInt(opts.page ?? '1', 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(opts.pageSize ?? '10', 10)));
    const data = await dispatch('order-list', { status, page: pageNum, pageSize, headed: opts.headed }, { headed: opts.headed, profile: opts.profile });
    emit({
        human: () => printOrders(data),
        data,
    });
}
function printOrders(r) {
    if (r.orders.length === 0) {
        process.stdout.write(`No orders found (status=${r.status}, page ${r.page}/${r.totalPages || 1}).\n`);
        return;
    }
    const w = String(r.orders.length).length;
    r.orders.forEach((o, i) => {
        const idx = String(i + 1).padStart(w, ' ');
        const label = STATUS_LABELS[o.status] ?? o.status;
        process.stdout.write(`${idx}. ¥${o.totalAmount.toFixed(2)} · ${o.createdAt} · ${label}\n`);
        const pad = ' '.repeat(w + 2);
        process.stdout.write(`${pad}from: ${o.seller.name} (${o.seller.loginId})\n`);
        for (const it of o.items) {
            process.stdout.write(`${pad}* ${it.quantity}×¥${it.unitPrice.toFixed(2)} = ¥${it.amount.toFixed(2)} — ${truncate(it.productName, 40)}`);
            if (it.spec)
                process.stdout.write(`  [${it.spec}]`);
            process.stdout.write('\n');
        }
        process.stdout.write(`${pad}orderId: ${o.orderId}\n`);
        if (i < r.orders.length - 1)
            process.stdout.write('\n');
    });
    process.stdout.write(`\nPage ${r.page} of ${r.totalPages} · ${r.totalOrders} total orders\n`);
}
function truncate(s, n) {
    if (s.length <= n)
        return s;
    return s.slice(0, n - 1) + '…';
}
//# sourceMappingURL=order-list.js.map
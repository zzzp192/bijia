// High-level "shortcut" workflows that compose existing commands.
import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
async function listOrders(status, page, pageSize, opts) {
    return dispatch('order-list', { status, page, pageSize }, { headed: opts.headed, profile: opts.profile });
}
async function getLogistics(orderId, opts, statusHint) {
    return dispatch('order-logistics', { orderId, maxScanPages: 5, statusHint }, { headed: opts.headed, profile: opts.profile });
}
function daysSince(iso) {
    if (!iso)
        return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t))
        return null;
    return Math.floor((Date.now() - t) / 86_400_000);
}
export async function runShipped(opts) {
    if (!opts.orderId || !/^\d+$/.test(opts.orderId)) {
        throw new CliError(2, 'BAD_INPUT', 'Valid orderId required.');
    }
    info(`Fetching order ${opts.orderId}...`);
    const order = await dispatch('order-get', { orderId: opts.orderId, maxScanPages: 5 }, { headed: opts.headed, profile: opts.profile });
    info(`Fetching logistics...`);
    const logistics = await getLogistics(opts.orderId, opts).catch(() => null);
    const data = {
        orderId: order.orderId,
        status: order.statusLabel,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        shippedAt: order.shippedAt,
        daysSincePaid: daysSince(order.paidAt),
        daysSinceShipped: daysSince(order.shippedAt),
        totalAmount: order.totalAmount,
        seller: order.seller,
        items: order.items.map((i) => ({
            name: i.productName,
            qty: i.quantity,
            amount: i.amount,
        })),
        logistics: logistics?.trace?.[0] ?? null,
    };
    emit({
        human: () => {
            process.stdout.write(`Order ${data.orderId}\n`);
            process.stdout.write(`  ${data.status}  ¥${data.totalAmount.toFixed(2)}\n`);
            process.stdout.write(`  seller: ${data.seller.name}\n`);
            process.stdout.write(`  paid:    ${data.paidAt ?? '-'}  (${data.daysSincePaid ?? '?'} days ago)\n`);
            process.stdout.write(`  shipped: ${data.shippedAt ?? '-'}  (${data.daysSinceShipped ?? '?'} days ago)\n`);
            if (data.logistics) {
                const lg = data.logistics;
                process.stdout.write(`  carrier: ${lg.carrier ?? '?'} · ${lg.mailNo}\n`);
                process.stdout.write(`  status:  ${lg.currentStatus}\n`);
                process.stdout.write(`  remark:  ${lg.remark}\n`);
            }
            else {
                process.stdout.write(`  (no logistics yet)\n`);
            }
            process.stdout.write('  items:\n');
            for (const it of data.items) {
                process.stdout.write(`    * ${it.qty}× ¥${it.amount.toFixed(2)} — ${it.name}\n`);
            }
        },
        data,
    });
}
export async function runStuck(opts) {
    const days = Math.max(0, parseInt(opts.days ?? '3', 10));
    const limit = Math.max(1, parseInt(opts.limit ?? '50', 10));
    info(`Finding waitsellersend orders paid more than ${days} days ago...`);
    const all = [];
    for (let p = 1; p <= 5; p++) {
        const r = await listOrders('waitsellersend', p, 50, opts);
        all.push(...r.orders);
        if (r.orders.length === 0 || p >= r.totalPages)
            break;
    }
    const stuck = all
        .map((o) => ({ o, days: daysSince(o.paidAt) }))
        .filter((x) => x.days !== null && x.days >= days)
        .sort((a, b) => (b.days ?? 0) - (a.days ?? 0))
        .slice(0, limit);
    const data = {
        threshold: days,
        total: stuck.length,
        orders: stuck.map((x) => ({
            orderId: x.o.orderId,
            daysSincePaid: x.days,
            paidAt: x.o.paidAt,
            totalAmount: x.o.totalAmount,
            seller: x.o.seller.name,
            sellerLoginId: x.o.seller.loginId,
            item: x.o.items[0]?.productName?.slice(0, 50) ?? '',
        })),
    };
    emit({
        human: () => {
            if (stuck.length === 0) {
                process.stdout.write(`No orders stuck > ${days} days.\n`);
                return;
            }
            process.stdout.write(`Stuck orders (paid > ${days} days, not shipped):\n\n`);
            for (const x of data.orders) {
                process.stdout.write(`  ${x.orderId}  ${x.daysSincePaid}d  ¥${x.totalAmount?.toFixed(2)}  ${x.seller}\n`);
                process.stdout.write(`    ${x.item}\n`);
            }
        },
        data,
    });
}
export async function runFakeShipped(opts) {
    const days = Math.max(0, parseInt(opts.days ?? '1', 10));
    const limit = Math.max(1, parseInt(opts.limit ?? '50', 10));
    const maxPages = Math.max(1, parseInt(opts.maxPages ?? '2', 10));
    const maxCheck = Math.max(1, parseInt(opts.maxCheck ?? '20', 10));
    info(`Finding waitbuyerreceive orders shipped > ${days} days ago...`);
    const all = [];
    for (let p = 1; p <= maxPages; p++) {
        const r = await listOrders('waitbuyerreceive', p, 50, opts);
        all.push(...r.orders);
        if (r.orders.length === 0 || p >= r.totalPages)
            break;
    }
    const candidates = all
        .map((o) => ({ o, days: daysSince(o.shippedAt) }))
        .filter((x) => x.days !== null && x.days >= days)
        .sort((a, b) => (b.days ?? 0) - (a.days ?? 0))
        .slice(0, maxCheck);
    info(`Checking logistics for ${candidates.length} oldest candidates (cap --max-check=${maxCheck})...`);
    const flagged = [];
    for (let i = 0; i < candidates.length; i++) {
        if (flagged.length >= limit)
            break;
        const c = candidates[i];
        info(`  [${i + 1}/${candidates.length}] ${c.o.orderId} (${c.days}d)...`);
        const lg = await getLogistics(c.o.orderId, opts, 'waitbuyerreceive').catch((e) => ({ __error: e.message }));
        if ('__error' in lg) {
            if (opts.debug)
                info(`    fetch failed: ${lg.__error}`);
            continue;
        }
        const trace = lg.trace?.[0];
        if (!trace) {
            if (opts.debug)
                info(`    no trace data (order found but logistics empty)`);
            continue;
        }
        if (opts.debug) {
            info(`    status="${trace.currentStatus}" remark="${trace.remark}"`);
        }
        // Heuristic: waybill exists but courier never picked up. Match common
        // 1688 / 菜鸟 / 快递 phrasing for "waiting for pickup".
        const isFake = /等待揽收|待揽收|未揽收|等待快递员揽收|包裹.*揽收|尚未揽收/.test(trace.remark) ||
            (trace.currentStatus === '已发货' && /已发货/.test(trace.remark));
        if (isFake) {
            flagged.push({
                orderId: c.o.orderId,
                daysSinceShipped: c.days ?? 0,
                seller: c.o.seller.name,
                sellerLoginId: c.o.seller.loginId,
                mailNo: trace.mailNo,
                carrier: trace.carrier,
                currentStatus: trace.currentStatus,
                remark: trace.remark,
                totalAmount: c.o.totalAmount,
                item: c.o.items[0]?.productName?.slice(0, 50) ?? '',
            });
        }
    }
    emit({
        human: () => {
            if (flagged.length === 0) {
                process.stdout.write(`No fake-shipped orders found (criteria: shipped > ${days} days, logistics frozen at "等待揽收").\n`);
                return;
            }
            process.stdout.write(`⚠ ${flagged.length} suspicious orders (waybill printed > ${days} days ago, courier never collected):\n\n`);
            for (const f of flagged) {
                process.stdout.write(`  ${f.orderId}  ${f.daysSinceShipped}d  ¥${f.totalAmount.toFixed(2)}  ${f.seller}\n`);
                process.stdout.write(`    ${f.carrier ?? '?'} ${f.mailNo}\n`);
                process.stdout.write(`    "${f.remark}"\n`);
                process.stdout.write(`    ${f.item}\n\n`);
            }
        },
        data: { threshold: days, total: flagged.length, orders: flagged },
    });
}
export async function runSellerHistory(opts) {
    if (!opts.seller) {
        throw new CliError(2, 'BAD_INPUT', 'Seller required (loginId or company name).');
    }
    const maxPages = Math.max(1, parseInt(opts.maxPages ?? '10', 10));
    const needle = opts.seller;
    info(`Scanning orders (up to ${maxPages * 50} most recent)...`);
    const matches = [];
    for (let p = 1; p <= maxPages; p++) {
        const r = await listOrders('all', p, 50, opts);
        for (const o of r.orders) {
            if (o.seller.loginId === needle ||
                o.seller.name === needle ||
                o.seller.loginId?.includes(needle) ||
                o.seller.name?.includes(needle)) {
                matches.push(o);
            }
        }
        if (r.orders.length === 0 || p >= r.totalPages)
            break;
    }
    // Compute shipping times for orders that have both paidAt and shippedAt
    const shipTimes = [];
    for (const o of matches) {
        if (o.paidAt && o.shippedAt) {
            const d = (Date.parse(o.shippedAt) - Date.parse(o.paidAt)) / 86_400_000;
            if (Number.isFinite(d) && d >= 0)
                shipTimes.push(d);
        }
    }
    const avgShipDays = shipTimes.length
        ? shipTimes.reduce((s, d) => s + d, 0) / shipTimes.length
        : null;
    const onTimeRate = shipTimes.length
        ? shipTimes.filter((d) => d < 2).length / shipTimes.length
        : null;
    const totalSpent = matches.reduce((s, o) => s + o.totalAmount, 0);
    const data = {
        seller: needle,
        totalOrders: matches.length,
        totalSpent,
        avgShipDays,
        onTimeRate,
        recent: matches.slice(0, 10).map((o) => ({
            orderId: o.orderId,
            createdAt: o.createdAt,
            status: o.statusLabel,
            amount: o.totalAmount,
            shipDays: o.paidAt && o.shippedAt
                ? Math.round((Date.parse(o.shippedAt) - Date.parse(o.paidAt)) / 86_400_000 * 10) / 10
                : null,
        })),
    };
    emit({
        human: () => {
            process.stdout.write(`Seller: ${needle}\n`);
            process.stdout.write(`  total orders:  ${data.totalOrders}\n`);
            process.stdout.write(`  total spent:   ¥${data.totalSpent.toFixed(2)}\n`);
            if (data.avgShipDays !== null) {
                process.stdout.write(`  avg ship days: ${data.avgShipDays.toFixed(1)}\n`);
            }
            if (data.onTimeRate !== null) {
                process.stdout.write(`  on-time (<2d): ${(data.onTimeRate * 100).toFixed(0)}%\n`);
            }
            if (data.recent.length) {
                process.stdout.write('\n  Recent orders:\n');
                for (const o of data.recent) {
                    process.stdout.write(`    ${o.orderId}  ${o.createdAt}  ¥${o.amount?.toFixed(2)}  ${o.status}` +
                        (o.shipDays !== null ? `  (shipped ${o.shipDays}d)` : '') +
                        '\n');
                }
            }
        },
        data,
    });
}
//# sourceMappingURL=workflows.js.map
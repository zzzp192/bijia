import fs from 'node:fs/promises';
import path from 'node:path';
import { dispatch } from '../session/dispatch.js';
import { emit } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { compareItemsToCsv, detailSummary, errorInfo, scoreDetail, } from './sourcing-utils.js';
export async function run(opts) {
    const offerIds = normalizeOfferIds(opts.offerIds);
    if (opts.output && !opts.csv) {
        throw new CliError(2, 'BAD_INPUT', '--output requires --csv.');
    }
    const items = [];
    for (const offerId of offerIds) {
        try {
            const detail = await dispatch('offer', { offerId, headed: opts.headed }, { headed: opts.headed, profile: opts.profile });
            const scored = scoreDetail(detail);
            items.push({
                offerId,
                ok: true,
                score: scored.score,
                scoreBreakdown: scored.scoreBreakdown,
                summary: detailSummary(detail),
            });
        }
        catch (error) {
            if (isRunLevelError(error))
                throw error;
            items.push({
                offerId,
                ok: false,
                score: null,
                scoreBreakdown: [],
                summary: null,
                error: errorInfo(error),
            });
        }
    }
    items.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const data = {
        total: items.length,
        ok: items.filter((item) => item.ok).length,
        failed: items.filter((item) => !item.ok).length,
        items,
    };
    if (opts.csv) {
        const text = compareItemsToCsv(items);
        if (opts.output) {
            const target = path.resolve(opts.output);
            await fs.writeFile(target, text);
            emit({
                human: () => process.stdout.write(`Wrote ${items.length} csv rows to ${target}\n`),
                data: { ...data, export: { format: 'csv', path: target, rows: items.length } },
            });
        }
        else {
            process.stdout.write(text);
        }
        return;
    }
    emit({
        human: () => printCompare(data),
        data,
    });
}
function printCompare(data) {
    if (data.items.length === 0) {
        process.stdout.write('No offers to compare.\n');
        return;
    }
    process.stdout.write(`Offer comparison (${data.ok} ok, ${data.failed} failed):\n\n`);
    for (const item of data.items) {
        if (!item.ok || !item.summary) {
            process.stdout.write(`${item.offerId} error: ${item.error?.code ?? 'ERROR'} ${item.error?.message ?? ''}\n`);
            continue;
        }
        const s = item.summary;
        const price = s.priceMin !== null
            ? s.priceMax !== null && s.priceMax !== s.priceMin
                ? `¥${s.priceMin}-${s.priceMax}`
                : `¥${s.priceMin}`
            : '(n/a)';
        process.stdout.write(`${item.score?.toString().padStart(3, ' ')}  ${price}  ${s.title}\n`);
        process.stdout.write(`     ${s.supplier.name ?? '?'} · MOQ ${s.minOrderQty ?? '?'} · sold ${s.saledCount ?? '?'} · skus ${s.skuCount} · ${s.offerId}\n`);
    }
}
function normalizeOfferIds(raw) {
    const out = [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
    if (out.length === 0) {
        throw new CliError(2, 'BAD_INPUT', 'At least one offerId is required.');
    }
    for (const id of out) {
        if (!/^\d+$/.test(id)) {
            throw new CliError(2, 'BAD_INPUT', `Invalid offerId: ${id}`);
        }
    }
    return out;
}
function isRunLevelError(error) {
    if (!error || typeof error !== 'object')
        return false;
    const code = error.code;
    return (code === 'NOT_LOGGED_IN' ||
        code === 'RISK_CONTROL' ||
        code === 'NETWORK_ERROR' ||
        code === 'CANCELED');
}
//# sourceMappingURL=compare.js.map
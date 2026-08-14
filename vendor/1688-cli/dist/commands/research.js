import fs from 'node:fs/promises';
import path from 'node:path';
import { dispatch } from '../session/dispatch.js';
import { emit } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { detailSummary, errorInfo, makeResearchItem, normalizeFilters, normalizeSearchSort, normalizeVerifiedFilter, parseEnrichTop, parseOptionalNumber, parsePositiveInt, researchItemsToCsv, researchItemsToJsonl, } from './sourcing-utils.js';
export async function run(opts) {
    const queries = normalizeKeywords(opts.keywords);
    const maxPerQuery = parsePositiveInt(opts.maxPerQuery, '--max-per-query', 20, 600);
    const sort = normalizeSearchSort(opts.sort);
    const filters = normalizeFilters({
        priceMin: parseOptionalNumber(opts.priceMin, '--price-min'),
        priceMax: parseOptionalNumber(opts.priceMax, '--price-max'),
        province: opts.province,
        city: opts.city,
        verified: normalizeVerifiedFilter(opts.verified),
        minTurnover: parseOptionalNumber(opts.minTurnover, '--min-turnover'),
        excludeAds: opts.excludeAds,
    });
    const enrichTop = parseEnrichTop(opts.enrich);
    validateExportOpts(opts);
    const itemsByOffer = new Map();
    for (const query of queries) {
        const result = await dispatch('search', { keyword: query, max: maxPerQuery, sort, filters, headed: opts.headed }, { headed: opts.headed, profile: opts.profile });
        result.offers.forEach((offer, i) => {
            if (itemsByOffer.has(offer.offerId))
                return;
            const item = makeResearchItem({
                sourceKeyword: query,
                sourceRank: i + 1,
                globalRank: 0,
                offer,
            });
            itemsByOffer.set(offer.offerId, item);
        });
    }
    const items = [...itemsByOffer.values()].sort((a, b) => b.score - a.score);
    items.forEach((item, i) => {
        item.globalRank = i + 1;
    });
    let enrichedCount = 0;
    if (enrichTop > 0) {
        for (const item of items.slice(0, enrichTop)) {
            try {
                const detail = await dispatch('offer', { offerId: item.offer.offerId, headed: opts.headed }, { headed: opts.headed, profile: opts.profile });
                item.enriched = detailSummary(detail);
                enrichedCount++;
            }
            catch (error) {
                if (isRunLevelError(error))
                    throw error;
                item.error = errorInfo(error);
            }
        }
    }
    const data = {
        queries,
        sort,
        filters,
        maxPerQuery,
        enrichTop,
        total: items.length,
        enrichedCount,
        items,
    };
    await emitResearch(data, opts);
}
async function emitResearch(data, opts) {
    if (opts.jsonl || opts.csv) {
        const format = opts.csv ? 'csv' : 'jsonl';
        const text = opts.csv
            ? researchItemsToCsv(data.items)
            : researchItemsToJsonl(data.items);
        if (opts.output) {
            const target = path.resolve(opts.output);
            await fs.writeFile(target, text);
            emit({
                human: () => process.stdout.write(`Wrote ${data.items.length} ${format} rows to ${target}\n`),
                data: { ...data, export: { format, path: target, rows: data.items.length } },
            });
        }
        else {
            process.stdout.write(text);
        }
        return;
    }
    emit({
        human: () => printResearch(data),
        data,
    });
}
function printResearch(data) {
    if (data.items.length === 0) {
        process.stdout.write(`No research results for: ${data.queries.join(', ')}\n`);
        return;
    }
    process.stdout.write(`Research results (${data.items.length}, sort=${data.sort}, enriched=${data.enrichedCount}):\n\n`);
    for (const item of data.items.slice(0, 30)) {
        const price = item.offer.price.text || '(n/a)';
        const supplier = item.offer.supplier.name ?? '?';
        const years = item.offer.supplier.years ? ` · ${item.offer.supplier.years}年` : '';
        const demand = item.demand.turnoverText ? ` · ${item.demand.turnoverText}` : '';
        const ad = item.offer.isP4P ? ' · 广告' : '';
        process.stdout.write(`${String(item.globalRank).padStart(2, ' ')}. ${item.score.toString().padStart(3, ' ')}  ${price}  ${item.offer.title}\n`);
        process.stdout.write(`    ${supplier}${years}${demand}${ad} · ${item.sourceKeyword}#${item.sourceRank} · ${item.offer.offerId}\n`);
        if (item.enriched) {
            const moq = item.enriched.minOrderQty !== null ? `MOQ ${item.enriched.minOrderQty}` : 'MOQ ?';
            process.stdout.write(`    enriched: ${moq}, skus ${item.enriched.skuCount}, sold ${item.enriched.saledCount ?? '?'}\n`);
        }
        if (item.error) {
            process.stdout.write(`    enrich error: ${item.error.code} ${item.error.message}\n`);
        }
    }
    if (data.items.length > 30) {
        process.stdout.write(`\n... ${data.items.length - 30} more items in JSON output\n`);
    }
}
function normalizeKeywords(raw) {
    const out = [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
    if (out.length === 0) {
        throw new CliError(2, 'BAD_INPUT', 'At least one keyword is required.');
    }
    return out;
}
function validateExportOpts(opts) {
    if (opts.jsonl && opts.csv) {
        throw new CliError(2, 'BAD_INPUT', 'Use only one of --jsonl or --csv.');
    }
    if (opts.output && !opts.jsonl && !opts.csv) {
        throw new CliError(2, 'BAD_INPUT', '--output requires --jsonl or --csv.');
    }
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
//# sourceMappingURL=research.js.map
import fs from 'node:fs/promises';
import path from 'node:path';
import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { withRecovery } from '../session/recovery.js';
import { clickSearchNextPage } from '../session/search-locators.js';
import { startSupplierSearchCapture, } from '../session/supplier-search.js';
import { sleep } from '../session/wait.js';
import { encodeGbkPercent } from '../util/encoding.js';
import { errorInfo, parseOptionalNumber, parsePositiveInt, } from './sourcing-utils.js';
const CAPTURE_PAGE_SIZE = 14;
const MAX_PAGES = 10;
export async function execute(ctx, args) {
    return withRecovery(ctx, { cmd: 'supplier-search', args }, async () => {
        const queries = normalizeKeywords(args.keywords);
        const filters = args.filters ?? normalizeSupplierFilters({});
        const fetchMax = hasActiveSupplierFilters(filters)
            ? Math.min(Math.max(args.maxPerQuery * 3, CAPTURE_PAGE_SIZE), CAPTURE_PAGE_SIZE * MAX_PAGES)
            : args.maxPerQuery;
        const bySupplier = new Map();
        for (const query of queries) {
            const suppliers = await fetchSupplierSearch(ctx, query, args.headed === true, fetchMax);
            suppliers.forEach((supplier, i) => {
                const key = supplierKey(supplier);
                if (bySupplier.has(key))
                    return;
                bySupplier.set(key, makeSupplierSearchItem(query, i + 1, supplier));
            });
        }
        const totalBeforeFilter = bySupplier.size;
        const filtered = [...bySupplier.values()]
            .filter((item) => supplierMatchesFilters(item.supplier, filters))
            .sort((a, b) => b.score - a.score);
        const maxTotal = queries.length * args.maxPerQuery;
        const items = filtered.slice(0, maxTotal);
        items.forEach((item, i) => {
            item.globalRank = i + 1;
        });
        const enrichTop = Math.min(args.enrichTop ?? 0, items.length);
        let enrichedCount = 0;
        if (enrichTop > 0) {
            const { execute: inspectSupplier } = await import('./supplier-inspect.js');
            for (const item of items.slice(0, enrichTop)) {
                const memberId = item.supplier.memberId;
                if (!memberId) {
                    item.error = {
                        code: 'SUPPLIER_MEMBER_ID_MISSING',
                        message: 'Company search did not expose supplier memberId; inspect enrichment skipped.',
                    };
                    continue;
                }
                try {
                    item.inspect = await inspectSupplier(ctx, {
                        target: memberId,
                        headed: args.headed,
                    });
                    enrichedCount++;
                }
                catch (error) {
                    if (isRunLevelError(error))
                        throw error;
                    item.error = errorInfo(error);
                }
            }
        }
        return {
            queries,
            source: {
                kind: 'company-search',
                endpoint: 'companySearchBusinessService',
                offerAggregation: false,
            },
            filters,
            maxPerQuery: args.maxPerQuery,
            enrichTop,
            totalBeforeFilter,
            total: items.length,
            enrichedCount,
            items,
        };
    }, { headed: args.headed === true, maxRetries: 1 });
}
export async function run(opts) {
    const data = await runSupplierCommand(opts, { defaultEnrich: '0' });
    await emitSupplierResults(data, opts, 'Supplier search');
}
export async function runResearch(opts) {
    const data = await runSupplierCommand(opts, { defaultEnrich: 'top:10' });
    await emitSupplierResults(data, opts, 'Supplier research');
}
export function buildCompanySearchUrl(keyword) {
    return `https://s.1688.com/company/company_search.htm?keywords=${encodeGbkPercent(keyword)}`;
}
export function normalizeSupplierFilters(input) {
    const minYears = input.minYears ?? null;
    if (minYears !== null && minYears < 0) {
        throw new CliError(2, 'BAD_INPUT', '--min-years must be >= 0.');
    }
    const minRepeatRate = normalizeRateFilter(input.minRepeatRate ?? null, '--min-repeat-rate');
    const minResponseRate = normalizeRateFilter(input.minResponseRate ?? null, '--min-response-rate');
    return {
        factoryOnly: input.factoryOnly === true,
        province: input.province?.trim() || null,
        city: input.city?.trim() || null,
        minYears,
        minRepeatRate,
        minResponseRate,
    };
}
export function parseSupplierEnrichTop(raw, fallback) {
    const value = (raw ?? fallback).trim();
    if (!value || value === '0' || value === 'none')
        return 0;
    if (value === 'all')
        return Number.MAX_SAFE_INTEGER;
    const normalized = value.startsWith('top:') ? value.slice(4) : value;
    const n = parseInt(normalized, 10);
    if (!Number.isFinite(n) || n < 0) {
        throw new CliError(2, 'BAD_INPUT', `Invalid --enrich: ${raw}. Use top:N, N, all, 0, or none.`);
    }
    return Math.min(n, 50);
}
export function makeSupplierSearchItem(sourceKeyword, sourceRank, supplier) {
    const scored = scoreSupplier(supplier);
    return {
        sourceKeyword,
        sourceRank,
        globalRank: 0,
        supplier,
        score: scored.score,
        scoreBreakdown: scored.scoreBreakdown,
    };
}
export function scoreSupplier(supplier) {
    const parts = [];
    const orderCount = supplier.demand.payOrderCount3m ?? supplier.demand.memberBookedCount ?? 0;
    const demandPoints = orderCount >= 10000
        ? 25
        : orderCount >= 1000
            ? 20
            : orderCount >= 100
                ? 15
                : orderCount >= 10
                    ? 8
                    : orderCount > 0
                        ? 4
                        : 0;
    parts.push({
        name: 'company-search-demand',
        points: demandPoints,
        reason: orderCount > 0 ? `${orderCount} orders in 3m` : 'no 3m order signal',
    });
    const years = supplier.tp.serviceYears ?? 0;
    parts.push({
        name: 'supplier-tenure',
        points: Math.min(15, years * 3),
        reason: years > 0 ? `${years} years` : 'no tenure',
    });
    const factoryPoints = supplier.factory.superFactory
        ? 20
        : supplier.factory.shiliFactory || supplier.factory.factoryInspection
            ? 15
            : supplier.factory.isFactory
                ? 10
                : supplier.factory.businessInspection || supplier.factory.shiliCompany
                    ? 8
                    : 0;
    parts.push({
        name: 'factory-trust',
        points: factoryPoints,
        reason: supplier.factory.superFactory
            ? 'super factory'
            : supplier.factory.factoryTag ?? supplier.factory.factoryLevel ?? 'no factory signal',
    });
    const repeatRate = supplier.service.repeatRate ?? 0;
    const responseRate = supplier.service.wwResponseRate ?? 0;
    const servicePoints = Math.min(8, Math.round(repeatRate * 10)) +
        Math.min(7, Math.round(responseRate * 8));
    parts.push({
        name: 'service-rates',
        points: servicePoints,
        reason: `repeat ${formatRate(repeatRate)}, response ${formatRate(responseRate)}`,
    });
    const composite = supplier.service.compositeScore ?? 0;
    parts.push({
        name: 'composite-score',
        points: Math.min(10, Math.round(composite * 2)),
        reason: composite > 0 ? `score ${composite}` : 'no composite score',
    });
    const previewCount = supplier.offersPreview.length;
    parts.push({
        name: 'offer-preview-depth',
        points: Math.min(10, previewCount * 2),
        reason: `${previewCount} company-search offer previews`,
    });
    const score = Math.min(100, Math.round(parts.reduce((sum, p) => sum + p.points, 0)));
    return { score, scoreBreakdown: parts };
}
export function supplierItemsToJsonl(items) {
    return items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
}
export function supplierItemsToCsv(items) {
    const header = [
        'globalRank',
        'score',
        'sourceKeyword',
        'sourceRank',
        'companyName',
        'memberId',
        'loginId',
        'shopUrl',
        'province',
        'city',
        'serviceYears',
        'isFactory',
        'factoryTag',
        'repeatRate',
        'responseRate',
        'payOrderCount3m',
        'payAmount3m',
        'productionService',
        'previewOfferCount',
        'inspected',
        'errorCode',
    ];
    const rows = items.map((item) => [
        item.globalRank,
        item.score,
        item.sourceKeyword,
        item.sourceRank,
        item.supplier.companyName,
        item.supplier.memberId ?? '',
        item.supplier.loginId ?? '',
        item.supplier.shopUrl ?? '',
        item.supplier.location.province ?? '',
        item.supplier.location.city ?? '',
        item.supplier.tp.serviceYears ?? '',
        item.supplier.factory.isFactory ? 'true' : 'false',
        item.supplier.factory.factoryTag ?? '',
        item.supplier.service.repeatRate ?? '',
        item.supplier.service.wwResponseRate ?? '',
        item.supplier.demand.payOrderCount3m ?? '',
        item.supplier.demand.payAmount3m ?? '',
        item.supplier.productionService ?? '',
        item.supplier.offersPreview.length,
        item.inspect ? 'true' : 'false',
        item.error?.code ?? '',
    ]);
    return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}
async function runSupplierCommand(opts, defaults) {
    const keywords = normalizeKeywords(opts.keywords);
    const maxPerQuery = parsePositiveInt(opts.max, '--max', 20, CAPTURE_PAGE_SIZE * MAX_PAGES);
    const filters = normalizeSupplierFilters({
        factoryOnly: opts.factoryOnly,
        province: opts.province,
        city: opts.city,
        minYears: parseOptionalNumber(opts.minYears, '--min-years'),
        minRepeatRate: parseOptionalNumber(opts.minRepeatRate, '--min-repeat-rate'),
        minResponseRate: parseOptionalNumber(opts.minResponseRate, '--min-response-rate'),
    });
    const enrichTop = parseSupplierEnrichTop(opts.enrich, defaults.defaultEnrich);
    validateExportOpts(opts);
    return dispatch('supplier-search', { keywords, maxPerQuery, filters, enrichTop, headed: opts.headed }, { headed: opts.headed, profile: opts.profile });
}
async function emitSupplierResults(data, opts, title) {
    if (opts.jsonl || opts.csv) {
        const format = opts.csv ? 'csv' : 'jsonl';
        const text = opts.csv ? supplierItemsToCsv(data.items) : supplierItemsToJsonl(data.items);
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
        human: () => printSupplierResults(data, title),
        data,
    });
}
async function fetchSupplierSearch(ctx, keyword, headed, maxResults) {
    const page = await ctx.newPage();
    const baseUrl = buildCompanySearchUrl(keyword);
    const pagesWanted = Math.min(Math.max(1, Math.ceil(maxResults / CAPTURE_PAGE_SIZE)), MAX_PAGES);
    let currentTargetPage = 1;
    async function warmup(delayMs) {
        try {
            await page.goto('https://s.1688.com/', {
                waitUntil: 'domcontentloaded',
                timeout: 20000,
            });
            await sleep(delayMs);
        }
        catch {
            /* best effort */
        }
    }
    async function navigateTo(targetUrl) {
        try {
            await page.goto(targetUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });
        }
        catch (error) {
            throw new CliError(9, 'NETWORK_ERROR', `Failed to load supplier search page: ${error.message}`);
        }
    }
    const isSearchBlocked = () => !headed && /\/punish|x5secdata=|punish\.1688\.com/.test(page.url());
    info('Warming up s.1688.com supplier search...');
    await warmup(1500);
    const allSuppliers = [];
    const seen = new Set();
    const capturePageAction = async (action, timeoutMs) => {
        const capture = startSupplierSearchCapture({
            page,
            targetPage: () => currentTargetPage,
            keep: 'largest',
        });
        try {
            await action();
            return await capture.wait({
                timeoutMs,
                settleMs: 1400,
                isClosed: () => page.isClosed(),
                isBlocked: isSearchBlocked,
            });
        }
        finally {
            capture.dispose();
        }
    };
    class PageAdvanceStopped extends Error {
    }
    for (let pageNum = 1; pageNum <= pagesWanted; pageNum++) {
        currentTargetPage = pageNum;
        let captureResult;
        if (pageNum === 1) {
            captureResult = await capturePageAction(async () => {
                info(`Searching 1688 suppliers for "${keyword}" from company search...`);
                if (headed)
                    info('A Chrome window has opened — solve verification there if needed.');
                await navigateTo(baseUrl);
            }, headed ? 180000 : 15000);
        }
        else {
            try {
                captureResult = await capturePageAction(async () => {
                    info(`Fetching supplier page ${pageNum}/${pagesWanted}...`);
                    const advanced = await clickSearchNextPage(page).catch(() => false);
                    if (!advanced)
                        throw new PageAdvanceStopped();
                }, headed ? 180000 : 15000);
            }
            catch (error) {
                if (error instanceof PageAdvanceStopped)
                    break;
                throw error;
            }
        }
        if (captureResult.status === 'browser_closed') {
            throw new CliError(130, 'CANCELED', 'Browser closed.');
        }
        if (captureResult.status === 'blocked') {
            throw riskControlError(headed);
        }
        if (captureResult.status !== 'captured' || !captureResult.data) {
            if (pageNum === 1)
                return [];
            break;
        }
        let added = 0;
        for (const supplier of captureResult.data.suppliers) {
            const key = supplierKey(supplier);
            if (seen.has(key))
                continue;
            seen.add(key);
            allSuppliers.push(supplier);
            added++;
        }
        if (allSuppliers.length >= maxResults)
            break;
        if (added === 0)
            break;
        if (pageNum < pagesWanted)
            await sleep(1500 + Math.random() * 2000);
    }
    return allSuppliers.slice(0, maxResults);
}
function printSupplierResults(data, title) {
    if (data.items.length === 0) {
        process.stdout.write(`No supplier results for: ${data.queries.join(', ')}\n`);
        return;
    }
    process.stdout.write(`${title} (${data.items.length}, company-search, enriched=${data.enrichedCount}):\n\n`);
    for (const item of data.items.slice(0, 30)) {
        const supplier = item.supplier;
        const loc = [supplier.location.province, supplier.location.city].filter(Boolean).join('');
        const years = supplier.tp.serviceYears ? `${supplier.tp.serviceYears}年` : '年限?';
        const factory = supplier.factory.superFactory
            ? '超级工厂'
            : supplier.factory.factoryTag ?? (supplier.factory.isFactory ? '工厂' : '商家');
        const demand = supplier.demand.payOrderCount3m !== null
            ? ` · 近3月${supplier.demand.payOrderCount3m}单`
            : '';
        process.stdout.write(`${String(item.globalRank).padStart(2, ' ')}. ${item.score.toString().padStart(3, ' ')}  ${supplier.companyName}\n`);
        process.stdout.write(`    ${loc || '?'} · ${years} · ${factory}${demand} · ${item.sourceKeyword}#${item.sourceRank}\n`);
        if (supplier.productionService) {
            process.stdout.write(`    products: ${supplier.productionService}\n`);
        }
        if (supplier.memberId || supplier.shopUrl) {
            process.stdout.write(`    ${supplier.memberId ?? '?'} · ${supplier.shopUrl ?? '?'}\n`);
        }
        if (item.inspect) {
            const inspected = item.inspect.factory.isFactory ? 'factory inspected' : 'supplier inspected';
            process.stdout.write(`    inspect: ${inspected}, offers ${item.inspect.offers.availableCount ?? '?'}\n`);
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
function supplierMatchesFilters(supplier, filters) {
    if (filters.factoryOnly && !supplier.factory.isFactory)
        return false;
    if (filters.province && !includesNormalized(supplier.location.province, filters.province)) {
        return false;
    }
    if (filters.city && !includesNormalized(supplier.location.city, filters.city)) {
        return false;
    }
    if (filters.minYears !== null &&
        (supplier.tp.serviceYears === null || supplier.tp.serviceYears < filters.minYears)) {
        return false;
    }
    if (filters.minRepeatRate !== null &&
        (supplier.service.repeatRate === null || supplier.service.repeatRate < filters.minRepeatRate)) {
        return false;
    }
    if (filters.minResponseRate !== null &&
        (supplier.service.wwResponseRate === null ||
            supplier.service.wwResponseRate < filters.minResponseRate)) {
        return false;
    }
    return true;
}
function hasActiveSupplierFilters(filters) {
    return (filters.factoryOnly ||
        filters.province !== null ||
        filters.city !== null ||
        filters.minYears !== null ||
        filters.minRepeatRate !== null ||
        filters.minResponseRate !== null);
}
function normalizeRateFilter(value, flag) {
    if (value === null)
        return null;
    if (value < 0)
        throw new CliError(2, 'BAD_INPUT', `${flag} must be >= 0.`);
    return value > 1 ? value / 100 : value;
}
function supplierKey(supplier) {
    return (supplier.memberId ??
        supplier.loginId ??
        supplier.shopUrl ??
        `${supplier.companyName}:${supplier.location.province ?? ''}:${supplier.location.city ?? ''}`);
}
function formatRate(value) {
    return `${Math.round(value * 100)}%`;
}
function includesNormalized(value, needle) {
    if (!value)
        return false;
    return value.trim().toLowerCase().includes(needle.trim().toLowerCase());
}
function riskControlError(headed) {
    return new CliError(4, 'RISK_CONTROL', headed
        ? '1688 supplier company search did not return a company payload after manual verification.'
        : '1688 risk control or empty company-search payload. Retry once with: 1688 supplier search <keyword> --headed', { recoverHint: headed ? undefined : 'retry_with_headed', retryable: !headed });
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
function csvCell(value) {
    const s = String(value ?? '');
    if (/[",\n]/.test(s))
        return `"${s.replace(/"/g, '""')}"`;
    return s;
}
//# sourceMappingURL=supplier-search.js.map
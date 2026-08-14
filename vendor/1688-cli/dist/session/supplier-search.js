import { waitWithDeadline } from './wait.js';
export const COMPANY_SEARCH_SERVICE = 'companySearchBusinessService';
export function readSupplierSearchRequestMeta(url) {
    if (!url.includes(COMPANY_SEARCH_SERVICE))
        return null;
    const parsed = new URL(url);
    const beginPage = numberFromSearch(parsed.searchParams.get('beginPage'));
    const pageSize = numberFromSearch(parsed.searchParams.get('pageSize'));
    return {
        ...(beginPage !== null ? { beginPage } : {}),
        ...(pageSize !== null ? { pageSize } : {}),
        ...(parsed.searchParams.get('keywords')
            ? { keywords: parsed.searchParams.get('keywords') ?? undefined }
            : {}),
        ...(parsed.searchParams.get('pageName')
            ? { pageName: parsed.searchParams.get('pageName') ?? undefined }
            : {}),
    };
}
export function parseSupplierItemsFromCompanySearchText(text) {
    return parseCompanySearchServiceText(text).suppliers;
}
export function parseCompanySearchServiceText(text) {
    const root = asRecord(parseJsonLike(text));
    const topData = asRecord(root?.data);
    const payload = asRecord(topData?.data);
    const rawItems = asArray(payload?.companyWithOfferLists);
    return {
        suppliers: rawItems
            .map(mapSupplierWrapper)
            .filter((s) => s !== null),
        pageCount: toNumber(payload?.pageCount),
        docsReturn: toNumber(payload?.docsReturn),
        code: toNumber(topData?.code),
        message: toStringOrNull(topData?.msg),
        requestId: toStringOrNull(root?.requestId),
        pageName: toStringOrNull(root?.pageName),
        rtTime: toNumber(root?.rtTime),
    };
}
export function startSupplierSearchCapture(opts) {
    const maxDiagnosticsEntries = 5;
    const startedAt = new Date().toISOString();
    let endedAt;
    let disposed = false;
    let pageClosed = false;
    let finalStatus;
    let timedOut = false;
    let data = null;
    let bestPayloadSize = 0;
    let lastParsedAt = 0;
    let seenCount = 0;
    let matchedCount = 0;
    let parsedCount = 0;
    let lastSeenUrl;
    let lastMatchedUrl;
    let lastParsedUrl;
    let lastError;
    const failures = [];
    const errorInfo = (error) => {
        if (error instanceof Error) {
            return { name: error.name, message: error.message };
        }
        return { message: String(error) };
    };
    const recordFailure = (url, error) => {
        const info = errorInfo(error);
        lastError = info;
        failures.push({
            at: new Date().toISOString(),
            url,
            ...info,
        });
        if (failures.length > maxDiagnosticsEntries)
            failures.shift();
    };
    const diagnostics = () => ({
        startedAt,
        endedAt,
        disposed,
        finalStatus,
        timedOut,
        seenCount,
        matchedCount,
        parsedCount,
        failureCount: failures.length,
        lastSeenUrl,
        lastMatchedUrl,
        lastParsedUrl,
        lastError,
        failures: [...failures],
    });
    const onResponse = async (resp) => {
        if (disposed)
            return;
        const url = resp.url();
        seenCount++;
        lastSeenUrl = url;
        try {
            const meta = readSupplierSearchRequestMeta(url);
            if (!meta)
                return;
            const targetPage = opts.targetPage?.();
            if (targetPage !== undefined && (meta.beginPage ?? 1) !== targetPage)
                return;
            matchedCount++;
            lastMatchedUrl = url;
            const text = await resp.text();
            const parsed = parseCompanySearchServiceText(text);
            if (parsed.suppliers.length === 0)
                return;
            const shouldReplace = !data ||
                opts.keep !== 'largest' ||
                parsed.suppliers.length > data.suppliers.length ||
                (parsed.suppliers.length === data.suppliers.length &&
                    text.length > bestPayloadSize);
            if (shouldReplace) {
                data = parsed;
                bestPayloadSize = text.length;
            }
            parsedCount++;
            lastParsedAt = Date.now();
            lastParsedUrl = url;
        }
        catch (error) {
            recordFailure(url, error);
        }
    };
    const onClose = () => {
        pageClosed = true;
        finalStatus ??= 'browser_closed';
        endedAt ??= new Date().toISOString();
    };
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        endedAt ??= new Date().toISOString();
        opts.page.off('response', onResponse);
        opts.page.off('close', onClose);
    };
    const wait = async (optsWait) => {
        const settleMs = optsWait.settleMs ?? 1200;
        const result = await waitWithDeadline(async (state) => {
            if (pageClosed || optsWait.isClosed?.())
                return 'browser_closed';
            if (data && state.now - lastParsedAt >= settleMs)
                return 'captured';
            if (await optsWait.isBlocked?.())
                return 'blocked';
            if (disposed)
                return 'stream_closed';
            return null;
        }, {
            timeoutMs: optsWait.timeoutMs,
            intervalMs: optsWait.intervalMs ?? 300,
            onTimeout: () => (data ? 'captured' : 'timeout'),
        });
        finalStatus = result;
        timedOut = result === 'timeout';
        endedAt ??= new Date().toISOString();
        return { status: result, data, diagnostics: diagnostics() };
    };
    const waitForAction = async (action, optsWait) => {
        try {
            const actionResult = await action();
            const result = await wait(optsWait);
            return {
                actionResult,
                status: result.status,
                data: result.data,
                diagnostics: result.diagnostics,
            };
        }
        finally {
            dispose();
        }
    };
    opts.page.on('response', onResponse);
    opts.page.on('close', onClose);
    return {
        wait,
        waitForAction,
        dispose,
        diagnostics,
        data: () => data,
    };
}
function mapSupplierWrapper(raw) {
    const wrapper = asRecord(raw);
    const company = asRecord(wrapper?.companyModel);
    const brand = asRecord(wrapper?.companyBrandSiteVO);
    if (!wrapper || !company)
        return null;
    const companyName = toStringOrNull(company.company) ??
        toStringOrNull(brand?.companyName) ??
        toStringOrNull(brand?.company) ??
        '';
    if (!companyName)
        return null;
    const enterpriseId = toStringOrNull(company.enterpriseId);
    const memberId = normalizeMemberId(toStringOrNull(company.userId) ?? enterpriseId ?? toStringOrNull(wrapper.memberId));
    const domainUri = toStringOrNull(company.domainUri);
    const shopUrl = normalizeUrl(toStringOrNull(brand?.url)) ??
        normalizeDomainUrl(domainUri);
    const factoryTag = toStringOrNull(wrapper.factoryTag) ?? toStringOrNull(company.factoryTag);
    const factoryLevel = toStringOrNull(company.factoryLevel);
    const factoryLevelIsFactory = factoryLevel !== null && /工厂|厂/.test(factoryLevel);
    const shiliFactory = toBool(wrapper.shiliFactory);
    const superFactory = toBool(wrapper.superFactory);
    const factoryInspection = toBool(wrapper.factoryInspection);
    const isFactory = toBool(company.isFactory) ||
        shiliFactory ||
        superFactory ||
        factoryInspection ||
        factoryLevelIsFactory ||
        !!factoryTag;
    return {
        companyName,
        loginId: toStringOrNull(company.loginId),
        memberId,
        enterpriseId,
        realUserId: toStringOrNull(company.realUserId),
        companyId: toStringOrNull(company.id),
        shopUrl,
        factoryCardUrl: memberId
            ? `https://sale.1688.com/factory/card.html?memberId=${encodeURIComponent(memberId)}`
            : null,
        domainUri,
        location: {
            province: toStringOrNull(company.province),
            city: toStringOrNull(company.city),
            address: toStringOrNull(company.address),
            latitude: toNumber(company.latitude),
            longitude: toNumber(company.longitude),
        },
        productionService: toStringOrNull(company.productionService),
        businessMode: toStringOrNull(company.businessMode),
        tp: {
            memberLevel: toStringOrNull(company.memberLevel),
            serviceYears: toNumber(company.tpServiceYear),
            tpNum: toNumber(company.tpNum),
        },
        factory: {
            isFactory,
            factoryTag,
            factoryLevel,
            shiliFactory,
            shiliCompany: toBool(wrapper.shiliCompany),
            superFactory,
            businessInspection: toBool(wrapper.businessInspection),
            factoryInspection,
            qiJianCompany: toBool(wrapper.qiJianCompany),
            safePurchase: toBool(wrapper.safePurchase),
            trust: toBool(wrapper.trust),
        },
        service: {
            compositeScore: toNumber(company.compositeNewScore),
            wwResponseRate: toNumber(company.wwResponseRate),
            repeatRate: toNumber(company.repeatRate),
            complianceRate: toNumber(company.complianceRate),
        },
        demand: {
            payOrderCount3m: toNumber(company.payMordCnt3Month),
            payAmount3m: toNumber(company.payOrdAmt3m),
            fuzzyPayAmount3m: toStringOrNull(wrapper.fuzzyPayOrdAmt3m),
            saleQuantity3m: toNumber(company.saleQuantity3Month),
            memberBookedCount: toNumber(wrapper.memberBookedCount),
        },
        tags: uniqueStrings([
            ...splitTags(toStringOrNull(company.memberTags)),
            ...splitTags(toStringOrNull(company.productionService)),
            factoryTag,
            factoryLevel,
            toStringOrNull(company.memberLevel),
        ]),
        offersPreview: asArray(wrapper.companyOffers)
            .map(mapOfferPreview)
            .filter((o) => o !== null),
    };
}
function mapOfferPreview(raw) {
    const offer = asRecord(raw);
    if (!offer)
        return null;
    const title = cleanText(toStringOrNull(offer.subject) ?? '');
    if (!title)
        return null;
    const url = normalizeUrl(toStringOrNull(offer.detailUrl));
    const offerId = toStringOrNull(offer.offerId) ??
        (url ? url.match(/\/offer\/(\d+)\.html/)?.[1] ?? null : null);
    const priceValue = toNumber(offer.price);
    return {
        offerId,
        title,
        url,
        price: {
            text: priceValue !== null ? `¥${priceValue}` : toStringOrNull(offer.price),
            value: priceValue,
        },
        unit: toStringOrNull(offer.unit),
        image: normalizeUrl(toStringOrNull(offer.picUrl)),
        bookedCount: toNumber(offer.bookedCount),
        saleQuantity: toNumber(offer.saleQuantity),
        quantitySumMonth: toNumber(offer.quantitySumMonth),
        brief: cleanText(toStringOrNull(offer.brief) ?? '') || null,
    };
}
function parseJsonLike(text) {
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    }
    catch {
        const match = trimmed.match(/^[\w$.]+\((.*)\);?$/s);
        if (!match?.[1])
            throw new Error('Company search response is not JSON.');
        return JSON.parse(match[1]);
    }
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function toStringOrNull(value) {
    if (typeof value === 'string') {
        const trimmed = cleanText(value);
        return trimmed || null;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return null;
}
function toNumber(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string')
        return null;
    const cleaned = value.replace(/,/g, '').trim();
    if (!cleaned || cleaned === '-1')
        return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}
function numberFromSearch(value) {
    if (value === null)
        return null;
    return toNumber(value);
}
function toBool(value) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'number')
        return value === 1;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return ['true', '1', 'y', 'yes', '是'].includes(normalized);
    }
    return false;
}
function cleanText(value) {
    return value.replace(/<\/?font[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
function normalizeMemberId(value) {
    if (!value)
        return null;
    if (value.startsWith('a-b2b-'))
        return value.slice(2);
    if (value.startsWith('b2b-'))
        return value;
    return null;
}
function normalizeDomainUrl(value) {
    if (!value)
        return null;
    return normalizeUrl(value.includes('://') || value.startsWith('//') ? value : `https://${value}`);
}
function normalizeUrl(value) {
    if (!value)
        return null;
    if (value.startsWith('//'))
        return `https:${value}`;
    if (/^https?:\/\//i.test(value))
        return value;
    return null;
}
function splitTags(value) {
    if (!value)
        return [];
    return value
        .split(/[;；,，|]/)
        .map((s) => s.trim())
        .filter((s) => !!s && !/^\d+$/.test(s));
}
function uniqueStrings(values) {
    return [...new Set(values.filter((v) => !!v))];
}
//# sourceMappingURL=supplier-search.js.map
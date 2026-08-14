import { parseMtopJsonp } from './mtop.js';
export const SEARCH_MTOP_API = 'mtop.relationrecommend.wirelessrecommend.recommend';
export const SEARCH_APP_ID = '32517';
function bool(s) {
    return s === 'true';
}
function parseCountText(text) {
    if (typeof text === 'number')
        return Number.isFinite(text) ? text : null;
    if (!text)
        return null;
    const compact = text.replace(/,/g, '').replace(/\s+/g, '');
    const match = compact.match(/(\d+(?:\.\d+)?)(万|w|W|亿|k|K)?/);
    if (!match?.[1])
        return null;
    const value = Number(match[1]);
    if (!Number.isFinite(value))
        return null;
    const unit = match[2] ?? '';
    const multiplier = unit === '亿'
        ? 100000000
        : unit === '万' || unit === 'w' || unit === 'W'
            ? 10000
            : unit === 'k' || unit === 'K'
                ? 1000
                : 1;
    return Math.round(value * multiplier);
}
function parsePercentText(text) {
    if (!text)
        return null;
    const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (!match?.[1])
        return null;
    const n = Number(match[1]);
    return Number.isFinite(n) ? n : null;
}
function textList(items) {
    return (items ?? [])
        .map((t) => t?.text?.trim() ?? '')
        .filter((s) => !!s);
}
export function mapOffer(item) {
    const d = item.data;
    if (!d?.offerId)
        return null;
    const title = (d.title ?? '').replace(/<\/?font[^>]*>/g, '').trim();
    const priceRaw = d.priceInfo?.price;
    const price = priceRaw ? parseFloat(priceRaw) : null;
    const yearsRaw = d.shop?.tpYear;
    const years = yearsRaw ? parseInt(yearsRaw, 10) : null;
    const tags = (d.tags ?? [])
        .map((t) => t?.text?.trim() ?? '')
        .filter((s) => !!s);
    const serviceTags = textList(d.serviceTags);
    const productBadges = textList(d.productBadges);
    const orderCountText = d.orderCountText ??
        (typeof d.orderCount === 'string' ? d.orderCount : undefined) ??
        d.bookedCount ??
        null;
    const repurchaseRateText = d.repurchaseRateText ?? d.repurchaseRate ?? null;
    return {
        offerId: d.offerId,
        title,
        price: {
            text: priceRaw ? `¥${priceRaw}` : '',
            min: price,
            max: price,
        },
        supplier: {
            name: d.shop?.text ?? null,
            shopUrl: d.shopAddition?.shopLinkUrl ?? d.winPortUrl ?? null,
            years,
        },
        location: {
            province: d.province ?? null,
            city: d.city ?? null,
        },
        bizType: d.bizType ?? null,
        verified: {
            factory: bool(d.factoryInspection),
            business: bool(d.businessInspection),
            superFactory: bool(d.superFactory),
        },
        tags,
        ...(serviceTags.length ? { serviceTags } : {}),
        ...(productBadges.length ? { productBadges } : {}),
        demand: {
            orderCountText,
            orderCount: typeof d.orderCount === 'number'
                ? d.orderCount
                : parseCountText(orderCountText),
            repurchaseRateText,
            repurchaseRate: parsePercentText(repurchaseRateText),
        },
        isP4P: bool(d.isP4P),
        turnover: d.bookedCount ?? null,
        url: `https://detail.1688.com/offer/${d.offerId}.html`,
        image: d.offerPicUrl ?? null,
    };
}
export function readSearchMtopRequestMeta(url) {
    if (!url.includes(SEARCH_MTOP_API))
        return null;
    try {
        const dataParam = new URLSearchParams(new URL(url).search).get('data') ?? '';
        if (!dataParam)
            return null;
        const dataObj = JSON.parse(dataParam);
        const params = JSON.parse(dataObj.params ?? '{}');
        const beginPage = params.beginPage === undefined ? undefined : Number(params.beginPage);
        return {
            appId: String(dataObj.appId),
            method: params.method,
            beginPage,
            sortType: params.sortType,
        };
    }
    catch {
        return null;
    }
}
export function parseOfferItemsFromMtopText(text) {
    const json = parseMtopJsonp(text);
    const items = json?.data?.data?.OFFER?.items ?? [];
    return items.map(mapOffer).filter((o) => o !== null);
}
//# sourceMappingURL=search-mtop.js.map
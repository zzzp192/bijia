// Decoder for 1688 IM "last message" payloads as they arrive in the
// `/r/Conversation/listNewestPagination` response.
//
// 1688 IM messages come in four practical shapes:
//   contentType === 1     → plain text
//   contentType === 2     → image (rare in CBU)
//   contentType === 101   → custom card (orders, offers, refunds, notices…)
//   contentType missing   → server stripped content (old messages, ~12+ months)
//
// For card messages, the human-readable preview AND structured fields
// (orderId / offerId / link / image / amount) live in TWO places:
//   1. `content.custom.data` — base64-encoded JSON
//   2. `message.extension.dynamic_msg_content` — JSON-string template
// The two are independent: some cards populate only one, some both, some
// neither (those degrade to the bare `[卡片消息]` summary).
//
// The card *template* itself is identified by a 6-digit code inside
// `extension.biMsgType` (e.g. `bc_0_170002_<tplInstanceId>` → `170002`).
// Codes seen in production map to known semantic categories; unmapped
// codes still surface the raw code so agents can filter on it.
// Card template code → semantic name. Source: probe of 2400+ live
// conversations on a real buyer account; codes not in this map fall back
// to `'unknown'` but the raw `cardCode` is still emitted so callers can
// branch on it.
const TEMPLATE_BY_CODE = {
    '170002': 'order_followup', // 催发货卡片
    '527001': 'order_fulfillment', // 少发漏发反馈
    '339001': 'order_status', // 我在看这笔订单
    '362001': 'order_payment_reminder', // 未付款提醒
    '367004': 'order_payment_reminder', // 订单已改价完成 — 请确认
    '381001': 'address_changed', // 订单地址已修改
    '247001': 'refund', // 订单待退货提醒
    '467001': 'offer', // 首发/趋势新品推荐
    '390001': 'offer', // 商品推荐 v2
    '487002': 'offer', // 商品推荐 v3
    '494001': 'coupon', // 老客券待领取
    '338001': 'evaluation_invite', // 客服评价邀请
    '364002': 'session_ended', // 会话已结束
    '352003': 'misc', // 延期必赔
    '280002': 'misc', // 推荐换供
    '293003': 'misc',
    '318002': 'misc',
    '356001': 'misc',
    '360001': 'misc',
    '399002': 'misc',
    '453005': 'misc',
};
export function decodeLastMessage(msg) {
    const ct = msg?.content?.contentType;
    if (ct === 1) {
        const text = msg?.content?.text?.content ?? '';
        return { kind: 'text', preview: text.slice(0, 200) };
    }
    if (ct === 2) {
        return { kind: 'image', preview: '[图片]' };
    }
    if (ct == null) {
        // Server returns a populated lastMessage envelope but with no `content`
        // for conversations whose last activity is older than ~12 months.
        return { kind: 'archived', preview: '[历史会话 — 内容已归档]' };
    }
    if (ct !== 101) {
        return { kind: 'other', preview: `[未知消息 ct=${ct}]` };
    }
    return decodeCard(msg ?? {});
}
function decodeCard(msg) {
    const ext = msg.extension ?? {};
    const custom = msg.content?.custom ?? {};
    const dataObj = decodeBase64Json(custom.data);
    const dynObj = decodeDynamicMsgContent(ext.dynamic_msg_content);
    const cardCode = ext.biMsgType?.match(/bc_\d+_(\d{6})_/)?.[1];
    const cardTemplate = (cardCode && TEMPLATE_BY_CODE[cardCode]) || 'unknown';
    const preview = pickPreview(custom.summary, dataObj, dynObj);
    const extras = extractExtras(dataObj, dynObj);
    const out = {
        kind: 'card',
        preview,
        cardTemplate,
    };
    if (cardCode)
        out.cardCode = cardCode;
    if (Object.keys(extras).length > 0)
        out.extras = extras;
    return out;
}
function decodeBase64Json(data) {
    if (!data)
        return null;
    try {
        const decoded = Buffer.from(data, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        return typeof parsed === 'object' && parsed !== null
            ? parsed
            : null;
    }
    catch {
        return null;
    }
}
function decodeDynamicMsgContent(raw) {
    if (!raw)
        return null;
    try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr[0] && typeof arr[0] === 'object') {
            const td = arr[0].templateData;
            return td && typeof td === 'object'
                ? td
                : null;
        }
        return null;
    }
    catch {
        return null;
    }
}
function pickPreview(summary, dataObj, dynObj) {
    // Order: prefer rich title fields > fall back to bare summary > generic.
    // `summary === '[卡片消息]'` is the SDK's degraded placeholder; only use
    // it as last resort.
    const isMeaningfulSummary = typeof summary === 'string' &&
        summary.length > 0 &&
        summary !== '[卡片消息]';
    const candidates = [
        isMeaningfulSummary ? summary : null,
        dataObj?.productTitle,
        dataObj?.title,
        dataObj?.refundTitle,
        dataObj?.refundContent,
        dynObj?.title,
        dynObj?.offerSubTitle,
        dynObj?.grayText,
        summary, // last resort — may be '[卡片消息]'
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.length > 0)
            return c.slice(0, 200);
    }
    return '[卡片消息]';
}
function extractExtras(dataObj, dynObj) {
    const extras = {};
    const linkUrl = asString(dataObj?.linkUrl) ??
        asString(dynObj?.pcJumpUrl) ??
        asString(dynObj?.actionJumpUrl);
    if (linkUrl)
        extras.linkUrl = linkUrl;
    // orderId: present in either base64 data (`linkUrl` query) or template
    // data (`actionJumpUrl`). Match either `order_id=` or `orderId=`.
    const orderId = linkUrl?.match(/order[_ ]?id=(\d+)/i)?.[1];
    if (orderId)
        extras.orderId = orderId;
    // offerId: 1688 product page URL form is `…/offer/<digits>.html`
    const offerSource = asString(dynObj?.pcJumpUrl) ?? asString(dynObj?.actionJumpUrl) ?? linkUrl;
    const offerId = offerSource?.match(/offer\/(\d+)/)?.[1];
    if (offerId)
        extras.offerId = offerId;
    // refundId from refund detail link
    const refundId = linkUrl?.match(/refundId=([A-Z0-9]+)/)?.[1];
    if (refundId)
        extras.refundId = refundId;
    const imgUrl = asString(dataObj?.imgUrl) ?? asString(dynObj?.offerPic);
    if (imgUrl)
        extras.imgUrl = imgUrl;
    // amount: order cards put it in `refundAmt` (display-ready string);
    // offer cards split price into firstPart/secondPart (yuan / cents).
    const amount = asString(dataObj?.refundAmt) ?? buildOfferAmount(dynObj);
    if (amount)
        extras.amount = amount;
    return extras;
}
function buildOfferAmount(dynObj) {
    const first = asString(dynObj?.firstPartPrice);
    if (!first)
        return null;
    const second = asString(dynObj?.secondPartPrice) ?? '00';
    return `¥${first}.${second}`;
}
function asString(v) {
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}
//# sourceMappingURL=im-cards.js.map
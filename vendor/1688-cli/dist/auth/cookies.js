export function parseIdentity(cookies) {
    const memberId = pick(cookies, 'unb', '.1688.com') ?? pick(cookies, 'unb', '.taobao.com');
    if (!memberId)
        return null;
    const trackraw = pick(cookies, 'tracknick');
    const nick = trackraw ? decodeTracknick(trackraw) : null;
    return { memberId, nick };
}
function pick(cookies, name, domainSuffix) {
    for (const c of cookies) {
        if (c.name !== name)
            continue;
        if (domainSuffix && !c.domain.endsWith(domainSuffix))
            continue;
        return c.value;
    }
    return undefined;
}
export function decodeTracknick(raw) {
    let s = raw;
    try {
        s = decodeURIComponent(s);
    }
    catch {
        // malformed percent encoding — leave as-is
    }
    // Handle literal \uXXXX escapes that sometimes survive in cookie values
    s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return s;
}
//# sourceMappingURL=cookies.js.map
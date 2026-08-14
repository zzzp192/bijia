const PROBE_URL = 'https://myalibaba.1688.com/';
export async function verifyOnline(ctx) {
    const page = await ctx.newPage();
    try {
        const resp = await page.goto(PROBE_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
        });
        const finalUrl = page.url();
        if (/login\.1688\.com|login\.taobao\.com/.test(finalUrl))
            return false;
        if (!resp)
            return false;
        if (resp.status() >= 400)
            return false;
        return true;
    }
    catch {
        return false;
    }
    finally {
        await page.close().catch(() => { });
    }
}
//# sourceMappingURL=verify.js.map
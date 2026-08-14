import { waitWithDeadline } from './wait.js';
import { SEARCH_APP_ID, parseOfferItemsFromMtopText, readSearchMtopRequestMeta, } from './search-mtop.js';
export async function captureSearchOffersForAction(opts, action, waitOptions) {
    const capture = startSearchOfferCapture(opts);
    return capture.waitForAction(action, waitOptions);
}
export function startSearchOfferCapture(opts) {
    const maxDiagnosticsEntries = 5;
    const startedAt = new Date().toISOString();
    let endedAt;
    let disposed = false;
    let pageClosed = false;
    let finalStatus;
    let timedOut = false;
    let offers = [];
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
    const reset = () => {
        endedAt = undefined;
        finalStatus = undefined;
        timedOut = false;
        offers = [];
        seenCount = 0;
        matchedCount = 0;
        parsedCount = 0;
        lastSeenUrl = undefined;
        lastMatchedUrl = undefined;
        lastParsedUrl = undefined;
        lastError = undefined;
        failures.length = 0;
    };
    const onResponse = async (resp) => {
        if (disposed)
            return;
        const url = resp.url();
        seenCount++;
        lastSeenUrl = url;
        try {
            const meta = readSearchMtopRequestMeta(url);
            if (meta) {
                if (meta.appId !== SEARCH_APP_ID)
                    return;
                if (opts.requireMethod && meta.method !== opts.requireMethod)
                    return;
                if (opts.requireSortType && meta.sortType !== opts.requireSortType)
                    return;
                const targetPage = opts.targetPage?.();
                if (targetPage !== undefined && (meta.beginPage ?? 1) !== targetPage)
                    return;
            }
            else if (!opts.allowUnscopedWirelessRecommend ||
                !/mtop\.relationrecommend\.wirelessrecommend\.recommend/i.test(url)) {
                return;
            }
            matchedCount++;
            lastMatchedUrl = url;
            const parsed = parseOfferItemsFromMtopText(await resp.text());
            if (parsed.length === 0)
                return;
            if (opts.keep === 'largest') {
                if (parsed.length > offers.length)
                    offers = parsed;
            }
            else {
                offers = parsed;
            }
            parsedCount++;
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
        const result = await waitWithDeadline(async () => {
            if (pageClosed || optsWait.isClosed?.())
                return 'browser_closed';
            if (offers.length > 0)
                return 'captured';
            if (await optsWait.isBlocked?.())
                return 'blocked';
            if (disposed)
                return 'stream_closed';
            return null;
        }, {
            timeoutMs: optsWait.timeoutMs,
            intervalMs: optsWait.intervalMs ?? 300,
            onTimeout: () => (offers.length > 0 ? 'captured' : 'timeout'),
        });
        finalStatus = result;
        timedOut = result === 'timeout';
        endedAt ??= new Date().toISOString();
        return { status: result, offers, diagnostics: diagnostics() };
    };
    const waitForAction = async (action, optsWait) => {
        try {
            const actionResult = await action();
            const result = await wait(optsWait);
            return {
                actionResult,
                status: result.status,
                offers: result.offers,
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
        reset,
        wait,
        waitForAction,
        dispose,
        diagnostics,
        offers: () => offers,
    };
}
//# sourceMappingURL=search-capture.js.map
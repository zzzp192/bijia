import { writeFileSync } from 'node:fs';
import { waitUntil } from './wait.js';
import { debugTmpPath } from '../util/temp.js';
export const IM_BASE = 'https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html';
export function collectWsFrames(page) {
    const frames = [];
    page.on('websocket', (ws) => {
        const record = (type, payloadRaw) => {
            const payload = typeof payloadRaw === 'string' ? payloadRaw : payloadRaw.toString();
            let method = '';
            let mid = null;
            try {
                const j = JSON.parse(payload);
                method = j?.lwp ?? '';
                mid = j?.headers?.mid ?? null;
            }
            catch {
                /* not JSON — skip */
            }
            frames.push({ type, method, mid, payloadLen: payload.length, payload });
        };
        ws.on('framesent', (frame) => record('sent', frame.payload));
        ws.on('framereceived', (frame) => record('recv', frame.payload));
    });
    return frames;
}
function midToMethodMap(frames) {
    const m = new Map();
    for (const f of frames) {
        if (f.type === 'sent' && f.mid && f.method)
            m.set(f.mid, f.method);
    }
    return m;
}
export function findLwpResponses(frames, method) {
    const midToMethod = midToMethodMap(frames);
    const out = [];
    for (const f of frames) {
        if (f.type !== 'recv')
            continue;
        if (!f.mid)
            continue;
        if (midToMethod.get(f.mid) !== method)
            continue;
        try {
            const env = JSON.parse(f.payload);
            if (env.code !== 200)
                continue;
            if (env.body !== undefined)
                out.push(env.body);
        }
        catch {
            /* skip */
        }
    }
    return out;
}
export async function waitForLwpResponse(frames, method, timeoutMs) {
    return waitUntil(() => {
        const midToMethod = midToMethodMap(frames);
        return frames.some((f) => f.type === 'recv' && f.mid && midToMethod.get(f.mid) === method);
    }, { timeoutMs, intervalMs: 200 });
}
/**
 * Probe support: synchronously dump WS frames to the system temp dir.
 *
 * Call from inside the command's `try` block (NOT from `page.on('close', ...)`)
 * so the dump runs before process exit. Headless `page.close()` does not
 * always flush close-event listeners before the process exits.
 */
export function dumpWsFramesForProbe(frames, interestingPattern = /Message|Conversation|SingleChat/i, payloadHints = /msgId|messageId|cardType|offerId|orderId|conversationCode|userConvs|listMessage/i) {
    if (process.env.BB1688_PROBE !== '1')
        return;
    const midToMethod = midToMethodMap(frames);
    const enriched = frames.map((f) => ({
        ...f,
        reqMethod: f.type === 'recv' && f.mid ? midToMethod.get(f.mid) ?? null : null,
    }));
    const interesting = enriched.filter((f) => {
        if (f.type === 'sent')
            return interestingPattern.test(f.method);
        if (f.reqMethod && interestingPattern.test(f.reqMethod))
            return true;
        return payloadHints.test(f.payload);
    });
    try {
        const fullPath = debugTmpPath('1688-ws-frames.json');
        const interestingPath = debugTmpPath('1688-ws-interesting.json');
        writeFileSync(fullPath, JSON.stringify(enriched, null, 2));
        writeFileSync(interestingPath, JSON.stringify(interesting, null, 2));
        process.stderr.write(`[ws-frames] total=${frames.length} interesting=${interesting.length}\n` +
            `methods seen: ${[...new Set(frames.map((f) => f.method).filter(Boolean))].join(', ')}\n` +
            `full dump → ${fullPath} (${enriched.length} frames)\n` +
            `interesting dump → ${interestingPath} (${interesting.length} frames)\n`);
    }
    catch (e) {
        process.stderr.write(`[ws-frames] write failed: ${String(e)}\n`);
    }
}
//# sourceMappingURL=im-ws.js.map
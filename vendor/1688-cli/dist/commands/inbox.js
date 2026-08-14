import { dispatch } from '../session/dispatch.js';
import { CliError } from '../io/errors.js';
import { emit, info } from '../io/output.js';
import { findImInput } from '../session/im-locators.js';
import { decodeLastMessage, } from '../session/im-cards.js';
import { IM_BASE, collectWsFrames, dumpWsFramesForProbe, findLwpResponses, waitForLwpResponse, } from '../session/im-ws.js';
import { withRecovery } from '../session/recovery.js';
import { readState } from '../session/state.js';
import { sleep } from '../session/wait.js';
const LWP_LIST = '/r/Conversation/listNewestPagination';
const LWP_LIST_TOP = '/r/Conversation/listTop';
// Hard cap on auto-pagination scroll rounds. The IM client returns ~20
// conversations per page, so MAX_PAGES * pageSize ≈ upper bound on
// inbox depth this command will surface. Matches `search` MAX_PAGES.
const MAX_PAGES = 10;
export function parseConversations(bodies, myMemberId) {
    const seen = new Set();
    const out = [];
    let cursor = null;
    // Use the LATEST response if duplicates fired (IM client occasionally
    // re-fetches). nextCursor comes from the last body received.
    for (const body of bodies) {
        if (typeof body.nextCursor === 'number')
            cursor = body.nextCursor;
        if (!Array.isArray(body.userConvs))
            continue;
        for (const u of body.userConvs) {
            if (u.type !== 1)
                continue; // single-chat only for v1
            const s = u.singleChatUserConversation;
            if (!s)
                continue;
            const cid = s.singleChatConversation?.cid ?? s.lastMessage?.message?.cid;
            if (!cid || seen.has(cid))
                continue;
            seen.add(cid);
            const peer = parsePeer(s.user_extension?.target);
            if (!peer)
                continue;
            const msg = s.lastMessage?.message;
            const decoded = decodeLastMessage(msg);
            const senderUid = (msg?.sender?.uid ?? '').split('@')[0] ?? '';
            const fromMe = senderUid === myMemberId;
            const lastMessage = {
                messageId: msg?.messageId != null ? String(msg.messageId) : null,
                kind: decoded.kind,
                preview: decoded.preview,
                at: msEpochToIso(msg?.createAt),
                fromMe,
            };
            if (decoded.cardTemplate)
                lastMessage.cardTemplate = decoded.cardTemplate;
            if (decoded.cardCode)
                lastMessage.cardCode = decoded.cardCode;
            if (decoded.extras)
                lastMessage.extras = decoded.extras;
            out.push({
                cid,
                peer,
                unread: s.redPoint ?? 0,
                topRank: s.topRank ?? 0,
                muted: (s.muteNotification ?? 0) === 1,
                updatedAt: msEpochToIso(s.modifyTime) ?? '',
                lastMessage,
            });
        }
    }
    // Pinned (topRank > 0) bubble to top, then by updatedAt desc.
    out.sort((a, b) => {
        if (a.topRank !== b.topRank)
            return b.topRank - a.topRank;
        return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });
    return { conversations: out, nextCursor: cursor };
}
function parsePeer(targetStr) {
    if (!targetStr)
        return null;
    try {
        const t = JSON.parse(targetStr);
        if (!t.id)
            return null;
        return { nick: t.dnick ?? t.id, id: t.id };
    }
    catch {
        return null;
    }
}
function msEpochToIso(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0)
        return null;
    return new Date(ms).toISOString();
}
async function loadMorePages(page, frames, args) {
    const imFrame = page
        .frames()
        .find((f) => /def_cbu_web_im_core/.test(f.url()));
    if (!imFrame)
        return;
    let pages = 1; // page 1 already loaded by initial wait
    while (pages < MAX_PAGES) {
        // Count UNIQUE conversations parsed so far. Stop if caller's limit is
        // already satisfied (post-filter for --unread).
        const bodies = findLwpResponses(frames, LWP_LIST);
        const { conversations } = parseConversations(bodies, args.myMemberId);
        const visible = args.unreadOnly
            ? conversations.filter((c) => c.unread > 0)
            : conversations;
        if (visible.length >= args.limit)
            return;
        // Stop if server says no more pages (hasMore=0 OR nextCursor=0).
        const lastBody = bodies.at(-1);
        if (lastBody && lastBody.hasMore === 0)
            return;
        if (lastBody && (lastBody.nextCursor ?? 0) === 0)
            return;
        const beforeCount = bodies.length;
        await scrollImSidebar(page, imFrame, pages);
        const arrived = await waitForFrameCountIncrease(frames, LWP_LIST, beforeCount, 6000);
        if (!arrived)
            return; // no more pages OR IM stopped responding
        pages++;
        // Cool-down before the next scroll — the IM SDK rate-limits
        // back-to-back lazy-loads beyond a few pages.
        await sleep(400);
    }
}
/**
 * Trigger the IM client's lazy-load. Headed and headless behave subtly
 * differently for repeated scrolls: a single strategy (e.g. only mouse.wheel,
 * or only JS scrollTop overshoot) works the first time then gets debounced
 * by the React virtualizer. Combining both in each round — JS overshoot to
 * push past the visible window, then mouse.wheel for a real input event —
 * reliably fires the next-page LWP request across head/headless modes.
 *
 * The IM iframe layout: [sidebar (~280px) | chat panel]. We aim at x+150,
 * y+250 — comfortably inside the sidebar conv list.
 */
async function scrollImSidebar(page, imFrame, attempt) {
    // Rotate strategies per attempt — the IM SDK throttles identical-shape
    // triggers. Probing showed it accepts JS scrollTop overshoot, real
    // mouse.wheel, and synthetic scroll-event dispatch each as independent
    // channels. Rotating across them defeats the throttle and unlocks
    // pages 5+ where a single repeated strategy stalls.
    const strategy = attempt % 3;
    if (strategy === 0) {
        await imFrame.evaluate(() => {
            for (const el of document.querySelectorAll('*')) {
                const sh = el.scrollHeight;
                const ch = el.clientHeight;
                if (sh > ch + 20)
                    el.scrollTop = sh + 1000;
            }
        });
        return;
    }
    if (strategy === 1) {
        const handle = await imFrame.frameElement().catch(() => null);
        const box = handle ? await handle.boundingBox().catch(() => null) : null;
        if (!box)
            return;
        // Vary position + delta each call so the SDK doesn't see "same wheel".
        await page.mouse.move(box.x + 150, box.y + 200 + (attempt % 4) * 50);
        await page.mouse.wheel(0, 1200 + (attempt % 5) * 300);
        return;
    }
    // Synthetic scroll event — moves scrollTop and fires the React-bound
    // scroll handler that virtual-list libraries (react-window/react-virtualized)
    // listen to.
    await imFrame.evaluate(() => {
        for (const el of document.querySelectorAll('*')) {
            const sh = el.scrollHeight;
            const ch = el.clientHeight;
            if (sh > ch + 20) {
                el.scrollTop = sh;
                el.dispatchEvent(new Event('scroll', { bubbles: true }));
            }
        }
    });
}
async function waitForFrameCountIncrease(frames, method, baseline, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const count = findLwpResponses(frames, method).length;
        if (count > baseline)
            return true;
        await sleep(200);
    }
    return false;
}
export async function execute(ctx, args) {
    return withRecovery(ctx, { cmd: 'inbox', args }, () => executeRaw(ctx, args), { headed: args.headed === true, maxRetries: 1 });
}
export async function executeRaw(ctx, args) {
    const page = await ctx.newPage();
    const frames = collectWsFrames(page);
    try {
        const url = `${IM_BASE}?fromid=cnalichn${encodeURIComponent(args.myLoginId)}`;
        info('Opening 旺旺 IM (inbox mode)...');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (/login\.1688\.com|login\.taobao\.com/.test(page.url())) {
            throw new CliError(3, 'NOT_LOGGED_IN', 'Session expired. Run `1688 login`.');
        }
        // Wait for IM iframe to mount (input visible = WS handshake done +
        // initial inbox fetch in-flight).
        await findImInput(page);
        // The IM client auto-fires listNewestPagination on load. Wait for it.
        const got = await waitForLwpResponse(frames, LWP_LIST, 12000);
        if (got) {
            // Tiny grace window in case of a re-fetch.
            await sleep(400);
        }
        else {
            // No response yet — give DOM/WS a bit more time.
            await sleep(2000);
        }
        // Auto-paginate when caller wants more than what page 1 returned.
        // The IM client lazy-loads on scroll; we trigger the same path by
        // scrolling all scrollable containers in the IM iframe. Each scroll
        // round produces one more listNewestPagination response (or none, if
        // we've hit the end).
        if (args.limit > 20) {
            await loadMorePages(page, frames, args);
        }
        dumpWsFramesForProbe(frames);
        const listBodies = findLwpResponses(frames, LWP_LIST);
        const topBodies = findLwpResponses(frames, LWP_LIST_TOP);
        const allBodies = [...topBodies, ...listBodies];
        if (allBodies.length === 0) {
            throw new CliError(24, 'IM_INBOX_EMPTY', 'IM inbox response not captured. Try --headed to debug.', { category: 'capture', currentUrl: page.url(), retryable: true });
        }
        const lastBody = listBodies.at(-1);
        const hasMoreFromServer = lastBody?.hasMore === 1 || (lastBody?.nextCursor ?? 0) > 0;
        const { conversations, nextCursor } = parseConversations(allBodies, args.myMemberId);
        let filtered = conversations;
        if (args.unreadOnly)
            filtered = filtered.filter((c) => c.unread > 0);
        const truncated = filtered.length > args.limit ||
            (filtered.length <= args.limit && hasMoreFromServer);
        if (filtered.length > args.limit)
            filtered = filtered.slice(0, args.limit);
        return {
            myLoginId: args.myLoginId,
            myMemberId: args.myMemberId,
            conversations: filtered,
            nextCursor,
            truncated,
        };
    }
    finally {
        await page.close().catch(() => { });
    }
}
export async function run(opts) {
    const limit = Math.min(200, Math.max(1, parseInt(opts.limit ?? '20', 10)));
    const state = await readState(opts.profile);
    if (!state.nick || !state.memberId) {
        throw new CliError(3, 'NOT_LOGGED_IN', 'Cannot determine your loginId/memberId. Run `1688 whoami` first.');
    }
    const data = await dispatch('inbox', {
        limit,
        unreadOnly: !!opts.unread,
        myLoginId: state.nick,
        myMemberId: state.memberId,
        headed: opts.headed,
    }, { headed: opts.headed, profile: opts.profile });
    emit({
        human: () => {
            process.stdout.write(`Inbox (${data.conversations.length}${data.truncated ? '+' : ''}):\n`);
            if (data.conversations.length === 0) {
                process.stdout.write('  (empty)\n');
                return;
            }
            for (const c of data.conversations) {
                const unread = c.unread > 0 ? `[${c.unread}]` : '   ';
                const pin = c.topRank > 0 ? '📌' : '  ';
                const time = c.updatedAt ? c.updatedAt.slice(11, 16) : '--:--';
                const me = c.lastMessage.fromMe ? '(我)' : '';
                process.stdout.write(`  ${pin} ${unread} ${time}  ${c.peer.nick.padEnd(20).slice(0, 20)}  ${me}${c.lastMessage.preview.slice(0, 50)}\n`);
                process.stdout.write(`         cid: ${c.cid}\n`);
            }
            if (data.nextCursor) {
                process.stdout.write(`\n(more available — pagination not yet implemented)\n`);
            }
        },
        data: { ok: true, data },
    });
}
//# sourceMappingURL=inbox.js.map
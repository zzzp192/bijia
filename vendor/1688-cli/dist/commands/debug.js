import path from 'node:path';
import fs from 'node:fs/promises';
import { emit } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { runsDir } from '../session/paths.js';
import { readAllEvents, readRecentEventSummaries, summarizeEvents, } from '../session/events.js';
export async function list(opts) {
    const limit = parseLimit(opts.limit ?? '20');
    let summaries = await readRecentEventSummaries(Math.max(limit * 3, limit));
    if (opts.failed)
        summaries = summaries.filter((s) => s.status === 'error');
    summaries = summaries.slice(-limit);
    emit({
        human: () => printSummaryList(summaries),
        data: { total: summaries.length, requests: summaries },
    });
}
export async function last(opts) {
    let summaries = summarizeEvents(await readAllEvents());
    if (opts.failed)
        summaries = summaries.filter((s) => s.status === 'error');
    const summary = summaries.at(-1) ?? null;
    emit({
        human: () => {
            if (!summary) {
                process.stdout.write('No debug events found.\n');
                return;
            }
            printSummary(summary);
        },
        data: { request: summary },
    });
}
export async function show(opts) {
    const summaries = summarizeEvents(await readAllEvents());
    const summary = summaries.find((s) => s.requestId === opts.requestId);
    if (!summary) {
        throw new CliError(2, 'NOT_FOUND', `No debug events found for ${opts.requestId}.`);
    }
    const artifactDir = summary.artifactDir ?? path.join(runsDir(), opts.requestId);
    const artifactExists = await exists(artifactDir);
    emit({
        human: () => {
            printSummary(summary);
            process.stdout.write(`artifactDir: ${artifactExists ? artifactDir : '(none)'}\n`);
            if (summary.events.length > 0) {
                process.stdout.write('events:\n');
                for (const event of summary.events) {
                    process.stdout.write(`- ${event.ts} ${event.phase} ${event.status}\n`);
                }
            }
        },
        data: {
            request: summary,
            artifactDir: artifactExists ? artifactDir : null,
            artifactExists,
        },
    });
}
export function parseLimit(raw) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1)
        return 20;
    return Math.min(n, 200);
}
function printSummaryList(summaries) {
    if (summaries.length === 0) {
        process.stdout.write('No debug events found.\n');
        return;
    }
    for (const summary of summaries) {
        const status = summary.status === 'error' ? `error:${summary.errorCode ?? 'UNKNOWN'}` : summary.status;
        const duration = summary.durationMs === undefined ? '' : ` ${summary.durationMs}ms`;
        process.stdout.write(`${summary.requestId} ${summary.cmd} ${status}${duration}\n`);
    }
}
function printSummary(summary) {
    process.stdout.write(`requestId: ${summary.requestId}\n`);
    process.stdout.write(`cmd: ${summary.cmd}\n`);
    process.stdout.write(`status: ${summary.status}\n`);
    if (summary.errorCode)
        process.stdout.write(`errorCode: ${summary.errorCode}\n`);
    if (summary.durationMs !== undefined)
        process.stdout.write(`durationMs: ${summary.durationMs}\n`);
    if (summary.pageState)
        process.stdout.write(`pageState: ${summary.pageState}\n`);
    if (summary.verification)
        process.stdout.write(`verification: ${summary.verification.state}\n`);
    if (summary.artifactDir)
        process.stdout.write(`artifactDir: ${summary.artifactDir}\n`);
}
async function exists(target) {
    try {
        await fs.access(target);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=debug.js.map
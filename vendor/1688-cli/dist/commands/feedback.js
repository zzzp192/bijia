// Submit feedback / report a bug. By default prepares a pre-filled GitHub
// issue URL and (on a TTY) opens the user's browser. With `--submit`,
// posts the issue directly via the `gh` CLI when it is installed and
// authenticated — no manual "Submit new issue" click needed.
//
// Diagnostic info is **anonymized**: version, Node version, OS, platform,
// optional last error from daemon.log. Nothing about the user's 1688
// account is included.
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs/promises';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { daemonLogFile } from '../session/paths.js';
import pkg from '../../package.json' with { type: 'json' };
const REPO = 'superjack2050/1688-cli';
const ISSUES_NEW_URL = `https://github.com/${REPO}/issues/new`;
async function readLastDaemonError() {
    try {
        const txt = await fs.readFile(daemonLogFile(), 'utf8');
        const lines = txt.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const l = lines[i] ?? '';
            if (/unexpected:|Error:|EACCES|ENOENT|EOTP/.test(l)) {
                return l.slice(0, 400);
            }
        }
        return null;
    }
    catch {
        return null;
    }
}
// Strip leading/trailing smart quotes (macOS "smart quotes" auto-replace
// dumb `"` with `“ ”` and the shell then treats them as literal chars,
// often leaving stray quote marks at the ends of the message).
function stripSmartQuotes(s) {
    return s.replace(/^[“”"'\s]+|[“”"'\s]+$/g, '');
}
export async function run(opts) {
    const raw = (opts.message ?? '').trim();
    const msg = stripSmartQuotes(raw).trim();
    if (msg.length < 5) {
        throw new CliError(2, 'BAD_INPUT', 'Feedback message is too short or empty. Provide at least 5 characters describing what you want to report.\n' +
            'Examples:\n' +
            "  1688 feedback 'Codex 调用 1688 login 后看不到二维码'\n" +
            "  1688 feedback --bug 'cart-add fails on multi-SKU offer'\n" +
            '\n' +
            "Tip: on macOS, prefer single quotes (' …') over double quotes to avoid smart-quote replacement.");
    }
    const lastErr = await readLastDaemonError();
    const isBug = !!opts.bug;
    const title = (isBug ? '[bug] ' : '[feedback] ') + msg.slice(0, 80);
    const body = [
        isBug ? '### Bug report' : '### Feedback',
        '',
        msg,
        '',
        '### Environment',
        `- 1688-cli: ${pkg.version}`,
        `- Node: ${process.version}`,
        `- OS: ${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`,
        lastErr
            ? `\n### Last daemon error (auto-attached)\n\`\`\`\n${lastErr}\n\`\`\``
            : '',
        '',
        '_(submitted via `1688 feedback`)_',
    ]
        .filter(Boolean)
        .join('\n');
    const url = ISSUES_NEW_URL +
        '?title=' +
        encodeURIComponent(title) +
        '&body=' +
        encodeURIComponent(body);
    // --submit: post directly via gh CLI.
    if (opts.submit) {
        const submitted = await submitViaGh({ title, body, isBug });
        emit({
            human: () => {
                process.stdout.write(`Issue submitted via gh.\n`);
                process.stdout.write(`  title: ${title}\n`);
                process.stdout.write(`  url:   ${submitted.url}\n`);
            },
            data: {
                url: submitted.url,
                title,
                bodyPreview: body.slice(0, 200),
                submitted: true,
            },
        });
        return;
    }
    // Default: prepare URL + (on TTY) open browser.
    const shouldOpen = opts.open !== false && process.stdout.isTTY;
    if (shouldOpen) {
        info('Opening GitHub issue page in your browser...');
        openInBrowser(url);
    }
    emit({
        human: () => {
            process.stdout.write(`Feedback prepared.\n`);
            process.stdout.write(`  title: ${title}\n`);
            process.stdout.write(`  url:   ${url}\n`);
            if (!shouldOpen) {
                process.stdout.write(`\nOpen the URL above in a browser and click "Submit new issue" to send.\n` +
                    `Or, if you have the GitHub CLI installed and authenticated, re-run with --submit.\n`);
            }
            else {
                process.stdout.write(`\nTip: if you have the GitHub CLI installed and authenticated, ` +
                    `add --submit to post directly without opening a browser.\n`);
            }
        },
        data: {
            url,
            title,
            bodyPreview: body.slice(0, 200),
            submitted: false,
        },
    });
}
async function submitViaGh(input) {
    // 1. gh installed?
    try {
        await runCapture('gh', ['--version'], 2000);
    }
    catch {
        throw new CliError(6, 'GH_NOT_INSTALLED', 'The GitHub CLI (`gh`) is not installed.\n' +
            '  macOS:    brew install gh\n' +
            '  Windows:  winget install --id GitHub.cli\n' +
            '  Linux:    https://github.com/cli/cli#installation\n' +
            '\n' +
            'Then run `gh auth login` once. Or omit --submit to use the browser flow.');
    }
    // 2. gh authenticated?
    try {
        await runCapture('gh', ['auth', 'status'], 3000);
    }
    catch (e) {
        throw new CliError(3, 'GH_NOT_AUTHED', 'The GitHub CLI is installed but not authenticated. Run:\n' +
            '  gh auth login\n' +
            '\n' +
            'Or omit --submit to use the browser flow.\n' +
            `(gh auth status returned: ${e.message})`);
    }
    // 3. create the issue
    const args = [
        'issue',
        'create',
        '--repo',
        REPO,
        '--title',
        input.title,
        '--body',
        input.body,
    ];
    if (input.isBug) {
        args.push('--label', 'bug');
    }
    try {
        const out = await runCapture('gh', args, 30_000);
        // gh prints the issue URL as the last non-empty line on success.
        const url = out
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .pop();
        if (!url || !/^https?:\/\//.test(url)) {
            throw new Error(`gh did not return an issue URL. Output:\n${out}`);
        }
        return { url };
    }
    catch (e) {
        throw new CliError(9, 'GH_SUBMIT_FAILED', `gh issue create failed: ${e.message}`);
    }
}
function runCapture(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on('data', (b) => {
            out += b.toString('utf8');
        });
        child.stderr.on('data', (b) => {
            err += b.toString('utf8');
        });
        child.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0)
                resolve(out);
            else
                reject(new Error(`${cmd} exited ${code}: ${err || out}`));
        });
    });
}
function openInBrowser(url) {
    const platform = process.platform;
    let cmd;
    let args;
    if (platform === 'darwin') {
        cmd = 'open';
        args = [url];
    }
    else if (platform === 'win32') {
        cmd = 'cmd';
        args = ['/c', 'start', '""', url];
    }
    else {
        cmd = 'xdg-open';
        args = [url];
    }
    try {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.unref();
    }
    catch {
        /* Best-effort. URL is still shown in stdout. */
    }
}
//# sourceMappingURL=feedback.js.map
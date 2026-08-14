import { withSession } from '../session/context.js';
import { parseIdentity } from '../auth/cookies.js';
import { clearState } from '../session/state.js';
import { emit, info, isJson } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { confirm } from '../io/prompt.js';
import { defaultProfileName } from '../session/paths.js';
const LOGOUT_URL = 'https://login.1688.com/member/logout.htm';
export async function run(opts) {
    const profile = defaultProfileName(opts.profile);
    const pre = await withSession({ headless: true, profile }, async (ctx) => parseIdentity(await ctx.cookies()));
    if (!pre) {
        await clearState(profile);
        emit({
            human: () => info('Not logged in.'),
            data: { ok: true, wasLoggedIn: false },
        });
        return;
    }
    if (!opts.yes) {
        if (isJson() || !process.stdin.isTTY) {
            throw new CliError(2, 'CONFIRM_REQUIRED', 'Pass --yes to confirm logout in non-interactive mode.');
        }
        const name = pre.nick ?? pre.memberId;
        const ok = await confirm(`Logout ${name} (memberId: ${pre.memberId})?`);
        if (!ok) {
            info('Canceled.');
            throw new CliError(130, 'CANCELED', '');
        }
    }
    await withSession({ headless: true, profile }, async (ctx) => {
        const page = await ctx.newPage();
        try {
            await page.goto(LOGOUT_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 15000,
            });
        }
        catch {
            /* ignore — proceed to local cookie wipe */
        }
        try {
            await ctx.clearCookies({ domain: /\.1688\.com$/ });
        }
        catch {
            /* ignore */
        }
        try {
            await ctx.clearCookies({ domain: /\.taobao\.com$/ });
        }
        catch {
            /* ignore */
        }
    });
    await clearState(profile);
    emit({
        human: () => process.stdout.write('Logged out.\n'),
        data: { ok: true, wasLoggedIn: true },
    });
}
//# sourceMappingURL=logout.js.map
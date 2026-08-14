import { dispatch } from '../session/dispatch.js';
import { parseIdentity } from '../auth/cookies.js';
import { verifyOnline } from '../auth/verify.js';
import { readState, writeState } from '../session/state.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { nowIso, relative } from '../util/time.js';
import { defaultProfileName } from '../session/paths.js';
export async function execute(ctx, args) {
    const cookies = await ctx.cookies();
    const id = parseIdentity(cookies);
    if (!id)
        return { loggedIn: false };
    if (args.verify) {
        const ok = await verifyOnline(ctx);
        if (!ok)
            return { loggedIn: false };
    }
    const profile = defaultProfileName(args.profile);
    const state = await readState(profile);
    const lastVerifiedAt = args.verify ? nowIso() : state.lastVerifiedAt;
    await writeState({
        ...state,
        memberId: id.memberId,
        nick: id.nick ?? undefined,
        lastVerifiedAt,
    }, profile);
    return {
        loggedIn: true,
        memberId: id.memberId,
        nick: id.nick,
        lastVerifiedAt: lastVerifiedAt ?? null,
    };
}
export async function run(opts) {
    const profile = defaultProfileName(opts.profile);
    const data = await dispatch('whoami', { verify: opts.verify, profile }, { profile });
    if (!data.loggedIn) {
        emit({
            human: () => info('Not logged in. Run `1688 login` to sign in.'),
            data: { loggedIn: false },
        });
        throw new CliError(3, 'NOT_LOGGED_IN', '');
    }
    emit({
        human: () => {
            const name = data.nick ?? data.memberId;
            const tail = data.lastVerifiedAt
                ? ` (verified ${relative(data.lastVerifiedAt)})`
                : '';
            process.stdout.write(`${name} (memberId: ${data.memberId})${tail}\n`);
        },
        data,
    });
}
//# sourceMappingURL=whoami.js.map
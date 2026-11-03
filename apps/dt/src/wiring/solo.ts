// `dt open` (ADR 0030, decision 2; plan modes, "As built in M5"): a session in the Solo mode has one person, on
// loopback, the facilitator without a join form or a facilitator link to claim. The person is bound to a secret only
// the user who launched `dt open` holds: the server prints a one-time link (`/session/open?code=…`, a facilitator
// link's code: single use, `SOLO_LINK_TTL_MS`); opening it signs that browser in as the Solo identity with the dev
// mode's cookie (`dt_session`: HttpOnly, SameSite=Strict, kept in the session's database, so it survives restarts).
// A request without that cookie is not identified (401, or a page saying to open the printed link): another local
// process or OS user on the machine is not the facilitator. The session must still be Solo: once `dt collab` has
// continued it, nothing is identified here any more (fail closed). Their name is git's `user.name`, else the OS user's.
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { userInfo } from 'node:os';
import {
    Collaboration,
    err,
    FACILITATOR_NAME,
    FACILITATOR_PARTICIPANT,
    type Identity,
    type IdentityKey,
    participantOf,
    secretHash,
    type SessionAccess,
    type SignIn,
} from '@domaintrail/collaboration';
import { DEV_COOKIE, devSecret, type Identified, type SessionIdentities } from '../server/session/identities.js';
import type { SessionHandler, SessionSurface } from '../server/http/server.js';

/** The identity of the one person of a Solo session. */
export const SOLO_IDENTITY: IdentityKey = { provider: 'dev', subject: 'solo' };

/** How long the link `dt open` prints signs a browser in. */
export const SOLO_LINK_TTL_MS = 60 * 60_000;

/** The page of the link `dt open` prints. */
export const SOLO_LINK_PATH = '/session/open';

/** How long the sign-in cookie of the Solo person is kept by the browser. */
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

const isSolo = (signIn: SignIn): boolean => signIn.identity.provider === SOLO_IDENTITY.provider && signIn.identity.subject === SOLO_IDENTITY.subject;

export interface SoloIdentitiesDeps {
    readonly session: Collaboration.SessionId;
    readonly access: SessionAccess;
    /** The identities of the dev mode, closed with these. */
    readonly base: SessionIdentities;
    readonly name: Collaboration.DisplayName;
    /** Whether the session is still open and Solo (asked on every identification). */
    readonly isOpenSolo: () => Promise<boolean>;
}

/**
 * The identities of a Solo session: a request is its one person, the facilitator, when it carries the cookie the
 * printed link set and the session is still open and Solo; otherwise no one. Signing in with a name and claiming the
 * role are refused (no one else joins a Solo session).
 */
export function soloIdentities(deps: SoloIdentitiesDeps): SessionIdentities {
    const { session, access, base, isOpenSolo } = deps;
    const identity: Identity = { ...SOLO_IDENTITY, displayName: deps.name };
    const who: Identified = {
        participant: { id: FACILITATOR_PARTICIPANT, identity },
        role: 'facilitator',
        actor: { kind: 'participant', participant: FACILITATOR_PARTICIPANT, role: 'Facilitator', identity: SOLO_IDENTITY },
    };
    /** The Solo sign-ins seen, by their secret's hash. */
    const known = new Set<string>();
    let closed = false;
    return {
        mode: base.mode,
        async identify(headers) {
            if (closed || !(await isOpenSolo())) return undefined;
            const secret = devSecret(headers);
            if (!secret) return undefined;
            const hash = secretHash(secret);
            if (known.has(hash)) return who;
            const signIn = await access.signedIn(secret);
            if (!signIn || signIn.session !== session || !isSolo(signIn)) return undefined;
            known.add(hash);
            return who;
        },
        signIn: async () => err({ type: 'SoloSession' }),
        async signOut(headers) {
            const secret = devSecret(headers);
            if (!secret) return undefined;
            known.delete(secretHash(secret));
            return (await access.signOut(secret)) ? SOLO_IDENTITY : undefined;
        },
        claimFacilitator: async () => err({ type: 'LinkInvalid' }),
        facilitatorParticipant: async () => (closed ? undefined : participantOf(SOLO_IDENTITY)),
        closeAll: async () => {
            closed = true;
            known.clear();
            return base.closeAll();
        },
    };
}

/** A one-time link that signs a browser in as the Solo person: what `dt open` prints. */
export async function issueSoloLink(access: SessionAccess, session: Collaboration.SessionId, url: string): Promise<string> {
    const link = await access.issueFacilitatorLink({ session, ttlMs: SOLO_LINK_TTL_MS });
    if (!link.ok) throw new Error('The session is not open');
    return `${url}${SOLO_LINK_PATH.slice(1)}?code=${link.value.code}`;
}

const sendText = (res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(`${text}\n`);
};

const NOT_SIGNED_IN = 'This is `dt open`: open the link it printed in its terminal to sign this browser in (or restart it for a new one).';

/**
 * The session's surface in the Solo mode: the dev mode's, but a page without the cookie gets a page saying to open the
 * printed link (no join form), and `SOLO_LINK_PATH` takes that link's code: used once, it sets the cookie and goes to
 * the Live View. The other `/session/…` pages (the join form, the facilitator link) answer the same as an unknown one.
 */
export function soloSurface(
    surface: SessionSurface,
    deps: {
        readonly session: Collaboration.SessionId;
        readonly access: SessionAccess;
        readonly name: Collaboration.DisplayName;
        readonly secureCookie: boolean;
    },
): SessionSurface {
    const pages: SessionHandler = async (req, url, res) => {
        if (url.pathname !== SOLO_LINK_PATH) return sendText(res, 404, 'Not found');
        if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed');
        const code = url.searchParams.get('code') ?? '';
        const claimed = code ? await deps.access.claimFacilitator({ session: deps.session, code, identity: SOLO_IDENTITY }) : undefined;
        if (!claimed?.ok) return sendText(res, 403, 'This link was used already or has expired. Restart `dt open` for a new one.');
        const secret = await deps.access.signIn({ session: deps.session, identity: { ...SOLO_IDENTITY, displayName: deps.name } });
        const cookie = [
            `${DEV_COOKIE}=${secret}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Strict',
            `Max-Age=${COOKIE_MAX_AGE}`,
            ...(deps.secureCookie ? ['Secure'] : []),
        ];
        res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'set-cookie': cookie.join('; ') });
        res.end();
    };
    return {
        ...surface,
        pages,
        signIn: (_req: IncomingMessage, _url: URL, res: ServerResponse) => sendText(res, 401, NOT_SIGNED_IN),
    };
}

/** git's `user.name` in `root`, if set (git may be missing). */
function gitUserName(root: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        execFile('git', ['config', 'user.name'], { cwd: root, timeout: 2_000, windowsHide: true }, (error, stdout) =>
            resolve(error ? undefined : stdout.trim() || undefined),
        );
    });
}

/** The OS user's name, if it can be read. */
function osUserName(): string | undefined {
    try {
        return userInfo().username || undefined;
    } catch {
        return undefined;
    }
}

/** The name of the person of a Solo session: git's `user.name` in `root`, else the OS user's, else `Facilitator`. */
export async function soloName(root: string): Promise<Collaboration.DisplayName> {
    for (const raw of [await gitUserName(root), osUserName()]) {
        const name = raw === undefined ? undefined : Collaboration.makeDisplayName(raw.slice(0, 200));
        if (name?.ok) return name.value;
    }
    return FACILITATOR_NAME;
}

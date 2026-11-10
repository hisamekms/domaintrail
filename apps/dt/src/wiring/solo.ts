// `dt open` (ADR 0030, decision 2; plan modes, "As built in M5"): a session in the Solo mode has one person, on
// loopback, the facilitator without a join form or a facilitator link to claim. The person is bound to secrets only the
// user who launched this `dt open` holds, kept in this server's memory and nowhere else: it prints a one-time link
// (`/session/open?code=…`, `SOLO_LINK_TTL_MS`), accepted only there (it is not a facilitator link: the database never
// sees it). `dt open link` issues another while the server runs: the same single use and lifetime, written by that
// command (as a hash, in a domain of its own: never a facilitator link nor an agent code) to the session's database,
// where this server redeems it, and revoked with the rest when it stops. Opening a link sets a cookie whose name is chosen when the server starts (`dt_open_<random>`), HttpOnly,
// SameSite=Strict, without Max-Age (gone with the browser session), and whose value this server instance alone knows.
// A request without it is not identified (401, a page saying to open the printed link): another local process or OS
// user is not the facilitator, and the cookie (sent by the browser to every port of the host) is worth nothing to
// another server, nor to this one once it stops or restarts. Everything is revoked when the server stops or the
// session is no longer open and Solo (`dt collab` continuing it): identification fails closed. Their name is git's
// `user.name`, else the OS user's.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
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
} from '@domaintrail/collaboration';
import { cookies, type Identified, type SessionIdentities } from '../server/session/identities.js';
import type { SessionHandler, SessionSurface } from '../server/http/server.js';

/** The identity of the one person of a Solo session. */
export const SOLO_IDENTITY: IdentityKey = { provider: 'dev', subject: 'solo' };

/** How long the link `dt open` prints signs a browser in. */
export const SOLO_LINK_TTL_MS = 60 * 60_000;

/** The page of the link `dt open` prints. */
export const SOLO_LINK_PATH = '/session/open';

const secret = (): string => randomBytes(32).toString('base64url');

/** The sign-in of a `dt open` server: its one-time link, its cookie's name, the browsers signed in; in memory only. */
export interface SoloSignIn {
    /** The cookie's name, chosen when the server started. */
    readonly cookieName: string;
    /** The one-time link below `url` (the server's address). */
    link(url: string): string;
    /**
     * Uses a link's `code` (the printed link's, or one `dt open link` issued): once, before it expires; a new browser
     * secret for the cookie, or undefined.
     */
    redeem(code: string): Promise<string | undefined>;
    /** Whether `headers` carry the cookie of a browser signed in here. */
    signedIn(headers: IncomingHttpHeaders): boolean;
    /** Forgets the link and every browser signed in. */
    revoke(): void;
}

export function createSoloSignIn(
    options: {
        ttlMs?: number;
        now?: () => number;
        /** Uses a code `dt open link` issued (single use, unexpired, of this session): whether it was valid. */
        redeemIssued?: (code: string) => Promise<boolean>;
    } = {},
): SoloSignIn {
    const now = options.now ?? Date.now;
    const cookieName = `dt_open_${randomBytes(6).toString('hex')}`;
    let code: string | undefined = secret();
    const expiresAt = now() + (options.ttlMs ?? SOLO_LINK_TTL_MS);
    const browsers = new Set<string>();
    let revoked = false;
    const signedInBrowser = (): string => {
        const browser = secret();
        browsers.add(secretHash(browser));
        return browser;
    };
    return {
        cookieName,
        link: (url) => `${url}${SOLO_LINK_PATH.slice(1)}?code=${code ?? ''}`,
        async redeem(given) {
            if (revoked || !given) return undefined;
            if (code !== undefined && now() <= expiresAt && secretHash(given) === secretHash(code)) {
                code = undefined;
                return signedInBrowser();
            }
            if (!options.redeemIssued || !(await options.redeemIssued(given)) || revoked) return undefined;
            return signedInBrowser();
        },
        signedIn(headers) {
            const value = cookies(headers).get(cookieName);
            return value !== undefined && browsers.has(secretHash(value));
        },
        revoke() {
            revoked = true;
            code = undefined;
            browsers.clear();
        },
    };
}

export interface SoloIdentitiesDeps {
    readonly signIn: SoloSignIn;
    /** The identities of the dev mode, closed with these. */
    readonly base: SessionIdentities;
    readonly name: Collaboration.DisplayName;
    /** Whether the session is still open and Solo (asked on every identification). */
    readonly isOpenSolo: () => Promise<boolean>;
}

/**
 * The identities of a Solo session: a request is its one person, the facilitator, when it carries the cookie of the
 * printed link and the session is still open and Solo; otherwise no one (and once it is not, everything is revoked).
 * Signing in with a name and claiming the role are refused (no one else joins a Solo session).
 */
export function soloIdentities(deps: SoloIdentitiesDeps): SessionIdentities {
    const { signIn, base, isOpenSolo } = deps;
    const identity: Identity = { ...SOLO_IDENTITY, displayName: deps.name };
    const who: Identified = {
        participant: { id: FACILITATOR_PARTICIPANT, identity },
        role: 'facilitator',
        actor: { kind: 'participant', participant: FACILITATOR_PARTICIPANT, role: 'Facilitator', identity: SOLO_IDENTITY },
    };
    let closed = false;
    return {
        mode: base.mode,
        cookieName: signIn.cookieName,
        async identify(headers) {
            if (closed) return undefined;
            if (!(await isOpenSolo())) {
                signIn.revoke();
                return undefined;
            }
            return signIn.signedIn(headers) ? who : undefined;
        },
        signIn: async () => err({ type: 'Collaboration.SoloSession' }),
        signInFacilitator: async () => err({ type: 'Collaboration.SoloSession' }),
        remove: async () => err({ type: 'NotRemovable' }),
        signOut: async () => undefined,
        claimFacilitator: async () => err({ type: 'LinkInvalid' }),
        facilitatorParticipant: async () => (closed ? undefined : participantOf(SOLO_IDENTITY)),
        closeAll: async () => {
            closed = true;
            signIn.revoke();
            return base.closeAll();
        },
    };
}

const sendText = (res: ServerResponse, status: number, text: string): void => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`${text}\n`);
};

const NOT_SIGNED_IN = 'This is `dt open`: open the link it printed in its terminal to sign this browser in (`dt open link` prints a new one).';

/**
 * The session's surface in the Solo mode: the dev mode's, but a page without the cookie gets a page saying to open the
 * printed link (no join form), and `SOLO_LINK_PATH` takes that link's code: used once, it sets the cookie and goes to
 * the Live View. The other `/session/…` pages (the join form, the facilitator link) are not found.
 */
export function soloSurface(surface: SessionSurface, signIn: SoloSignIn): SessionSurface {
    const pages: SessionHandler = async (req, url, res) => {
        if (url.pathname !== SOLO_LINK_PATH) return sendText(res, 404, 'Not found');
        if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed');
        const browser = await signIn.redeem(url.searchParams.get('code') ?? '');
        if (!browser) return sendText(res, 403, 'This link was used already or has expired. `dt open link` prints a new one.');
        // a session cookie (no Max-Age): it ends with the browser session, and the server forgets it when it stops
        const cookie = `${signIn.cookieName}=${browser}; Path=/; HttpOnly; SameSite=Strict`;
        res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'set-cookie': cookie });
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

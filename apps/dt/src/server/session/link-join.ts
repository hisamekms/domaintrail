// Joining a session of the `link` identity mode (dt collab --tunnel, or `collab.link.publicUrl`): the facilitator
// makes a shared invite link (multi-use, `INVITE_TTL_MS`, one live at a time: a new one or 「招待を止める」 stops the
// previous); whoever opens it gives a name and so makes a join request, then waits on a page that reloads itself; the
// facilitator approves or denies each request in their page; once approved, the visitor's next look at the waiting page
// signs them in (the session cookie, HttpOnly, Secure, SameSite=Strict) and goes to the Live View. The invite's code is
// a secret: only its hash is stored, it is never logged, and it leaves the URL bar after the form (a POST, then a
// redirect). The waiting page knows its request by a cookie of its own (HttpOnly, Secure, SameSite=Strict), never by a
// URL. Requests are limited (pending at once, in all per invite, per client key: `clientKey`, which reads
// `CF-Connecting-IP` only from the quick tunnel this process started), and expire after 10 minutes or with the invite. The facilitator also removes a participant here: their
// sign-ins are revoked and their pages closed.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    type Collaboration,
    type IdentityKey,
    type JoinRequest,
    type JoinRequestNotFound,
    type JoinRequests,
    type Result,
    type SessionAccess,
    type SessionNotOpen,
} from '@domaintrail/collaboration';
import type { InviteBody, InviteStateBody, JoinRequestBody } from '@domaintrail/collaboration/protocol';
import { clientKey } from '../http/access.js';
import { BodyError, mediaType, readText } from '../http/json.js';
import type { NotRemovable, SessionIdentities } from './identities.js';
import { cookies } from './identities.js';
import { displayName } from './input.js';
import { invitePage, messagePage, nameCookie, pageLanguage, rememberedName, waitingPage } from './pages.js';

/** How long an invite link works. */
export const INVITE_TTL_MS = 60 * 60_000;
/** The page an invite link opens, and where its form is posted. */
export const INVITE_PATH = '/session/invite';
/** The page a join request waits on. */
export const WAIT_PATH = '/session/wait';
/** Largest invite form. */
const MAX_FORM = 2048;
/** An invite's code: what `SecretGenerator` makes (base64url of 32 bytes); anything else is not looked up. */
const CODE = /^[A-Za-z0-9_-]{43}$/;

/**
 * What the facilitator's pages are told of the joining: the pending requests (each marked when its name is another
 * pending request's or a participant's), the live invite, and whether it took as many requests as it may.
 */
export interface JoinSnapshot {
    readonly requests: readonly JoinRequestBody[];
    readonly invite: InviteStateBody | null;
    readonly inviteUsedUp: boolean;
}

/** A name as two names are compared for being the same person's: NFKC, case and spaces folded. */
const sameNameKey = (name: string): string => name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export interface LinkJoinDeps {
    readonly session: Collaboration.SessionId;
    readonly access: SessionAccess;
    readonly identities: SessionIdentities;
    readonly requests: JoinRequests;
    /** The public origin the links are made with (`https://…`), as known now (a tunnel's is known once it is up). */
    readonly publicUrl: () => string;
    /** The names of the session's participants now: a request of the same name is marked. */
    readonly participantNames: () => Promise<readonly string[]>;
    /** The cookie of the waiting page (a name chosen when the server starts). */
    readonly waitCookie: string;
    /** The pending requests or the invite changed: the facilitator's pages are told (`snapshot`). */
    readonly changed: () => void;
    /** A participant was removed: their pages are closed. */
    readonly disconnect: (identity: IdentityKey, reason: string) => void;
    /** A participant signed in: what the pages are sent (after the use case appended to the outbox). */
    readonly pump: () => Promise<void>;
    readonly log: (line: string) => void;
    readonly inviteTtlMs?: number;
    /** Whether `CF-Connecting-IP` names the client: only behind the quick tunnel this process started (`--tunnel`). */
    readonly trustForwarded?: boolean;
}

export interface LinkJoin {
    /** A new invite link (the previous one stops working, its pending requests expire). */
    issueInvite(): Promise<Result<InviteBody, SessionNotOpen>>;
    /** Stops the invite: whether one was live (its requests pending or approved but not yet in expire). */
    revokeInvite(): Promise<boolean>;
    snapshot(): Promise<JoinSnapshot>;
    approve(id: string): Result<JoinRequest, JoinRequestNotFound>;
    deny(id: string): Result<JoinRequest, JoinRequestNotFound>;
    /** Revokes a participant's sign-ins and closes their pages. */
    remove(participant: string): Promise<Result<IdentityKey, NotRemovable>>;
    /** Answers `INVITE_PATH` and `WAIT_PATH`; false for any other path. */
    page(req: IncomingMessage, url: URL, res: ServerResponse, signedIn: boolean): Promise<boolean>;
    /**
     * Drops what expired; the facilitator's pages are told when the pending requests changed, or when the invite changed
     * from elsewhere (`dt collab invite`: the requests made through the previous one expire).
     */
    sweep(): Promise<void>;
}

/** A cookie of the `link` mode: HttpOnly, Secure, SameSite=Strict, for the whole host; `value` undefined removes it. */
export function linkCookie(name: string, value: string | undefined, maxAgeS?: number): string {
    const parts = [`${name}=${value ?? ''}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict'];
    if (value === undefined) parts.push('Max-Age=0');
    else if (maxAgeS !== undefined) parts.push(`Max-Age=${maxAgeS}`);
    return parts.join('; ');
}

const requestBody = (r: JoinRequest, duplicate: boolean): JoinRequestBody => ({
    id: r.id,
    name: r.name,
    requestedAt: r.requestedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    ...(duplicate && { duplicate }),
});

function redirect(res: ServerResponse, location: string, cookie: readonly string[]): void {
    res.writeHead(303, { location, 'cache-control': 'no-store', ...(cookie.length > 0 && { 'set-cookie': [...cookie] }) });
    res.end();
}

export function createLinkJoin(deps: LinkJoinDeps): LinkJoin {
    const { session, access, identities, requests, waitCookie } = deps;
    const ttlMs = deps.inviteTtlMs ?? INVITE_TTL_MS;
    const inviteLink = (code: string): string => `${deps.publicUrl()}${INVITE_PATH}?code=${code}`;
    /** Removes the waiting page's cookie, only from a browser that sent one (nothing to say to anyone else). */
    const clearWait = (req: IncomingMessage): string[] => (cookies(req.headers).has(waitCookie) ? [linkCookie(waitCookie, undefined)] : []);

    const invitePost = async (req: IncomingMessage, res: ServerResponse, language: ReturnType<typeof pageLanguage>): Promise<void> => {
        if (mediaType(req) !== 'application/x-www-form-urlencoded') return messagePage(res, language, 415, 'formMediaType');
        let form: URLSearchParams;
        try {
            form = new URLSearchParams(await readText(req, MAX_FORM));
        } catch (e) {
            if (e instanceof BodyError) return messagePage(res, language, e.status, 'formTooLarge');
            throw e;
        }
        const code = form.get('code') ?? '';
        const inviteExpiresAt = CODE.test(code) ? await access.checkInvite({ session, code }) : undefined;
        if (!inviteExpiresAt) return messagePage(res, language, 410, 'inviteNotValid');
        const remembered = { name: rememberedName(req.headers) };
        const name = displayName(form.get('name') ?? '');
        if (!name.ok) return invitePage(res, language, 400, code, { ...remembered, error: 'invalidName' });
        const made = requests.request({
            name: name.value,
            key: clientKey(req.socket.remoteAddress, req.headers, deps.trustForwarded ?? false),
            inviteExpiresAt,
        });
        if (!made.ok) {
            const tooMany = made.error.type === 'TooManyPending';
            if (made.error.type === 'InviteExhausted') {
                deps.log('join requests: the invite took as many as it may; make another');
                deps.changed();
            }
            return invitePage(res, language, 429, code, { ...remembered, error: tooMany ? 'tooManyPending' : 'rateLimited' });
        }
        deps.log('join request: waiting for the facilitator');
        deps.changed();
        const maxAgeS = Math.ceil((inviteExpiresAt.getTime() - Date.now()) / 1000);
        redirect(res, WAIT_PATH, [linkCookie(waitCookie, made.value.secret, Math.max(1, maxAgeS)), nameCookie(name.value, true)]);
    };

    const waitPage = async (req: IncomingMessage, res: ServerResponse, language: ReturnType<typeof pageLanguage>): Promise<void> => {
        const secret = cookies(req.headers).get(waitCookie) ?? '';
        const status = CODE.test(secret) ? requests.status(secret) : { state: 'expired' as const };
        const done = clearWait(req);
        const ended = (status: number, message: 'denied' | 'requestExpired' | 'sessionFull' | 'sessionClosed'): void => {
            if (done.length) res.setHeader('set-cookie', done);
            messagePage(res, language, status, message);
        };
        if (status.state === 'pending') return waitingPage(res, language, status.request.name);
        if (status.state === 'denied') return ended(403, 'denied');
        if (status.state === 'expired') return ended(410, 'requestExpired');
        const admitted = requests.admit(secret);
        if (!admitted) return ended(410, 'requestExpired');
        const signedIn = await identities.signIn(admitted.name);
        if (!signedIn.ok) return ended(409, signedIn.error.type === 'SessionFull' ? 'sessionFull' : 'sessionClosed');
        await deps.pump();
        deps.log(`joined: ${signedIn.value.identified.participant.id}`);
        // a session cookie (no Max-Age): it ends with the browser session, and every sign-in ends with the session
        redirect(res, '/', [linkCookie(identities.cookieName, signedIn.value.secret), ...done]);
    };

    /** The live invite's expiry as last seen: another one means the invite changed. */
    let seen: number | undefined;
    /** The invite changed: the requests made through the previous one expire (when it stopped, the approved ones too). */
    const expire = async (stopped: boolean): Promise<void> => {
        if (stopped) requests.expireAll();
        else requests.expirePending();
        seen = (await access.liveInvite(session))?.getTime();
        deps.changed();
    };

    return {
        async issueInvite() {
            const issued = await access.issueInvite({ session, ttlMs });
            if (!issued.ok) return issued;
            await expire(false);
            deps.log(`invite link made (expires ${issued.value.expiresAt.toISOString()})`);
            return { ok: true, value: { link: inviteLink(issued.value.code), expiresAt: issued.value.expiresAt.toISOString() } };
        },

        async revokeInvite() {
            const revoked = await access.revokeInvite(session);
            await expire(true);
            if (revoked) deps.log('invite link stopped');
            return revoked;
        },

        async snapshot() {
            const [expiresAt, participants] = await Promise.all([access.liveInvite(session), deps.participantNames()]);
            const pending = requests.pending();
            const counts = new Map<string, number>();
            for (const name of [...participants, ...pending.map((r) => r.name)]) counts.set(sameNameKey(name), (counts.get(sameNameKey(name)) ?? 0) + 1);
            return {
                requests: pending.map((r) => requestBody(r, (counts.get(sameNameKey(r.name)) ?? 0) > 1)),
                invite: expiresAt ? { expiresAt: expiresAt.toISOString() } : null,
                inviteUsedUp: expiresAt !== undefined && requests.exhausted(),
            };
        },

        approve(id) {
            const decided = requests.approve(id);
            if (decided.ok) {
                deps.log('join request approved');
                deps.changed();
            }
            return decided;
        },

        deny(id) {
            const decided = requests.deny(id);
            if (decided.ok) {
                deps.log('join request denied');
                deps.changed();
            }
            return decided;
        },

        async remove(participant) {
            const removed = await identities.remove(participant);
            if (removed.ok) {
                deps.disconnect(removed.value, 'removed');
                deps.log(`removed: ${participant}`);
            }
            return removed;
        },

        async page(req, url, res, signedIn) {
            if (url.pathname !== INVITE_PATH && url.pathname !== WAIT_PATH) return false;
            const language = pageLanguage(req.headers['accept-language']);
            const reading = req.method === 'GET' || req.method === 'HEAD';
            if (signedIn) redirect(res, '/', clearWait(req));
            else if (url.pathname === WAIT_PATH) await (reading ? waitPage(req, res, language) : messagePage(res, language, 405, 'linkMethod'));
            else if (req.method === 'POST') await invitePost(req, res, language);
            else if (!reading) messagePage(res, language, 405, 'formMethod');
            else {
                const code = url.searchParams.get('code') ?? '';
                if (CODE.test(code) && (await access.checkInvite({ session, code })))
                    invitePage(res, language, 200, code, { name: rememberedName(req.headers) });
                else messagePage(res, language, 410, 'inviteNotValid');
            }
            return true;
        },

        async sweep() {
            const live = (await access.liveInvite(session))?.getTime();
            // another invite (`dt collab invite`), or none any more (`--stop`, or it expired)
            if (live !== seen) return expire(live === undefined);
            if (requests.sweep()) deps.changed();
        },
    };
}

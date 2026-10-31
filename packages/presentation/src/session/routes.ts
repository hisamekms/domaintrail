// The browser's side of a session (ADR 0026, S4): the REST API under `/api/session/`, the pages under `/session/` (the
// join form, the facilitator link) and the sign-in answer for a page without an identity. Every input is checked at
// the boundary (`input.ts`); every error is typed JSON (`{ "error": { "type": … } }`). Participants read, send
// requests and dismiss their own; only the facilitator queues and cancels runs, takes, confirms and restores
// revisions, dismisses others' requests and closes the session.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IdentityKey } from '@domaintrail/collaboration/application/identity';
import type { CollaborationUseCases, SessionState } from '@domaintrail/collaboration/application/use-cases';
import type { Collaboration } from '@domaintrail/collaboration/generated/index';
import type { Me, SessionStateBody } from '@domaintrail/collaboration/protocol';
import type { AccessPolicy, Authorization } from '../http/access.js';
import { BodyError, mediaType, readJson, readText, sendError, sendJson } from '../http/json.js';
import type { SessionSurface } from '../http/server.js';
import { DEV_COOKIE, type Identified, type SessionIdentities } from './identities.js';
import { body, displayName, MAX_NOTE, MAX_REQUEST_TEXT, requestIds, targetSnapshot, text, uuid, type InvalidInput } from './input.js';
import { joinPage, messagePage, safeNext } from './pages.js';
import { publicParticipant } from './presence.js';

/** Largest body of a session API request (a request's text is at most 10,000 characters). */
export const MAX_SESSION_BODY = 64 * 1024;
/** Largest join form. */
const MAX_FORM = 2048;
/** Cloudflare Access's logout path, on the session's public host: where a page goes after leaving an `access` session. */
export const ACCESS_LOGOUT = '/cdn-cgi/access/logout';
/** How long the `dev` cookie lives in the browser (the sign-in is revoked when the session closes). */
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

export interface SessionHttpDeps {
    readonly session: Collaboration.SessionId;
    readonly collaboration: CollaborationUseCases;
    readonly identities: SessionIdentities;
    /** The Host and Origin rules of the session. */
    readonly hostPolicy: Pick<AccessPolicy, 'allowedHost' | 'allowedOrigin'>;
    /** Sends what the outbox got to the pages and the agent; called after every change. */
    readonly pump: () => Promise<void>;
    /** The outbox position the pages were sent up to (the `seq` of a state). */
    readonly cursor: () => number;
    /**
     * Runs `work`, a write of the sources (a restore), with the workspace watcher's refresh and publish held; when
     * `wrote(result)`, every page gets the written sources in one refresh and publish on resume.
     */
    readonly holdWatcher: <T>(work: () => Promise<T>, wrote: (result: T) => boolean) => Promise<T>;
    /** An identity's sign-in ended or its role changed: its pages are disconnected (they reconnect as what they are now). */
    readonly disconnect: (identity: IdentityKey, reason: string) => void;
    /** The facilitator closed the session (after the use case): revoke, disconnect, stop. */
    readonly closed: () => Promise<void>;
    /** The cookie is `Secure` (the session is served over https). */
    readonly secureCookie: boolean;
    readonly log: (line: string) => void;
}

type Participant = Extract<Authorization, { kind: 'participant' }>;
type Admitted = Exclude<Authorization, { kind: 'forbidden' }>;

/** The HTTP status of an error type of the use cases (and of this layer). */
export function statusOf(type: string): number {
    switch (type) {
        case 'InvalidInput':
        case 'InvalidTarget':
        case 'NoRequests':
        case 'UnknownRevision':
            return 400;
        case 'Unauthenticated':
            return 401;
        case 'Forbidden':
        case 'FacilitatorOnly':
        case 'NotYourRequest':
        case 'NotAParticipant':
            return 403;
        case 'NotFound':
        case 'SessionNotFound':
        case 'RequestNotFound':
        case 'RevisionNotFound':
        case 'RevisionOfAnotherSession':
            return 404;
        case 'BlobMissing':
        case 'ManualRecoveryNeeded':
            return 500;
        default:
            // the state does not allow it now: closed session, dismissed request, run in progress, lost lease, …
            return 409;
    }
}

const fail = <E extends { readonly type: string; readonly message?: string }>(res: ServerResponse, error: E): void =>
    sendError(res, statusOf(error.type), error.type, error.message, error);

const bodyError = (res: ServerResponse, e: unknown): void => {
    if (e instanceof BodyError) return sendError(res, e.status, e.type, e.message);
    throw e;
};

export function meOf(session: Collaboration.SessionId, who: Identified): Me {
    return {
        session,
        participant: publicParticipant(who),
        identity: { provider: who.participant.identity.provider, displayName: who.participant.identity.displayName },
    };
}

export function stateBody(state: SessionState, seq: number): SessionStateBody {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the aggregates become their JSON when encoded (dates as ISO strings)
    return { ...state, seq } as unknown as SessionStateBody;
}

/** The cookie that signs a browser in (dev), or out (`secret` undefined). */
function devCookie(secret: string | undefined, secure: boolean): string {
    const parts = [`${DEV_COOKIE}=${secret ?? ''}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', secret ? `Max-Age=${COOKIE_MAX_AGE}` : 'Max-Age=0'];
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

interface Route {
    readonly method: 'GET' | 'POST';
    readonly path: RegExp;
    /** Who may call it: anyone admitted (sign-in), any participant, or the facilitator only. */
    readonly role: 'anyone' | 'participant' | 'facilitator';
    readonly handle: (ctx: { req: IncomingMessage; res: ServerResponse; auth: Admitted; params: string[] }) => Promise<void>;
}

/** The participant of a route that needs one (checked before the route is called). */
const who = (auth: Admitted): Participant => {
    if (auth.kind !== 'participant') throw new Error('A participant route without a participant');
    return auth;
};

export function createSessionHttp(deps: SessionHttpDeps): SessionSurface {
    const { session, collaboration: use, identities } = deps;

    const state = async (): Promise<SessionState> => {
        const s = await use.sessionState({ session });
        if (!s.ok) throw new Error(`The session ${session} is gone`);
        return s.value;
    };

    /** Reads the JSON body as an object with only `keys`; answered already (and undefined) when it is not one. */
    const input = async (req: IncomingMessage, res: ServerResponse, keys: readonly string[]): Promise<Record<string, unknown> | undefined> => {
        let raw: unknown;
        try {
            raw = await readJson(req, MAX_SESSION_BODY);
        } catch (e) {
            bodyError(res, e);
            return undefined;
        }
        const b = body(raw, keys);
        if (b.ok) return b.value;
        fail(res, b.error);
        return undefined;
    };

    const checked = <T>(res: ServerResponse, r: { ok: true; value: T } | { ok: false; error: InvalidInput }): T | undefined => {
        if (r.ok) return r.value;
        fail(res, r.error);
        return undefined;
    };

    /** Answers a use case's result: `status` and `answer(value)` on success, the typed error otherwise. */
    const answer = async <T>(
        res: ServerResponse,
        result: { ok: true; value: T } | { ok: false; error: { readonly type: string } },
        status: number,
        body: (value: T) => unknown,
    ): Promise<void> => {
        if (!result.ok) return fail(res, result.error);
        await deps.pump();
        sendJson(res, status, body(result.value));
    };

    const signIn = async (
        name: Collaboration.DisplayName,
    ): Promise<{ ok: true; secret: string; identified: Identified } | { ok: false; error: { readonly type: string } }> => {
        const r = await identities.signIn(name);
        if (!r.ok) return r;
        await deps.pump();
        deps.log(`joined: ${r.value.identified.participant.id}`);
        return { ok: true, ...r.value };
    };

    const routes: Route[] = [
        {
            method: 'GET',
            path: /^\/api\/session\/me$/,
            role: 'participant',
            handle: async ({ res, auth }) => sendJson(res, 200, meOf(session, who(auth))),
        },
        {
            method: 'POST',
            path: /^\/api\/session\/join$/,
            role: 'anyone',
            handle: async ({ req, res, auth }) => {
                if (identities.mode !== 'dev') return sendError(res, 404, 'NotFound', 'Participants of this session sign in through Cloudflare Access.');
                const raw = await input(req, res, ['name']);
                if (!raw) return;
                const name = checked(res, displayName(raw.name));
                if (!name) return;
                if (auth.kind === 'participant') return sendJson(res, 200, meOf(session, auth));
                const r = await signIn(name);
                if (!r.ok) return fail(res, r.error);
                sendJson(res, 201, meOf(session, r.identified), { 'set-cookie': devCookie(r.secret, deps.secureCookie) });
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/leave$/,
            role: 'participant',
            handle: async ({ req, res, auth }) => {
                if (identities.mode !== 'dev') {
                    // the sign-in is Cloudflare's: this identity's pages close, and the page goes on to Access's logout
                    deps.disconnect(who(auth).participant.identity, 'signed out');
                    return sendJson(res, 200, { left: true, logout: ACCESS_LOGOUT });
                }
                const left = await identities.signOut(req.headers);
                if (left) deps.disconnect(left, 'signed out');
                sendJson(res, 200, { left: left !== undefined }, { 'set-cookie': devCookie(undefined, deps.secureCookie) });
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/facilitator\/claim$/,
            role: 'participant',
            handle: async ({ req, res, auth }) => {
                const raw = await input(req, res, ['code']);
                if (!raw) return;
                if (typeof raw.code !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(raw.code))
                    return fail(res, { type: 'InvalidInput', field: 'code', message: 'Expected a link code.' });
                const me = who(auth);
                const claimed = await identities.claimFacilitator(raw.code, me.participant.identity);
                if (!claimed.ok) return fail(res, claimed.error);
                if (claimed.value.previous) deps.disconnect(claimed.value.previous, 'facilitator changed');
                deps.disconnect(me.participant.identity, 'facilitator changed');
                deps.log('facilitator claimed');
                const now = await identities.identify(req.headers);
                sendJson(res, 200, now ? meOf(session, now) : meOf(session, me));
            },
        },
        {
            method: 'GET',
            path: /^\/api\/session\/state$/,
            role: 'participant',
            handle: async ({ res }) => {
                const seq = deps.cursor();
                sendJson(res, 200, stateBody(await state(), seq));
            },
        },
        {
            method: 'GET',
            path: /^\/api\/session\/requests$/,
            role: 'participant',
            handle: async ({ res }) => sendJson(res, 200, { requests: (await state()).requests }),
        },
        {
            method: 'POST',
            path: /^\/api\/session\/requests$/,
            role: 'participant',
            handle: async ({ req, res, auth }) => {
                const raw = await input(req, res, ['target', 'body']);
                if (!raw) return;
                const target = checked(res, targetSnapshot(raw.target));
                if (!target) return;
                const t = checked(res, text(raw.body, 'body', MAX_REQUEST_TEXT));
                if (!t) return;
                if (!(await state()).revisions.some((r) => r.id === target.sourceRevision))
                    return fail(res, { type: 'UnknownRevision', field: 'target.sourceRevision', message: 'Not a revision of this session.' });
                const sent = await use.sendRequest({ session, author: who(auth).participant.id, target, body: t });
                await answer(res, sent, 201, (request) => ({ request }));
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/requests\/([^/]+)\/dismiss$/,
            role: 'participant',
            handle: async ({ res, auth, params }) => {
                const id = checked(res, uuid(params[0], 'id'));
                if (!id) return;
                const request = (await state()).requests.find((r) => r.id === id);
                if (!request) return fail(res, { type: 'NotFound', aggregate: 'Request', id });
                const me = who(auth);
                if (me.role !== 'facilitator' && request.author !== me.participant.id)
                    return fail(res, { type: 'NotYourRequest', message: "Only the facilitator dismisses others' requests." });
                await answer(res, await use.dismissRequest({ request: request.id, by: me.participant.id }), 200, (r) => ({ request: r }));
            },
        },
        {
            method: 'GET',
            path: /^\/api\/session\/runs$/,
            role: 'participant',
            handle: async ({ res }) => sendJson(res, 200, { runs: (await state()).runs }),
        },
        {
            method: 'POST',
            path: /^\/api\/session\/runs$/,
            role: 'facilitator',
            handle: async ({ req, res, auth }) => {
                const raw = await input(req, res, ['requests', 'note']);
                if (!raw) return;
                const ids = checked(res, requestIds(raw.requests));
                if (!ids) return;
                let note: Collaboration.Text | undefined;
                if (raw.note !== undefined) {
                    note = checked(res, text(raw.note, 'note', MAX_NOTE));
                    if (!note) return;
                }
                const queued = await use.queueRun({ session, requests: ids, queuedBy: who(auth).participant.id, ...(note && { note }) });
                await answer(res, queued, 201, (run) => ({ run }));
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/runs\/([^/]+)\/cancel$/,
            role: 'facilitator',
            handle: async ({ res, auth, params }) => {
                const id = checked(res, uuid(params[0], 'id'));
                if (!id) return;
                const run = (await state()).runs.find((r) => r.id === id);
                if (!run) return fail(res, { type: 'NotFound', aggregate: 'AgentRun', id });
                await answer(res, await use.cancelRun({ run: run.id, by: who(auth).participant.id }), 200, (r) => ({ run: r }));
            },
        },
        {
            method: 'GET',
            path: /^\/api\/session\/revisions$/,
            role: 'participant',
            handle: async ({ res }) => sendJson(res, 200, { revisions: (await state()).revisions }),
        },
        {
            method: 'POST',
            path: /^\/api\/session\/revisions$/,
            role: 'facilitator',
            handle: async ({ req, res, auth }) => {
                if (!(await input(req, res, []))) return;
                await answer(res, await use.takeRevision({ session, by: who(auth).participant.id }), 201, (revision) => ({ revision }));
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/revisions\/([^/]+)\/confirm$/,
            role: 'facilitator',
            handle: async ({ res, auth, params }) => {
                const id = checked(res, uuid(params[0], 'id'));
                if (!id) return;
                const revision = (await state()).revisions.find((r) => r.id === id);
                if (!revision) return fail(res, { type: 'NotFound', aggregate: 'Revision', id });
                await answer(res, await use.confirmRevision({ revision: revision.id, by: who(auth).participant.id }), 200, (r) => ({ revision: r }));
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/revisions\/([^/]+)\/restore$/,
            role: 'facilitator',
            handle: async ({ req, res, auth, params }) => {
                const id = checked(res, uuid(params[0], 'id'));
                if (!id) return;
                const raw = await input(req, res, ['recordExternalChanges']);
                if (!raw) return;
                if (raw.recordExternalChanges !== undefined && typeof raw.recordExternalChanges !== 'boolean')
                    return fail(res, { type: 'InvalidInput', field: 'recordExternalChanges', message: 'Expected true or false.' });
                const revision = (await state()).revisions.find((r) => r.id === id);
                if (!revision) return fail(res, { type: 'NotFound', aggregate: 'Revision', id });
                const me = who(auth);
                const restored = await deps.holdWatcher(
                    () =>
                        use.restoreRevision({
                            session,
                            revision: revision.id,
                            by: me.participant.id,
                            identity: me.participant.identity,
                            recordExternalChanges: raw.recordExternalChanges === true,
                        }),
                    (r) => r.ok || r.error.type === 'ManualRecoveryNeeded',
                );
                if (restored.ok) deps.log(`restored revision ${revision.id} (by ${me.participant.id})`);
                else if (restored.error.type === 'ManualRecoveryNeeded')
                    deps.log(
                        `restore of revision ${revision.id} failed after writing (${restored.error.cause}): manual recovery needed, the workspace before is revision ${restored.error.preRestore}`,
                    );
                else deps.log(`restore of revision ${revision.id} refused: ${restored.error.type}`);
                // the revisions recorded on the way (the external changes, the pre-restore) reach the pages either way
                await deps.pump();
                await answer(res, restored, 200, (r) => r);
            },
        },
        {
            method: 'GET',
            path: /^\/api\/session\/revisions\/([^/]+)\/compare\/([^/]+)$/,
            role: 'participant',
            handle: async ({ res, params }) => {
                const before = checked(res, uuid(params[0], 'before'));
                if (!before) return;
                const after = checked(res, uuid(params[1], 'after'));
                if (!after) return;
                const revisions = (await state()).revisions;
                const a = revisions.find((r) => r.id === before);
                if (!a) return fail(res, { type: 'NotFound', aggregate: 'Revision', id: before });
                const b = revisions.find((r) => r.id === after);
                if (!b) return fail(res, { type: 'NotFound', aggregate: 'Revision', id: after });
                const compared = await use.compareRevisions({ session, before: a.id, after: b.id });
                if (!compared.ok) return fail(res, compared.error);
                sendJson(res, 200, compared.value);
            },
        },
        {
            method: 'GET',
            path: /^\/api\/session\/targets$/,
            role: 'participant',
            handle: async ({ res }) => {
                const t = await use.targetStatuses({ session });
                if (!t.ok) return fail(res, t.error);
                sendJson(res, 200, { contentHash: t.value.contentHash, statuses: Object.fromEntries(t.value.statuses) });
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/close$/,
            role: 'facilitator',
            handle: async ({ req, res }) => {
                if (!(await input(req, res, []))) return;
                const closed = await use.closeSession({ session });
                if (!closed.ok) return fail(res, closed.error);
                await deps.pump();
                sendJson(res, 200, { session: closed.value });
                await deps.closed();
            },
        },
    ];

    const api: SessionSurface['api'] = async (req, url, res, auth) => {
        const matching = routes.filter((r) => r.path.test(url.pathname));
        const route = matching.find((r) => r.method === req.method);
        // without an identity only the sign-in is answered: nothing else, not even what exists
        if (route?.role !== 'anyone' && auth.kind !== 'participant') return sendError(res, 401, 'Unauthenticated', 'Sign in to the session first.');
        if (!matching.length) return sendError(res, 404, 'NotFound', 'No such session API.');
        if (!route) return sendError(res, 405, 'MethodNotAllowed', `Use ${matching.map((r) => r.method).join(' or ')}.`);
        if (route.role === 'facilitator' && (auth.kind !== 'participant' || auth.role !== 'facilitator'))
            return sendError(res, 403, 'FacilitatorOnly', 'Only the facilitator may do this.');
        const params = route.path.exec(url.pathname)?.slice(1) ?? [];
        await route.handle({ req, res, auth, params });
    };

    const signInAnswer: SessionSurface['signIn'] = (req, url, res) => {
        if (identities.mode === 'dev') return joinPage(res, 401, `${url.pathname}${url.search}`);
        messagePage(res, 401, 'Sign in required', 'Open this session through its Cloudflare Access URL to sign in.');
    };

    const pages: SessionSurface['pages'] = async (req, url, res, auth) => {
        if (url.pathname === '/session/join') {
            if (identities.mode !== 'dev') return messagePage(res, 404, 'Not found', 'Participants of this session sign in through Cloudflare Access.');
            if (req.method === 'GET' || req.method === 'HEAD') {
                if (auth.kind === 'participant') return redirect(res, safeNext(url.searchParams.get('next')));
                return joinPage(res, 200, safeNext(url.searchParams.get('next')));
            }
            if (req.method !== 'POST') return messagePage(res, 405, 'Method not allowed', 'Use the form.');
            if (mediaType(req) !== 'application/x-www-form-urlencoded') return messagePage(res, 415, 'Unsupported form', 'Use the form.');
            let form: URLSearchParams;
            try {
                form = new URLSearchParams(await readText(req, MAX_FORM));
            } catch (e) {
                if (e instanceof BodyError) return messagePage(res, e.status, 'Form too large', e.message);
                throw e;
            }
            const next = safeNext(form.get('next'));
            if (auth.kind === 'participant') return redirect(res, next);
            const name = displayName(form.get('name') ?? '');
            if (!name.ok) return joinPage(res, 400, next, name.error.message);
            const r = await signIn(name.value);
            if (!r.ok) return joinPage(res, statusOf(r.error.type), next, r.error.type === 'SessionFull' ? 'The session is full.' : 'The session is not open.');
            return redirect(res, next, devCookie(r.secret, deps.secureCookie));
        }
        if (url.pathname === '/session/facilitator') {
            if (req.method !== 'GET' && req.method !== 'HEAD') return messagePage(res, 405, 'Method not allowed', 'Open the link.');
            const code = url.searchParams.get('code') ?? '';
            if (!/^[A-Za-z0-9_-]{16,128}$/.test(code)) return messagePage(res, 400, 'Not a facilitator link', 'The link is incomplete.');
            if (auth.kind !== 'participant') return signInAnswer(req, url, res);
            // opening the link while signed in claims it: the code is the secret, single use and short-lived
            const claimed = await identities.claimFacilitator(code, auth.participant.identity);
            if (!claimed.ok)
                return messagePage(res, 409, 'Link not valid', 'This facilitator link was used already or has expired. Ask for a new one (dt session link).');
            if (claimed.value.previous) deps.disconnect(claimed.value.previous, 'facilitator changed');
            deps.disconnect(auth.participant.identity, 'facilitator changed');
            deps.log('facilitator claimed');
            return redirect(res, '/');
        }
        messagePage(res, 404, 'Not found', 'No such page.');
    };

    return { policy: { ...deps.hostPolicy, identify: (headers) => identities.identify(headers) }, api, pages, signIn: signInAnswer };
}

function redirect(res: ServerResponse, location: string, cookie?: string): void {
    res.writeHead(303, { location, 'cache-control': 'no-store', ...(cookie && { 'set-cookie': cookie }) });
    res.end();
}

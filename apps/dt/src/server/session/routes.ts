// The browser's side of a session (ADR 0026, S4): the REST API under `/api/session/`, the pages under `/session/` (the
// join form, the facilitator link) and the sign-in answer for a page without an identity. Every input is checked at
// the boundary (`input.ts`); every error is typed JSON (`{ "error": { "type": … } }`). Participants read, send
// messages (addressed to the AI by a mention of it or a reply to it, ADR 0030), react to messages and AI turns, vote on
// a question's options or an assumption's choices and withdraw their change proposals; only the facilitator addresses
// any message to the AI (「AI に送る」), approves and rejects proposals, queues, cancels and reverts runs, takes and
// restores revisions, hands the role over and closes the session. A participant sees the triages' outcomes only, the
// facilitator their record (`views.ts`). Who
// may do what is the collaboration's (ADR 0027): each use case takes the `Actor` of the identity and its commands
// refuse what the role does not allow; the role of each route below is a hint that answers first, with the same
// status and body as the refusal of the domain.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    type AnswerData,
    Collaboration,
    type CollaborationUseCases,
    type IdentityKey,
    knownAgentRunId,
    knownChangeProposalId,
    knownInterviewId,
    knownRequestId,
    INTERVIEW_COMMANDS,
    readBriefText,
    type PickData,
    PROPOSAL_LIMITS,
    readProposalText,
    type SessionState,
} from '@domaintrail/collaboration';
import type { AgentPresence, Me, MessageTemplateBody, ModelChangesBody, Role, SessionStateBody } from '@domaintrail/collaboration/protocol';
import type { AccessPolicy, Authorization } from '../http/access.js';
import { BodyError, mediaType, readJson, readText, sendError, sendJson } from '../http/json.js';
import type { SessionSurface } from '../http/server.js';
import { DEV_COOKIE, type Identified, type SessionIdentities } from './identities.js';
import {
    answer as answerInput,
    assumptionRef,
    body,
    pick as pickInput,
    displayName,
    markSign,
    markTarget,
    MAX_NOTE,
    MAX_REQUEST_TEXT,
    MAX_RUN_REQUESTS,
    requestIds,
    mentionIds,
    modelTarget,
    replyTarget,
    requestTargets,
    text,
    uuid,
    type InvalidInput,
} from './input.js';
import { joinPage, messagePage, nameCookie, pageLanguage, rememberedName, safeNext } from './pages.js';
import { publicParticipant } from './presence.js';
import { stateFor, triageFor } from './views.js';

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
    /** Lets the server take the reverts at the head of the queue (`RevertQueue.kick`); resolves when it is done. */
    readonly reverts: () => Promise<void>;
    /** An identity's sign-in ended or its role changed: its pages are disconnected (they reconnect as what they are now). */
    readonly disconnect: (identity: IdentityKey, reason: string) => void;
    /** Another identity holds the facilitator's role: every page still connected gets the session's state again. */
    readonly facilitatorChanged: () => void;
    /** The facilitator closed the session (after the use case): revoke, disconnect, stop. */
    readonly closed: () => Promise<void>;
    /** Another one-time facilitator link (`POST /api/session/facilitator/link`). */
    readonly issueFacilitatorLink: () => Promise<{ readonly link: string; readonly expiresAt: string }>;
    /** The cookie is `Secure` (the session is served over https). */
    readonly secureCookie: boolean;
    /** The emoji the add-reaction popover offers first (`session.quickReactions`), sent with the state. */
    readonly quickReactions: readonly string[];
    /** The team's message templates (`templates`), sent with the state. */
    readonly templates?: readonly MessageTemplateBody[];
    /** Messages were addressed to the AI: the server's stage of their triage (Clef) takes them. */
    readonly triaged: () => void;
    /** The agents connected per role and the work waiting for one, sent with the state. */
    readonly agentPresence: () => Promise<AgentPresence>;
    /** The facilitator retries the AI's given-up answer or proposal for a message: whether one was given up. */
    readonly retryAnswer: (request: Collaboration.RequestId) => Promise<boolean>;
    readonly log: (line: string) => void;
}

type Participant = Extract<Authorization, { kind: 'participant' }>;
type Admitted = Exclude<Authorization, { kind: 'forbidden' }>;

/** The HTTP status of an error type of the use cases (and of this layer). */
export function statusOf(type: string): number {
    switch (type) {
        case 'InvalidInput':
        case 'InvalidTarget':
        case 'TooManyTargets':
        case 'DuplicateTarget':
        case 'WorkspaceTarget':
        case 'TooManyMentions':
        case 'DuplicateMention':
        case 'MentionedNotAParticipant':
        case 'NoRequests':
        case 'UnknownRevision':
        case 'InvalidReply':
        case 'InvalidAnswer':
        case 'AlternativeNotFound':
        case 'AssumptionNotFound':
        case 'PickMismatch':
        case 'MarkNotForTarget':
        case 'InvalidTriageStep':
        case 'InvalidTriageInput':
        case 'AnswerTooLong':
        case 'InvalidProposal':
        case 'NoSuchOption':
            return 400;
        case 'NotTheInterviewer':
            return 403;
        case 'InterviewAlreadyRunning':
        case 'InterviewMovedOn':
            return 409;
        case 'Unauthenticated':
            return 401;
        case 'Forbidden':
        case 'FacilitatorOnly':
        case 'NotYourRequest':
        case 'NotAParticipant':
        case 'FacilitatorDoesNotVote':
        case 'NotTheRequester':
            return 403;
        case 'NotFound':
        case 'SessionNotFound':
        case 'RequestNotFound':
        case 'RevisionNotFound':
        case 'RevisionOfAnotherSession':
        case 'MarkTargetNotFound':
        case 'RunNotFound':
        case 'RunOfAnotherSession':
        case 'TriageNotFound':
        case 'TriageOfAnotherSession':
            return 404;
        case 'BlobMissing':
        case 'ManualRecoveryNeeded':
            return 500;
        default:
            // the state does not allow it now: closed session, dismissed request, run in progress, lost lease, …
            return 409;
    }
}

/** What a participant gets for an operation reserved to the facilitator: from a route's role, or from a command. */
const FACILITATOR_ONLY = 'Only the facilitator may do this.';

/** The message of an error that has none of its own: the domain's refusals read as the routes' always did. */
const defaultMessage = (type: string): string | undefined => (type === 'FacilitatorOnly' ? FACILITATOR_ONLY : undefined);

/** The status and the body of an error of the use cases (and of this layer). */
export function errorAnswer(error: { readonly type: string; readonly message?: string }): { status: number; body: { error: object } } {
    const message = error.message ?? defaultMessage(error.type);
    return { status: statusOf(error.type), body: { error: { ...error, type: error.type, ...(message !== undefined && { message }) } } };
}

const fail = <E extends { readonly type: string; readonly message?: string }>(res: ServerResponse, error: E): void => {
    const { status, body } = errorAnswer(error);
    sendJson(res, status, body);
};

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

/**
 * The state for a page of `role`: the session's aggregates at `seq` (a participant gets the triages' outcomes only), the
 * quick reactions, the agents connected and the work waiting, and the participant holding the facilitator's role, if any.
 */
export function stateBody(
    state: SessionState,
    seq: number,
    quickReactions: readonly string[],
    facilitatorHolder: Collaboration.ParticipantId | undefined,
    role: Role,
    agent?: AgentPresence,
    templates: readonly MessageTemplateBody[] = [],
): SessionStateBody {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the aggregates become their JSON when encoded (dates as ISO strings)
    const body = {
        ...state,
        seq,
        quickReactions,
        ...(templates.length > 0 && { templates }),
        ...(agent && { agent }),
        ...(facilitatorHolder && { facilitatorHolder }),
    } as unknown as SessionStateBody;
    return stateFor(role, body);
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

/** A change proposal's how as the facilitator edits it (`PROPOSAL_LIMITS.editedHow`). */
function editedHowInput(raw: unknown, field: string): { ok: true; value: Collaboration.ProposalText } | { ok: false; error: InvalidInput } {
    const read = readProposalText(raw, field, PROPOSAL_LIMITS.editedHow);
    return read.ok ? read : { ok: false, error: { type: 'InvalidInput', field: read.error.path, message: read.error.message } };
}

/** A proposal's option as the facilitator chose it: its index (whether the proposal has it is the use case's). */
function optionInput(raw: unknown, field: string): { ok: true; value: Collaboration.ProposalOptionIndex } | { ok: false; error: InvalidInput } {
    const made = typeof raw === 'number' ? Collaboration.makeProposalOptionIndex(raw) : undefined;
    return made?.ok ? made : { ok: false, error: { type: 'InvalidInput', field, message: 'Expected an option index (0 to 2).' } };
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

    /** Whether the proposal is one of this session's (answered with `NotFound` otherwise). */
    const proposalOfSession = async (res: ServerResponse, id: string): Promise<boolean> => {
        if ((await state()).proposals.some((p) => p.id === id)) return true;
        fail(res, { type: 'NotFound', aggregate: 'ChangeProposal', id });
        return false;
    };

    /** Whether the interview is one of this session's (answered with `NotFound` otherwise). */
    const interviewOfSession = async (res: ServerResponse, id: string): Promise<boolean> => {
        if ((await state()).interviews.some((i) => i.id === id)) return true;
        fail(res, { type: 'NotFound', aggregate: 'Interview', id });
        return false;
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
                deps.facilitatorChanged();
                deps.log('facilitator claimed');
                const now = await identities.identify(req.headers);
                sendJson(res, 200, now ? meOf(session, now) : meOf(session, me));
            },
        },
        {
            method: 'GET',
            path: /^\/api\/session\/state$/,
            role: 'participant',
            handle: async ({ res, auth }) => {
                const seq = deps.cursor();
                const [s, holder, agent] = await Promise.all([state(), identities.facilitatorParticipant(), deps.agentPresence()]);
                sendJson(res, 200, stateBody(s, seq, deps.quickReactions, holder, who(auth).role, agent, deps.templates));
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
                // `target` (one) is the former body, still taken; the former `apply` is gone (addressing, ADR 0030)
                const raw = await input(req, res, ['targets', 'target', 'body', 'replyTo', 'mentions']);
                if (!raw) return;
                const me = who(auth);
                const targets = checked(res, requestTargets(raw));
                if (!targets) return;
                const t = checked(res, text(raw.body, 'body', MAX_REQUEST_TEXT));
                if (!t) return;
                // a reply to a run of the session (ended, not waiting for an answer) or to a message of it: the use case checks it
                let replyTo: Collaboration.ReplyTarget | undefined;
                if (raw.replyTo !== undefined) {
                    replyTo = checked(res, replyTarget(raw.replyTo));
                    if (!replyTo) return;
                }
                // the people `@name[pN]` mentions: participants of the session, each once (the use case checks who)
                const mentions = checked(res, mentionIds(raw.mentions));
                if (!mentions) return;
                const revisions = (await state()).revisions;
                const unknown = targets.findIndex((target) => !revisions.some((r) => r.id === target.sourceRevision));
                if (unknown >= 0)
                    return fail(res, {
                        type: 'UnknownRevision',
                        field: raw.target === undefined ? `targets[${unknown}].sourceRevision` : 'target.sourceRevision',
                        message: 'Not a revision of this session.',
                    });
                // addressed to the AI (a mention of it, a reply to it, a Solo session): its triage opens with stage 1
                const sent = await use.sendMessage({ session, actor: me.actor, targets, body: t, ...(replyTo && { replyTo }), mentions });
                if (sent.ok && sent.value.triage) deps.triaged();
                await answer(res, sent, 201, (v) => ({
                    request: v.request,
                    ...(v.triage && { triage: triageFor(me.role, v.triage) }),
                    ...(v.interview && { interview: v.interview }),
                }));
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/requests\/address$/,
            role: 'facilitator',
            handle: async ({ req, res, auth }) => {
                // the facilitator's 「AI に送る」, one message or several (ADR 0030)
                const raw = await input(req, res, ['requests']);
                if (!raw) return;
                const ids = checked(res, requestIds(raw.requests));
                if (!ids) return;
                const addressed = await use.addressMessages({ session, actor: who(auth).actor, requests: ids });
                if (addressed.ok) deps.triaged();
                await answer(res, addressed, 201, (triages) => ({ triages }));
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/requests\/([^/]+)\/address$/,
            role: 'facilitator',
            handle: async ({ req, res, auth, params }) => {
                const id = checked(res, uuid(params[0], 'id'));
                if (!id) return;
                if (!(await input(req, res, []))) return;
                const addressed = await use.addressMessages({ session, actor: who(auth).actor, requests: [knownRequestId(id)] });
                if (addressed.ok) deps.triaged();
                await answer(res, addressed, 201, (triages) => ({ triages }));
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/requests\/([^/]+)\/retry-answer$/,
            role: 'facilitator',
            handle: async ({ req, res, params }) => {
                // the AI's answer or proposal given up after failing twice: handed out again (ADR 0030, as built in M4)
                const id = checked(res, uuid(params[0], 'id'));
                if (!id) return;
                if (!(await input(req, res, []))) return;
                if (!(await deps.retryAnswer(knownRequestId(id))))
                    return fail(res, { type: 'AnswerNotGivenUp', message: 'No answer or proposal of the AI for this message is given up.' });
                sendJson(res, 200, {});
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/proposals\/approve$/,
            role: 'facilitator',
            handle: async ({ req, res, auth }) => {
                // open proposals, each with its chosen option (the recommended one when not given) and as is or with its
                // how edited; approved together, one run (plan Q2)
                const raw = await input(req, res, ['proposals', 'note']);
                if (!raw) return;
                if (!Array.isArray(raw.proposals) || raw.proposals.length === 0 || raw.proposals.length > MAX_RUN_REQUESTS)
                    return fail(res, { type: 'InvalidInput', field: 'proposals', message: `Expected 1 to ${MAX_RUN_REQUESTS} proposals.` });
                const proposals: {
                    proposal: Collaboration.ChangeProposalId;
                    option?: Collaboration.ProposalOptionIndex;
                    editedHow?: Collaboration.ProposalText;
                }[] = [];
                for (const [i, p] of raw.proposals.entries()) {
                    const one = checked(res, body(p, ['proposal', 'option', 'how']));
                    if (!one) return;
                    const id = checked(res, uuid(one.proposal, `proposals[${i}].proposal`));
                    if (!id) return;
                    let option: Collaboration.ProposalOptionIndex | undefined;
                    if (one.option !== undefined) {
                        option = checked(res, optionInput(one.option, `proposals[${i}].option`));
                        if (option === undefined) return;
                    }
                    let editedHow: Collaboration.ProposalText | undefined;
                    if (one.how !== undefined) {
                        editedHow = checked(res, editedHowInput(one.how, `proposals[${i}].how`));
                        if (!editedHow) return;
                    }
                    proposals.push({ proposal: knownChangeProposalId(id), ...(option !== undefined && { option }), ...(editedHow && { editedHow }) });
                }
                let note: Collaboration.Text | undefined;
                if (raw.note !== undefined) {
                    note = checked(res, text(raw.note, 'note', MAX_NOTE));
                    if (!note) return;
                }
                const approved = await use.approveProposals({ session, actor: who(auth).actor, proposals, ...(note && { note }) });
                await answer(res, approved, 201, (v) => ({ run: v.run, proposals: v.proposals }));
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/proposals\/([^/]+)\/reject$/,
            role: 'facilitator',
            handle: async ({ req, res, auth, params }) => {
                const id = checked(res, uuid(params[0], 'id'));
                if (!id) return;
                const raw = await input(req, res, ['note']);
                if (!raw) return;
                let note: Collaboration.Text | undefined;
                if (raw.note !== undefined) {
                    note = checked(res, text(raw.note, 'note', PROPOSAL_LIMITS.note));
                    if (!note) return;
                }
                if (!(await proposalOfSession(res, id))) return;
                const rejected = await use.rejectProposal({ proposal: knownChangeProposalId(id), actor: who(auth).actor, ...(note && { note }) });
                await answer(res, rejected, 200, (proposal) => ({ proposal }));
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/proposals\/([^/]+)\/withdraw$/,
            role: 'participant',
            handle: async ({ req, res, auth, params }) => {
                const id = checked(res, uuid(params[0], 'id'));
                if (!id) return;
                if (!(await input(req, res, []))) return;
                if (!(await proposalOfSession(res, id))) return;
                const withdrawn = await use.withdrawProposal({ proposal: knownChangeProposalId(id), actor: who(auth).actor });
                await answer(res, withdrawn, 200, (proposal) => ({ proposal }));
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/interviews$/,
            role: 'facilitator',
            handle: async ({ req, res, auth }) => {
                // `/es` or `/model` (the plan's round 5): the opening message and the interview, the interviewer's first
                // question due; the facilitator only (in Solo, the person)
                const raw = await input(req, res, ['command', 'body', 'language', 'focus']);
                if (!raw) return;
                const command = Object.entries(INTERVIEW_COMMANDS).find(([id]) => id === raw.command)?.[1];
                if (!command)
                    return fail(res, { type: 'InvalidInput', field: 'command', message: `Expected one of ${Object.keys(INTERVIEW_COMMANDS).join(', ')}.` });
                const t = checked(res, text(raw.body, 'body', 200));
                if (!t) return;
                if (raw.language !== 'ja' && raw.language !== 'en')
                    return fail(res, { type: 'InvalidInput', field: 'language', message: 'Expected ja or en.' });
                let focus: Collaboration.ModelTarget | undefined;
                if (raw.focus !== undefined) {
                    focus = checked(res, modelTarget(raw.focus, 'focus'));
                    if (!focus) return;
                }
                const started = await use.startInterview({
                    session,
                    actor: who(auth).actor,
                    command,
                    body: t,
                    language: raw.language === 'en' ? 'En' : 'Ja',
                    ...(focus && { focus }),
                });
                await answer(res, started, 201, (v) => ({ interview: v.interview, request: v.request }));
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/interviews\/([^/]+)\/confirm$/,
            role: 'facilitator',
            handle: async ({ req, res, auth, params }) => {
                const id = checked(res, uuid(params[0], 'id'));
                if (!id) return;
                const raw = await input(req, res, ['text']);
                if (!raw) return;
                let edited: Collaboration.BriefText | undefined;
                if (raw.text !== undefined) {
                    const read = readBriefText(raw.text, 'text');
                    if (!read.ok) return fail(res, { type: 'InvalidInput', field: read.error.path, message: read.error.message });
                    edited = read.value;
                }
                if (!(await interviewOfSession(res, id))) return;
                const confirmed = await use.confirmInterview({ interview: knownInterviewId(id), actor: who(auth).actor, ...(edited && { text: edited }) });
                await answer(res, confirmed, 201, (v) => ({ interview: v.interview, run: v.run }));
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/interviews\/([^/]+)\/stop$/,
            role: 'facilitator',
            handle: async ({ req, res, auth, params }) => {
                const id = checked(res, uuid(params[0], 'id'));
                if (!id) return;
                if (!(await input(req, res, []))) return;
                if (!(await interviewOfSession(res, id))) return;
                const stopped = await use.stopInterview({ interview: knownInterviewId(id), actor: who(auth).actor });
                await answer(res, stopped, 200, (interview) => ({ interview }));
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/marks$/,
            role: 'participant',
            handle: async ({ req, res, auth }) => {
                // a vote or a reaction of mine, placed or taken off; the facilitator's vote is refused by the model too
                const raw = await input(req, res, ['target', 'sign', 'placed']);
                if (!raw) return;
                const target = checked(res, markTarget(raw.target));
                if (!target) return;
                const sign = checked(res, markSign(raw.sign));
                if (!sign) return;
                if (typeof raw.placed !== 'boolean') return fail(res, { type: 'InvalidInput', field: 'placed', message: 'Expected true or false.' });
                const me = who(auth);
                if (sign.kind === 'Vote' && me.role === 'facilitator')
                    return fail(res, { type: 'FacilitatorDoesNotVote', message: "The facilitator's answer is the decision: the facilitator does not vote." });
                const set = await use.setMark({ session, actor: me.actor, target, sign, placed: raw.placed });
                if (!set.ok && set.error.type === 'ReactionLimitReached')
                    return fail(res, {
                        ...set.error,
                        message: `A message or a turn holds at most ${set.error.limit} different emoji: add one already there, or take one off first.`,
                    });
                await answer(res, set, 200, (r) => ({ ...(r.placed && { placed: r.placed }), removed: r.removed }));
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
                const raw = await input(req, res, ['requests', 'note', 'answerTo', 'answer', 'pick']);
                if (!raw) return;
                const ids = checked(res, requestIds(raw.requests));
                if (!ids) return;
                let note: Collaboration.Text | undefined;
                if (raw.note !== undefined) {
                    note = checked(res, text(raw.note, 'note', MAX_NOTE));
                    if (!note) return;
                }
                // the answer to a run's questions: both fields, or neither
                let answered: { answerTo: Collaboration.AgentRunId; answer: AnswerData } | undefined;
                if (raw.answerTo !== undefined || raw.answer !== undefined) {
                    if (raw.answerTo === undefined) return fail(res, { type: 'InvalidInput', field: 'answerTo', message: 'Expected the run answered.' });
                    const to = checked(res, uuid(raw.answerTo, 'answerTo'));
                    if (!to) return;
                    const a = checked(res, answerInput(raw.answer));
                    if (!a) return;
                    answered = { answerTo: knownAgentRunId(to), answer: a };
                }
                // an alternative picked of a completed run's assumption: its requests queued again (checked by the use case)
                let picked: PickData | undefined;
                if (raw.pick !== undefined) {
                    picked = checked(res, pickInput(raw.pick));
                    if (!picked) return;
                }
                const queued = await use.queueRun({
                    session,
                    requests: ids,
                    actor: who(auth).actor,
                    ...(note && { note }),
                    ...(answered && { answer: answered }),
                    ...(picked && { pick: picked }),
                });
                await answer(res, queued, 201, (run) => ({ run }));
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/approvals$/,
            role: 'facilitator',
            handle: async ({ req, res, auth }) => {
                // an assumption of a completed run approved as it is: recorded, nothing sent to the agent
                const raw = await input(req, res, ['run', 'assumption']);
                if (!raw) return;
                const assumption = checked(res, assumptionRef(raw));
                if (!assumption) return;
                await answer(res, await use.approveAssumption({ session, actor: who(auth).actor, assumption }), 201, (approval) => ({ approval }));
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
                await answer(res, await use.cancelRun({ run: run.id, actor: who(auth).actor }), 200, (r) => ({ run: r }));
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/runs\/([^/]+)\/revert$/,
            role: 'facilitator',
            handle: async ({ req, res, auth, params }) => {
                // a revert queues like any change (ADR 0026, amendment): asked, then the server takes it at once if it
                // is at the head (mechanically, or left to the AI); the answer is the run as it is then
                const id = checked(res, uuid(params[0], 'id'));
                if (!id) return;
                const raw = await input(req, res, ['body']);
                if (!raw) return;
                const message = checked(res, text(raw.body, 'body', MAX_NOTE));
                if (!message) return;
                const me = who(auth);
                const requested = await use.requestRevert({ session, actor: me.actor, run: knownAgentRunId(id), body: message });
                if (!requested.ok) {
                    deps.log(`revert of run ${id} refused: ${requested.error.type}`);
                    return fail(res, requested.error);
                }
                deps.log(`queued the revert of run ${id} (run ${requested.value.run.id}, by ${me.participant.id})`);
                await deps.pump();
                await deps.reverts();
                const { runs } = await state();
                const run = runs.find((r) => r.id === requested.value.run.id) ?? requested.value.run;
                // what is before it in the queue: the run in progress and the queued ones ahead
                const ahead =
                    run.state === 'Queued'
                        ? runs.filter((r) => r.state === 'Running' || (r.state === 'Queued' && runs.indexOf(r) < runs.indexOf(run))).length
                        : 0;
                sendJson(res, 201, { request: requested.value.request, run, ahead });
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
                await answer(res, await use.takeRevision({ session, actor: who(auth).actor }), 201, (revision) => ({ revision }));
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
                            actor: me.actor,
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
            path: /^\/api\/session\/revisions\/([^/]+)\/changes\/([^/]+)$/,
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
                const changes = await use.modelChanges({ session, before: a.id, after: b.id });
                if (!changes.ok) return fail(res, changes.error);
                sendJson(res, 200, changes.value satisfies ModelChangesBody);
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
            path: /^\/api\/session\/facilitator\/link$/,
            role: 'facilitator',
            handle: async ({ req, res }) => {
                if (!(await input(req, res, []))) return;
                // another one-time link, to hand the role over (as `dt session link`)
                sendJson(res, 201, await deps.issueFacilitatorLink());
            },
        },
        {
            method: 'POST',
            path: /^\/api\/session\/close$/,
            role: 'facilitator',
            handle: async ({ req, res, auth }) => {
                if (!(await input(req, res, []))) return;
                const closed = await use.closeSession({ session, actor: who(auth).actor });
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
            return sendError(res, 403, 'FacilitatorOnly', FACILITATOR_ONLY);
        const params = route.path.exec(url.pathname)?.slice(1) ?? [];
        await route.handle({ req, res, auth, params });
    };

    const signInAnswer: SessionSurface['signIn'] = (req, url, res) => {
        const language = pageLanguage(req.headers['accept-language']);
        if (identities.mode === 'dev') return joinPage(res, language, 401, `${url.pathname}${url.search}`, { name: rememberedName(req.headers) });
        messagePage(res, language, 401, 'signInRequired');
    };

    const pages: SessionSurface['pages'] = async (req, url, res, auth) => {
        const language = pageLanguage(req.headers['accept-language']);
        if (url.pathname === '/session/join') {
            if (identities.mode !== 'dev') return messagePage(res, language, 404, 'signInThroughAccess');
            const remembered = { name: rememberedName(req.headers) };
            if (req.method === 'GET' || req.method === 'HEAD') {
                if (auth.kind === 'participant') return redirect(res, safeNext(url.searchParams.get('next')));
                return joinPage(res, language, 200, safeNext(url.searchParams.get('next')), remembered);
            }
            if (req.method !== 'POST') return messagePage(res, language, 405, 'formMethod');
            if (mediaType(req) !== 'application/x-www-form-urlencoded') return messagePage(res, language, 415, 'formMediaType');
            let form: URLSearchParams;
            try {
                form = new URLSearchParams(await readText(req, MAX_FORM));
            } catch (e) {
                if (e instanceof BodyError) return messagePage(res, language, e.status, 'formTooLarge');
                throw e;
            }
            const next = safeNext(form.get('next'));
            if (auth.kind === 'participant') return redirect(res, next);
            const name = displayName(form.get('name') ?? '');
            if (!name.ok) return joinPage(res, language, 400, next, { ...remembered, error: 'invalidName' });
            const r = await signIn(name.value);
            if (!r.ok)
                return joinPage(res, language, statusOf(r.error.type), next, {
                    ...remembered,
                    error: r.error.type === 'SessionFull' ? 'sessionFull' : 'sessionNotOpen',
                });
            // the name is remembered for the next join form, of this session or another one on the host
            return redirect(res, next, [devCookie(r.secret, deps.secureCookie), nameCookie(name.value, deps.secureCookie)]);
        }
        if (url.pathname === '/session/facilitator') {
            if (req.method !== 'GET' && req.method !== 'HEAD') return messagePage(res, language, 405, 'linkMethod');
            const code = url.searchParams.get('code') ?? '';
            if (!/^[A-Za-z0-9_-]{16,128}$/.test(code)) return messagePage(res, language, 400, 'linkIncomplete');
            if (auth.kind !== 'participant') return signInAnswer(req, url, res);
            // opening the link while signed in claims it: the code is the secret, single use and short-lived
            const claimed = await identities.claimFacilitator(code, auth.participant.identity);
            if (!claimed.ok) return messagePage(res, language, 409, 'linkNotValid');
            if (claimed.value.previous) deps.disconnect(claimed.value.previous, 'facilitator changed');
            deps.disconnect(auth.participant.identity, 'facilitator changed');
            deps.facilitatorChanged();
            deps.log('facilitator claimed');
            return redirect(res, '/');
        }
        messagePage(res, language, 404, 'notFound');
    };

    return { policy: { ...deps.hostPolicy, identify: (headers) => identities.identify(headers) }, api, pages, signIn: signInAnswer };
}

function redirect(res: ServerResponse, location: string, cookie?: string | string[]): void {
    res.writeHead(303, { location, 'cache-control': 'no-store', ...(cookie && { 'set-cookie': cookie }) });
    res.end();
}

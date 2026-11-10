// The wire of the knowledge store's HTTP API (ADR 0031, section 8), shared by the `cloudflare` adapter, which sends it,
// and the Worker template (apps/knowledge-worker), which serves it: the paths, the headers, the query of a search, the
// error bodies, and the decoders of every body that crosses it.
//
// The bodies are the port's values as JSON (`JSON.stringify`: a `Date` becomes its ISO string). Decoding checks every
// value with the generated constructors (`Knowledge.make…`), so that what a body holds is a value of the model or a
// `WireError`, never a cast: the Worker decodes what dt sends, the adapter what the Worker answers.
import { Knowledge, type Result } from './generated/index.js';
import type { DroppedOperation, DropReason } from './domain/extraction.js';
import type { PastVersion } from './domain/records.js';
import type { RetirementCandidate } from './domain/retirement.js';
import {
    PUBLISHED_LEVELS,
    type AppliedExtraction,
    type ApprovedProposal,
    type RetiredFilter,
    type RetirementInput,
    type Deletion,
    type ItemWithHistory,
    type KnowledgeQuery,
    type MissingStickies,
    type Page,
    type PublishedEntry,
    type PublishedSticky,
    type PublishedStorming,
    type PublishResult,
    type RedactionEntry,
    type StickyCount,
} from './application/ports.js';

// ---- paths and headers ------------------------------------------------------------------------------------------

/** The version of the API: the prefix of every path. A change that breaks dt makes `/v2`. */
export const API_VERSION = 'v1';

/** The path of a project's API: `/v1/projects/<project>`; the routes of section 8 are below it. */
export const projectPath = (project: Knowledge.ProjectName): string => `/${API_VERSION}/projects/${project}`;

/** The idempotency key of `POST /extractions`: `idempotencyKey(extraction.by)`, `<session>#<number>`. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/**
 * The person a call acts for (`correct`, `delete`, `restore`), when the caller is a service token (dt for its session's
 * participant). A caller that Access knows as a person acts for itself, whatever this says.
 */
export const ACTOR_HEADER = 'X-Knowledge-Actor';

/** The service token's headers that Cloudflare Access checks before the Worker sees the request. */
export const ACCESS_CLIENT_ID_HEADER = 'CF-Access-Client-Id';
export const ACCESS_CLIENT_SECRET_HEADER = 'CF-Access-Client-Secret';

/** The media types an image may have. No SVG: the read-only page would serve a script with it. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** The largest image accepted, in bytes. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** The default and the largest page of a list. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** The most stickies one `about` filter names (D1 binds at most 100 parameters per statement). */
export const MAX_ABOUT = 50;

// ---- the Live View --------------------------------------------------------------------------------------------

/**
 * What dt sends the Live View's pages over their WebSocket when the knowledge changed (an extraction applied, a person's
 * correction, deletion or undo, the redaction log followed): the pages read what they show again, through dt's
 * `/api/session/knowledge` (whose bodies are this API's).
 */
export interface KnowledgeChangedMessage {
    readonly type: 'knowledge.changed';
}

export const KNOWLEDGE_CHANGED: KnowledgeChangedMessage = { type: 'knowledge.changed' };

// ---- errors -----------------------------------------------------------------------------------------------------

/**
 * The error body of every answer that is not a 2xx: the domain's errors by their type (`KnowledgeItemNotFound`, 404;
 * `KnowledgeItemGone`, 410), and the API's own.
 */
export interface ErrorBody {
    readonly error: {
        readonly type: ApiErrorType | DomainErrorType;
        readonly itemId?: string;
        readonly proposalId?: string;
        /** `ProposalRefused`'s reason. */
        readonly reason?: string;
        readonly message?: string;
    };
}

/** The domain's errors an answer may carry, by their type (`domainErrorStatus` gives their status). */
export type DomainErrorType =
    | 'Knowledge.KnowledgeItemNotFound'
    | 'Knowledge.KnowledgeItemGone'
    | 'Knowledge.AlreadyRetired'
    | 'Knowledge.NotRetired'
    | 'Knowledge.ReplacementWithoutReason'
    | 'Knowledge.ReplacedByItself'
    | 'Knowledge.MalformedProposal'
    | 'Knowledge.ProposalRefused'
    | 'Knowledge.ProposalNotFound'
    | 'Knowledge.ProposalDecided';

export const DOMAIN_ERROR_TYPES: readonly DomainErrorType[] = [
    'Knowledge.KnowledgeItemNotFound',
    'Knowledge.KnowledgeItemGone',
    'Knowledge.AlreadyRetired',
    'Knowledge.NotRetired',
    'Knowledge.ReplacementWithoutReason',
    'Knowledge.ReplacedByItself',
    'Knowledge.MalformedProposal',
    'Knowledge.ProposalRefused',
    'Knowledge.ProposalNotFound',
    'Knowledge.ProposalDecided',
];

/** The status of a domain's error: 404 for what is not there, 410 for a deleted item, 409 for a state that refuses, 400 for a malformed request. */
export function domainErrorStatus(type: DomainErrorType): number {
    switch (type) {
        case 'Knowledge.KnowledgeItemNotFound':
        case 'Knowledge.ProposalNotFound':
            return 404;
        case 'Knowledge.KnowledgeItemGone':
            return 410;
        case 'Knowledge.ReplacementWithoutReason':
        case 'Knowledge.ReplacedByItself':
        case 'Knowledge.MalformedProposal':
            return 400;
        default:
            return 409;
    }
}

/** The body of a domain's error (the store's `Result` error, as JSON). */
export function domainErrorBody(e: DomainError): ErrorBody {
    return {
        error: {
            type: e.type,
            ...('itemId' in e && { itemId: e.itemId }),
            ...('proposalId' in e && { proposalId: e.proposalId }),
            ...('reason' in e && { reason: e.reason }),
        },
    };
}

export type ApiErrorType =
    /** 400: a path, a query, a header or a body that is not what the API takes. */
    | 'BadRequest'
    /** 401: no identity from Access (or its token does not verify). */
    | 'Unauthenticated'
    /** 403: `authorize` refused, or a read-only service token tried to write. */
    | 'Forbidden'
    /** 404: no such route, or no such image. */
    | 'NotFound'
    /** 409: an `Idempotency-Key` sent again with other operations. */
    | 'IdempotencyKeyReused'
    /** 413, 415: an image too large, or of a media type not taken. */
    | 'ImageRejected'
    /** 501: a route reserved for a later version. */
    | 'NotImplemented'
    /** 413: a published storming larger than `MAX_PUBLISHED_BYTES`. */
    | 'TooLarge'
    /** 403 from a person's write whose `Origin` is not the Worker's own (the read-only page's calls only). */
    | 'CrossOrigin'
    /** 503: the D1 database has not had the template's migrations applied. */
    | 'StoreNotMigrated'
    /** 500: anything else. */
    | 'Internal';

/** A body, a query or an answer that is not what the API takes: where in it, and what is wrong. */
export class WireError extends Error {
    override readonly name = 'WireError';
}

/** The error body of an answer, when it is one. */
export function decodeErrorBody(v: unknown): ErrorBody['error'] | undefined {
    if (!isObject(v) || !isObject(v.error) || typeof v.error.type !== 'string') return undefined;
    const { type, itemId, proposalId, reason, message } = v.error;
    const known = [...API_ERROR_TYPES, ...DOMAIN_ERROR_TYPES].find((t) => t === type) ?? 'Internal';
    return {
        type: known,
        ...(typeof itemId === 'string' && { itemId }),
        ...(typeof proposalId === 'string' && { proposalId }),
        ...(typeof reason === 'string' && { reason }),
        ...(typeof message === 'string' && { message }),
    };
}

const API_ERROR_TYPES: readonly ApiErrorType[] = [
    'BadRequest',
    'Unauthenticated',
    'Forbidden',
    'NotFound',
    'IdempotencyKeyReused',
    'ImageRejected',
    'NotImplemented',
    'TooLarge',
    'CrossOrigin',
    'StoreNotMigrated',
    'Internal',
];

// ---- the query of a search --------------------------------------------------------------------------------------

/** A search as the query of `GET /knowledge`: each list filter repeated (`about=A&about=B`). */
export function knowledgeQueryParams(query: KnowledgeQuery): URLSearchParams {
    const params = new URLSearchParams();
    for (const a of query.about ?? []) params.append('about', a);
    for (const w of query.when ?? []) params.append('when', w);
    for (const k of query.kind ?? []) params.append('kind', k);
    for (const o of query.origin ?? []) params.append('origin', o);
    if (query.perspective !== undefined) params.set('perspective', query.perspective);
    if (query.q !== undefined) params.set('q', query.q);
    if (query.session !== undefined) params.set('session', query.session);
    if (query.retired !== undefined) params.set('retired', query.retired);
    if (query.bookmarked) params.set('bookmarked', 'true');
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    return params;
}

/** The search a query of `GET /knowledge` asks for; a `WireError` when a value is not one. */
export function knowledgeQueryOf(params: URLSearchParams): KnowledgeQuery {
    const all = <T>(key: string, d: Decoder<T>): T[] => params.getAll(key).map((v, i) => d(v, `${key}[${i}]`));
    const one = <T>(key: string, d: Decoder<T>): T | undefined => {
        const v = params.get(key);
        return v === null ? undefined : d(v, key);
    };
    const about = all('about', stickyRef);
    if (about.length > MAX_ABOUT) fail('about', `at most ${MAX_ABOUT} stickies`);
    const when = all('when', oneOf(WHEN));
    const kind = all('kind', oneOf(KINDS));
    const origin = all('origin', oneOf(ORIGINS));
    const perspective = one('perspective', branded(Knowledge.makePerspective, str));
    const q = one('q', str);
    const session = one('session', branded(Knowledge.makeSessionRef, str));
    const retired = one('retired', oneOf<RetiredFilter>(['include', 'only']));
    const bookmarked = one('bookmarked', oneOf(['true'] as const));
    const limit = one('limit', limitOf);
    const cursor = one('cursor', str);
    return {
        ...(about.length > 0 && { about }),
        ...(when.length > 0 && { when }),
        ...(kind.length > 0 && { kind }),
        ...(origin.length > 0 && { origin }),
        ...(perspective !== undefined && { perspective }),
        ...(q !== undefined && q.trim() !== '' && { q }),
        ...(session !== undefined && { session }),
        ...(retired !== undefined && { retired }),
        ...(bookmarked !== undefined && { bookmarked: true }),
        ...(limit !== undefined && { limit }),
        ...(cursor !== undefined && { cursor }),
    };
}

/** A page size of a query: an integer from 1 to `MAX_LIMIT`. */
export function limitOf(v: unknown, at: string): number {
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return fail(at, `expected an integer from 1 to ${MAX_LIMIT}`);
    return n;
}

// ---- decoders ---------------------------------------------------------------------------------------------------

/** Reads a value of the wire at `at` (a path in the body, for the error), or throws a `WireError`. */
export type Decoder<T> = (v: unknown, at: string) => T;

const fail = (at: string, what: string): never => {
    throw new WireError(`${at}: ${what}`);
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown, at: string): Record<string, unknown> => (isObject(v) ? v : fail(at, 'expected an object'));
const str: Decoder<string> = (v, at) => (typeof v === 'string' ? v : fail(at, 'expected a string'));
const num: Decoder<number> = (v, at) => (typeof v === 'number' && Number.isFinite(v) ? v : fail(at, 'expected a number'));
const bool: Decoder<boolean> = (v, at) => (typeof v === 'boolean' ? v : fail(at, 'expected a boolean'));

/** A value of the model made by its generated constructor from a string or a number. */
const branded =
    <T, V>(make: (value: V) => Result<T, unknown>, base: Decoder<V>): Decoder<T> =>
    (v, at) => {
        const made = make(base(v, at));
        return made.ok ? made.value : fail(at, `not valid (${JSON.stringify(made.error)})`);
    };

const oneOf =
    <T extends string>(values: readonly T[]): Decoder<T> =>
    (v, at) =>
        values.find((x) => x === v) ?? fail(at, `expected one of ${values.join(', ')}`);

const list =
    <T>(d: Decoder<T>): Decoder<T[]> =>
    (v, at) =>
        Array.isArray(v) ? v.map((x, i) => d(x, `${at}[${i}]`)) : fail(at, 'expected an array');

const nonEmpty =
    <T>(d: Decoder<T>): Decoder<readonly [T, ...T[]]> =>
    (v, at) => {
        const [first, ...rest] = list(d)(v, at);
        return first === undefined ? fail(at, 'expected at least one') : [first, ...rest];
    };

/** An optional field: absent (or `null`) is `undefined`. */
const opt = <T>(d: Decoder<T>, v: unknown, at: string): T | undefined => (v === undefined || v === null ? undefined : d(v, at));

/** A time: an ISO 8601 string (what `JSON.stringify` makes of a `Date`). */
const time: Decoder<Date> = (v, at) => {
    const s = str(v, at);
    const d = new Date(s);
    return /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(d.getTime()) ? d : fail(at, 'expected an ISO 8601 time');
};

const WHEN: readonly Knowledge.When[] = ['as_is', 'to_be', 'none'];
const KINDS: readonly Knowledge.KnowledgeKind[] = ['rule', 'flow', 'example', 'term', 'pain', 'want', 'decision'];
const ORIGINS: readonly Knowledge.Origin[] = ['said', 'agreed', 'investigated', 'inferred'];
const AUDIT_OPERATIONS: readonly Knowledge.AuditOperation[] = [
    'add',
    'addSource',
    'rewrite',
    'revise',
    'linkConflict',
    'correct',
    'bookmark',
    'unbookmark',
    'delete',
    'restore',
    'unlinkConflict',
    'handOverToHotspot',
    'retire',
    'unretire',
    'propose',
    'dismiss',
];
const RETIREMENT_REASONS: readonly Knowledge.RetirementReason[] = ['replaced', 'obsolete', 'wrong'];
const PROPOSAL_ACTIONS: readonly Knowledge.ProposalAction[] = ['retire', 'unretire'];

export const itemId: Decoder<Knowledge.KnowledgeItemId> = branded(Knowledge.makeKnowledgeItemId, str);
export const imageId: Decoder<Knowledge.ImageId> = branded(Knowledge.makeImageId, str);
export const projectName: Decoder<Knowledge.ProjectName> = branded(Knowledge.makeProjectName, str);
export const userName: Decoder<Knowledge.UserName> = branded(Knowledge.makeUserName, str);
export const sessionRef: Decoder<Knowledge.SessionRef> = branded(Knowledge.makeSessionRef, str);
export const stickyRef: Decoder<Knowledge.StickyRef> = branded(Knowledge.makeStickyRef, str);
const messageRef: Decoder<Knowledge.MessageRef> = branded(Knowledge.makeMessageRef, str);
export const itemVersion: Decoder<Knowledge.ItemVersion> = branded(Knowledge.makeItemVersion, num);
const reasonOf: Decoder<Knowledge.Reason> = branded(Knowledge.makeReason, str);
export const proposalId: Decoder<Knowledge.RetirementProposalId> = branded(Knowledge.makeRetirementProposalId, str);
const retirementReason: Decoder<Knowledge.RetirementReason> = oneOf(RETIREMENT_REASONS);

const labels: Decoder<Knowledge.Labels> = (v, at) => {
    const o = obj(v, at);
    const perspective = opt(branded(Knowledge.makePerspective, str), o.perspective, `${at}.perspective`);
    return {
        when: oneOf(WHEN)(o.when, `${at}.when`),
        kind: oneOf(KINDS)(o.kind, `${at}.kind`),
        origin: oneOf(ORIGINS)(o.origin, `${at}.origin`),
        ...(perspective !== undefined && { perspective }),
    };
};

/** An item's content: its title, text, labels and the stickies it is about, each once. */
export const itemContent: Decoder<Knowledge.ItemContent> = (v, at) => {
    const o = obj(v, at);
    const content: Knowledge.ItemContent = {
        title: branded(Knowledge.makeItemTitle, str)(o.title, `${at}.title`),
        text: branded(Knowledge.makeItemText, str)(o.text, `${at}.text`),
        labels: labels(o.labels, `${at}.labels`),
        about: list(stickyRef)(o.about, `${at}.about`),
    };
    if (Knowledge.checkItemContent(content).length > 0) fail(`${at}.about`, 'a sticky named twice');
    return content;
};

const source: Decoder<Knowledge.Source> = (v, at) => {
    const o = obj(v, at);
    return {
        session: sessionRef(o.session, `${at}.session`),
        message: messageRef(o.message, `${at}.message`),
        at: time(o.at, `${at}.at`),
        quote: branded(Knowledge.makeQuote, str)(o.quote, `${at}.quote`),
    };
};

const extractionRef: Decoder<Knowledge.ExtractionRef> = (v, at) => {
    const o = obj(v, at);
    return { session: sessionRef(o.session, `${at}.session`), number: branded(Knowledge.makeExtractionNumber, num)(o.number, `${at}.number`) };
};

const withReason = (o: Record<string, unknown>, at: string): { reason?: Knowledge.Reason } => {
    const reason = opt(reasonOf, o.reason, `${at}.reason`);
    return reason === undefined ? {} : { reason };
};

/** A piece of a proposal's evidence: a decision, a sticky's change, a message. */
export const evidence: Decoder<Knowledge.Evidence> = (v, at) => {
    const o = obj(v, at);
    const kind = oneOf(['Decision', 'StickyChange', 'Said'] as const)(o.kind, `${at}.kind`);
    switch (kind) {
        case 'Decision':
            return { kind, item: itemId(o.item, `${at}.item`) };
        case 'StickyChange':
            return { kind, sticky: stickyRef(o.sticky, `${at}.sticky`), change: branded(Knowledge.makeEvidenceNote, str)(o.change, `${at}.change`) };
        case 'Said':
            return {
                kind,
                session: sessionRef(o.session, `${at}.session`),
                message: messageRef(o.message, `${at}.message`),
                quote: branded(Knowledge.makeQuote, str)(o.quote, `${at}.quote`),
            };
    }
};

/** Who proposed: an extraction, or a review. */
export const proposer: Decoder<Knowledge.Proposer> = (v, at) => {
    const o = obj(v, at);
    const kind = oneOf(['Extraction', 'Review'] as const)(o.kind, `${at}.kind`);
    return kind === 'Extraction'
        ? { kind, extraction: extractionRef(o.extraction, `${at}.extraction`) }
        : { kind, review: branded(Knowledge.makeReviewRef, str)(o.review, `${at}.review`) };
};

const operation: Decoder<Knowledge.Operation> = (v, at) => {
    const o = obj(v, at);
    const kind = oneOf(['Add', 'AddSource', 'Update', 'Conflict', 'ProposeRetire', 'ProposeUnretire'] as const)(o.kind, `${at}.kind`);
    switch (kind) {
        case 'Add':
            return {
                kind,
                id: itemId(o.id, `${at}.id`),
                content: itemContent(o.content, `${at}.content`),
                sources: nonEmpty(source)(o.sources, `${at}.sources`),
                ...withReason(o, at),
            };
        case 'AddSource':
            return {
                kind,
                item: itemId(o.item, `${at}.item`),
                base: itemVersion(o.base, `${at}.base`),
                source: source(o.source, `${at}.source`),
                agreed: bool(o.agreed, `${at}.agreed`),
                ...withReason(o, at),
            };
        case 'Update':
            return {
                kind,
                item: itemId(o.item, `${at}.item`),
                base: itemVersion(o.base, `${at}.base`),
                revised: itemContent(o.revised, `${at}.revised`),
                sources: nonEmpty(source)(o.sources, `${at}.sources`),
                ...withReason(o, at),
            };
        case 'Conflict':
            return {
                kind,
                id: itemId(o.id, `${at}.id`),
                content: itemContent(o.content, `${at}.content`),
                sources: nonEmpty(source)(o.sources, `${at}.sources`),
                item: itemId(o.item, `${at}.item`),
                base: itemVersion(o.base, `${at}.base`),
                ...withReason(o, at),
            };
        case 'ProposeRetire': {
            const replacedBy = opt(itemId, o.replacedBy, `${at}.replacedBy`);
            return {
                kind,
                item: itemId(o.item, `${at}.item`),
                retirementReason: retirementReason(o.retirementReason, `${at}.retirementReason`),
                ...(replacedBy !== undefined && { replacedBy }),
                evidence: nonEmpty(evidence)(o.evidence, `${at}.evidence`),
                reason: reasonOf(o.reason, `${at}.reason`),
            };
        }
        case 'ProposeUnretire':
            return {
                kind,
                item: itemId(o.item, `${at}.item`),
                evidence: nonEmpty(evidence)(o.evidence, `${at}.evidence`),
                reason: reasonOf(o.reason, `${at}.reason`),
            };
    }
};

/** The body of `POST /extractions`. */
export const extraction: Decoder<Knowledge.Extraction> = (v, at) => {
    const o = obj(v, at);
    return { by: extractionRef(o.by, `${at}.by`), operations: list(operation)(o.operations, `${at}.operations`) };
};

/** An item's retirement. */
export const retirement: Decoder<Knowledge.Retirement> = (v, at) => {
    const o = obj(v, at);
    const reason = opt(retirementReason, o.reason, `${at}.reason`);
    const replacedBy = opt(itemId, o.replacedBy, `${at}.replacedBy`);
    const proposal = opt(proposalId, o.proposal, `${at}.proposal`);
    const r: Knowledge.Retirement = {
        ...(reason !== undefined && { reason }),
        ...(replacedBy !== undefined && { replacedBy }),
        by: userName(o.by, `${at}.by`),
        at: time(o.at, `${at}.at`),
        ...(proposal !== undefined && { proposal }),
    };
    if (Knowledge.checkRetirement(r).length > 0) fail(`${at}.replacedBy`, 'a replacement without the reason replaced');
    return r;
};

/** An item as the store holds it, live or deleted. */
export const knowledgeItem: Decoder<Knowledge.KnowledgeItem> = (v, at) => {
    const o = obj(v, at);
    const createdIn = opt(sessionRef, o.createdIn, `${at}.createdIn`);
    const retired = opt(retirement, o.retirement, `${at}.retirement`);
    const bookmarked = opt(bool, o.bookmarked, `${at}.bookmarked`);
    const common: Knowledge.KnowledgeItemCommon = {
        id: itemId(o.id, `${at}.id`),
        content: itemContent(o.content, `${at}.content`),
        sources: list(source)(o.sources, `${at}.sources`),
        version: itemVersion(o.version, `${at}.version`),
        conflictsWith: list(itemId)(o.conflictsWith, `${at}.conflictsWith`),
        ...(createdIn !== undefined && { createdIn }),
        createdAt: time(o.createdAt, `${at}.createdAt`),
        updatedAt: time(o.updatedAt, `${at}.updatedAt`),
        ...(bookmarked === true && { bookmarked: true }),
        ...(retired !== undefined && { retirement: retired }),
    };
    const state = oneOf(['Live', 'Deleted'] as const)(o.state, `${at}.state`);
    return state === 'Live'
        ? { ...common, state }
        : { ...common, state, deletedBy: userName(o.deletedBy, `${at}.deletedBy`), deletedAt: time(o.deletedAt, `${at}.deletedAt`) };
};

/** A live item: what every read of the API returns. */
export const liveItem: Decoder<Knowledge.LiveKnowledgeItem> = (v, at) => {
    const item = knowledgeItem(v, at);
    return item.state === 'Live' ? item : fail(`${at}.state`, 'expected a live item');
};

/** A person's explicit setting of the shared bookmark. */
export const bookmarkBody: Decoder<boolean> = (v, at) => {
    const o = obj(v, at);
    return bool(o.bookmarked, `${at}.bookmarked`);
};

const pastVersion: Decoder<PastVersion> = (v, at) => {
    const o = obj(v, at);
    return {
        version: itemVersion(o.version, `${at}.version`),
        content: itemContent(o.content, `${at}.content`),
        replacedAt: time(o.replacedAt, `${at}.replacedAt`),
    };
};

/** The body of `GET /knowledge/:id`. */
export const itemWithHistory: Decoder<ItemWithHistory> = (v, at) => {
    const o = obj(v, at);
    const history = opt(list(pastVersion), o.history, `${at}.history`);
    return { item: liveItem(o.item, `${at}.item`), ...(history !== undefined && { history }) };
};

/** A page of a list: `{ items, next? }`. */
export const page =
    <T>(d: Decoder<T>): Decoder<Page<T>> =>
    (v, at) => {
        const o = obj(v, at);
        const next = opt(str, o.next, `${at}.next`);
        return { items: list(d)(o.items, `${at}.items`), ...(next !== undefined && { next }) };
    };

const stickyCount: Decoder<StickyCount> = (v, at) => {
    const o = obj(v, at);
    return { sticky: stickyRef(o.sticky, `${at}.sticky`), hasItems: bool(o.hasItems, `${at}.hasItems`), hasConflict: bool(o.hasConflict, `${at}.hasConflict`) };
};

/** The body of `POST /knowledge/:id/unlink`'s answer: `{ items }`, the item first. */
export const liveItems: Decoder<Knowledge.LiveKnowledgeItem[]> = (v, at) => list(liveItem)(obj(v, at).items, `${at}.items`);

/** The body of `POST /knowledge/:id/unlink`: `{ other }`, the item it is said not to conflict with. */
export const unlinkBody: Decoder<Knowledge.KnowledgeItemId> = (v, at) => itemId(obj(v, at).other, `${at}.other`);

/** The body of `POST /knowledge/:id/hand-over`: `{ other, hotspot }`, the other side of the conflict and the hotspot it goes to. */
export const handOverBody: Decoder<{ readonly other: Knowledge.KnowledgeItemId; readonly hotspot: Knowledge.StickyRef }> = (v, at) => {
    const o = obj(v, at);
    return { other: itemId(o.other, `${at}.other`), hotspot: stickyRef(o.hotspot, `${at}.hotspot`) };
};

/** The body of `GET /counts`: `{ counts }`. */
export const stickyCounts: Decoder<StickyCount[]> = (v, at) => list(stickyCount)(obj(v, at).counts, `${at}.counts`);

const PROPOSAL_REFUSALS: readonly Knowledge.ProposalRefusal[] = [
    'itemUnavailable',
    'moot',
    'pending',
    'dismissedBefore',
    'asIsAgainstStickies',
    'replacementUnavailable',
    'evidenceUnavailable',
];
/** Why a proposal was not taken. */
export const proposalRefusal: Decoder<Knowledge.ProposalRefusal> = oneOf(PROPOSAL_REFUSALS);

/** Why an operation was dropped. */
export const dropReason: Decoder<DropReason> = (v, at) => {
    const o = obj(v, at);
    const type = oneOf([
        'Knowledge.KnowledgeItemNotFound',
        'Knowledge.KnowledgeItemGone',
        'Knowledge.KnowledgeItemExists',
        'Knowledge.StaleOperation',
        'Knowledge.DuplicateSource',
        'Knowledge.ConflictWithoutSource',
        'Knowledge.ConflictWithItself',
        'Knowledge.RetiredItem',
        'Knowledge.MalformedProposal',
        'Knowledge.ProposalRefused',
    ] as const)(o.type, `${at}.type`);
    switch (type) {
        case 'Knowledge.KnowledgeItemNotFound':
        case 'Knowledge.KnowledgeItemGone':
        case 'Knowledge.KnowledgeItemExists':
        case 'Knowledge.RetiredItem':
            return { type, itemId: itemId(o.itemId, `${at}.itemId`) };
        case 'Knowledge.ProposalRefused':
            return { type, reason: proposalRefusal(o.reason, `${at}.reason`) };
        default:
            return { type };
    }
};

const droppedOperation: Decoder<DroppedOperation> = (v, at) => {
    const o = obj(v, at);
    return { operation: operation(o.operation, `${at}.operation`), reason: dropReason(o.reason, `${at}.reason`) };
};

/** The body of `POST /extractions`' answer. */
export const appliedExtraction: Decoder<AppliedExtraction> = (v, at) => {
    const o = obj(v, at);
    return {
        items: list(liveItem)(o.items, `${at}.items`),
        dropped: list(droppedOperation)(o.dropped, `${at}.dropped`),
        replayed: bool(o.replayed, `${at}.replayed`),
        ...(o.proposals !== undefined && { proposals: list(openProposal)(o.proposals, `${at}.proposals`) }),
    };
};

const messageKey: Decoder<Knowledge.MessageKey> = (v, at) => {
    const o = obj(v, at);
    return { session: sessionRef(o.session, `${at}.session`), message: messageRef(o.message, `${at}.message`) };
};

/** The body of a deletion's answer (`DELETE /knowledge/:id`, `DELETE /knowledge?session=`). */
export const deletion: Decoder<Deletion> = (v, at) => {
    const o = obj(v, at);
    return { items: list(itemId)(o.items, `${at}.items`), messages: list(messageKey)(o.messages, `${at}.messages`) };
};

const redactionEntry: Decoder<RedactionEntry> = (v, at) => {
    const o = obj(v, at);
    const r = obj(o.redaction, `${at}.redaction`);
    return {
        redaction: { item: itemId(r.item, `${at}.redaction.item`), messages: list(messageKey)(r.messages, `${at}.redaction.messages`) },
        cursor: str(o.cursor, `${at}.cursor`),
    };
};

/** The body of `GET /redactions`: `{ entries }`, oldest first. */
export const redactionEntries: Decoder<RedactionEntry[]> = (v, at) => list(redactionEntry)(obj(v, at).entries, `${at}.entries`);

export const actor: Decoder<Knowledge.Actor> = (v, at) => {
    const o = obj(v, at);
    const kind = oneOf(['Extractor', 'Person', 'Review'] as const)(o.kind, `${at}.kind`);
    switch (kind) {
        case 'Extractor':
            return { kind, extraction: extractionRef(o.extraction, `${at}.extraction`) };
        case 'Person':
            return { kind, user: userName(o.user, `${at}.user`) };
        case 'Review':
            return { kind, review: branded(Knowledge.makeReviewRef, str)(o.review, `${at}.review`) };
    }
};

// ---- retiring (廃止) ---------------------------------------------------------------------------------------------

/** A proposal as the store holds it, open, approved or dismissed. */
export const retirementProposal: Decoder<Knowledge.RetirementProposal> = (v, at) => {
    const o = obj(v, at);
    const reason = opt(retirementReason, o.reason, `${at}.reason`);
    const replacedBy = opt(itemId, o.replacedBy, `${at}.replacedBy`);
    const common: Knowledge.RetirementProposalCommon = {
        id: proposalId(o.id, `${at}.id`),
        item: itemId(o.item, `${at}.item`),
        action: oneOf(PROPOSAL_ACTIONS)(o.action, `${at}.action`),
        ...(reason !== undefined && { reason }),
        ...(replacedBy !== undefined && { replacedBy }),
        explanation: reasonOf(o.explanation, `${at}.explanation`),
        evidence: nonEmpty(evidence)(o.evidence, `${at}.evidence`),
        proposedBy: proposer(o.proposedBy, `${at}.proposedBy`),
        proposedAt: time(o.proposedAt, `${at}.proposedAt`),
    };
    if (Knowledge.checkRetirementProposalCommon(common).length > 0) fail(at, 'not a proposal (its reason, replacement or evidence)');
    const state = oneOf(['Open', 'Approved', 'Dismissed'] as const)(o.state, `${at}.state`);
    return state === 'Open'
        ? { ...common, state }
        : { ...common, state, decidedBy: userName(o.decidedBy, `${at}.decidedBy`), decidedAt: time(o.decidedAt, `${at}.decidedAt`) };
};

/** An open proposal: what the list of 廃止の候補 shows. */
export const openProposal: Decoder<Knowledge.OpenRetirementProposal> = (v, at) => {
    const p = retirementProposal(v, at);
    return p.state === 'Open' ? p : fail(`${at}.state`, 'expected an open proposal');
};

/** The body of `GET /proposals`: `{ proposals }`, newest first. */
export const openProposals: Decoder<Knowledge.OpenRetirementProposal[]> = (v, at) => list(openProposal)(obj(v, at).proposals, `${at}.proposals`);

/** The body of `POST /knowledge/:id/retire`: `{ reason?, replacedBy? }` (an empty object retires without a reason). */
export const retireBody: Decoder<RetirementInput> = (v, at) => {
    const o = v === undefined || v === null ? {} : obj(v, at);
    const reason = opt(retirementReason, o.reason, `${at}.reason`);
    const replacedBy = opt(itemId, o.replacedBy, `${at}.replacedBy`);
    return { ...(reason !== undefined && { reason }), ...(replacedBy !== undefined && { replacedBy }) };
};

/** The body of `POST /proposals` (the review's, through the store's port): a candidate with its evidence. */
export const retirementCandidate: Decoder<RetirementCandidate> = (v, at) => {
    const o = obj(v, at);
    const reason = opt(retirementReason, o.reason, `${at}.reason`);
    const replacedBy = opt(itemId, o.replacedBy, `${at}.replacedBy`);
    return {
        item: itemId(o.item, `${at}.item`),
        action: oneOf(PROPOSAL_ACTIONS)(o.action, `${at}.action`),
        ...(reason !== undefined && { reason }),
        ...(replacedBy !== undefined && { replacedBy }),
        explanation: reasonOf(o.explanation, `${at}.explanation`),
        evidence: nonEmpty(evidence)(o.evidence, `${at}.evidence`),
        proposedBy: proposer(o.proposedBy, `${at}.proposedBy`),
    };
};

/** A domain's error as the model's value, from an answer's error body; `undefined` when the body is not one of them. */
export type DomainError =
    | Knowledge.KnowledgeItemNotFound
    | Knowledge.KnowledgeItemGone
    | Knowledge.AlreadyRetired
    | Knowledge.NotRetired
    | Knowledge.ReplacementWithoutReason
    | Knowledge.ReplacedByItself
    | Knowledge.MalformedProposal
    | Knowledge.ProposalRefused
    | Knowledge.ProposalNotFound
    | Knowledge.ProposalDecided;

export function domainErrorOf(body: ErrorBody['error'] | undefined): DomainError | undefined {
    if (body === undefined) return undefined;
    try {
        switch (body.type) {
            case 'Knowledge.KnowledgeItemNotFound':
            case 'Knowledge.KnowledgeItemGone':
                return { type: body.type, itemId: itemId(body.itemId, 'error.itemId') };
            case 'Knowledge.ProposalNotFound':
            case 'Knowledge.ProposalDecided':
                return { type: body.type, proposalId: proposalId(body.proposalId, 'error.proposalId') };
            case 'Knowledge.ProposalRefused':
                return { type: body.type, reason: proposalRefusal(body.reason, 'error.reason') };
            case 'Knowledge.AlreadyRetired':
            case 'Knowledge.NotRetired':
            case 'Knowledge.ReplacementWithoutReason':
            case 'Knowledge.ReplacedByItself':
            case 'Knowledge.MalformedProposal':
                return { type: body.type };
            default:
                return undefined;
        }
    } catch (e) {
        if (e instanceof WireError) return undefined;
        throw e;
    }
}

/** The body of `POST /proposals/:id/approve`'s answer: `{ proposal, item }`. */
export const approvedProposal: Decoder<ApprovedProposal> = (v, at) => {
    const o = obj(v, at);
    const proposal = retirementProposal(o.proposal, `${at}.proposal`);
    return proposal.state === 'Approved' ? { proposal, item: liveItem(o.item, `${at}.item`) } : fail(`${at}.proposal.state`, 'expected an approved proposal');
};

/** The body of `POST /proposals/:id/dismiss`'s answer: the proposal, dismissed. */
export const dismissedProposal: Decoder<Knowledge.DismissedRetirementProposal> = (v, at) => {
    const p = retirementProposal(v, at);
    return p.state === 'Dismissed' ? p : fail(`${at}.state`, 'expected a dismissed proposal');
};

/** One record of the audit log (its `caller`, the Access identity the Worker recorded, is the Worker's own and not read). */
export const auditEntry: Decoder<Knowledge.AuditEntry> = (v, at) => {
    const o = obj(v, at);
    return {
        item: itemId(o.item, `${at}.item`),
        version: itemVersion(o.version, `${at}.version`),
        operation: oneOf(AUDIT_OPERATIONS)(o.operation, `${at}.operation`),
        actor: actor(o.actor, `${at}.actor`),
        ...withReason(o, at),
        at: time(o.at, `${at}.at`),
    };
};

/** The body of `POST /images`' answer: `{ id }`. */
export const imageRef: Decoder<Knowledge.ImageId> = (v, at) => imageId(obj(v, at).id, `${at}.id`);

// ---- the session's extraction switch, in the Live View -----------------------------------------------------------

/**
 * Whether the session extracts its knowledge (ADR 0031, section 3), as dt sends it to every page of the session over
 * its WebSocket: on connect, then each time the facilitator switches it (`POST /api/session/extraction`).
 */
export interface KnowledgeExtractionMessage {
    readonly type: 'knowledge.extraction';
    readonly enabled: boolean;
}

/** The body of `GET` and `POST /api/session/extraction` (the answer; the facilitator's `POST` sends `{ enabled }`). */
export interface ExtractionSwitchBody {
    readonly enabled: boolean;
}

/** The body of `GET` and `POST /api/session/extraction`'s answer: `{ enabled }`. */
export const extractionSwitch: Decoder<ExtractionSwitchBody> = (v, at) => ({ enabled: bool(obj(v, at).enabled, `${at}.enabled`) });

// ---- the published stormings (ADR 0031, section 11) -------------------------------------------------------------

/** The largest published storming taken, in bytes of its JSON (a D1 row holds at most 2 MB). */
export const MAX_PUBLISHED_BYTES = 1_500_000;

const STORMING_ID = /^[_a-zA-Z][_a-zA-Z0-9]*$/;
/** A storming's ID, as a path and the stickies' references name it. */
export const stormingId: Decoder<string> = (v, at) => {
    const s = str(v, at);
    return STORMING_ID.test(s) && s.length <= 200 ? s : fail(at, "expected a storming's ID");
};
const shortText =
    (max: number): Decoder<string> =>
    (v, at) => {
        const s = str(v, at);
        return s.length <= max ? s : fail(at, `expected at most ${max} characters`);
    };
const drawingVersion: Decoder<string> = (v, at) => {
    const s = str(v, at);
    return /^[A-Za-z0-9._:-]{1,128}$/.test(s) ? s : fail(at, 'expected a version (letters, digits, ._:-)');
};
const commitId: Decoder<string> = (v, at) => {
    const s = str(v, at);
    return /^[0-9a-f]{7,64}$/.test(s) ? s : fail(at, "expected a commit's ID (hex)");
};

const drawing = (v: unknown, at: string): PublishedStorming['drawing'] => {
    const o = obj(v, at);
    const commit = opt(commitId, o.commit, `${at}.commit`);
    return { at: time(o.at, `${at}.at`), ...(commit !== undefined && { commit }) };
};

const publishedSticky =
    (storming: string): Decoder<PublishedSticky> =>
    (v, at) => {
        const o = obj(v, at);
        const ref = stickyRef(o.ref, `${at}.ref`);
        if (!ref.startsWith(`${storming}.`)) fail(`${at}.ref`, `expected a sticky of ${storming}`);
        const label = opt(shortText(1000), o.label, `${at}.label`);
        return { ref, ...(label !== undefined && { label }) };
    };

/**
 * The body of `PUT /published/:storming`: the published form, its drawings kept as they are (objects the store does
 * not look into; the page draws them).
 */
export const publishedStorming: Decoder<PublishedStorming> = (v, at) => {
    const o = obj(v, at);
    if (o.format !== 1) fail(`${at}.format`, 'expected 1 (a later form needs a later Worker)');
    const storming = stormingId(o.storming, `${at}.storming`);
    const label = opt(shortText(1000), o.label, `${at}.label`);
    const stickies = list(publishedSticky(storming))(o.stickies, `${at}.stickies`);
    if (new Set(stickies.map((s) => s.ref)).size !== stickies.length) fail(`${at}.stickies`, 'a sticky named twice');
    const views = obj(o.views, `${at}.views`);
    const unknown = Object.keys(views).filter((k) => !PUBLISHED_LEVELS.some((l) => l === k));
    if (unknown.length) fail(`${at}.views`, `unknown level ${unknown.join(', ')}`);
    const drawings: PublishedStorming['views'] = {
        'big-picture': obj(views['big-picture'], `${at}.views.big-picture`),
        'design-level': obj(views['design-level'], `${at}.views.design-level`),
    };
    return {
        format: 1,
        storming,
        ...(label !== undefined && { label }),
        version: drawingVersion(o.version, `${at}.version`),
        drawing: drawing(o.drawing, `${at}.drawing`),
        stickies,
        views: drawings,
    };
};

const publishedEntry: Decoder<PublishedEntry> = (v, at) => {
    const o = obj(v, at);
    const label = opt(str, o.label, `${at}.label`);
    return {
        storming: stormingId(o.storming, `${at}.storming`),
        ...(label !== undefined && { label }),
        version: str(o.version, `${at}.version`),
        drawing: drawing(o.drawing, `${at}.drawing`),
        publishedAt: time(o.publishedAt, `${at}.publishedAt`),
    };
};

/** The body of `GET /published`: `{ stormings }`, by ID. */
export const publishedEntries: Decoder<PublishedEntry[]> = (v, at) => list(publishedEntry)(obj(v, at).stormings, `${at}.stormings`);

/** The body of `PUT /published/:storming`'s answer: `{ entry, changed }`. */
export const publishResult: Decoder<PublishResult> = (v, at) => {
    const o = obj(v, at);
    return { entry: publishedEntry(o.entry, `${at}.entry`), changed: bool(o.changed, `${at}.changed`) };
};

/** The body of `DELETE /published/:storming`'s answer: `{ storming, removed }`, whether there was a form to remove. */
export const unpublishResult: Decoder<boolean> = (v, at) => bool(obj(v, at).removed, `${at}.removed`);

/** The body of `GET /missing`: the stickies no published storming has, and the items about them. */
export const missingStickies: Decoder<MissingStickies> = (v, at) => {
    const o = obj(v, at);
    return { stickies: list(stickyRef)(o.stickies, `${at}.stickies`), items: list(liveItem)(o.items, `${at}.items`) };
};

/** The body of `GET /v1/projects`: `{ projects }`, the projects that have knowledge or a published storming. */
export const projectNames: Decoder<Knowledge.ProjectName[]> = (v, at) => list(projectName)(obj(v, at).projects, `${at}.projects`);

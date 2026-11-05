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
import type { AppliedExtraction, Deletion, ItemWithHistory, KnowledgeQuery, Page, RedactionEntry, StickyCount } from './application/ports.js';

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

// ---- errors -----------------------------------------------------------------------------------------------------

/**
 * The error body of every answer that is not a 2xx: the domain's errors by their type (`KnowledgeItemNotFound`, 404;
 * `KnowledgeItemGone`, 410), and the API's own.
 */
export interface ErrorBody {
    readonly error: {
        readonly type: ApiErrorType | 'KnowledgeItemNotFound' | 'KnowledgeItemGone';
        readonly itemId?: string;
        readonly message?: string;
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
    /** 501: a route reserved for a later version (`PUT /published/:storming`). */
    | 'NotImplemented'
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
    const { type, itemId, message } = v.error;
    const known = [...API_ERROR_TYPES, 'KnowledgeItemNotFound' as const, 'KnowledgeItemGone' as const].find((t) => t === type) ?? 'Internal';
    return { type: known, ...(typeof itemId === 'string' && { itemId }), ...(typeof message === 'string' && { message }) };
}

const API_ERROR_TYPES: readonly ApiErrorType[] = [
    'BadRequest',
    'Unauthenticated',
    'Forbidden',
    'NotFound',
    'IdempotencyKeyReused',
    'ImageRejected',
    'NotImplemented',
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
const AUDIT_OPERATIONS: readonly Knowledge.AuditOperation[] = ['add', 'addSource', 'rewrite', 'revise', 'linkConflict', 'correct', 'delete', 'restore'];

export const itemId: Decoder<Knowledge.KnowledgeItemId> = branded(Knowledge.makeKnowledgeItemId, str);
export const imageId: Decoder<Knowledge.ImageId> = branded(Knowledge.makeImageId, str);
export const projectName: Decoder<Knowledge.ProjectName> = branded(Knowledge.makeProjectName, str);
export const userName: Decoder<Knowledge.UserName> = branded(Knowledge.makeUserName, str);
export const sessionRef: Decoder<Knowledge.SessionRef> = branded(Knowledge.makeSessionRef, str);
export const stickyRef: Decoder<Knowledge.StickyRef> = branded(Knowledge.makeStickyRef, str);
const messageRef: Decoder<Knowledge.MessageRef> = branded(Knowledge.makeMessageRef, str);
export const itemVersion: Decoder<Knowledge.ItemVersion> = branded(Knowledge.makeItemVersion, num);
const reasonOf: Decoder<Knowledge.Reason> = branded(Knowledge.makeReason, str);

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

/** An item's content: its text, labels and the stickies it is about, each once. */
export const itemContent: Decoder<Knowledge.ItemContent> = (v, at) => {
    const o = obj(v, at);
    const content: Knowledge.ItemContent = {
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

const operation: Decoder<Knowledge.Operation> = (v, at) => {
    const o = obj(v, at);
    const kind = oneOf(['Add', 'AddSource', 'Update', 'Conflict'] as const)(o.kind, `${at}.kind`);
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
    }
};

/** The body of `POST /extractions`. */
export const extraction: Decoder<Knowledge.Extraction> = (v, at) => {
    const o = obj(v, at);
    return { by: extractionRef(o.by, `${at}.by`), operations: list(operation)(o.operations, `${at}.operations`) };
};

/** An item as the store holds it, live or deleted. */
export const knowledgeItem: Decoder<Knowledge.KnowledgeItem> = (v, at) => {
    const o = obj(v, at);
    const createdIn = opt(sessionRef, o.createdIn, `${at}.createdIn`);
    const common: Knowledge.KnowledgeItemCommon = {
        id: itemId(o.id, `${at}.id`),
        content: itemContent(o.content, `${at}.content`),
        sources: list(source)(o.sources, `${at}.sources`),
        version: itemVersion(o.version, `${at}.version`),
        conflictsWith: list(itemId)(o.conflictsWith, `${at}.conflictsWith`),
        ...(createdIn !== undefined && { createdIn }),
        createdAt: time(o.createdAt, `${at}.createdAt`),
        updatedAt: time(o.updatedAt, `${at}.updatedAt`),
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

/** The body of `GET /counts`: `{ counts }`. */
export const stickyCounts: Decoder<StickyCount[]> = (v, at) => list(stickyCount)(obj(v, at).counts, `${at}.counts`);

/** Why an operation was dropped. */
export const dropReason: Decoder<DropReason> = (v, at) => {
    const o = obj(v, at);
    const type = oneOf([
        'KnowledgeItemNotFound',
        'KnowledgeItemGone',
        'KnowledgeItemExists',
        'StaleOperation',
        'DuplicateSource',
        'ConflictWithoutSource',
        'ConflictWithItself',
    ] as const)(o.type, `${at}.type`);
    switch (type) {
        case 'KnowledgeItemNotFound':
        case 'KnowledgeItemGone':
        case 'KnowledgeItemExists':
            return { type, itemId: itemId(o.itemId, `${at}.itemId`) };
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

const actor: Decoder<Knowledge.Actor> = (v, at) => {
    const o = obj(v, at);
    const kind = oneOf(['Extractor', 'Person'] as const)(o.kind, `${at}.kind`);
    return kind === 'Extractor' ? { kind, extraction: extractionRef(o.extraction, `${at}.extraction`) } : { kind, user: userName(o.user, `${at}.user`) };
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

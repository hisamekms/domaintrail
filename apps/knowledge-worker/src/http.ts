// The store's HTTP API (ADR 0031, section 8), under `/v1/projects/:project`:
//
// | Method and path                    | Store call        | Action  |
// |------------------------------------|-------------------|---------|
// | GET /knowledge                     | search            | read    |
// | DELETE /knowledge?session=         | deleteSession     | delete  |
// | GET /knowledge/:id[?history=1]     | get               | read    |
// | PATCH /knowledge/:id               | correct           | correct |
// | DELETE /knowledge/:id              | delete            | delete  |
// | POST /knowledge/:id/restore        | restore (元に戻す) | delete  |
// | POST /knowledge/:id/unlink         | unlinkConflict    | correct |
// | POST /knowledge/:id/images         | attachImage       | correct |
// | GET /counts?storming=              | counts            | read    |
// | POST /extractions                  | applyExtraction   | extract |
// | POST /images, GET /images/:id      | putImage, getImage | correct, read |
// | GET /audit                         | audit             | read    |
// | GET /redactions?after=             | the redaction log | read    |
// | PUT /published/:storming           | (`dt publish`: not yet) | — |
//
// Every call needs a caller (access.ts); a write needs a person or a writing service token, and every call passes
// `authorize(user, project, action)`, which today allows everyone. The bodies are the protocol's
// (contexts/knowledge/src/protocol.ts).
import { authorize, idempotencyKey, type Knowledge, type KnowledgeAction } from '@domaintrail/knowledge';
import {
    ACTOR_HEADER,
    API_VERSION,
    IDEMPOTENCY_HEADER,
    IMAGE_MEDIA_TYPES,
    MAX_IMAGE_BYTES,
    WireError,
    extraction as extractionOf,
    imageId,
    itemContent,
    itemId,
    knowledgeQueryOf,
    unlinkBody,
    limitOf,
    projectName,
    sessionRef,
    userName,
    type ApiErrorType,
    type ErrorBody,
} from '@domaintrail/knowledge/protocol';
import { callerName, identify, mayWrite, type AccessSettings, type AccessTokenVerifier, type Caller } from './access.js';
import type { Env } from './env.js';
import { D1KnowledgeStore, IdempotencyKeyReused } from './store.js';

export interface HandleOptions {
    readonly now?: () => Date;
    /** The verifier of Access tokens (tests); default one per isolate and settings. */
    readonly verifier?: (settings: AccessSettings) => AccessTokenVerifier;
}

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

const failure = (status: number, type: ErrorBody['error']['type'], message?: string, itemId?: string): Response =>
    json({ error: { type, ...(itemId !== undefined && { itemId }), ...(message !== undefined && { message }) } } satisfies ErrorBody, status);

const apiError = (status: number, type: ApiErrorType, message?: string): Response => failure(status, type, message);

/** The domain's error of a call about an item, as its answer. */
const itemError = (e: Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone): Response =>
    e.type === 'KnowledgeItemNotFound' ? failure(404, e.type, 'no such item', e.itemId) : failure(410, e.type, 'the item is deleted', e.itemId);

/** A percent-encoded part of a path or a header, decoded; a `WireError` when it is not one. */
function decoded(part: string, at: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        throw new WireError(`${at}: not percent-encoded text`);
    }
}

export async function handle(request: Request, env: Env, options: HandleOptions = {}): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== API_VERSION) return apiError(404, 'NotFound', `no route ${url.pathname}`);

    const caller = await identify(request, env, options.verifier);
    if (!('kind' in caller)) return apiError(caller.status, caller.type, caller.message);

    if (parts.length === 2 && parts[1] === 'health' && request.method === 'GET') return json({ api: API_VERSION, caller: callerName(caller) });
    if (parts[1] !== 'projects' || parts.length < 4) return apiError(404, 'NotFound', `no route ${url.pathname}`);

    try {
        const project = projectName(decoded(parts[2], 'project'), 'project');
        return await route(request, url, parts.slice(3), project, caller, env, options);
    } catch (e) {
        if (e instanceof WireError) return apiError(400, 'BadRequest', e.message);
        if (e instanceof IdempotencyKeyReused) return apiError(409, 'IdempotencyKeyReused', e.message);
        const message = e instanceof Error ? e.message : String(e);
        if (/no such table/i.test(message)) return apiError(503, 'StoreNotMigrated', "the D1 database lacks the template's tables: apply its migrations");
        console.error(`knowledge-worker: ${request.method} ${url.pathname} failed: ${message}`);
        return apiError(500, 'Internal', "the store failed; see the Worker's logs");
    }
}

async function route(
    request: Request,
    url: URL,
    path: readonly string[],
    project: Knowledge.ProjectName,
    caller: Caller,
    env: Env,
    options: HandleOptions,
): Promise<Response> {
    const store = new D1KnowledgeStore(env.DB, env.IMAGES, { caller: callerName(caller), ...(options.now && { now: options.now }) });
    const method = request.method;
    const [resource, id, sub] = path;
    const q = url.searchParams;

    /** The caller, if it may do `action`; otherwise the answer refusing it. */
    const allow = (action: KnowledgeAction): Response | undefined => {
        if (action !== 'read' && !mayWrite(caller, env)) return apiError(403, 'Forbidden', 'this service token may only read (WRITER_TOKENS)');
        const user = userName(callerName(caller), 'caller');
        // `visibility: members` is stored (the projects table) but not enforced yet: authorize allows everyone
        if (!authorize(user, project, action)) return apiError(403, 'Forbidden', `not allowed to ${action} in ${project}`);
        return undefined;
    };
    /** Who a person's action is by: a person caller acts for itself, a service token for the participant it names. */
    const actor = (): Knowledge.UserName => {
        if (caller.kind === 'person') return userName(caller.email, 'caller');
        const named = request.headers.get(ACTOR_HEADER);
        if (!named) throw new WireError(`${ACTOR_HEADER}: a service token acts for a person, named in this header`);
        return userName(decoded(named, ACTOR_HEADER), ACTOR_HEADER);
    };
    const body = async (): Promise<unknown> => {
        try {
            return await request.json();
        } catch {
            throw new WireError('body: not JSON');
        }
    };

    switch (resource) {
        case 'knowledge': {
            if (id === undefined) {
                if (method === 'GET') return allow('read') ?? json(await store.search(project, knowledgeQueryOf(q)));
                if (method === 'DELETE') {
                    const session = sessionRef(q.get('session'), 'session');
                    return allow('delete') ?? json(await store.deleteSession(project, session, actor()));
                }
                break;
            }
            const item = itemId(decoded(id, 'id'), 'id');
            if (sub === undefined) {
                if (method === 'GET') {
                    const denied = allow('read');
                    if (denied) return denied;
                    const found = await store.get(project, item, { history: q.get('history') === '1' });
                    return found ? json(found) : itemError({ type: 'KnowledgeItemNotFound', itemId: item });
                }
                if (method === 'PATCH') {
                    const denied = allow('correct');
                    if (denied) return denied;
                    const b = await body();
                    const content = itemContent(typeof b === 'object' && b !== null && 'content' in b ? b.content : undefined, 'content');
                    const r = await store.correct(project, item, content, actor());
                    return r.ok ? json(r.value) : itemError(r.error);
                }
                if (method === 'DELETE') {
                    const denied = allow('delete');
                    if (denied) return denied;
                    const r = await store.delete(project, item, actor());
                    return r.ok ? json(r.value) : itemError(r.error);
                }
            }
            if (sub === 'restore' && method === 'POST') {
                const denied = allow('delete');
                if (denied) return denied;
                const r = await store.restore(project, item, actor());
                return r.ok ? json(r.value) : itemError(r.error);
            }
            if (sub === 'unlink' && method === 'POST') {
                const denied = allow('correct');
                if (denied) return denied;
                const other = unlinkBody(await body(), 'body');
                const r = await store.unlinkConflict(project, item, other, actor());
                return r.ok ? json({ items: r.value }) : itemError(r.error);
            }
            if (sub === 'images' && method === 'POST') {
                const denied = allow('correct');
                if (denied) return denied;
                const image = await imageOf(request);
                if (image instanceof Response) return image;
                const r = await store.attachImage(project, item, image, actor());
                return r.ok ? json(r.value) : itemError(r.error);
            }
            break;
        }
        case 'counts':
            if (method === 'GET' && id === undefined) {
                const storming = q.get('storming');
                if (!storming || !/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(storming)) throw new WireError('storming: expected the name of a storming');
                return allow('read') ?? json({ counts: await store.counts(project, storming) });
            }
            break;
        case 'extractions':
            if (method === 'POST' && id === undefined) {
                const denied = allow('extract');
                if (denied) return denied;
                const extraction = extractionOf(await body(), 'body');
                const key = request.headers.get(IDEMPOTENCY_HEADER);
                if (key !== null && key !== idempotencyKey(extraction.by))
                    throw new WireError(`${IDEMPOTENCY_HEADER}: expected ${idempotencyKey(extraction.by)}, the extraction's session and number`);
                return json(await store.applyExtraction(project, extraction));
            }
            break;
        case 'images':
            if (method === 'POST' && id === undefined) {
                const denied = allow('correct');
                if (denied) return denied;
                const image = await imageOf(request);
                if (image instanceof Response) return image;
                return json({ id: await store.putImage(project, image) }, 201);
            }
            if (method === 'GET' && id !== undefined && sub === undefined) {
                const denied = allow('read');
                if (denied) return denied;
                const image = await store.getImage(project, imageId(decoded(id, 'id'), 'id'));
                if (!image) return apiError(404, 'NotFound', 'no such image');
                return new Response(image.bytes.slice(), {
                    headers: {
                        'Content-Type': image.mediaType,
                        'X-Content-Type-Options': 'nosniff',
                        'Content-Security-Policy': "default-src 'none'",
                        'Cache-Control': 'private, max-age=300',
                    },
                });
            }
            break;
        case 'audit':
            if (method === 'GET' && id === undefined) {
                const denied = allow('read');
                if (denied) return denied;
                const limit = q.has('limit') ? limitOf(q.get('limit'), 'limit') : undefined;
                const itemFilter = q.has('item') ? itemId(q.get('item'), 'item') : undefined;
                const cursor = q.get('cursor') ?? undefined;
                const page = await store.auditPage(project, {
                    ...(itemFilter !== undefined && { item: itemFilter }),
                    ...(limit !== undefined && { limit }),
                    ...(cursor !== undefined && { cursor }),
                });
                // each record with the Access identity of the request that made it
                return json({ items: page.items.map((r) => ({ ...r.entry, caller: r.caller })), ...(page.next !== undefined && { next: page.next }) });
            }
            break;
        case 'redactions':
            if (method === 'GET' && id === undefined) {
                const denied = allow('read');
                if (denied) return denied;
                const limit = q.has('limit') ? Math.min(Number(q.get('limit')) || 1000, 1000) : 1000;
                return json({ entries: await store.redactionsPage(project, q.get('after') ?? undefined, limit) });
            }
            break;
        case 'published':
            if (method === 'PUT' && id !== undefined) return apiError(501, 'NotImplemented', '`dt publish` is not served by this version of the Worker');
            break;
    }
    return apiError(404, 'NotFound', `no route ${method} ${url.pathname}`);
}

/** The image of a request's body, or the answer refusing it (its media type, its size). */
async function imageOf(request: Request): Promise<{ mediaType: string; bytes: Uint8Array } | Response> {
    const mediaType = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_MEDIA_TYPES.some((t) => t === mediaType)) return apiError(415, 'ImageRejected', `an image is one of ${IMAGE_MEDIA_TYPES.join(', ')}`);
    const declared = Number(request.headers.get('Content-Length') ?? '0');
    if (declared > MAX_IMAGE_BYTES) return apiError(413, 'ImageRejected', `an image is at most ${MAX_IMAGE_BYTES} bytes`);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) return apiError(400, 'BadRequest', 'an empty image');
    if (bytes.byteLength > MAX_IMAGE_BYTES) return apiError(413, 'ImageRejected', `an image is at most ${MAX_IMAGE_BYTES} bytes`);
    return { mediaType, bytes };
}

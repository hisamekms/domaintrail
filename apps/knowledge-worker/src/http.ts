// The store's HTTP API (ADR 0031, section 8), under `/v1/projects/:project`:
//
// | Method and path                    | Store call        | Action  |
// |------------------------------------|-------------------|---------|
// | GET /knowledge                     | search            | read    |
// | DELETE /knowledge?session=         | deleteSession     | delete  |
// | GET /knowledge/:id[?history=1]     | get               | read    |
// | PATCH /knowledge/:id               | correct           | correct |
// | POST /knowledge/:id/bookmark        | setBookmark       | correct |
// | DELETE /knowledge/:id              | delete            | delete  |
// | POST /knowledge/:id/restore        | restore (元に戻す) | delete  |
// | POST /knowledge/:id/unlink         | unlinkConflict    | correct |
// | POST /knowledge/:id/hand-over      | handOverToHotspot | correct |
// | POST /knowledge/:id/images         | attachImage       | correct |
// | POST /knowledge/:id/retire         | retire (廃止する)  | correct |
// | POST /knowledge/:id/unretire       | unretire (廃止を取り消す) | correct |
// | GET /proposals                     | proposals (廃止の候補) | read |
// | POST /proposals                    | propose (the review's) | extract |
// | POST /proposals/:id/approve        | approveProposal   | correct |
// | POST /proposals/:id/dismiss        | dismissProposal   | correct |
// | GET /counts?storming=              | counts            | read    |
// | POST /extractions                  | applyExtraction   | extract |
// | POST /images, GET /images/:id      | putImage, getImage | correct, read |
// | GET /audit                         | audit             | read    |
// | GET /redactions?after=             | the redaction log | read    |
// | PUT /published/:storming           | putPublished (`dt publish`) | publish |
// | DELETE /published/:storming        | deletePublished (`dt publish --prune`) | publish |
// | GET /published, /published/:storming | listPublished, publishedBody | read |
// | GET /missing                       | missingStickies   | read    |
//
// and `GET /v1/projects` (the projects the page offers). Every call needs a caller (access.ts); a write needs a person
// or a writing service token, publishing a writing service token only (CI's `dt publish`, never a page), and every call
// passes `authorize(user, project, action)`, which today allows everyone. A person's write must come from the Worker's
// own page (its `Origin`), so that another site cannot make a signed-in reader's browser delete. The bodies are the
// protocol's (contexts/knowledge/src/protocol.ts).
import { authorize, idempotencyKey, type Knowledge, type KnowledgeAction } from '@domaintrail/knowledge';
import {
    ACTOR_HEADER,
    API_VERSION,
    IDEMPOTENCY_HEADER,
    IMAGE_MEDIA_TYPES,
    MAX_IMAGE_BYTES,
    MAX_PUBLISHED_BYTES,
    WireError,
    domainErrorBody,
    domainErrorStatus,
    extraction as extractionOf,
    proposalId,
    retireBody,
    retirementCandidate,
    type DomainError,
    imageId,
    itemContent,
    bookmarkBody,
    itemId,
    knowledgeQueryOf,
    unlinkBody,
    handOverBody,
    limitOf,
    projectName,
    publishedStorming,
    sessionRef,
    stormingId,
    userName,
    type ApiErrorType,
    type ErrorBody,
} from '@domaintrail/knowledge/protocol';
import { callerName, identify, mayWrite, type AccessSettings, type AccessTokenVerifier, type Caller } from './access.js';
import type { Env } from './env.js';
import { D1KnowledgeStore, IdempotencyKeyReused } from './store.js';
import { deletePublished, listPublished, missingStickies, projectList, publishedBody, putPublished } from './published.js';

export interface HandleOptions {
    readonly now?: () => Date;
    /** The verifier of Access tokens (tests); default one per isolate and settings. */
    readonly verifier?: (settings: AccessSettings) => AccessTokenVerifier;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const failure = (status: number, type: ErrorBody['error']['type'], message?: string, itemId?: string): Response =>
    json({ error: { type, ...(itemId !== undefined && { itemId }), ...(message !== undefined && { message }) } } satisfies ErrorBody, status);

const apiError = (status: number, type: ApiErrorType, message?: string): Response => failure(status, type, message);

/** The domain's error of a call about an item, as its answer. */
const itemError = (e: Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone): Response =>
    e.type === 'Knowledge.KnowledgeItemNotFound' ? failure(404, e.type, 'no such item', e.itemId) : failure(410, e.type, 'the item is deleted', e.itemId);

/** A domain's error (a store call's `Result`), as its answer. */
const domainError = (e: DomainError): Response => json(domainErrorBody(e), domainErrorStatus(e.type));

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
    const crossOrigin = refusedOrigin(request, url, caller);
    if (crossOrigin) return crossOrigin;

    try {
        if (parts.length === 2 && parts[1] === 'projects' && request.method === 'GET') return json({ projects: await projectList(env.DB) });
        if (parts[1] !== 'projects' || parts.length < 4) return apiError(404, 'NotFound', `no route ${url.pathname}`);
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
        // the drawing comes from the repository's `main`, through CI: a person (the page) never replaces it
        if (action === 'publish' && caller.kind !== 'service')
            return apiError(403, 'Forbidden', '`dt publish`, with a writing service token, publishes; a person does not');
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
                    return found ? json(found) : itemError({ type: 'Knowledge.KnowledgeItemNotFound', itemId: item });
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
            if (sub === 'bookmark' && method === 'POST') {
                const denied = allow('correct');
                if (denied) return denied;
                const bookmarked = bookmarkBody(await body(), 'body');
                const r = await store.setBookmark(project, item, bookmarked, actor());
                return r.ok ? json(r.value) : itemError(r.error);
            }
            if (sub === 'unlink' && method === 'POST') {
                const denied = allow('correct');
                if (denied) return denied;
                const other = unlinkBody(await body(), 'body');
                const r = await store.unlinkConflict(project, item, other, actor());
                return r.ok ? json({ items: r.value }) : itemError(r.error);
            }
            if (sub === 'hand-over' && method === 'POST') {
                const denied = allow('correct');
                if (denied) return denied;
                const { other, hotspot } = handOverBody(await body(), 'body');
                const r = await store.handOverToHotspot(project, item, other, hotspot, actor());
                return r.ok ? json({ items: r.value }) : itemError(r.error);
            }
            if (sub === 'retire' && method === 'POST') {
                const denied = allow('correct');
                if (denied) return denied;
                const r = await store.retire(project, item, retireBody(await body(), 'body'), actor());
                return r.ok ? json(r.value) : domainError(r.error);
            }
            if (sub === 'unretire' && method === 'POST') {
                const denied = allow('correct');
                if (denied) return denied;
                const r = await store.unretire(project, item, actor());
                return r.ok ? json(r.value) : domainError(r.error);
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
        case 'proposals': {
            if (id === undefined) {
                if (method === 'GET') return allow('read') ?? json({ proposals: await store.proposals(project) });
                if (method === 'POST') {
                    const denied = allow('extract');
                    if (denied) return denied;
                    const r = await store.propose(project, retirementCandidate(await body(), 'body'));
                    return r.ok ? json(r.value) : domainError(r.error);
                }
                break;
            }
            const proposal = proposalId(decoded(id, 'id'), 'id');
            if (sub === 'approve' && method === 'POST') {
                const denied = allow('correct');
                if (denied) return denied;
                const r = await store.approveProposal(project, proposal, actor());
                return r.ok ? json(r.value) : domainError(r.error);
            }
            if (sub === 'dismiss' && method === 'POST') {
                const denied = allow('correct');
                if (denied) return denied;
                const r = await store.dismissProposal(project, proposal, actor());
                return r.ok ? json(r.value) : domainError(r.error);
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
        case 'published': {
            if (id === undefined) {
                if (method === 'GET') return allow('read') ?? json({ stormings: await listPublished(env.DB, project) });
                break;
            }
            if (sub !== undefined) break;
            const storming = stormingId(decoded(id, 'storming'), 'storming');
            if (method === 'GET') {
                const denied = allow('read');
                if (denied) return denied;
                const kept = await publishedBody(env.DB, project, storming);
                return kept === undefined ? apiError(404, 'NotFound', `${storming} is not published`) : new Response(kept, { headers: JSON_HEADERS });
            }
            if (method === 'PUT') {
                const denied = allow('publish');
                if (denied) return denied;
                const form = await publishedOf(request);
                if (form instanceof Response) return form;
                if (form.storming !== storming) throw new WireError(`body.storming: expected ${storming}, the storming of the path`);
                return json(await putPublished(env.DB, project, form, callerName(caller), (options.now ?? ((): Date => new Date()))()));
            }
            if (method === 'DELETE') {
                const denied = allow('publish');
                if (denied) return denied;
                // idempotent: removing a storming that is not published answers `removed: false`
                return json({ storming, removed: await deletePublished(env.DB, project, storming) });
            }
            break;
        }
        case 'missing':
            if (method === 'GET' && id === undefined) return allow('read') ?? json(await missingStickies(env.DB, store, project));
            break;
    }
    return apiError(404, 'NotFound', `no route ${method} ${url.pathname}`);
}

/**
 * A person's write that does not come from the Worker's own page: refused (403), so that another site cannot make the
 * browser of someone signed in to Access delete or correct (the Access cookie goes with any request to the host). A
 * browser sends `Origin` with every write; a call without one (a script with a token) is not a browser's. Service tokens
 * (dt) are not browsers.
 */
function refusedOrigin(request: Request, url: URL, caller: Caller): Response | undefined {
    if (caller.kind !== 'person' || request.method === 'GET' || request.method === 'HEAD') return undefined;
    const origin = request.headers.get('Origin');
    const site = request.headers.get('Sec-Fetch-Site');
    if ((origin !== null && origin !== url.origin) || (site !== null && site !== 'same-origin'))
        return apiError(403, 'CrossOrigin', "a person's change is taken from the Worker's own page only");
    return undefined;
}

/** The published form of a request's body, or the answer refusing it (its size). */
async function publishedOf(request: Request): Promise<ReturnType<typeof publishedStorming> | Response> {
    const tooLarge = (): Response => apiError(413, 'TooLarge', `a published storming is at most ${MAX_PUBLISHED_BYTES} bytes of JSON`);
    if (Number(request.headers.get('Content-Length') ?? '0') > MAX_PUBLISHED_BYTES) return tooLarge();
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_PUBLISHED_BYTES) return tooLarge();
    let body: unknown;
    try {
        body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new WireError('body: not JSON');
    }
    return publishedStorming(body, 'body');
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

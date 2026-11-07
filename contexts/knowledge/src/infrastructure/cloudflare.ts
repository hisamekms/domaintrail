// The `cloudflare` adapter of the knowledge store (ADR 0031, section 5): an HTTP client of the Worker that the user
// deploys from DomainTrail's template (apps/knowledge-worker), behind Cloudflare Access. It sends the Access service
// token's headers with every call; Access checks them before the Worker sees the request, and the Worker records the
// token's identity in its audit log beside the person a call acts for (`X-Knowledge-Actor`).
//
// The domain's answers (an item missing or deleted) come back as the port's `Result`s; anything else that is not a
// 2xx — Access refusing the token, the Worker failing, a body that is not the API's — rejects the promise with a
// `KnowledgeStoreError`, as the port says (`application/ports.ts`).
import { err, ok, type Knowledge, type Result } from '../generated/index.js';
import type { AuditQuery, KnowledgeImage, KnowledgeQuery, KnowledgeStore, Page, RedactionEntry, StormingPublisher } from '../application/ports.js';
import type { DomainError } from '../protocol.js';
import { idempotencyKey } from '../domain/extraction.js';
import {
    ACCESS_CLIENT_ID_HEADER,
    ACCESS_CLIENT_SECRET_HEADER,
    ACTOR_HEADER,
    IDEMPOTENCY_HEADER,
    MAX_ABOUT,
    MAX_LIMIT,
    appliedExtraction,
    approvedProposal,
    auditEntry,
    decodeErrorBody,
    deletion,
    dismissedProposal,
    domainErrorOf,
    openProposals,
    retirementProposal,
    imageRef,
    itemWithHistory,
    knowledgeQueryParams,
    liveItem,
    liveItems,
    page,
    projectPath,
    publishedEntries,
    publishResult,
    redactionEntries,
    stickyCounts,
    unpublishResult,
    type Decoder,
} from '../protocol.js';

/** An Access service token (Zero Trust → Access → Service credentials). */
export interface AccessServiceToken {
    readonly clientId: string;
    readonly clientSecret: string;
}

export interface CloudflareKnowledgeStoreSettings {
    /** The Worker's URL (`https://knowledge.example.com`); a path under it is kept as a prefix. */
    readonly url: string;
    /** The service token sent to Access; none for a Worker reached without Access (`wrangler dev` on loopback). */
    readonly serviceToken?: AccessServiceToken;
    /** How long a call may take. Default: 15 s. */
    readonly timeoutMs?: number;
    readonly fetch?: typeof fetch;
}

/** The store could not be reached, refused the call, or answered what the API does not. */
export class KnowledgeStoreError extends Error {
    override readonly name = 'KnowledgeStoreError';
    constructor(
        message: string,
        /** The HTTP status, when there was an answer. */
        readonly status?: number,
        /** The error body's type (`Forbidden`, `StoreNotMigrated`, …), when the Worker sent one. */
        readonly type?: string,
    ) {
        super(message);
    }
}

/** The page size the adapter reads the redaction log in. */
const REDACTIONS_PAGE = 1000;

interface Call {
    readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    readonly query?: URLSearchParams;
    readonly json?: unknown;
    readonly bytes?: KnowledgeImage;
    readonly headers?: Record<string, string>;
}

/** The Worker's store: the knowledge, and the published stormings that `dt publish` sends (ADR 0031, section 11). */
export interface CloudflareKnowledgeStore extends KnowledgeStore, StormingPublisher {}

/** The `KnowledgeStore` of a Worker of the template, reached through Access. */
export function cloudflareKnowledgeStore(settings: CloudflareKnowledgeStoreSettings): CloudflareKnowledgeStore {
    const base = new URL(settings.url);
    const prefix = base.pathname.replace(/\/+$/, '');
    const doFetch = settings.fetch ?? fetch;
    const timeoutMs = settings.timeoutMs ?? 15_000;

    const request = async (project: Knowledge.ProjectName, path: string, call: Call = {}): Promise<Response> => {
        const url = new URL(base);
        url.pathname = `${prefix}${projectPath(project)}${path}`;
        url.search = call.query?.toString() ?? '';
        const headers = new Headers(call.headers);
        if (settings.serviceToken) {
            headers.set(ACCESS_CLIENT_ID_HEADER, settings.serviceToken.clientId);
            headers.set(ACCESS_CLIENT_SECRET_HEADER, settings.serviceToken.clientSecret);
        }
        let body: BodyInit | undefined;
        if (call.json !== undefined) {
            headers.set('Content-Type', 'application/json');
            body = JSON.stringify(call.json);
        } else if (call.bytes) {
            headers.set('Content-Type', call.bytes.mediaType);
            // a copy over an ArrayBuffer of its own (the bytes may be a view of a larger or shared buffer)
            body = call.bytes.bytes.slice();
        }
        const method = call.method ?? 'GET';
        let res: Response;
        try {
            // a redirect is Access sending an unauthenticated caller to its sign-in page: never follow it
            res = await doFetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        } catch (e) {
            throw new KnowledgeStoreError(`the knowledge store at ${base.origin} could not be reached: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (res.status >= 300 && res.status < 400)
            throw new KnowledgeStoreError(
                `Cloudflare Access did not let the call through (a redirect to sign in): check knowledge's service token and the Access policy of ${base.origin}`,
                res.status,
                'Unauthenticated',
            );
        return res;
    };

    /** The error of an answer that is not a 2xx, with the Worker's error body when it sent one. */
    const failure = async (res: Response, what: string): Promise<KnowledgeStoreError> => {
        const text = await res.text().catch(() => '');
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = undefined;
        }
        const body = decodeErrorBody(parsed);
        const detail = body ? `${body.type}${body.message ? `: ${body.message}` : ''}` : `HTTP ${res.status}`;
        return new KnowledgeStoreError(`the knowledge store refused ${what} (${detail})`, res.status, body?.type);
    };

    const read = async <T>(res: Response, d: Decoder<T>, what: string): Promise<T> => {
        if (!res.ok) throw await failure(res, what);
        let json: unknown;
        try {
            json = await res.json();
        } catch {
            throw new KnowledgeStoreError(`the knowledge store answered ${what} with what is not JSON (is the URL the Worker's?)`, res.status);
        }
        try {
            return d(json, 'body');
        } catch (e) {
            throw new KnowledgeStoreError(
                `the knowledge store answered ${what} with what the API does not: ${e instanceof Error ? e.message : String(e)}`,
                res.status,
            );
        }
    };

    /**
     * The domain's error of an answer about an item: 404 with `KnowledgeItemNotFound` (missing, or removed by the sweep),
     * 410 with `KnowledgeItemGone` (deleted); `undefined` for any other answer. A 404 of another kind (no such route:
     * the URL is not the Worker's) is a failure.
     */
    const missing = async (res: Response, what: string): Promise<'KnowledgeItemNotFound' | 'KnowledgeItemGone' | undefined> => {
        if (res.status !== 404 && res.status !== 410) return undefined;
        const body = decodeErrorBody(await res.json().catch(() => undefined));
        if (res.status === 404 && body?.type === 'KnowledgeItemNotFound') return body.type;
        if (res.status === 410 && body?.type === 'KnowledgeItemGone') return body.type;
        throw new KnowledgeStoreError(`the knowledge store refused ${what} (HTTP ${res.status})`, res.status, body?.type);
    };

    /** An answer about an item that is never `KnowledgeItemGone` (deleting, restoring): a 410 is a failure. */
    const notFoundOr = async <T>(
        res: Response,
        d: Decoder<T>,
        id: Knowledge.KnowledgeItemId,
        what: string,
    ): Promise<Result<T, Knowledge.KnowledgeItemNotFound>> => {
        const gone = await missing(res, what);
        if (gone === 'KnowledgeItemNotFound') return err({ type: gone, itemId: id });
        if (gone) throw new KnowledgeStoreError(`the knowledge store refused ${what} (${gone})`, res.status, gone);
        return ok(await read(res, d, what));
    };

    /**
     * The domain's error of an answer, when it is one of `types` (a 4xx whose body names it); `undefined` for a 2xx. Any
     * other answer is a failure.
     */
    const refusal = async <T extends DomainError['type']>(
        res: Response,
        what: string,
        types: readonly T[],
    ): Promise<Extract<DomainError, { readonly type: T }> | undefined> => {
        if (res.ok) return undefined;
        if (res.status >= 400 && res.status < 500) {
            const text = await res.text().catch(() => '');
            let parsed: unknown;
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = undefined;
            }
            const body = decodeErrorBody(parsed);
            const e = domainErrorOf(body);
            const wanted = (x: DomainError | undefined): x is Extract<DomainError, { readonly type: T }> => x !== undefined && types.some((t) => t === x.type);
            if (wanted(e)) return e;
            throw new KnowledgeStoreError(`the knowledge store refused ${what} (${body?.type ?? `HTTP ${res.status}`})`, res.status, body?.type);
        }
        throw await failure(res, what);
    };

    const proposalPath = (id: Knowledge.RetirementProposalId): string => `/proposals/${encodeURIComponent(id)}`;

    const itemPath = (id: Knowledge.KnowledgeItemId): string => `/knowledge/${encodeURIComponent(id)}`;
    const actor = (by: Knowledge.UserName): Record<string, string> => ({ [ACTOR_HEADER]: encodeURIComponent(by) });

    const search = async (project: Knowledge.ProjectName, query: KnowledgeQuery): Promise<Page<Knowledge.LiveKnowledgeItem>> =>
        read(await request(project, '/knowledge', { query: knowledgeQueryParams(query) }), page(liveItem), 'a search');

    return {
        async about(project, stickies) {
            const found = new Map<string, Knowledge.LiveKnowledgeItem>();
            for (let i = 0; i < stickies.length; i += MAX_ABOUT) {
                const about = stickies.slice(i, i + MAX_ABOUT);
                let cursor: string | undefined;
                do {
                    const p = await search(project, { about, limit: MAX_LIMIT, ...(cursor !== undefined && { cursor }) });
                    for (const item of p.items) found.set(item.id, item);
                    cursor = p.next;
                } while (cursor !== undefined);
            }
            // newest first, as the Worker lists them
            return [...found.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        },

        search,

        async counts(project, storming) {
            return read(await request(project, '/counts', { query: new URLSearchParams({ storming }) }), stickyCounts, 'the counts');
        },

        async get(project, id, options) {
            const query = options?.history ? new URLSearchParams({ history: '1' }) : undefined;
            const res = await request(project, itemPath(id), { ...(query && { query }) });
            if (res.status === 404) {
                await res.body?.cancel();
                return undefined;
            }
            return read(res, itemWithHistory, `reading ${id}`);
        },

        async applyExtraction(project, extraction) {
            const res = await request(project, '/extractions', {
                method: 'POST',
                json: extraction,
                headers: { [IDEMPOTENCY_HEADER]: idempotencyKey(extraction.by) },
            });
            return read(res, appliedExtraction, `extraction ${idempotencyKey(extraction.by)}`);
        },

        async correct(project, id, corrected, by) {
            const res = await request(project, itemPath(id), { method: 'PATCH', json: { content: corrected }, headers: actor(by) });
            const what = `correcting ${id}`;
            const gone = await missing(res, what);
            return gone ? err({ type: gone, itemId: id }) : ok(await read(res, liveItem, what));
        },

        async unlinkConflict(project, id, other, by) {
            const res = await request(project, `${itemPath(id)}/unlink`, { method: 'POST', json: { other }, headers: actor(by) });
            const what = `unlinking ${id} from ${other}`;
            const gone = await missing(res, what);
            return gone ? err({ type: gone, itemId: id }) : ok(await read(res, liveItems, what));
        },

        async handOverToHotspot(project, id, other, hotspot, by) {
            const res = await request(project, `${itemPath(id)}/hand-over`, { method: 'POST', json: { other, hotspot }, headers: actor(by) });
            const what = `handing ${id} and ${other} over to ${hotspot}`;
            const gone = await missing(res, what);
            return gone ? err({ type: gone, itemId: id }) : ok(await read(res, liveItems, what));
        },

        async delete(project, id, by) {
            const res = await request(project, itemPath(id), { method: 'DELETE', headers: actor(by) });
            return notFoundOr(res, deletion, id, `deleting ${id}`);
        },

        async deleteSession(project, session, by) {
            const res = await request(project, '/knowledge', { method: 'DELETE', query: new URLSearchParams({ session }), headers: actor(by) });
            return read(res, deletion, `deleting the items of session ${session}`);
        },

        async restore(project, id, by) {
            const res = await request(project, `${itemPath(id)}/restore`, { method: 'POST', headers: actor(by) });
            return notFoundOr(res, liveItem, id, `restoring ${id}`);
        },

        async retire(project, id, retirement, by) {
            const res = await request(project, `${itemPath(id)}/retire`, { method: 'POST', json: retirement, headers: actor(by) });
            const what = `retiring ${id}`;
            const e = await refusal(res, what, [
                'KnowledgeItemNotFound',
                'KnowledgeItemGone',
                'AlreadyRetired',
                'ReplacementWithoutReason',
                'ReplacedByItself',
                'ProposalRefused',
            ] as const);
            return e ? err(e) : ok(await read(res, liveItem, what));
        },

        async unretire(project, id, by) {
            const res = await request(project, `${itemPath(id)}/unretire`, { method: 'POST', headers: actor(by) });
            const what = `unretiring ${id}`;
            const e = await refusal(res, what, ['KnowledgeItemNotFound', 'KnowledgeItemGone', 'NotRetired'] as const);
            return e ? err(e) : ok(await read(res, liveItem, what));
        },

        async propose(project, candidate) {
            const res = await request(project, '/proposals', { method: 'POST', json: candidate });
            const what = `a proposal about ${candidate.item}`;
            const e = await refusal(res, what, ['MalformedProposal', 'ProposalRefused'] as const);
            return e ? err(e) : ok(await read(res, retirementProposal, what));
        },

        async proposals(project) {
            return read(await request(project, '/proposals'), openProposals, 'the proposals');
        },

        async approveProposal(project, id, by) {
            const res = await request(project, `${proposalPath(id)}/approve`, { method: 'POST', headers: actor(by) });
            const what = `approving ${id}`;
            const e = await refusal(res, what, ['ProposalNotFound', 'ProposalDecided', 'ProposalRefused'] as const);
            return e ? err(e) : ok(await read(res, approvedProposal, what));
        },

        async dismissProposal(project, id, by) {
            const res = await request(project, `${proposalPath(id)}/dismiss`, { method: 'POST', headers: actor(by) });
            const what = `dismissing ${id}`;
            const e = await refusal(res, what, ['ProposalNotFound', 'ProposalDecided'] as const);
            return e ? err(e) : ok(await read(res, dismissedProposal, what));
        },

        async redactions(project, after) {
            const entries: RedactionEntry[] = [];
            let cursor = after;
            for (;;) {
                const query = new URLSearchParams({ limit: String(REDACTIONS_PAGE), ...(cursor !== undefined && { after: cursor }) });
                const got = await read(await request(project, '/redactions', { query }), redactionEntries, 'the redaction log');
                entries.push(...got);
                if (got.length < REDACTIONS_PAGE) return entries;
                cursor = got[got.length - 1].cursor;
            }
        },

        async audit(project, query: AuditQuery) {
            const params = new URLSearchParams();
            if (query.item !== undefined) params.set('item', query.item);
            if (query.limit !== undefined) params.set('limit', String(query.limit));
            if (query.cursor !== undefined) params.set('cursor', query.cursor);
            return read(await request(project, '/audit', { query: params }), page(auditEntry), 'the audit log');
        },

        async putImage(project, image) {
            return read(await request(project, '/images', { method: 'POST', bytes: image }), imageRef, 'an image');
        },

        async getImage(project, id) {
            const res = await request(project, `/images/${encodeURIComponent(id)}`);
            if (res.status === 404) {
                await res.body?.cancel();
                return undefined;
            }
            if (!res.ok) throw await failure(res, `image ${id}`);
            return { mediaType: res.headers.get('Content-Type') ?? 'application/octet-stream', bytes: new Uint8Array(await res.arrayBuffer()) };
        },

        async publish(project, published) {
            const res = await request(project, `/published/${encodeURIComponent(published.storming)}`, { method: 'PUT', json: published });
            return read(res, publishResult, `publishing ${published.storming}`);
        },

        async published(project) {
            return read(await request(project, '/published'), publishedEntries, 'the published stormings');
        },

        async unpublish(project, storming) {
            const res = await request(project, `/published/${encodeURIComponent(storming)}`, { method: 'DELETE' });
            return read(res, unpublishResult, `removing the published ${storming}`);
        },
    };
}

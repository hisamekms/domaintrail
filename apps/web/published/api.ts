// The Worker's API as its read-only page calls it, on its own origin with the reader's Access cookie (ADR 0031,
// sections 8 and 11): the knowledge through the panels' `KnowledgeApi`, the published stormings, and the items about
// stickies missing from them. The answers are decoded with the store's protocol. An expired Access session answers a
// redirect to its sign-in: the page is loaded again, which signs in.
import type { Knowledge, MissingStickies, PublishedEntry, PublishedStorming } from '@domaintrail/knowledge';
import {
    API_VERSION,
    approvedProposal,
    decodeErrorBody,
    deletion,
    dismissedProposal,
    openProposals,
    itemWithHistory,
    liveItem,
    liveItems,
    missingStickies,
    page,
    projectNames,
    publishedEntries,
    publishedStorming,
    stickyCounts,
    type Decoder,
} from '@domaintrail/knowledge/protocol';
import { allAbout, type KnowledgeApi } from '../knowledge/api';

/** A call the Worker refused, or that did not reach it. */
export class PageApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly type: string,
    ) {
        super(message);
    }
}

type Body = { readonly json: unknown } | { readonly blob: Blob };

const enc = encodeURIComponent;

async function call<T>(path: string, decode: Decoder<T>, init: { method?: string; body?: Body } = {}): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`/${API_VERSION}${path}`, {
            method: init.method ?? 'GET',
            credentials: 'same-origin',
            redirect: 'manual',
            ...(init.body && {
                headers: { 'Content-Type': 'blob' in init.body ? init.body.blob.type : 'application/json' },
                body: 'blob' in init.body ? init.body.blob : JSON.stringify(init.body.json),
            }),
        });
    } catch (e) {
        throw new PageApiError(e instanceof Error ? e.message : String(e), 0, 'Network');
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        // Access wants the reader to sign in again: the page itself goes through its sign-in
        location.reload();
        throw new PageApiError('Sign in again.', 0, 'SignInRequired');
    }
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
        const error = decodeErrorBody(body);
        throw new PageApiError(error?.message ?? `HTTP ${res.status}`, res.status, error?.type ?? 'HttpError');
    }
    return decode(body, 'body');
}

/** The knowledge of a project, as the panels read and change it on the Worker's page (no session: no hotspot). */
export function workerKnowledgeApi(project: string): KnowledgeApi {
    const base = `/projects/${enc(project)}`;
    const item = (id: string): string => `${base}/knowledge/${enc(id)}`;
    const search = (query: URLSearchParams): ReturnType<KnowledgeApi['search']> => call(`${base}/knowledge?${query.toString()}`, page(liveItem));
    return {
        counts: (storming) => call(`${base}/counts?storming=${enc(storming)}`, stickyCounts),
        search,
        about: (sticky) => allAbout(search, sticky),
        get: (id) =>
            call(`${item(id)}?history=1`, itemWithHistory).catch((e: unknown) => {
                if (e instanceof PageApiError && (e.status === 404 || e.status === 410)) return undefined;
                throw e;
            }),
        correct: (id, content) => call(item(id), liveItem, { method: 'PATCH', body: { json: { content } } }),
        setBookmark: (id, bookmarked) => call(`${item(id)}/bookmark`, liveItem, { method: 'POST', body: { json: { bookmarked } } }),
        delete: (id) => call(item(id), deletion, { method: 'DELETE' }),
        restore: (id) => call(`${item(id)}/restore`, liveItem, { method: 'POST' }),
        unlink: (id, other) => call(`${item(id)}/unlink`, liveItems, { method: 'POST', body: { json: { other } } }),
        attachImage: (id, file) => call(`${item(id)}/images`, liveItem, { method: 'POST', body: { blob: file } }),
        retire: (id, retirement) => call(`${item(id)}/retire`, liveItem, { method: 'POST', body: { json: retirement } }),
        unretire: (id) => call(`${item(id)}/unretire`, liveItem, { method: 'POST' }),
        proposals: () => call(`${base}/proposals`, openProposals),
        approve: (proposal) => call(`${base}/proposals/${enc(proposal)}/approve`, approvedProposal, { method: 'POST' }),
        dismiss: (proposal) => call(`${base}/proposals/${enc(proposal)}/dismiss`, dismissedProposal, { method: 'POST' }),
        imageUrl: (id) => `/${API_VERSION}${base}/images/${enc(id)}`,
        hotspots: false,
    };
}

/** What the page reads besides the knowledge. */
export const publishedApi = {
    /** The projects that have knowledge or a published storming. */
    projects: (): Promise<Knowledge.ProjectName[]> => call('/projects', projectNames),
    /** The published stormings of a project. */
    list: (project: string): Promise<PublishedEntry[]> => call(`/projects/${enc(project)}/published`, publishedEntries),
    /** A storming's published form. */
    storming: (project: string, storming: string): Promise<PublishedStorming> =>
        call(`/projects/${enc(project)}/published/${enc(storming)}`, publishedStorming),
    /** The items about stickies that no published storming has. */
    missing: (project: string): Promise<MissingStickies> => call(`/projects/${enc(project)}/missing`, missingStickies),
};

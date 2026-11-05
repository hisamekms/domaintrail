// The knowledge as the panels read and change it (`KnowledgeApi`), and dt's API that a session's page calls for it
// (`/api/session/knowledge`, apps/dt/src/server/session/knowledge.ts): the answers are the store's values as JSON,
// decoded with the store's own protocol (`@domaintrail/knowledge/protocol`). A session without a store answers 404: the
// page then shows no knowledge at all. The Worker's read-only page gives the panels its own (apps/web/published).
import { createContext, useContext } from 'react';
import type { Knowledge, ItemWithHistory, Page, StickyCount, Deletion } from '@domaintrail/knowledge';
import { deletion, extractionSwitch, itemWithHistory, liveItem, liveItems, page, stickyCounts, type Decoder } from '@domaintrail/knowledge/protocol';
import { isSignInRedirect, reloadForSignIn, SAME_ORIGIN } from '../app/sign-in';
import type { ClearedHandOver, HandOver, HandOvers } from './model';
import { SessionApiError } from '../session/api';

const BASE = '/api/session/knowledge';

/** Two items' IDs, else undefined. */
const pairOf = (v: unknown): readonly [string, string] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const [a, b]: unknown[] = v;
    return typeof a === 'string' && typeof b === 'string' ? [a, b] : undefined;
};

/**
 * The body of `GET /api/session/knowledge/hand-overs`: the presses of ホットスポットにする still waiting for their run,
 * and those cleared lately with why (an unknown reason read as none found).
 */
const handOvers: Decoder<HandOvers> = (v, at) => {
    const list: unknown = typeof v === 'object' && v !== null ? Reflect.get(v, 'handOvers') : undefined;
    const cleared: unknown = typeof v === 'object' && v !== null ? Reflect.get(v, 'cleared') : undefined;
    if (!Array.isArray(list)) throw new Error(`${at}.handOvers: expected a list`);
    const field = (h: unknown, key: string): unknown => (typeof h === 'object' && h !== null ? Reflect.get(h, key) : undefined);
    const pending = list.flatMap((h: unknown): HandOver[] => {
        const request = field(h, 'request');
        const items = pairOf(field(h, 'items'));
        return typeof request === 'string' && items ? [{ request, items }] : [];
    });
    const reasons = (Array.isArray(cleared) ? cleared : []).flatMap((h: unknown): ClearedHandOver[] => {
        const items = pairOf(field(h, 'items'));
        const reason = field(h, 'reason');
        return items ? [{ items, reason: reason === 'several' || reason === 'ended' ? reason : 'none' }] : [];
    });
    return { pending, cleared: reasons };
};
/** Whether the session extracts its knowledge (ADR 0031, section 3): read by anyone, switched by the facilitator. */
const EXTRACTION = '/api/session/extraction';

/** A POST's body: JSON, or an image's bytes with their type. */
type Post = { readonly json: unknown } | { readonly blob: Blob };

async function call<T>(path: string, decode: Decoder<T>, init?: Post, base: string = BASE): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`${base}${path}`, {
            ...(init && {
                method: 'POST',
                headers: { 'content-type': 'blob' in init ? init.blob.type : 'application/json' },
                body: 'blob' in init ? init.blob : JSON.stringify(init.json),
            }),
            ...SAME_ORIGIN,
        });
    } catch (e) {
        throw new SessionApiError('Network', 0, e instanceof Error ? e.message : String(e));
    }
    if (isSignInRedirect(res)) {
        reloadForSignIn();
        throw new SessionApiError('SignInRequired', 0, 'Sign in again.');
    }
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
        const error: unknown = typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined;
        const field = (k: string): string | undefined => {
            const v: unknown = typeof error === 'object' && error !== null && k in error ? Reflect.get(error, k) : undefined;
            return typeof v === 'string' ? v : undefined;
        };
        throw new SessionApiError(field('type') ?? 'HttpError', res.status, field('message'));
    }
    return decode(body, 'body');
}

const enc = encodeURIComponent;

/** What the knowledge's panels ask of the store, through dt (a session's page) or the Worker (its read-only page). */
export interface KnowledgeApi {
    /** Per sticky of a storming that has items: whether one is in a conflict. */
    counts(storming: string): Promise<StickyCount[]>;
    /** A page of the items that match. */
    search(query: URLSearchParams): Promise<Page<Knowledge.LiveKnowledgeItem>>;
    /** The items about one sticky (newest first; every page). */
    about(sticky: string): Promise<Knowledge.LiveKnowledgeItem[]>;
    /** An item with its earlier versions; undefined when it is gone. */
    get(id: string): Promise<ItemWithHistory | undefined>;
    correct(id: string, content: unknown): Promise<Knowledge.LiveKnowledgeItem>;
    delete(id: string): Promise<Deletion>;
    restore(id: string): Promise<Knowledge.LiveKnowledgeItem>;
    unlink(id: string, other: string): Promise<Knowledge.LiveKnowledgeItem[]>;
    attachImage(id: string, file: Blob): Promise<Knowledge.LiveKnowledgeItem>;
    /** Where the page shows an image of the knowledge from. */
    imageUrl(id: string): string;
    /** A conflict can be made a hotspot (a message to the session's AI): only where there is a session. */
    readonly hotspots: boolean;
    /** ホットスポットにする pressed, its message sent (ADR 0031, section 4): only where there is a session. */
    pressHotspot?(request: string, items: readonly [string, string]): Promise<unknown>;
}

/** The items about one sticky, every page of `search`'s, newest first. */
export async function allAbout(search: KnowledgeApi['search'], sticky: string): Promise<Knowledge.LiveKnowledgeItem[]> {
    const items: Knowledge.LiveKnowledgeItem[] = [];
    let cursor: string | undefined;
    do {
        const p = await search(new URLSearchParams({ about: sticky, limit: '200', ...(cursor !== undefined && { cursor }) }));
        items.push(...p.items);
        cursor = p.next;
    } while (cursor !== undefined);
    return items;
}

export const knowledgeApi = {
    /** Per sticky of a storming that has items: whether one is in a conflict. */
    counts: (storming: string): Promise<StickyCount[]> => call(`/counts?storming=${enc(storming)}`, stickyCounts),
    /** A page of the items that match. */
    search: (query: URLSearchParams): Promise<Page<Knowledge.LiveKnowledgeItem>> => call(`?${query.toString()}`, page(liveItem)),
    /** The items about one sticky (newest first; every page). */
    about: (sticky: string): Promise<Knowledge.LiveKnowledgeItem[]> => allAbout((q) => call(`?${q.toString()}`, page(liveItem)), sticky),
    /** An item with its earlier versions; undefined when it is gone. */
    get: (id: string): Promise<ItemWithHistory | undefined> =>
        call(`/items/${enc(id)}?history=1`, itemWithHistory).catch((e: unknown) => {
            if (e instanceof SessionApiError && (e.status === 404 || e.status === 410)) return undefined;
            throw e;
        }),
    correct: (id: string, content: unknown): Promise<Knowledge.LiveKnowledgeItem> => call(`/items/${enc(id)}/correct`, liveItem, { json: { content } }),
    delete: (id: string): Promise<Deletion> => call(`/items/${enc(id)}/delete`, deletion, { json: {} }),
    restore: (id: string): Promise<Knowledge.LiveKnowledgeItem> => call(`/items/${enc(id)}/restore`, liveItem, { json: {} }),
    unlink: (id: string, other: string): Promise<Knowledge.LiveKnowledgeItem[]> => call(`/items/${enc(id)}/unlink`, liveItems, { json: { other } }),
    attachImage: (id: string, file: Blob): Promise<Knowledge.LiveKnowledgeItem> => call(`/items/${enc(id)}/images`, liveItem, { blob: file }),
    /** The conflicts being made hotspots, and those whose press was cleared lately (ADR 0031, section 4). */
    handOvers: (): Promise<HandOvers> => call('/hand-overs', handOvers),
    /** ホットスポットにする pressed, its message sent: the conflict shows as being made a hotspot until its run ends. */
    pressHotspot: (request: string, items: readonly [string, string]): Promise<unknown> => call('/hand-overs', (v) => v, { json: { request, items } }),
    /** Whether the session extracts its knowledge (404 without a store). */
    extraction: async (): Promise<boolean> => (await call('', extractionSwitch, undefined, EXTRACTION)).enabled,
    /** The facilitator switches the session's extraction on or off; the answer is the state now. */
    setExtraction: async (enabled: boolean): Promise<boolean> => (await call('', extractionSwitch, { json: { enabled } }, EXTRACTION)).enabled,
};

/** Where the page shows an image of the knowledge from. */
export const imageUrl = (id: string): string => `${BASE}/images/${enc(id)}`;

/** The knowledge of a session's page, through dt. */
export const sessionKnowledgeApi: KnowledgeApi = { ...knowledgeApi, imageUrl, hotspots: true };

/** The API the panels below use: the session's, unless a page provides its own. */
export const KnowledgeApiContext = createContext<KnowledgeApi>(sessionKnowledgeApi);
export const useKnowledgeApi = (): KnowledgeApi => useContext(KnowledgeApiContext);

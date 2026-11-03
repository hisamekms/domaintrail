import { useEffect, useState } from 'react';
import type { LaidOutGraph } from '@domaintrail/visualization';
import { fetchServer } from '../app/sign-in';

/**
 * The compact layouts (「詰めて表示」, printing) of the pushed graphs: the server lays a graph out compactly on request
 * (`/api/compact`), and the page keeps what it got here, by graph and shape, so that switching back and forth (and
 * printing with Ctrl+P, which cannot wait for a request) finds it at once. Focused Structure Views are asked for with
 * `spacing=compact` instead (`view/graph.ts`).
 */

/** Number of compact layouts kept (the least recently fetched go first). */
const KEPT = 40;

const layouts = new Map<string, LaidOutGraph>();
const pending = new Map<string, Promise<LaidOutGraph | null>>();

/** A graph's key in the cache: its ID and shape (a changed graph is laid out again). */
export const compactCacheKey = (graph: Pick<LaidOutGraph, 'id' | 'signature'>): string => `${graph.id}|${graph.signature}`;

/** The compact layout of `graph` the page has, if any (the graph itself when it is laid out compactly already). */
export function cachedCompact(graph: LaidOutGraph): LaidOutGraph | undefined {
    if (graph.spacing === 'compact') return graph;
    return layouts.get(compactCacheKey(graph));
}

/** Keeps a compact layout (exported for tests). */
export function keepCompact(graph: LaidOutGraph): void {
    const key = compactCacheKey(graph);
    layouts.delete(key);
    layouts.set(key, graph);
    if (layouts.size > KEPT) layouts.delete(layouts.keys().next().value!);
}

/**
 * The compact layout of a pushed graph: the cached one, or one asked of the server. Null when the server has none (the
 * graph is gone) or the request fails; the layout it answers may be of a newer version of the graph.
 */
export function fetchCompact(graph: LaidOutGraph): Promise<LaidOutGraph | null> {
    const cached = cachedCompact(graph);
    if (cached) return Promise.resolve(cached);
    const key = compactCacheKey(graph);
    const running = pending.get(key);
    if (running) return running;
    const request = fetchServer(`/api/compact?${new URLSearchParams({ graph: graph.id })}`)
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the response of our own server's api/compact
        .then((r) => (r.ok ? (r.json() as Promise<LaidOutGraph>) : null))
        .then((laid) => {
            if (laid) keepCompact(laid);
            return laid;
        })
        .catch(() => null)
        .finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
}

/**
 * What a canvas draws of `graph`: its compact layout while `compact` is on and the page has it (asking the server for it
 * when it does not), the graph as pushed otherwise (also while the compact one loads).
 */
export function useCompactGraph<G extends LaidOutGraph | null | undefined>(graph: G, compact: boolean): G | LaidOutGraph {
    const [, setLoaded] = useState(0);
    const wanted = compact && graph ? graph : undefined;
    const key = wanted ? compactCacheKey(wanted) : undefined;
    useEffect(() => {
        if (!wanted || cachedCompact(wanted)) return;
        let cancelled = false;
        void fetchCompact(wanted).then(() => {
            if (!cancelled) setLoaded((n) => n + 1);
        });
        return () => {
            cancelled = true;
        };
        // the key stands for the graph
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    return (wanted && cachedCompact(wanted)) ?? graph;
}

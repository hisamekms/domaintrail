// The page's knowledge (ADR 0031, section 10): whether the session has a store, the marks of the storming shown, the
// stickies an opened item lights up, deleting with 10 seconds to undo, and whether the session extracts (section 3).
// What is shown is read again whenever dt says the knowledge changed (`knowledge.changed`, after an extraction or
// anyone's change) and after this page's own; the extraction's state follows dt's `knowledge.extraction`. The conflicts
// being made hotspots (ホットスポットにする pressed, its run not ended) are read with it.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { firstDeclarations } from '@domaintrail/storming';
import type { DisplayMode } from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import type { ViewSocket } from '../app/useViewSocket';
import { nameIn } from '../model-utils';
import { SessionApiError } from '../session/api';
import { knowledgeApi, type KnowledgeApi } from './api';
import { extractionOfMessage, makingHotspots, marksOf, type StickyMark } from './model';

/** How long a deletion can be undone on the page (ADR 0031, section 7; the store keeps it longer). */
export const UNDO_MS = 10_000;

export interface KnowledgeView {
    /** The session has a knowledge store (false until known, and without one). */
    readonly available: boolean;
    /** Bumped whenever the knowledge changed: what shows it reads again. */
    readonly version: number;
    /** The marks of the stickies of the storming shown, by canvas element (`es/<Storming>/<Local>`). */
    readonly marks: ReadonlyMap<string, StickyMark>;
    /** The stickies the opened item is about, lit on the canvas. */
    readonly lit: readonly string[];
    readonly setLit: (stickies: readonly string[]) => void;
    /** The item deleted last, while it can be undone. */
    readonly undoable: string | undefined;
    remove(id: string): Promise<void>;
    undo(): Promise<void>;
    /** This page changed the knowledge. */
    changed(): void;
    /** A sticky's name as the canvas shows it. */
    label(sticky: string): string;
    /** Selects a sticky on the canvas. */
    select(sticky: string): void;
    /** Whether the session extracts its knowledge; undefined until known and without a store. */
    readonly extraction: boolean | undefined;
    /** The facilitator switches the extraction on or off. */
    setExtraction(enabled: boolean): Promise<void>;
    /** The conflicts being made hotspots, by `pairKey` (ADR 0031, section 4); none where there is no session. */
    readonly makingHotspots?: ReadonlySet<string>;
    /** The last failure, said once. */
    readonly error: string | undefined;
    readonly setError: (error: string | undefined) => void;
}

export const KnowledgeContext = createContext<KnowledgeView | undefined>(undefined);

/**
 * Deleting with 元に戻す for `UNDO_MS` (ADR 0031, section 7), the same on a session's page and on the Worker's: the
 * item deleted last, while it can be undone; `deleted` after a deletion, `changed` after either, `failed` with why.
 */
export function useDeletion(
    api: Pick<KnowledgeApi, 'delete' | 'restore'>,
    events: { readonly changed: () => void; readonly deleted: () => void; readonly failed: (e: unknown) => void },
): { readonly undoable: string | undefined; readonly remove: (id: string) => Promise<void>; readonly undo: () => Promise<void> } {
    const [undoable, setUndoable] = useState<string | undefined>();
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);
    const remove = async (id: string): Promise<void> => {
        try {
            await api.delete(id);
            clearTimeout(timer.current);
            setUndoable(id);
            timer.current = setTimeout(() => setUndoable(undefined), UNDO_MS);
            events.deleted();
            events.changed();
        } catch (e) {
            events.failed(e);
        }
    };
    const undo = async (): Promise<void> => {
        if (!undoable) return;
        clearTimeout(timer.current);
        setUndoable(undefined);
        try {
            await api.restore(undoable);
            events.changed();
        } catch (e) {
            events.failed(e);
        }
    };
    return { undoable, remove, undo };
}
export const useKnowledgeView = (): KnowledgeView | undefined => useContext(KnowledgeContext);

export function useKnowledge(input: {
    readonly socket: ViewSocket;
    /** A session serves the page (only then is the knowledge asked for). */
    readonly session: boolean;
    /** The storming the canvas shows, if any. */
    readonly storming: string | undefined;
    readonly stormings: readonly StormingView[];
    readonly mode: DisplayMode;
    readonly select: (selection: string) => void;
}): KnowledgeView {
    const { socket, session, storming, stormings, mode, select } = input;
    const [available, setAvailable] = useState(false);
    const [version, setVersion] = useState(0);
    const [marks, setMarks] = useState<ReadonlyMap<string, StickyMark>>(new Map());
    const [lit, setLitState] = useState<readonly string[]>([]);
    const [error, setError] = useState<string | undefined>();
    const [extraction, setExtractionState] = useState<boolean | undefined>();
    const [making, setMaking] = useState<ReadonlySet<string>>(new Set());
    const changed = useCallback(() => setVersion((v) => v + 1), []);

    // dt says the knowledge changed: read it again
    useEffect(
        () =>
            socket.subscribe((message) => {
                const type: string = message.type;
                if (type === 'knowledge.changed') changed();
                const enabled = extractionOfMessage(message);
                if (enabled !== undefined) setExtractionState(enabled);
            }),
        [socket, changed],
    );
    // whether the session extracts, read once (dt sends it on connect too, perhaps before this page listened); none
    // without a store (404)
    useEffect(() => {
        if (!session) return;
        let stale = false;
        knowledgeApi.extraction().then(
            (enabled) => !stale && setExtractionState((known) => known ?? enabled),
            () => undefined,
        );
        return () => {
            stale = true;
        };
    }, [session]);

    // the marks of the storming shown (and whether there is a store at all: a session without one answers 404)
    useEffect(() => {
        if (!session || !storming) return;
        let stale = false;
        knowledgeApi.counts(storming).then(
            (counts) => {
                if (stale) return;
                setAvailable(true);
                setMarks(marksOf(counts));
            },
            (e: unknown) => {
                if (stale) return;
                if (e instanceof SessionApiError && e.status === 404) setAvailable(false);
                setMarks(new Map());
            },
        );
        return () => {
            stale = true;
        };
    }, [session, storming, version]);
    // the conflicts being made hotspots: read again with the knowledge (dt tells a press and its end as a change)
    useEffect(() => {
        if (!session) return;
        let stale = false;
        knowledgeApi.handOvers().then(
            (h) => !stale && setMaking(makingHotspots(h)),
            () => !stale && setMaking(new Set()),
        );
        return () => {
            stale = true;
        };
    }, [session, version]);
    // a session's page without a storming shown still learns whether there is a store
    useEffect(() => {
        if (!session || storming) return;
        knowledgeApi.search(new URLSearchParams({ limit: '1' })).then(
            () => setAvailable(true),
            () => setAvailable(false),
        );
    }, [session, storming]);

    const setLit = useCallback((stickies: readonly string[]) => setLitState((old) => (old.join() === stickies.join() ? old : stickies)), []);

    const failed = (e: unknown): void => setError(e instanceof Error ? e.message : String(e));

    const { undoable, remove, undo } = useDeletion(knowledgeApi, { changed, deleted: () => setLitState([]), failed });

    const setExtraction = async (enabled: boolean): Promise<void> => {
        try {
            setExtractionState(await knowledgeApi.setExtraction(enabled));
        } catch (e) {
            failed(e);
        }
    };

    const labels = useMemo(() => new Map(stormings.map((s) => [s.id, firstDeclarations(s.storming)] as const)), [stormings]);
    const label = useCallback(
        (sticky: string): string => {
            const dot = sticky.indexOf('.');
            const local = sticky.slice(dot + 1);
            return nameIn(mode, local, labels.get(sticky.slice(0, dot))?.get(local)?.label);
        },
        [labels, mode],
    );

    return {
        available,
        version,
        marks,
        lit,
        setLit,
        undoable,
        remove,
        undo,
        changed,
        label,
        select: (sticky) => select(`es/${sticky.replace('.', '/')}`),
        extraction,
        setExtraction,
        makingHotspots: making,
        error,
        setError,
    };
}

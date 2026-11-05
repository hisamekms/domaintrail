// The page's knowledge (ADR 0031, section 10): whether the session has a store, the marks of the storming shown, the
// stickies an opened item lights up, deleting with 10 seconds to undo, and whether the session extracts (section 3).
// What is shown is read again whenever dt says the knowledge changed (`knowledge.changed`, after an extraction or
// anyone's change) and after this page's own; the extraction's state follows dt's `knowledge.extraction`. The conflicts
// being made hotspots (ホットスポットにする pressed, its run not ended) are read with it. The ナレッジ list's filters are
// the page's, so that an opened item's label chip, wherever it is, shows the list filtered by its label.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { firstDeclarations } from '@domaintrail/storming';
import type { DisplayMode } from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import type { ViewSocket } from '../app/useViewSocket';
import { nameIn } from '../model-utils';
import { SessionApiError } from '../session/api';
import { knowledgeApi, type KnowledgeApi } from './api';
import {
    clearedReasons,
    extractionOfMessage,
    makingHotspots,
    marksOf,
    NO_FILTERS,
    onlyLabel,
    type ClearedReason,
    type Filters,
    type LabelChip,
    type StickyMark,
} from './model';

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
    /** Why a conflict's press of ホットスポットにする got its buttons back lately, by `pairKey`. */
    readonly clearedHotspots?: ReadonlyMap<string, ClearedReason>;
    /** Whether a sticky is a hotspot (the items about it and another sticky are kept together there); none: no sticky is. */
    readonly isHotspot?: (sticky: string) => boolean;
    /**
     * A source's message when this page's session holds it: who said it, named as the chat names them now (never stored
     * in the item), and going to it in the chat; none for another session's message and on the Worker's page.
     */
    readonly messageOf?: (session: string, message: string) => SourceMessage | undefined;
    /** The last failure, said once. */
    readonly error: string | undefined;
    readonly setError: (error: string | undefined) => void;
    /** The ナレッジ list's filters, kept while the list is closed. */
    readonly filters: Filters;
    readonly setFilters: (filters: Filters) => void;
    /** An opened item's label chip pressed: the ナレッジ list shown, filtered by that label alone (`onlyLabel`). */
    readonly filterByLabel: (chip: LabelChip) => void;
}

/** The ナレッジ list's filters of a page, and a label chip's press: those filters, and the list shown (`showList`). */
export function useListFilters(showList: () => void): Pick<KnowledgeView, 'filters' | 'setFilters' | 'filterByLabel'> {
    const [filters, setFilters] = useState<Filters>(NO_FILTERS);
    // the page's latest: it may be made anew on each render
    const show = useRef(showList);
    show.current = showList;
    const filterByLabel = useCallback((chip: LabelChip): void => {
        setFilters(onlyLabel(chip));
        show.current();
    }, []);
    return { filters, setFilters, filterByLabel };
}

/** A source's message in this page's session: who said it, and going to it in the chat. */
export interface SourceMessage {
    readonly who: string;
    readonly open: () => void;
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
    /** Shows the ナレッジ list (the left column, at its tab). */
    readonly showList: () => void;
}): KnowledgeView {
    const { socket, session, storming, stormings, mode, select, showList } = input;
    const listFilters = useListFilters(showList);
    const [available, setAvailable] = useState(false);
    const [version, setVersion] = useState(0);
    const [marks, setMarks] = useState<ReadonlyMap<string, StickyMark>>(new Map());
    const [lit, setLitState] = useState<readonly string[]>([]);
    const [error, setError] = useState<string | undefined>();
    const [extraction, setExtractionState] = useState<boolean | undefined>();
    const [making, setMaking] = useState<ReadonlySet<string>>(new Set());
    const [cleared, setCleared] = useState<ReadonlyMap<string, ClearedReason>>(new Map());
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
            (h) => {
                if (stale) return;
                setMaking(makingHotspots(h.pending));
                setCleared(clearedReasons(h.cleared));
            },
            () => {
                if (stale) return;
                setMaking(new Set());
                setCleared(new Map());
            },
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
    const isHotspot = useCallback(
        (sticky: string): boolean => {
            const dot = sticky.indexOf('.');
            return labels.get(sticky.slice(0, dot))?.get(sticky.slice(dot + 1))?.kind === 'hotspot';
        },
        [labels],
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
        clearedHotspots: cleared,
        isHotspot,
        error,
        setError,
        ...listFilters,
    };
}

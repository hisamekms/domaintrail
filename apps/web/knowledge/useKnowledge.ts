// The page's knowledge (ADR 0031, section 10): whether the session has a store, the marks of the storming shown, the
// stickies an opened item lights up, deleting with 10 seconds to undo, and whether the session extracts (section 3).
// What is shown is read again whenever dt says the knowledge changed (`knowledge.changed`, after an extraction or
// anyone's change) and after this page's own; the extraction's state follows dt's `knowledge.extraction`.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { firstDeclarations } from '@domaintrail/storming';
import type { DisplayMode } from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import type { ViewSocket } from '../app/useViewSocket';
import { nameIn } from '../model-utils';
import { SessionApiError } from '../session/api';
import { knowledgeApi } from './api';
import { extractionOfMessage, marksOf, type StickyMark } from './model';

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
    /** The last failure, said once. */
    readonly error: string | undefined;
    readonly setError: (error: string | undefined) => void;
}

export const KnowledgeContext = createContext<KnowledgeView | undefined>(undefined);
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
    const [undoable, setUndoable] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [extraction, setExtractionState] = useState<boolean | undefined>();
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
    // a session's page without a storming shown still learns whether there is a store
    useEffect(() => {
        if (!session || storming) return;
        knowledgeApi.search(new URLSearchParams({ limit: '1' })).then(
            () => setAvailable(true),
            () => setAvailable(false),
        );
    }, [session, storming]);

    useEffect(() => () => clearTimeout(timer.current), []);

    const setLit = useCallback((stickies: readonly string[]) => setLitState((old) => (old.join() === stickies.join() ? old : stickies)), []);

    const failed = (e: unknown): void => setError(e instanceof Error ? e.message : String(e));

    const remove = async (id: string): Promise<void> => {
        try {
            await knowledgeApi.delete(id);
            clearTimeout(timer.current);
            setUndoable(id);
            timer.current = setTimeout(() => setUndoable(undefined), UNDO_MS);
            setLitState([]);
            changed();
        } catch (e) {
            failed(e);
        }
    };
    const undo = async (): Promise<void> => {
        if (!undoable) return;
        clearTimeout(timer.current);
        setUndoable(undefined);
        try {
            await knowledgeApi.restore(undoable);
            changed();
        } catch (e) {
            failed(e);
        }
    };

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
        error,
        setError,
    };
}

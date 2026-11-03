// The page's hooks of a session (ADR 0026): the session's state from the socket, the presence sent and received, and
// the drafts in IndexedDB. The page is in a session only once the socket sent `session.state`; under `dt view` it never
// does, so nothing here calls the session API or sends anything there.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Cursor, Me, RunActivity, SessionStateBody, ViewLocation } from '@domaintrail/collaboration/protocol';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import type { ViewSocket } from '../app/useViewSocket';
import type { DiagramCanvas } from '../view/diagram';
import { SessionApiError, sessionApi, type TargetStatuses } from './api';
import {
    COMPOSER_DRAFT,
    composerScope,
    createIndexedDbDrafts,
    createMemoryDrafts,
    editDraft,
    newDraft,
    type Draft,
    type DraftScope,
    type DraftStorage,
} from './drafts';
import { EMPTY_COMPOSER, type ComposerValue } from './mentions';
import { WORKSPACE_TARGET } from './targets';
import { hasCanvas } from './location';
import { NO_PEERS, receivePresence, throttle, type Peers } from './presence';
import { adopt, disconnected, INITIAL_SESSION, receive, refetched, type SessionModel } from './state';
import type { ModelTarget, TargetDraft } from './targets';

/** The WebSocket close codes of a session (apps/dt's `WS_SESSION_CLOSED`, `WS_REVOKED`). */
const WS_SESSION_CLOSED = 4000;
const WS_REVOKED = 4001;
/** The Access token of the page expired (apps/dt's `WS_EXPIRED`): the socket reconnects; a reload signs in again. */
const WS_EXPIRED = 4002;
/** At most 20 presence updates a second (the server's interval). */
export const PRESENCE_INTERVAL_MS = 50;

export type SessionStatus = 'live' | 'closed' | 'signed-out';

export interface SessionData {
    readonly me: Me;
    readonly state: SessionStateBody;
    readonly peers: Peers;
    readonly status: SessionStatus;
    /** Each request's target as it resolves now; undefined until fetched. */
    readonly targets: TargetStatuses | undefined;
    /** Increases with each `session.state` (each connection): presence is sent again then. */
    readonly epoch: number;
    /** The last failure of a call the page made by itself (state, targets, me). */
    readonly error: string | undefined;
    /** What the running runs are doing, by run ID (the latest each reported; shown only while a run is running). */
    readonly activities: Readonly<Record<string, RunActivity>>;
}

const NO_ACTIVITIES: Readonly<Record<string, RunActivity>> = {};

const message = (e: unknown): string => (e instanceof SessionApiError ? `${e.type} (${e.status})` : e instanceof Error ? e.message : String(e));

/** The session the page is in, or undefined (not a session, or its state has not arrived yet). */
export function useSession(socket: ViewSocket, current: ViewPayload | null): SessionData | undefined {
    const { subscribe, subscribeClose } = socket;
    const [model, setModel] = useState<SessionModel>(INITIAL_SESSION);
    const [peers, setPeers] = useState<Peers>(NO_PEERS);
    const [status, setStatus] = useState<SessionStatus>('live');
    const [epoch, setEpoch] = useState(0);
    const [targets, setTargets] = useState<TargetStatuses | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [activities, setActivities] = useState<Readonly<Record<string, RunActivity>>>(NO_ACTIVITIES);

    useEffect(
        () =>
            subscribe((m) => {
                if (m.type === 'session.activities') return setActivities(m.activities);
                if (m.type === 'run.activity') return setActivities((a) => ({ ...a, [m.run]: m.activity }));
                if (m.type === 'session.state') {
                    setEpoch((e) => e + 1);
                    setStatus('live');
                }
                setModel((s) => receive(s, m));
                setPeers((p) => receivePresence(p, m));
            }),
        [subscribe],
    );

    const inSession = model.state !== undefined;
    useEffect(
        () =>
            subscribeClose((code) => {
                setModel(disconnected);
                setPeers(NO_PEERS);
                if (code === WS_SESSION_CLOSED) setStatus('closed');
                if (code === WS_EXPIRED && inSession) {
                    // the socket reconnects by itself; when the sign-in is gone, a reload lets Access sign the page in again
                    sessionApi.me().then(
                        () => undefined,
                        (e: unknown) => {
                            if (e instanceof SessionApiError && e.status === 401) location.reload();
                            else setError(message(e));
                        },
                    );
                    return;
                }
                if (code !== WS_REVOKED || !inSession) return;
                // signed out, or the role changed: who the page is now (it reconnects as that)
                sessionApi.me().then(
                    (me) => setModel((s) => ({ ...s, me })),
                    (e: unknown) => {
                        if (e instanceof SessionApiError && e.status === 401) setStatus('signed-out');
                        else setError(message(e));
                    },
                );
            }),
        [subscribeClose, inSession],
    );

    // an event that did not carry everything: the state again (taken only if it is not older than the one held)
    useEffect(() => {
        if (!model.refetch) return;
        setModel(refetched);
        sessionApi.state().then(
            (state) => setModel((s) => adopt(s, state, undefined, false)),
            (e: unknown) => setError(message(e)),
        );
    }, [model.refetch]);

    // the requests' targets against the sources now: again when a request is sent or the sources change
    const requestCount = model.state?.requests.length ?? 0;
    useEffect(() => {
        if (!inSession) return;
        const timer = setTimeout(() => {
            sessionApi.targets().then(setTargets, (e: unknown) => setError(message(e)));
        }, 200);
        return () => clearTimeout(timer);
    }, [inSession, requestCount, current]);

    return useMemo(
        () => (model.state && model.me ? { me: model.me, state: model.state, peers, status, targets, epoch, error, activities } : undefined),
        [model.state, model.me, peers, status, targets, epoch, error, activities],
    );
}

/**
 * Sends this page's presence: its location and selected target when they change (and on each new connection), its
 * cursor in page coordinates while the pointer is over a canvas (at most every 50 ms), and leaves on unload.
 */
export function usePresence(
    socket: ViewSocket,
    session: SessionData | undefined,
    canvas: DiagramCanvas | null,
    location: ViewLocation,
    selectedTarget: ModelTarget | undefined,
): void {
    const { send } = socket;
    const active = session !== undefined && session.status === 'live';
    const epoch = session?.epoch ?? 0;
    const latest = useRef({ location, selectedTarget, cursor: undefined as Cursor | undefined });
    const updates = useMemo(
        () =>
            throttle<void>(PRESENCE_INTERVAL_MS, () => {
                const { location: at, selectedTarget: target, cursor } = latest.current;
                send({ type: 'presence.update', location: at, ...(cursor && hasCanvas(at) && { cursor }), ...(target && { selectedTarget: target }) });
            }),
        [send],
    );
    useEffect(() => () => updates.cancel(), [updates]);

    const locationKey = JSON.stringify(location);
    const targetKey = JSON.stringify(selectedTarget ?? null);
    useEffect(() => {
        latest.current = { ...latest.current, location, selectedTarget };
        if (active) updates.push();
        // the keys stand for the location and the target
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, epoch, locationKey, targetKey, updates]);

    useEffect(() => {
        if (!active || !canvas) return;
        const container = canvas.container();
        const move = (e: PointerEvent): void => {
            const p = canvas.screenToPage({ x: e.clientX, y: e.clientY });
            latest.current = { ...latest.current, cursor: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 } };
            updates.push();
        };
        const leave = (): void => {
            latest.current = { ...latest.current, cursor: undefined };
            updates.push();
        };
        container.addEventListener('pointermove', move);
        container.addEventListener('pointerleave', leave);
        return () => {
            container.removeEventListener('pointermove', move);
            container.removeEventListener('pointerleave', leave);
        };
    }, [active, canvas, updates]);

    useEffect(() => {
        if (!active) return;
        const leave = (): void => {
            updates.cancel();
            send({ type: 'presence.leave' });
        };
        window.addEventListener('pagehide', leave);
        return () => window.removeEventListener('pagehide', leave);
    }, [active, send, updates]);
}

/** The drafts' storage of this browser: IndexedDB, or memory when the browser has none. */
export function defaultDraftStorage(): DraftStorage {
    return typeof indexedDB === 'undefined' ? createMemoryDrafts() : createIndexedDbDrafts(indexedDB);
}

/** How long typing waits before a draft is saved. */
const AUTOSAVE_MS = 300;

export interface Drafts {
    readonly drafts: readonly Draft[];
    readonly error: string | undefined;
    add(target: TargetDraft): void;
    edit(id: string, patch: Partial<Pick<Draft, 'body' | 'target'>>): void;
    remove(id: string): Promise<void>;
}

/** The drafts of a participant in a session: loaded from the storage, saved as they are edited. */
export function useDrafts(storage: DraftStorage, scope: DraftScope | undefined): Drafts {
    const [drafts, setDrafts] = useState<readonly Draft[]>([]);
    const [error, setError] = useState<string | undefined>();
    const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const session = scope?.session;
    const participant = scope?.participant;
    const key = useMemo(() => (session && participant ? { session, participant } : undefined), [session, participant]);

    useEffect(() => {
        setDrafts([]);
        if (!key) return;
        let cancelled = false;
        storage.load(key).then(
            (loaded) => {
                if (!cancelled) setDrafts(loaded);
            },
            (e: unknown) => setError(message(e)),
        );
        return () => {
            cancelled = true;
        };
    }, [storage, key]);

    const save = useCallback(
        (draft: Draft) => {
            if (!key) return;
            storage.save(key, draft).then(
                () => setError(undefined),
                (e: unknown) => setError(message(e)),
            );
        },
        [storage, key],
    );

    useEffect(() => {
        const pending = timers.current;
        return () => {
            for (const t of pending.values()) clearTimeout(t);
            pending.clear();
        };
    }, [key]);

    const add = useCallback(
        (target: TargetDraft) => {
            const draft = newDraft(crypto.randomUUID(), target, Date.now());
            setDrafts((ds) => [...ds, draft]);
            save(draft);
        },
        [save],
    );

    const edit = useCallback(
        (id: string, patch: Partial<Pick<Draft, 'body' | 'target'>>) => {
            setDrafts((ds) => {
                const next = editDraft(ds, id, patch, Date.now());
                const draft = next.find((d) => d.id === id);
                clearTimeout(timers.current.get(id));
                if (draft)
                    timers.current.set(
                        id,
                        setTimeout(() => {
                            timers.current.delete(id);
                            save(draft);
                        }, AUTOSAVE_MS),
                    );
                return next;
            });
        },
        [save],
    );

    const remove = useCallback(
        async (id: string) => {
            clearTimeout(timers.current.get(id));
            timers.current.delete(id);
            setDrafts((ds) => ds.filter((d) => d.id !== id));
            if (key) await storage.remove(key, id);
        },
        [storage, key],
    );

    return { drafts, error, add, edit, remove };
}

export interface ComposerDraft {
    /** The unsent request: its text and targets (empty while there is none, and until it is loaded). */
    readonly value: ComposerValue;
    readonly error: string | undefined;
    /** Changes it; it is saved shortly after typing stops. */
    setValue(value: ComposerValue): void;
    /** Forgets it (once it was sent). */
    clear(): Promise<void>;
}

const isEmpty = (v: ComposerValue): boolean => v.text === '' && v.chips.length === 0;

/** The chat composer's one unsent request of a participant in a session, kept in the drafts' storage until it is sent. */
export function useComposerDraft(storage: DraftStorage, scope: DraftScope | undefined): ComposerDraft {
    const [value, setValueState] = useState<ComposerValue>(EMPTY_COMPOSER);
    const [error, setError] = useState<string | undefined>();
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const session = scope?.session;
    const participant = scope?.participant;
    const key = useMemo(() => (session && participant ? composerScope({ session, participant }) : undefined), [session, participant]);

    useEffect(() => {
        setValueState(EMPTY_COMPOSER);
        if (!key) return;
        let cancelled = false;
        storage.load(key).then(
            (loaded) => {
                const draft = loaded.find((d) => d.id === COMPOSER_DRAFT);
                // typing before the load finished wins; a draft saved before there were chips (or people) has none
                if (!cancelled && draft) setValueState((v) => (isEmpty(v) ? { text: draft.body, chips: draft.chips ?? [], people: draft.people ?? [] } : v));
            },
            (e: unknown) => setError(message(e)),
        );
        return () => {
            cancelled = true;
            clearTimeout(timer.current);
        };
    }, [storage, key]);

    const setValue = useCallback(
        (next: ComposerValue) => {
            setValueState(next);
            clearTimeout(timer.current);
            if (!key) return;
            timer.current = setTimeout(() => {
                const now = Date.now();
                const write = isEmpty(next)
                    ? storage.remove(key, COMPOSER_DRAFT)
                    : storage.save(key, { ...newDraft(COMPOSER_DRAFT, WORKSPACE_TARGET, now), body: next.text, chips: next.chips, people: next.people });
                write.then(
                    () => setError(undefined),
                    (e: unknown) => setError(message(e)),
                );
            }, AUTOSAVE_MS);
        },
        [storage, key],
    );

    const clear = useCallback(async () => {
        clearTimeout(timer.current);
        setValueState(EMPTY_COMPOSER);
        if (key) await storage.remove(key, COMPOSER_DRAFT);
    }, [storage, key]);

    return { value, error, setValue, clear };
}

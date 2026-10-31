// The page's hooks of a session (ADR 0026): the session's state from the socket, the presence sent and received, and
// the drafts in IndexedDB. The page is in a session only once the socket sent `session.state`; under `dt view` it never
// does, so nothing here calls the session API or sends anything there.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from 'tldraw';
import type { Cursor, Me, SessionStateBody, ViewLocation } from '@domaintrail/collaboration/protocol';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import type { ViewSocket } from '../app/useViewSocket';
import { SessionApiError, sessionApi, type TargetStatuses } from './api';
import { createIndexedDbDrafts, createMemoryDrafts, editDraft, newDraft, type Draft, type DraftScope, type DraftStorage } from './drafts';
import { hasCanvas } from './location';
import { NO_PEERS, receivePresence, throttle, type Peers } from './presence';
import { adopt, disconnected, INITIAL_SESSION, receive, refetched, type SessionModel } from './state';
import type { ModelTarget, TargetDraft } from './targets';

/** The WebSocket close codes of a session (composition's `WS_SESSION_CLOSED`, `WS_REVOKED`). */
const WS_SESSION_CLOSED = 4000;
const WS_REVOKED = 4001;
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
}

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

    useEffect(
        () =>
            subscribe((m) => {
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
        () => (model.state && model.me ? { me: model.me, state: model.state, peers, status, targets, epoch, error } : undefined),
        [model.state, model.me, peers, status, targets, epoch, error],
    );
}

/**
 * Sends this page's presence: its location and selected target when they change (and on each new connection), its
 * cursor in tldraw world coordinates while the pointer is over a canvas (at most every 50 ms), and leaves on unload.
 */
export function usePresence(
    socket: ViewSocket,
    session: SessionData | undefined,
    editor: Editor | null,
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
        if (!active || !editor) return;
        const container = editor.getContainer();
        const move = (e: PointerEvent): void => {
            const p = editor.screenToPage({ x: e.clientX, y: e.clientY });
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
    }, [active, editor, updates]);

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

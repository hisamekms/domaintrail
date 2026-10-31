import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, SessionServerMessage } from '@domaintrail/collaboration/protocol';
import type { ViewPayload } from '@domaintrail/visualization/protocol';

export type Connection = 'connecting' | 'open' | 'closed';

export interface ViewState {
    current: ViewPayload | null;
    connection: Connection;
}

/** The socket of the page: the view, and in a session its other messages (not rendered yet; the session panel's). */
export interface ViewSocket extends ViewState {
    /** Listens to the session's messages (`session.*`, `request.*`, `run.*`, `revision.*`, `presence.*`); returns the unsubscribe. */
    subscribe: (listener: (message: SessionServerMessage) => void) => () => void;
    /** Sends a message to the server (presence); false when the socket is not open. */
    send: (message: ClientMessage) => boolean;
    /** Listens to the socket closing, with its close code (a session closes with 4000 or 4001); returns the unsubscribe. */
    subscribeClose: (listener: (code: number) => void) => () => void;
}

type ServerMessage = ViewPayload | SessionServerMessage;

/** Subscribes to model updates from the view server, reconnecting when the server restarts. */
export function useViewSocket(): ViewSocket {
    const [state, setState] = useState<ViewState>({ current: null, connection: 'connecting' });
    const retry = useRef(0);
    const socket = useRef<WebSocket | undefined>(undefined);
    const listeners = useRef(new Set<(message: SessionServerMessage) => void>());
    const closeListeners = useRef(new Set<(code: number) => void>());

    useEffect(() => {
        let ws: WebSocket | undefined;
        let disposed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const connect = () => {
            ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
            socket.current = ws;
            ws.onopen = () => {
                retry.current = 0;
                setState((s) => ({ ...s, connection: 'open' }));
            };
            ws.onmessage = (ev) => {
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the messages of our own server
                const message = JSON.parse(String(ev.data)) as ServerMessage;
                // the view, as always; anything else belongs to a session and never replaces the view
                if (message.type === 'update') setState({ current: message, connection: 'open' });
                else for (const listener of listeners.current) listener(message);
            };
            ws.onclose = (ev) => {
                if (disposed) return;
                for (const listener of closeListeners.current) listener(ev.code);
                setState((s) => ({ ...s, connection: 'closed' }));
                timer = setTimeout(connect, Math.min(5000, 500 * 2 ** retry.current++));
            };
        };
        connect();
        return () => {
            disposed = true;
            clearTimeout(timer);
            ws?.close();
        };
    }, []);

    const subscribe = useCallback((listener: (message: SessionServerMessage) => void) => {
        listeners.current.add(listener);
        return () => void listeners.current.delete(listener);
    }, []);
    const send = useCallback((message: ClientMessage) => {
        const ws = socket.current;
        if (ws?.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(message));
        return true;
    }, []);

    const subscribeClose = useCallback((listener: (code: number) => void) => {
        closeListeners.current.add(listener);
        return () => void closeListeners.current.delete(listener);
    }, []);

    return { ...state, subscribe, send, subscribeClose };
}

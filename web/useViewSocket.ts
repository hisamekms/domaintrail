import { useEffect, useRef, useState } from 'react';
import type { ViewPayload } from '../src/server/protocol';

export type Connection = 'connecting' | 'open' | 'closed';

export interface ViewState {
    current: ViewPayload | null;
    /** The payload that was shown before the current model (for ghosts of removed nodes). */
    previous: ViewPayload | null;
    connection: Connection;
}

/** Subscribes to model updates from the view server, reconnecting when the server restarts. */
export function useViewSocket(): ViewState {
    const [state, setState] = useState<ViewState>({ current: null, previous: null, connection: 'connecting' });
    const retry = useRef(0);

    useEffect(() => {
        let ws: WebSocket | undefined;
        let disposed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const connect = () => {
            ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
            ws.onopen = () => {
                retry.current = 0;
                setState((s) => ({ ...s, connection: 'open' }));
            };
            ws.onmessage = (ev) => {
                const payload = JSON.parse(ev.data as string) as ViewPayload;
                setState((s) => {
                    const modelChanged = s.current && s.current.modelVersion !== payload.modelVersion;
                    return { current: payload, previous: modelChanged ? s.current : s.previous, connection: 'open' };
                });
            };
            ws.onclose = () => {
                if (disposed) return;
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

    return state;
}

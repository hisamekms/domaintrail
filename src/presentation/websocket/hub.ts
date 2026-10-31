import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { ViewPayload } from '../../visualization/protocol.js';

/** What the server sends over the WebSocket: the view, as `type: 'update'`. */
export type ServerMessage = ViewPayload;

/** The pages connected over the WebSocket. */
export interface WebSocketHub {
    /** Accepts an upgrade that passed the access check, and sends the current view to the new page. */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
    /** Sends `message` to every open page. */
    publish(message: ServerMessage): void;
    /** Closes every page's connection and the WebSocket server. */
    close(): void;
}

/** The one place a message becomes what goes over the wire; another message type would be routed here. */
const encode = (message: ServerMessage): string => JSON.stringify(message);

/** A hub that sends `current()` to each page as it connects. */
export function createWebSocketHub(current: () => ServerMessage): WebSocketHub {
    const wss = new WebSocketServer({ noServer: true });
    return {
        handleUpgrade(req, socket, head) {
            wss.handleUpgrade(req, socket, head, (ws) => ws.send(encode(current())));
        },
        publish(message) {
            const data = encode(message);
            for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
        },
        close() {
            for (const ws of wss.clients) ws.terminate();
            wss.close();
        },
    };
}

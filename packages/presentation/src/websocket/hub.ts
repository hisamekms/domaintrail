import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { ClientMessage, SessionServerMessage } from '@domaintrail/collaboration/protocol';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import { parseClientMessage } from './client-messages.js';

/**
 * What the server sends over the WebSocket: the view, as `type: 'update'` (all `dt view` ever sends), and in a
 * session the messages of `SessionServerMessage` (`session.*`, `request.*`, `run.*`, `revision.*`, `presence.*`).
 */
export type ServerMessage = ViewPayload | SessionServerMessage;

/** A page connected to the hub, with what the server knows of it (`data`: its participant in a session). */
export interface Connection<T> {
    readonly id: string;
    readonly data: T;
    send(message: ServerMessage): void;
}

/** What a session adds to the hub: reading the page's messages, and knowing when pages come and go. */
export interface HubSession<T> {
    /** Largest message accepted from a page, in bytes; a larger one closes its connection (1009). */
    readonly maxPayload: number;
    /** A page connected (after it was sent the current view). */
    onConnect(connection: Connection<T>): void;
    /** A page sent a valid message (anything else is dropped). */
    onMessage(connection: Connection<T>, message: ClientMessage): void;
    onClose(connection: Connection<T>): void;
}

/** The pages connected over the WebSocket. */
export interface WebSocketHub<T> {
    /** Accepts an upgrade that passed the access check, and sends the current view to the new page. */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, data: T): void;
    /** Sends `message` to every open page. */
    publish(message: ServerMessage): void;
    /** Sends `message` to the open pages that match. */
    publishWhere(matches: (connection: Connection<T>) => boolean, message: ServerMessage): void;
    /** Closes the connections that match, with a WebSocket close code and reason. */
    closeWhere(matches: (connection: Connection<T>) => boolean, code: number, reason: string): void;
    /** Closes every page's connection and the WebSocket server. */
    close(): void;
}

/** The one place a message becomes what goes over the wire. */
const encode = (message: ServerMessage): string => JSON.stringify(message);

const text = (data: RawData): string => (Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data).toString('utf8');

/**
 * A hub that sends `current()` to each page as it connects. Without `session` (`dt view`) it reads nothing from the
 * pages; with it, messages are parsed and validated here and handed to `session.onMessage`.
 */
export function createWebSocketHub<T = undefined>(current: () => ServerMessage, session?: HubSession<T>): WebSocketHub<T> {
    const wss = new WebSocketServer(session ? { noServer: true, maxPayload: session.maxPayload } : { noServer: true });
    const connections = new Map<WebSocket, Connection<T>>();
    const open = (ws: WebSocket): boolean => ws.readyState === WebSocket.OPEN;
    return {
        handleUpgrade(req, socket, head, data) {
            wss.handleUpgrade(req, socket, head, (ws) => {
                ws.send(encode(current()));
                if (!session) return;
                const connection: Connection<T> = {
                    id: randomUUID(),
                    data,
                    send(message) {
                        if (open(ws)) ws.send(encode(message));
                    },
                };
                connections.set(ws, connection);
                ws.on('message', (raw, isBinary) => {
                    const body = text(raw);
                    // checked here too: not every runtime's ws honors maxPayload (Bun's does not)
                    if (Buffer.byteLength(body) > session.maxPayload) return ws.close(1009, 'message too big');
                    const message = isBinary ? undefined : parseClientMessage(body);
                    if (message) session.onMessage(connection, message);
                });
                // a message too large or not a frame: the page's connection ends at once (no close handshake to wait for)
                ws.on('error', () => ws.terminate());
                ws.on('close', () => {
                    connections.delete(ws);
                    session.onClose(connection);
                });
                session.onConnect(connection);
            });
        },
        publish(message) {
            const data = encode(message);
            for (const ws of wss.clients) if (open(ws)) ws.send(data);
        },
        publishWhere(matches, message) {
            const data = encode(message);
            for (const [ws, connection] of connections) if (open(ws) && matches(connection)) ws.send(data);
        },
        closeWhere(matches, code, reason) {
            for (const [ws, connection] of connections) if (matches(connection)) ws.close(code, reason);
        },
        close() {
            for (const ws of wss.clients) ws.terminate();
            wss.close();
        },
    };
}

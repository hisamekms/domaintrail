import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { checkAccess, hostAllowList } from './access.js';
import type { Assets } from './assets.js';
import { send, type ApiRoutes } from './routes.js';

/** The path of the WebSocket. */
export const WS_PATH = '/ws';

/** Takes over an upgrade to the WebSocket that passed the access check. */
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

export interface ViewHttpServerOptions {
    /** The address the server is bound to, which decides the Host names it answers to (see `hostAllowList`). */
    host: string;
    api: ApiRoutes;
    assets: Assets;
    /** The upgrade on `WS_PATH`. */
    upgrade: UpgradeHandler;
}

/**
 * The Live View's HTTP server (not yet listening): the API, the WebSocket upgrade and the page. Every request and upgrade
 * enters through `admitted`, which applies `checkAccess` to the API's requests and the WebSocket's upgrade; the page
 * (and any other path) is served to anyone.
 */
export function createViewHttpServer({ host, api, assets, upgrade }: ViewHttpServerOptions): Server {
    const allowedHost = hostAllowList(host);
    /** Whether `req` may be answered; `guarded` when it asks for the API (a request) or the WebSocket (an upgrade). */
    const admitted = (req: IncomingMessage, guarded: boolean): boolean => !guarded || checkAccess(req.headers, allowedHost) === 'ok';

    const http = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!admitted(req, api.has(url.pathname))) return send(res, 403, 'text/plain', 'Forbidden');
        const route = api.get(url.pathname);
        if (route) return route(req, url, res);
        const asset = req.method === 'GET' || req.method === 'HEAD' ? assets.get(url.pathname) : undefined;
        if (!asset) return send(res, 404, 'text/plain', 'Not found');
        send(res, 200, asset.type, asset.body);
    });
    http.on('upgrade', (req, socket, head) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (pathname !== WS_PATH || !admitted(req, true)) {
            socket.end(`HTTP/1.1 ${pathname === WS_PATH ? '403 Forbidden' : '404 Not Found'}\r\nConnection: close\r\n\r\n`);
            return;
        }
        upgrade(req, socket, head);
    });
    return http;
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { checkAccess, hostAllowList, type AccessPolicy, type Authorization } from './access.js';
import type { Assets } from './assets.js';
import { sendError } from './json.js';
import { send, type ApiRoutes } from './routes.js';

/** The path of the WebSocket. */
export const WS_PATH = '/ws';

/** The API of a session, below `/api/session` (404 in `dt view`). */
export const SESSION_API = '/api/session';

/** The pages of a session that are not the Live View (the facilitator link, the join form), below `/session/`. */
export const SESSION_PAGES = '/session/';

/** Takes over an upgrade to the WebSocket that passed the access check, with who is connecting. */
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, auth: Authorization) => void;

/** Answers a request of a session that passed the Host/Origin check; `auth` may still be anonymous. */
export type SessionHandler = (req: IncomingMessage, url: URL, res: ServerResponse, auth: Exclude<Authorization, { kind: 'forbidden' }>) => Promise<void>;

/** What a session adds to the Live View's server (see `createViewHttpServer`). */
export interface SessionSurface {
    /** The access check of the session: Host/Origin and identities. */
    readonly policy: AccessPolicy;
    /** `/api/session` and below. */
    readonly api: SessionHandler;
    /** `/session/…`: the facilitator link and the join form. */
    readonly pages: SessionHandler;
    /** What a browser without an identity gets instead of the page: the join form (dev), or 401 (access). */
    readonly signIn: (req: IncomingMessage, url: URL, res: ServerResponse) => void;
}

export interface ViewHttpServerOptions {
    /** The address the server is bound to, which decides the Host names it answers to (see `hostAllowList`). */
    host: string;
    api: ApiRoutes;
    assets: Assets;
    /** The upgrade on `WS_PATH`. */
    upgrade: UpgradeHandler;
    /** A session (`dt session start`): every request then needs an identity. Absent for `dt view`. */
    session?: SessionSurface;
}

const isApi = (pathname: string): boolean => pathname === '/api' || pathname.startsWith('/api/');
const isSessionApi = (pathname: string): boolean => pathname === SESSION_API || pathname.startsWith(`${SESSION_API}/`);

/**
 * The Live View's HTTP server (not yet listening): the API, the WebSocket upgrade and the page. Every request and upgrade
 * enters through `checkAccess`. For `dt view` it guards the API's requests and the WebSocket's upgrade, and the page
 * (and any other path) is served to anyone. In a session it guards everything: the page, the API, the session's API
 * and the WebSocket need an identity; without one a page request gets the session's sign-in answer, an API request 401.
 */
export function createViewHttpServer({ host, api, assets, upgrade, session }: ViewHttpServerOptions): Server {
    const viewPolicy: AccessPolicy = { allowedHost: hostAllowList(host) };

    const serveView = (req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> | void => {
        const route = api.get(url.pathname);
        if (route) return route(req, url, res);
        const asset = req.method === 'GET' || req.method === 'HEAD' ? assets.get(url.pathname) : undefined;
        if (!asset) return send(res, 404, 'text/plain', 'Not found');
        send(res, 200, asset.type, asset.body);
    };

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!session) {
            if (api.has(url.pathname) && (await checkAccess(req.headers, viewPolicy)).kind === 'forbidden') return send(res, 403, 'text/plain', 'Forbidden');
            return serveView(req, url, res);
        }
        const auth = await checkAccess(req.headers, session.policy);
        if (auth.kind === 'forbidden') {
            return isApi(url.pathname) ? sendError(res, 403, 'Forbidden', 'Host or Origin not allowed.') : send(res, 403, 'text/plain', 'Forbidden');
        }
        if (isSessionApi(url.pathname)) return session.api(req, url, res, auth);
        if (url.pathname.startsWith(SESSION_PAGES)) return session.pages(req, url, res, auth);
        if (auth.kind === 'anonymous') {
            return isApi(url.pathname) ? sendError(res, 401, 'Unauthenticated', 'Sign in to the session first.') : session.signIn(req, url, res);
        }
        return serveView(req, url, res);
    };

    const http = createServer((req, res) => {
        handle(req, res).catch((e: unknown) => {
            // an answer is still owed; the error goes to stderr without the request (its headers may carry a token)
            console.error(`Request failed: ${e instanceof Error ? e.message : String(e)}`);
            if (!res.headersSent) send(res, 500, 'text/plain', 'Internal error');
            else res.end();
        });
    });
    http.on('upgrade', (req, socket, head) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        const refuse = (status: string): void => void socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
        if (pathname !== WS_PATH) return refuse('404 Not Found');
        checkAccess(req.headers, session?.policy ?? viewPolicy).then(
            (auth) => {
                if (auth.kind === 'forbidden') return refuse('403 Forbidden');
                if (session && auth.kind !== 'participant') return refuse('401 Unauthorized');
                upgrade(req, socket, head, auth);
            },
            (e: unknown) => {
                console.error(`Upgrade failed: ${e instanceof Error ? e.message : String(e)}`);
                refuse('500 Internal Server Error');
            },
        );
    });
    return http;
}

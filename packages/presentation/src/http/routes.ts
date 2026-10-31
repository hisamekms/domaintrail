import type { IncomingMessage, ServerResponse } from 'node:http';
import { STRUCTURE_LEVELS, type StructureLevel } from '../../visualization/domain/graph/ir.js';
import { UnknownRevisionError, type GitRevisions } from '../../visualization/application/ports.js';
import type { ViewService } from '../../visualization/application/view-service.js';
import type { BaselineSpec, ViewPayload } from '../../visualization/protocol.js';

/** Answers one API request; the access check has been passed already (see `createViewHttpServer`). */
export type ApiRoute = (req: IncomingMessage, url: URL, res: ServerResponse) => Promise<void> | void;

/** The API's routes by path. */
export type ApiRoutes = ReadonlyMap<string, ApiRoute>;

/** What the API works with. */
export interface ApiDeps {
    view: ViewService;
    /** The revisions offered as baselines. */
    git: Pick<GitRevisions, 'listRefs'>;
    /** Pushes a view to every page (after a change of baseline). */
    publish: (payload: ViewPayload) => void;
    log: (line: string) => void;
}

export function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
    res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff' });
    res.end(body);
}

const isStructureLevel = (s: string | null): s is StructureLevel => (STRUCTURE_LEVELS as readonly (string | null)[]).includes(s);

/** The Structure View level asked for: `level=…`, or `overview=1` as asked before there were three levels. */
function structureLevel(params: URLSearchParams): StructureLevel {
    const level = params.get('level');
    if (isStructureLevel(level)) return level;
    return params.get('overview') === '1' ? 'overview' : 'detail';
}

/** Largest request body accepted (a baseline is a few bytes). */
const MAX_BODY = 4096;

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
            body += chunk;
            if (body.length > MAX_BODY) reject(new Error('Request body too large'));
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

/** `{"kind":"previous"}` or `{"kind":"git","ref":"main"}`; undefined when it is neither. */
function parseBaseline(body: string): BaselineSpec | undefined {
    try {
        const v: unknown = JSON.parse(body);
        if (typeof v !== 'object' || v === null || !('kind' in v)) return undefined;
        if (v.kind === 'previous') return { kind: 'previous' };
        if (v.kind === 'git' && 'ref' in v && typeof v.ref === 'string' && v.ref.trim()) return { kind: 'git', ref: v.ref.trim() };
    } catch {
        // not JSON
    }
    return undefined;
}

/** The view last computed. */
function stateRoute({ view }: ApiDeps): ApiRoute {
    return (_req, _url, res) => send(res, 200, 'application/json', JSON.stringify(view.state));
}

/**
 * `?contexts=A,B&level=overview&hide=C`: Structure View of those bounded contexts with their dependencies as stubs,
 * except those on and from C (`overview=1` is still accepted for `level=overview`)
 */
function focusRoute({ view }: ApiDeps): ApiRoute {
    return async (_req, url, res) => {
        const contexts = (url.searchParams.get('contexts') ?? '').split(',').filter(Boolean);
        try {
            const hidden = (url.searchParams.get('hide') ?? '').split(',').filter(Boolean);
            const graph = await view.focusGraph(contexts, structureLevel(url.searchParams), hidden);
            return graph ? send(res, 200, 'application/json', JSON.stringify(graph)) : send(res, 404, 'text/plain', 'No such contexts');
        } catch {
            return send(res, 500, 'text/plain', 'Layout failed');
        }
    };
}

/** The revisions the page offers as baselines. */
function gitRefsRoute({ git }: ApiDeps): ApiRoute {
    return async (_req, _url, res) => send(res, 200, 'application/json', JSON.stringify(await git.listRefs()));
}

/** POST `{"kind":"git","ref":"main"}` or `{"kind":"previous"}`: what the model is compared with, for every page. */
function baselineRoute({ view, publish, log }: ApiDeps): ApiRoute {
    return async (req, _url, res) => {
        if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method not allowed');
        const spec = parseBaseline(await readBody(req).catch(() => ''));
        if (!spec) return send(res, 400, 'text/plain', 'Expected {"kind":"previous"} or {"kind":"git","ref":"<revision>"}');
        try {
            const payload = await view.setBaseline(spec);
            publish(payload);
            log(`baseline: ${spec.kind === 'git' ? spec.ref : 'previous'}`);
            return send(res, 200, 'application/json', JSON.stringify(payload.baseline));
        } catch (e) {
            if (e instanceof UnknownRevisionError) return send(res, 400, 'text/plain', e.message);
            return send(res, 500, 'text/plain', 'Comparison failed');
        }
    };
}

/** The Live View's API: `/api/state`, `/api/focus`, `/api/git/refs` and `/api/baseline`. */
export function createApiRoutes(deps: ApiDeps): ApiRoutes {
    return new Map([
        ['/api/state', stateRoute(deps)],
        ['/api/focus', focusRoute(deps)],
        ['/api/git/refs', gitRefsRoute(deps)],
        ['/api/baseline', baselineRoute(deps)],
    ]);
}

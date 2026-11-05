// The Live View's knowledge (ADR 0031, section 10), under `/api/session/knowledge`: the page never talks to the store,
// dt does, for any participant of the session, with the participant's identity as the person a change is by. The
// bodies are the store's values as JSON (`@domaintrail/knowledge/protocol`, which the page decodes with), so that the
// page reads the same items through dt whichever store the workspace has.
//
// | Method and path                              | Store call                     |
// |----------------------------------------------|--------------------------------|
// | GET  /api/session/knowledge?about&when&…&q   | search (the ナレッジ list)      |
// | GET  /api/session/knowledge/counts?storming= | counts (the dot and the mark)  |
// | GET  /api/session/knowledge/items/:id        | get (`?history=1`: versions)   |
// | POST /api/session/knowledge/items/:id/correct | correct `{ content }` (直す)  |
// | POST /api/session/knowledge/items/:id/delete | delete (消す)                  |
// | POST /api/session/knowledge/items/:id/restore | restore (元に戻す)            |
// | POST /api/session/knowledge/items/:id/unlink | unlinkConflict `{ other }` (食い違いではない) |
// | POST /api/session/knowledge/items/:id/images | putImage, then correct: the image at the end of the text (画像を付ける) |
// | GET  /api/session/knowledge/images/:id       | getImage                       |
//
// A change made here is told to every page (`changed`); a store that fails or cannot be reached is answered 502.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Knowledge, type KnowledgeStore } from '@domaintrail/knowledge';
import { IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, WireError, itemContent, itemId, imageId, knowledgeQueryOf, unlinkBody } from '@domaintrail/knowledge/protocol';
import type { Identified } from '../http/access.js';
import { BodyError, mediaType, readJson, sendError, sendJson } from '../http/json.js';

/** The path the routes are below. */
export const KNOWLEDGE_API = '/api/session/knowledge';

/** Largest JSON body (an item's text is at most 20,000 characters). */
const MAX_BODY = 128 * 1024;

export interface KnowledgeRoutesDeps {
    readonly store: KnowledgeStore;
    readonly project: Knowledge.ProjectName;
    /** The knowledge changed (a person's change made here): every page reads it again. */
    readonly changed: () => void;
    readonly log: (line: string) => void;
}

/** Answers a request below `KNOWLEDGE_API` of a participant (the session's access check passed already). */
export type KnowledgeRoutes = (req: IncomingMessage, url: URL, res: ServerResponse, who: Identified) => Promise<void>;

/** Whether a path is one of the knowledge routes'. */
export const isKnowledgePath = (pathname: string): boolean => pathname === KNOWLEDGE_API || pathname.startsWith(`${KNOWLEDGE_API}/`);

/**
 * The person a participant's change is by, as the store records it, namespaced by how the identity was proven so that
 * the two can never be taken for each other: `access:<e-mail>` for an identity Cloudflare Access verified, else
 * `guest:<name>` (`dev`, `link`: a name the person typed, unverified — it may even look like an e-mail).
 */
export function actorOf(who: Identified): Knowledge.UserName {
    const { identity } = who.participant;
    const raw = identity.provider === 'access' && identity.email ? `access:${identity.email}` : `guest:${identity.displayName}`;
    const made = Knowledge.makeUserName(raw);
    if (made.ok) return made.value;
    const fallback = Knowledge.makeUserName(`guest:${who.participant.id}`);
    if (!fallback.ok) throw new Error(`No user name for ${who.participant.id}`);
    return fallback.value;
}

/** The image's line appended to an item's text: the reference the store's sweep and the page follow (`image:<id>`). */
export const imageLine = (id: Knowledge.ImageId): string => `![](image:${id})`;

/** Reads a request's body as bytes, at most `limit`. */
async function readBytes(req: IncomingMessage, limit: number): Promise<Uint8Array> {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
        req.resume();
        throw new BodyError(413, 'BodyTooLarge', `The body is larger than ${limit} bytes.`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += b.length;
        if (size > limit) throw new BodyError(413, 'BodyTooLarge', `The body is larger than ${limit} bytes.`);
        chunks.push(b);
    }
    return new Uint8Array(Buffer.concat(chunks));
}

export function createKnowledgeRoutes(deps: KnowledgeRoutesDeps): KnowledgeRoutes {
    const { store, project } = deps;

    const itemError = (res: ServerResponse, e: Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone): void =>
        e.type === 'KnowledgeItemNotFound'
            ? sendError(res, 404, e.type, 'No such knowledge item.', { itemId: e.itemId })
            : sendError(res, 410, e.type, 'The knowledge item is deleted.', { itemId: e.itemId });

    const json = async (req: IncomingMessage): Promise<unknown> => readJson(req, MAX_BODY);

    /** A change made: answered, then told to every page. */
    const done = (res: ServerResponse, status: number, body: unknown): void => {
        sendJson(res, status, body);
        deps.changed();
    };

    const handle = async (req: IncomingMessage, url: URL, res: ServerResponse, who: Identified): Promise<void> => {
        const rest = url.pathname.slice(KNOWLEDGE_API.length).split('/').filter(Boolean);
        const method = req.method ?? 'GET';
        const q = url.searchParams;
        if (rest.length === 0) {
            if (method !== 'GET') return sendError(res, 405, 'MethodNotAllowed', 'Use GET.');
            return sendJson(res, 200, await store.search(project, knowledgeQueryOf(q)));
        }
        const [resource, raw, action] = rest;
        if (resource === 'counts' && rest.length === 1) {
            if (method !== 'GET') return sendError(res, 405, 'MethodNotAllowed', 'Use GET.');
            const storming = q.get('storming');
            if (!storming || !/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(storming)) throw new WireError('storming: expected the name of a storming');
            return sendJson(res, 200, { counts: await store.counts(project, storming) });
        }
        if (resource === 'images' && raw !== undefined && rest.length === 2) {
            if (method !== 'GET') return sendError(res, 405, 'MethodNotAllowed', 'Use GET.');
            const image = await store.getImage(project, imageId(raw, 'id'));
            if (!image) return sendError(res, 404, 'NotFound', 'No such image.');
            res.writeHead(200, {
                'content-type': image.mediaType,
                'x-content-type-options': 'nosniff',
                'content-security-policy': "default-src 'none'",
                'cache-control': 'private, max-age=300',
            });
            res.end(Buffer.from(image.bytes));
            return;
        }
        if (resource !== 'items' || raw === undefined || rest.length > 3) return sendError(res, 404, 'NotFound', 'No such knowledge API.');
        const id = itemId(raw, 'id');
        if (action === undefined) {
            if (method !== 'GET') return sendError(res, 405, 'MethodNotAllowed', 'Use GET.');
            const found = await store.get(project, id, { history: q.get('history') === '1' });
            return found ? sendJson(res, 200, found) : itemError(res, { type: 'KnowledgeItemNotFound', itemId: id });
        }
        if (method !== 'POST') return sendError(res, 405, 'MethodNotAllowed', 'Use POST.');
        const by = actorOf(who);
        switch (action) {
            case 'correct': {
                const b = await json(req);
                const content = itemContent(typeof b === 'object' && b !== null && 'content' in b ? b.content : undefined, 'content');
                const r = await store.correct(project, id, content, by);
                return r.ok ? done(res, 200, r.value) : itemError(res, r.error);
            }
            case 'delete': {
                await json(req);
                const r = await store.delete(project, id, by);
                return r.ok ? done(res, 200, r.value) : itemError(res, r.error);
            }
            case 'restore': {
                await json(req);
                const r = await store.restore(project, id, by);
                return r.ok ? done(res, 200, r.value) : itemError(res, r.error);
            }
            case 'unlink': {
                const other = unlinkBody(await json(req), 'body');
                const r = await store.unlinkConflict(project, id, other, by);
                return r.ok ? done(res, 200, { items: r.value }) : itemError(res, r.error);
            }
            case 'images': {
                const type = mediaType(req);
                if (!IMAGE_MEDIA_TYPES.some((t) => t === type)) {
                    req.resume();
                    return sendError(res, 415, 'ImageRejected', `An image is one of ${IMAGE_MEDIA_TYPES.join(', ')}.`);
                }
                const bytes = await readBytes(req, MAX_IMAGE_BYTES);
                if (bytes.byteLength === 0) return sendError(res, 400, 'BadRequest', 'An empty image.');
                const found = await store.get(project, id);
                if (!found) return itemError(res, { type: 'KnowledgeItemNotFound', itemId: id });
                const image = await store.putImage(project, { mediaType: type, bytes });
                const text = Knowledge.makeItemText(`${found.item.content.text.trimEnd()}\n\n${imageLine(image)}\n`);
                if (!text.ok) return sendError(res, 413, 'ImageRejected', 'The text has no room for another image.');
                const r = await store.correct(project, id, { ...found.item.content, text: text.value }, by);
                return r.ok ? done(res, 201, r.value) : itemError(res, r.error);
            }
        }
        return sendError(res, 404, 'NotFound', 'No such knowledge API.');
    };

    return async (req, url, res, who) => {
        try {
            await handle(req, url, res, who);
        } catch (e) {
            if (res.headersSent) return void res.end();
            if (e instanceof WireError) return sendError(res, 400, 'InvalidInput', e.message);
            if (e instanceof BodyError) return sendError(res, e.status, e.type, e.message);
            const message = e instanceof Error ? e.message : String(e);
            deps.log(`knowledge: ${req.method ?? 'GET'} ${url.pathname} failed (${message})`);
            sendError(res, 502, 'KnowledgeStoreFailed', 'The knowledge store failed or could not be reached.');
        }
    };
}

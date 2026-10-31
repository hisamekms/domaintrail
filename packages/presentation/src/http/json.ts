// JSON over HTTP for the session APIs: bodies read with a size limit and a content type, answers and typed errors
// (`{ "error": { "type": … } }`, the `ErrorBody` of `@domaintrail/collaboration/protocol`).
import type { IncomingMessage, ServerResponse } from 'node:http';

/** A request body that cannot be read as asked: answered with `status` and an error of `type`. */
export class BodyError extends Error {
    constructor(
        readonly status: number,
        readonly type: 'BodyTooLarge' | 'UnsupportedMediaType' | 'InvalidJson',
        message: string,
    ) {
        super(message);
    }
}

/**
 * The body of `req` as text, at most `limit` bytes; a larger body is refused (`BodyTooLarge`) and the rest of it
 * discarded unread.
 */
export function readText(req: IncomingMessage, limit: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > limit) {
            req.resume();
            reject(new BodyError(413, 'BodyTooLarge', `The body is larger than ${limit} bytes.`));
            return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let refused = false;
        req.on('data', (chunk: Buffer) => {
            if (refused) return;
            size += chunk.length;
            if (size > limit) {
                refused = true;
                chunks.length = 0;
                reject(new BodyError(413, 'BodyTooLarge', `The body is larger than ${limit} bytes.`));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!refused) resolve(Buffer.concat(chunks).toString('utf8'));
        });
        req.on('error', reject);
    });
}

/** The media type of a request, without parameters, in lowercase. */
export const mediaType = (req: IncomingMessage): string => (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

/**
 * The body of `req` as JSON, at most `limit` bytes. Only `application/json` is accepted: a page of another origin cannot
 * send it without a preflight, which this server never grants. An empty body is `{}`.
 */
export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
    if (mediaType(req) !== 'application/json') {
        req.resume();
        throw new BodyError(415, 'UnsupportedMediaType', 'Send the body as application/json.');
    }
    const text = await readText(req, limit);
    if (!text.trim()) return {};
    try {
        return JSON.parse(text);
    } catch {
        throw new BodyError(400, 'InvalidJson', 'The body is not JSON.');
    }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
}

/** A typed error: `{ "error": { "type": type, "message": message, …detail } }`. */
export function sendError(res: ServerResponse, status: number, type: string, message?: string, detail: object = {}): void {
    sendJson(res, status, { error: { ...detail, type, ...(message !== undefined && { message }) } });
}

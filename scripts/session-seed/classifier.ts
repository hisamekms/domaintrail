// A stand-in for Cloudflare's Clef (Workers AI) that the seeded session server asks instead of Cloudflare
// (`DOMAINTRAIL_CLASSIFIER_URL`): the chat's 依頼 / 会話 tags appear without a Cloudflare account, and no message leaves
// this machine. A scenario says what a message reads as (`expect`); any other message (one typed later in the
// browser) is guessed from its words. It keeps serving while the session server runs, so later messages are tagged too.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The probabilities a scenario gives: a request, talk, and unsure (no tag: the facilitator decides). */
export const READS_AS = { request: 0.93, chat: 0.07, unsure: 0.5 } as const;
export type ReadsAs = keyof typeof READS_AS;

/** Words that make a message typed later read as a request. */
const REQUEST_WORDS = /(して|ください|欲しい|ほしい|追加|変更|削除|足して|消して|直して|分けて|まとめて|作って|add|change|remove|rename)/i;

export interface MockClassifier {
    /** The base URL to give the server (`DOMAINTRAIL_CLASSIFIER_URL`). */
    readonly url: string;
    /** What the message with this exact text reads as. */
    expect(text: string, as: ReadsAs): void;
    /** How many messages it was asked about. */
    asked(): number;
    close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;

export async function startMockClassifier(): Promise<MockClassifier> {
    const expected = new Map<string, number>();
    let asked = 0;
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size <= MAX_BODY) chunks.push(c);
        });
        req.on('end', () => {
            let state = '';
            try {
                const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (typeof body === 'object' && body !== null && 'state' in body && typeof body.state === 'string') state = body.state;
            } catch {
                // not JSON: an unsure answer
            }
            asked++;
            // the server sends at most 4,000 characters of a message: a long one is looked up by its start
            const p = expected.get(state.slice(0, 4000)) ?? (REQUEST_WORDS.test(state) ? READS_AS.request : READS_AS.chat);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ success: true, result: { answers: { request: { type: 'noul', noul: p } } } }));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- listening on TCP
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        expect: (text, as) => void expected.set(text.slice(0, 4000), READS_AS[as]),
        asked: () => asked,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

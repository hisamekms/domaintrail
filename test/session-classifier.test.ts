import { describe, expect, test } from 'bun:test';
import { applicable, classificationOf, createClassifications, type MessageClassifier } from '@domaintrail/collaboration/application/classifier';
import { clefProbability, clefRequest, createClefClassifier } from '@domaintrail/collaboration/infrastructure/clef';

describe('classifying the chat’s messages', () => {
    test('a request from the threshold on, talk below it; unsure near it (applicable), unknown without a probability', () => {
        expect(classificationOf(0.9, 0.5)).toEqual({ kind: 'request', probability: 0.9 });
        expect(classificationOf(0.1, 0.5)).toEqual({ kind: 'chat', probability: 0.1 });
        expect(classificationOf(0.55, 0.5)).toEqual({ kind: 'unknown', probability: 0.55 });
        expect(classificationOf(0.45, 0.5)).toEqual({ kind: 'unknown', probability: 0.45 });
        expect(classificationOf(undefined, 0.5)).toEqual({ kind: 'unknown' });
        expect(classificationOf(Number.NaN, 0.5)).toEqual({ kind: 'unknown' });
        expect([applicable({ kind: 'chat' }), applicable({ kind: 'request' }), applicable({ kind: 'unknown' }), applicable(undefined)]).toEqual([
            false,
            true,
            true,
            true,
        ]);
    });

    test('in the background, once per message; a failure or a timeout leaves it applicable, and the text is never logged', async () => {
        const told: [string, string][] = [];
        const log: string[] = [];
        const classifier: MessageClassifier = {
            classify: async (text, signal) => {
                if (text === 'boom secret') throw new Error('500');
                if (text === 'slow') await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
                return text.startsWith('Add') ? 0.95 : 0.05;
            },
        };
        const c = createClassifications({
            classifier,
            threshold: 0.5,
            timeoutMs: 50,
            log: (l) => log.push(l),
            onClassified: (id, x) => told.push([id, x.kind]),
        });
        c.classify('a', 'Add a cancel command.');
        c.classify('b', 'lol');
        c.classify('c', 'boom secret');
        c.classify('d', 'slow');
        c.classify('a', 'Add it again.');
        await c.settled();
        expect(told.sort((x, y) => x[0].localeCompare(y[0]))).toEqual([
            ['a', 'request'],
            ['b', 'chat'],
            ['c', 'unknown'],
            ['d', 'unknown'],
        ]);
        expect(c.all()).toMatchObject({ a: { kind: 'request' }, b: { kind: 'chat' }, c: { kind: 'unknown' }, d: { kind: 'unknown' } });
        expect(log.join('\n')).toContain('timed out');
        expect(log.join('\n')).not.toContain('secret');
    });
});

describe('the Clef adapter (Workers AI)', () => {
    test('one yes/no ("noul") question per message to the account’s model, the token as a bearer', async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const fakeFetch = (async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return Response.json({
                result: { model: 'clef-flash', answers: { request: { type: 'noul', noul: 0.82 } }, usage: { input_tokens: 9, output_tokens: 1 } },
                success: true,
            });
        }) as unknown as typeof fetch;
        const clef = createClefClassifier({ accountId: 'acc', model: 'clef-flash', token: 'tok', fetch: fakeFetch });
        expect(await clef.classify('Rename Order to Purchase.', new AbortController().signal)).toBe(0.82);
        expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clef-flash');
        expect(calls[0].init.headers).toEqual({ authorization: 'Bearer tok', 'content-type': 'application/json' });
        expect(JSON.parse(calls[0].init.body as string)).toEqual(clefRequest('clef-flash', 'Rename Order to Purchase.'));
        expect(clefRequest('clef', 'x')).toMatchObject({ model: 'clef', state: 'x', questions: { request: { type: 'noul' } } });
    });

    test('the probability bare or in Cloudflare’s result; an error or an answer without one throws', async () => {
        expect(clefProbability({ answers: { request: { type: 'noul', noul: 0.3 } } })).toBe(0.3);
        expect(() => clefProbability({ result: { answers: {} } })).toThrow();
        expect(() => clefProbability({ answers: { request: { type: 'noul', noul: 2 } } })).toThrow();
        const failing = createClefClassifier({
            accountId: 'acc',
            model: 'clef',
            token: 'tok',
            fetch: (async () => new Response('no', { status: 401 })) as unknown as typeof fetch,
        });
        expect(await failing.classify('x', new AbortController().signal).then(String, (e: unknown) => String(e))).toContain('401');
    });
});

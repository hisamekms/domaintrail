import { describe, expect, test } from 'bun:test';
import { CLEF_NOT_CONFIGURED, clefStep, type MessageClassifier } from './classifier.js';
import { clefProbabilities, clefRequest, createClefClassifier } from '../infrastructure/clef.js';

const answers = (consultation: number, change_request: number, neither: number): Record<string, unknown> => ({
    consultation: { type: 'noul', noul: consultation },
    change_request: { type: 'noul', noul: change_request },
    neither: { type: 'noul', noul: neither },
});

describe('stage 2: Clef', () => {
    const options = { threshold: 0.9, timeoutMs: 50 };

    test('one answer at or above the threshold decides, with the probabilities as the reason and the model', async () => {
        const classifier: MessageClassifier = { model: 'clef-flash', classify: async () => ({ consultation: 0.95, changeRequest: 0.1, neither: 0.02 }) };
        expect(await clefStep(classifier, 'なぜ？', options)).toMatchObject({
            stage: 'Clef',
            verdict: 'Consultation',
            confidence: 0.95,
            reason: '相談 0.95 / 依頼 0.10 / 不要 0.02',
            model: 'clef-flash',
        });
        const change: MessageClassifier = { classify: async () => ({ consultation: 0.1, changeRequest: 0.92, neither: 0.01 }) };
        expect((await clefStep(change, 'x', options)).verdict).toBe('ChangeRequest');
    });

    test('none or several sure: unknown; no classifier: unknown with that reason; a failure or a timeout: unknown with why, never the text', async () => {
        const unsure: MessageClassifier = { classify: async () => ({ consultation: 0.6, changeRequest: 0.5, neither: 0.1 }) };
        expect(await clefStep(unsure, 'x', options)).toMatchObject({ verdict: 'Unknown' });
        const both: MessageClassifier = { classify: async () => ({ consultation: 0.95, changeRequest: 0.95, neither: 0 }) };
        expect((await clefStep(both, 'x', options)).verdict).toBe('Unknown');
        expect(await clefStep(undefined, 'x', options)).toEqual({ stage: 'Clef', verdict: 'Unknown', reason: CLEF_NOT_CONFIGURED, durationMs: 0 });
        const failing: MessageClassifier = {
            classify: async () => {
                throw new Error('500');
            },
        };
        const failed = await clefStep(failing, 'secret text', options);
        expect(failed).toMatchObject({ verdict: 'Unknown', error: '500' });
        expect(JSON.stringify(failed)).not.toContain('secret');
        const slow: MessageClassifier = {
            classify: (_text, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
        };
        expect(await clefStep(slow, 'x', options)).toMatchObject({ verdict: 'Unknown', error: 'timed out' });
    });
});

describe('the Clef adapter (Workers AI)', () => {
    test('three yes/no ("noul") questions per message to the account’s model, the token as a bearer', async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const fakeFetch = (async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return Response.json({
                result: { model: 'clef-flash', answers: answers(0.82, 0.1, 0.05), usage: { input_tokens: 9, output_tokens: 1 } },
                success: true,
            });
        }) as unknown as typeof fetch;
        const clef = createClefClassifier({ accountId: 'acc', model: 'clef-flash', token: 'tok', fetch: fakeFetch });
        expect(await clef.classify('Order とは？', new AbortController().signal)).toEqual({ consultation: 0.82, changeRequest: 0.1, neither: 0.05 });
        expect(clef.model).toBe('clef-flash');
        expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clef-flash');
        expect(calls[0].init.headers).toEqual({ authorization: 'Bearer tok', 'content-type': 'application/json' });
        expect(JSON.parse(calls[0].init.body as string)).toEqual(clefRequest('clef-flash', 'Order とは？'));
        expect(clefRequest('clef', 'x')).toMatchObject({
            model: 'clef',
            state: 'x',
            questions: { consultation: { type: 'noul' }, change_request: { type: 'noul' }, neither: { type: 'noul' } },
        });
    });

    test('the probabilities bare or in Cloudflare’s result; an error or an answer without one of them throws', async () => {
        expect(clefProbabilities({ answers: answers(0.3, 0.6, 0.1) })).toEqual({ consultation: 0.3, changeRequest: 0.6, neither: 0.1 });
        expect(() => clefProbabilities({ result: { answers: { consultation: { type: 'noul', noul: 0.3 } } } })).toThrow();
        expect(() => clefProbabilities({ answers: answers(2, 0, 0) })).toThrow();
        const failing = createClefClassifier({
            accountId: 'acc',
            model: 'clef',
            token: 'tok',
            fetch: (async () => new Response('no', { status: 401 })) as unknown as typeof fetch,
        });
        expect(await failing.classify('x', new AbortController().signal).then(String, (e: unknown) => String(e))).toContain('401');
    });
});

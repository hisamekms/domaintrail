// The extraction entry point of the agent API (ADR 0031, section 3): an extraction handed to a connected extractor and
// its result taken back, `unavailable` without one (or when it goes away), the credential refused in a result, the
// session's end told; the light model's question handed out the same way, marked `gate`.
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ExtractionInput } from '@domaintrail/knowledge';
import { createExtractionDispatcher, readExtractionResult } from './extractions.js';

/** A response that keeps what is written to it. */
type Kept = { written: string[]; status?: number; ended: boolean };
function fakeResponse(): ServerResponse & Kept {
    const kept: Kept = { written: [], ended: false };
    const fake: object = Object.assign(new EventEmitter(), kept, {
        writeHead(status: number) {
            Object.assign(fake, { status });
            return fake;
        },
        write(chunk: string) {
            (fake as Kept).written.push(chunk);
            return true;
        },
        end(chunk?: string) {
            if (chunk) (fake as Kept).written.push(chunk);
            (fake as Kept).ended = true;
            return fake;
        },
        setHeader: () => fake,
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stand-in with the parts of a response the dispatcher uses
    return fake as ServerResponse & Kept;
}

const input: ExtractionInput = { session: 's1', number: 1, messages: [], items: [], stickies: [] };
const events = (res: { written: string[] }): { event: string; data: Record<string, unknown> }[] =>
    res.written
        .filter((w) => w.startsWith('event: '))
        .map((w) => {
            const [event, data] = w.trim().split('\n');
            return { event: event.slice('event: '.length), data: JSON.parse(data.slice('data: '.length)) as Record<string, unknown> };
        });

describe('the extraction entry point', () => {
    test('no extractor connected: unavailable', async () => {
        const dispatcher = createExtractionDispatcher({ timeoutMs: 1_000, maxStreams: 2, log: () => {} });
        expect(await dispatcher.extract(input)).toEqual({ kind: 'unavailable' });
        dispatcher.close(false);
    });

    test('a job to the connected extractor, its result back; the extractor going away leaves the next one unavailable', async () => {
        let connected = 0;
        const dispatcher = createExtractionDispatcher({ timeoutMs: 1_000, maxStreams: 2, token: 'secret', onConnected: () => connected++, log: () => {} });
        const stream = fakeResponse();
        dispatcher.events({} as IncomingMessage, stream);
        expect([connected, dispatcher.connected(), stream.status]).toEqual([1, 1, 200]);
        const answer = dispatcher.extract(input);
        const [job] = events(stream);
        expect(job.event).toBe('extraction.job');
        expect(job.data).toMatchObject({ session: 's1', number: 1, timeoutMs: 1_000, stage: 'extract' });
        const res = fakeResponse();
        dispatcher.result(res, String(job.data.job), { reply: { operations: [] }, model: 'opus', durationMs: 900, usage: { inputTokens: 10, junk: 'x' } });
        expect(await answer).toEqual({ kind: 'done', result: { reply: { operations: [] }, model: 'opus', durationMs: 900, usage: { inputTokens: 10 } } });
        expect(res.status).toBe(200);
        // the job is done: a second result is refused
        const again = fakeResponse();
        dispatcher.result(again, String(job.data.job), {});
        expect(again.status).toBe(409);
        // handed out, then the extractor goes away
        const pending = dispatcher.extract(input);
        stream.emit('close');
        expect(await pending).toEqual({ kind: 'unavailable' });
        expect(await dispatcher.extract(input)).toEqual({ kind: 'unavailable' });
        dispatcher.close(false);
    });

    test("the light model's question: a job of its own stage, its reply taken back as given; one job at a time per extractor", async () => {
        const dispatcher = createExtractionDispatcher({ timeoutMs: 1_000, maxStreams: 2, log: () => {} });
        const stream = fakeResponse();
        dispatcher.events({} as IncomingMessage, stream);
        const answer = dispatcher.gate({ session: 's1', number: 2, messages: [], stickies: ['見積もり'] });
        // its extractor is busy: the extraction waits for none, it is unavailable now
        expect(await dispatcher.extract(input)).toEqual({ kind: 'unavailable' });
        const [job] = events(stream);
        expect(job.data).toMatchObject({ stage: 'gate', number: 2, stickies: ['見積もり'] });
        expect(job.data).not.toHaveProperty('items');
        dispatcher.result(fakeResponse(), String(job.data.job), { reply: { verdict: 'no', messages: [] }, model: 'haiku', durationMs: 300 });
        expect(await answer).toEqual({ kind: 'done', result: { reply: { verdict: 'no', messages: [] }, model: 'haiku', durationMs: 300 } });
        dispatcher.close(false);
    });

    test('a result holding the credential is refused, and the extraction failed; the end of the session is told', async () => {
        const dispatcher = createExtractionDispatcher({ timeoutMs: 1_000, maxStreams: 2, token: 'secret', log: () => {} });
        const stream = fakeResponse();
        dispatcher.events({} as IncomingMessage, stream);
        const answer = dispatcher.extract(input);
        const [job] = events(stream);
        const res = fakeResponse();
        dispatcher.result(res, String(job.data.job), { reply: { operations: [{ text: 'the token is secret' }] }, durationMs: 1 });
        expect(res.status).toBe(400);
        expect(await answer).toEqual({ kind: 'done', result: { error: 'refused: the output contained a credential', durationMs: 1 } });
        dispatcher.close(true);
        expect(events(stream).map((e) => e.event)).toEqual(['extraction.job', 'session.closed']);
        expect(stream.ended).toBe(true);
    });

    test("a result's envelope: an error wins over a reply; the numbers kept only when they are ones", () => {
        expect(readExtractionResult({ error: '  timed out ', reply: { operations: [] }, durationMs: -5 })).toEqual({ error: 'timed out', durationMs: 0 });
        expect(readExtractionResult({ reply: 'text', model: 7, durationMs: 12 })).toEqual({ reply: 'text', durationMs: 12 });
    });
});

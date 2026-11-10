import { expect, test } from 'bun:test';
import { workerKnowledgeApi } from '../published/api';
import { sessionKnowledgeApi } from './api';

test('both knowledge pages write the project bookmark through their own API', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const original = globalThis.fetch;
    const item = {
        state: 'Live',
        id: 'kn_00000001',
        content: { title: '月末締め', text: '翌月に作業する', labels: { when: 'as_is', kind: 'rule', origin: 'said' }, about: [] },
        sources: [],
        version: 1,
        conflictsWith: [],
        createdAt: '2026-11-05T09:00:00.000Z',
        updatedAt: '2026-11-05T09:00:00.000Z',
        bookmarked: true,
    };
    Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            calls.push({
                url: url instanceof Request ? url.url : url instanceof URL ? url.href : url,
                method: init?.method ?? 'GET',
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            });
            return new Response(JSON.stringify(item), { headers: { 'content-type': 'application/json' } });
        },
    });
    try {
        expect((await sessionKnowledgeApi.setBookmark(item.id, true)).bookmarked).toBe(true);
        expect((await workerKnowledgeApi('shop').setBookmark(item.id, false)).bookmarked).toBe(true);
        expect(calls).toEqual([
            { url: '/api/session/knowledge/items/kn_00000001/bookmark', method: 'POST', body: { bookmarked: true } },
            { url: '/v1/projects/shop/knowledge/kn_00000001/bookmark', method: 'POST', body: { bookmarked: false } },
        ]);
    } finally {
        Object.defineProperty(globalThis, 'fetch', { configurable: true, value: original });
    }
});

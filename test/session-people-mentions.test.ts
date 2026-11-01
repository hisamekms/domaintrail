// Mentions of people (ADR 0026, amendment "mentions of people"): a message names 0 to 20 participants of its session,
// each once, as `mentions`; its body writes them `@name[pN]`. The body's tokens as the page, the prompt and the
// classifier read them (`domain/body.ts`), the use case's checks, and the session server's route.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Collaboration as C } from '@domaintrail/collaboration/generated/index';
import { createCollaboration, type CollaborationUseCases } from '@domaintrail/collaboration/application/use-cases';
import { MAX_REQUEST_MENTIONS, parseBody, peopleAsNames, plainBody, renumberTokens, tokenName, tokensIn } from '@domaintrail/collaboration/domain/body';
import { openSessionBlobs } from '@domaintrail/collaboration/infrastructure/blobs';
import { createUnitOfWork, openDatabase } from '@domaintrail/collaboration/infrastructure/sqlite';
import { createModelValidator } from '@domaintrail/collaboration/infrastructure/validator';
import { startSessionServer, type SessionServer } from '@domaintrail/composition/session';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/modeling/core/config';
import { createWorkspaceSnapshot } from '@domaintrail/workspace/infrastructure/snapshot';

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};
const error = <E>(r: { ok: true } | { ok: false; error: E }): E => {
    if (r.ok) throw new Error('expected an error');
    return r.error;
};

const DT = `context Sales {
  id OrderId: UUID

  aggregate Order {
    id: OrderId
  }
}
`;

async function workspace(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-mentions-'));
    dirs.push(root);
    await writeFile(path.join(root, 'sales.dt'), DT);
    return root;
}

describe("a body's tokens", () => {
    const counts = { targets: 2, people: 1 };
    test('`#name[n]` is an element, `@name[n]` too (as written before), `@name[pN]` a person; the rest is text', () => {
        expect(parseBody('#注文[1] と @顧客[2] を @佐藤[p1] に <b>確認</b> #謎[3] @謎[p2] #人[p1] a@b[1]', counts)).toEqual([
            { kind: 'element', name: '注文', index: 0 },
            { kind: 'text', text: ' と ' },
            { kind: 'element', name: '顧客', index: 1 },
            { kind: 'text', text: ' を ' },
            { kind: 'person', name: '佐藤', index: 0 },
            // past the request's targets and people, and a person written with `#`: text as it was written
            { kind: 'text', text: ' に <b>確認</b> #謎[3] @謎[p2] #人[p1] a' },
            { kind: 'element', name: 'b', index: 0 },
        ]);
        // a Japanese IME's full-width signs
        expect(parseBody('＃注文[1]＠佐藤[p1]', counts)).toEqual([
            { kind: 'element', name: '注文', index: 0 },
            { kind: 'person', name: '佐藤', index: 0 },
        ]);
    });

    test('on one line: `#name` and `@name`; bare (for the classifier): the names alone', () => {
        expect(plainBody('#注文[1] を @佐藤[p1] と @顧客[2] で #謎[3]', counts)).toBe('#注文 を @佐藤 と #顧客 で #謎[3]');
        expect(plainBody('#注文[1] を @佐藤[p1] が見る', undefined, true)).toBe('注文 を 佐藤 が見る');
    });

    test('the prompt reads a person as a plain `@name` and keeps the elements numbered', () => {
        expect(peopleAsNames('#注文[1] を @佐藤[p1] と @顧客[2]')).toBe('#注文[1] を @佐藤 と @顧客[2]');
    });

    test('the tokens of a text, renumbered by kind; a name made fit for a token', () => {
        expect(tokensIn('#a[1] @b[p2] @c[3]')).toEqual([
            { kind: 'element', name: 'a', index: 0 },
            { kind: 'person', name: 'b', index: 1 },
            { kind: 'element', name: 'c', index: 2 },
        ]);
        expect(renumberTokens('#a[1] @b[p2] @c[3]', 'person', (i) => (i === 1 ? 0 : undefined))).toBe('#a[1] @b[p1] @c[3]');
        expect(renumberTokens('#a[1] @b[p2] @c[3]', 'element', (i) => (i === 0 ? undefined : i - 1))).toBe('a @b[p2] @c[2]');
        expect(tokenName('佐藤 #1 @x [y]')).toBe('佐藤1xy');
        expect(tokenName('  ')).toBe('?');
    });
});

describe('sending a message that mentions people', () => {
    let use: CollaborationUseCases;
    let session: C.SessionId;
    let other: C.SessionId;
    const facilitator = value(C.makeParticipantId('facilitator'));
    const ann = value(C.makeParticipantId('ann'));
    const bob = value(C.makeParticipantId('bob'));
    const stranger = value(C.makeParticipantId('stranger'));
    const name = value(C.makeDisplayName('Ada'));
    const body = value(C.makeText('@Bob[p1] 見て'));

    beforeAll(async () => {
        const root = await workspace();
        let n = 0;
        use = createCollaboration({
            uow: createUnitOfWork(openDatabase(':memory:')),
            workspace: createWorkspaceSnapshot(root),
            blobs: await openSessionBlobs(root),
            validator: createModelValidator(),
            clock: { now: () => new Date('2026-11-01T09:00:00Z') },
            ids: { newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` },
        });
        session = value(await use.startSession({ facilitator, name })).session.id;
        value(await use.joinSession({ session, participant: ann, name }));
        value(await use.joinSession({ session, participant: bob, name }));
        // a participant of another session only
        const elsewhere = await use.startSession({ facilitator: stranger, name });
        other = value(elsewhere).session.id;
    });

    test('the session’s participants, each once, kept in order; the facilitator too', async () => {
        const sent = value(await use.sendRequest({ session, author: ann, targets: [], body, mentions: [bob, facilitator] }));
        expect(sent.mentions).toEqual([bob, facilitator]);
        const state = value(await use.sessionState({ session }));
        expect(state.requests.find((r) => r.id === sent.id)?.mentions).toEqual([bob, facilitator]);
        // none: an empty list
        expect(value(await use.sendRequest({ session, author: ann, targets: [], body })).mentions).toEqual([]);
    });

    test('not someone outside the session (of another one, or unknown), nor twice, nor more than 20', async () => {
        expect(error(await use.sendRequest({ session, author: ann, targets: [], body, mentions: [bob, stranger] }))).toEqual({
            type: 'MentionedNotAParticipant',
            participant: stranger,
        });
        expect(other).not.toBe(session);
        expect(error(await use.sendRequest({ session, author: ann, targets: [], body, mentions: [bob, bob] }))).toEqual({ type: 'DuplicateMention' });
        // 21 participants are not needed to pass the limit: the count is checked before anything is sent
        const many = Array.from({ length: MAX_REQUEST_MENTIONS + 1 }, () => bob);
        expect(error(await use.sendRequest({ session, author: ann, targets: [], body, mentions: many })).type).toBe('TooManyMentions');
        // nothing was sent
        const state = value(await use.sessionState({ session }));
        expect(state.requests.filter((r) => r.mentions.includes(stranger) || r.mentions.length > 2)).toEqual([]);
    });
});

describe('the requests route with mentions', () => {
    let server: SessionServer;
    let ada: string;
    let bob: string;
    // what the classifier is asked: the bodies with their mentions as names
    const classified: string[] = [];
    const json = { 'content-type': 'application/json' };
    const join = async (who: string): Promise<string> => {
        const res = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: who }) });
        return (res.headers.get('set-cookie') ?? '').split(';')[0];
    };
    const api = (cookie: string, p: string, body?: unknown): Promise<Response> =>
        fetch(`${server.url}api/session/${p}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { cookie, ...(body !== undefined && json) },
            ...(body !== undefined && { body: JSON.stringify(body) }),
        });

    beforeAll(async () => {
        server = await startSessionServer({
            root: await workspace(),
            debounceMs: 30,
            classifier: {
                classify: async (text) => {
                    classified.push(text);
                    return 0.9;
                },
            },
            session: {
                port: 0,
                host: '127.0.0.1',
                identity: 'dev',
                agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS], maxPreviousRunDiff: 20 * 1024 },
                maxParticipants: 50,
                quickReactions: ['👍'],
                classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.5 },
            },
        });
        await server.ready;
        ada = await join('Ada');
        bob = await join('Bob');
    });
    afterAll(() => server?.stop());

    test('mentions the session’s participants; refused with the field or the error otherwise', async () => {
        const state = (await (await api(ada, 'state')).json()) as { session: { participants: { id: string; name: string }[] } };
        const bobId = state.session.participants.find((p) => p.name === 'Bob')?.id ?? '';
        const sent = await api(ada, 'requests', { targets: [], body: '@Bob[p1] 見て', mentions: [bobId] });
        expect(sent.status).toBe(201);
        expect(((await sent.json()) as { request: { mentions: string[] } }).request.mentions).toEqual([bobId]);
        for (let i = 0; i < 50 && classified.length === 0; i++) await Bun.sleep(10);
        expect(classified).toEqual(['Bob 見て']);
        // without: none
        const plain = (await (await api(bob, 'requests', { targets: [], body: 'x' })).json()) as { request: { mentions: string[] } };
        expect(plain.request.mentions).toEqual([]);

        const bad = async (body: unknown): Promise<[number, string]> => {
            const res = await api(ada, 'requests', body);
            const e = ((await res.json()) as { error: { type: string; field?: string } }).error;
            return [res.status, e.field ?? e.type];
        };
        expect(await bad({ targets: [], body: 'x', mentions: 'bob' })).toEqual([400, 'mentions']);
        expect(await bad({ targets: [], body: 'x', mentions: [bobId, bobId] })).toEqual([400, 'mentions[1]']);
        expect(await bad({ targets: [], body: 'x', mentions: [''] })).toEqual([400, 'mentions[0]']);
        expect(await bad({ targets: [], body: 'x', mentions: Array.from({ length: 21 }, (_, i) => `p${i}`) })).toEqual([400, 'mentions']);
        expect(await bad({ targets: [], body: 'x', mentions: ['dev:nobody'] })).toEqual([400, 'MentionedNotAParticipant']);
    });
});

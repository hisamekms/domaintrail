// The session's records (records.ts) over the real store (SQLite) and a journey file in memory: the facilitator's acts
// recorded (a goal, marks merged while nothing comes between, a journey done with dt's note, the current journey
// chosen), nothing for an act that changed nothing, a participant's request and its outcome on the same record, the
// journey file changed outside dt, the records kept in the database and told in the session so far.
import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Collaboration as C, type Result } from '../generated/index.js';
import { sha256Hex } from '../domain/sha256.js';
import { writeJourney, type JourneyFile } from '../domain/journey.js';
import { createUnitOfWork, openDatabase } from '../infrastructure/sqlite.js';
import type { Actor } from './actor.js';
import type { CollaborationDeps, JourneyFileStore } from './ports.js';
import { createCollaboration, type CollaborationUseCases } from './use-cases.js';

const value = <T, E>(r: Result<T, E>): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};

const facilitatorId = value(C.makeParticipantId('local:facilitator'));
const bobId = value(C.makeParticipantId('dev:bob'));
const facilitator: Actor = { kind: 'participant', participant: facilitatorId, role: 'Facilitator' };
const bob: Actor = { kind: 'participant', participant: bobId, role: 'Participant' };
const REQUEST = '00000000-0000-4000-8000-00000000aaaa';

const FILE: JourneyFile = {
    version: 1,
    stormings: { Issue: { purpose: '交付の流れ', participants: [], use: 'modeling', level: 'BigPicture', state: 'active', marks: [] } },
    modeling: [
        {
            id: 'all',
            name: '全体',
            purpose: '全体を描く',
            participants: [],
            pattern: 'Whole',
            goal: 'invariants',
            state: 'active',
            marks: { steps: [], contexts: {} },
        },
    ],
};
const labels = (key: string): string | undefined => (key === 'es:Issue' ? '交付' : undefined);

function memoryJourneys(initial?: string): JourneyFileStore {
    let text = initial;
    return {
        read: async () => text,
        write: async (next, expected) => {
            if (text !== expected) return false;
            text = next;
            return true;
        },
    };
}

async function open(file = ':memory:') {
    let t = Date.parse('2026-11-04T09:00:00Z');
    let n = 0;
    const db = openDatabase(file);
    const deps: CollaborationDeps = {
        uow: createUnitOfWork(db),
        journeys: memoryJourneys(writeJourney(FILE)),
        workspace: {
            read: async () => ({ files: [{ path: 'a.dt', bytes: new Uint8Array(), hash: sha256Hex(new Uint8Array()) }], symlinks: [] }),
            write: async () => ({ ok: true }),
        },
        blobs: { put: async () => undefined, get: async () => undefined },
        validator: { validate: async () => ({ diagnostics: [], model: undefined, stormings: [], stormingsComplete: true }) },
        clock: { now: () => new Date((t += 1000)) },
        ids: { newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` },
    };
    const use: CollaborationUseCases = createCollaboration(deps);
    const session = value(await use.openSession({ mode: 'Collab', facilitator: facilitatorId, name: value(C.makeDisplayName('Ada')) })).session.id;
    value(await use.joinSession({ session, participant: bobId, name: value(C.makeDisplayName('Bob')) }));
    const records = async (): Promise<readonly C.SessionRecord[]> => value(await use.sessionState({ session })).records;
    return { use, session, records, db };
}

describe('the acts recorded', () => {
    test('a goal changed; marks merge while nothing comes between; an act that changed nothing is not recorded', async () => {
        const { use, session, records } = await open();
        const act = (a: Parameters<CollaborationUseCases['actOnJourney']>[0]['act']) => use.actOnJourney({ actor: facilitator, act: a, session, labels });
        value(await act({ kind: 'goal', journey: 'es:Issue', goal: 'DesignLevel' }));
        value(await act({ kind: 'mark', journey: 'es:Issue', step: 'exceptions', done: true }));
        value(await act({ kind: 'mark', journey: 'es:Issue', step: 'questions', done: true }));
        // set again: the file does not change, nothing is recorded
        value(await act({ kind: 'mark', journey: 'es:Issue', step: 'questions', done: true }));
        expect((await records()).map((r) => r.fact)).toEqual([
            { kind: 'GoalChanged', journey: { journey: 'es:Issue', label: '交付' }, from: 'BigPicture', to: 'DesignLevel', other: true },
            {
                kind: 'MarksChanged',
                journey: { journey: 'es:Issue', label: '交付' },
                done: true,
                marks: [{ step: 'exceptions' }, { step: 'questions' }],
                other: true,
            },
        ] as unknown as C.RecordFact[]);
        // a message in between: the next mark is a row of its own
        value(await use.sendMessage({ session, actor: bob, targets: [], body: value(C.makeText('ここまでで合っていますか')) }));
        value(await act({ kind: 'mark', journey: 'es:Issue', step: 'exceptions', done: false }));
        value(await act({ kind: 'mark', journey: 'es:Issue', step: 'questions', done: false }));
        const last = (await records()).at(-1);
        expect(last?.fact).toMatchObject({ kind: 'MarksChanged', done: false, marks: [{ step: 'exceptions' }, { step: 'questions' }] });
        expect(await records()).toHaveLength(3);
    });

    test('a journey marked done: its record and dt’s note with the next step, in the language asked', async () => {
        const { use, session, records } = await open();
        value(await use.actOnJourney({ actor: facilitator, act: { kind: 'state', journey: 'es:Issue', state: 'done' }, session, labels }));
        expect((await records()).map((r) => r.fact)).toMatchObject([{ kind: 'StateChanged', state: 'Done' }]);
        const note = value(await use.sessionState({ session })).requests.at(-1);
        expect(note).toMatchObject({ author: 'ai', body: '「交付」を完了にしました。\n次はこのストーミングからモデリングを始めましょう。' });
        expect(note?.journeyNote).toEqual({ journey: 'es:Issue', command: 'ModelStart', targets: [] } as unknown as C.JourneyNote);
        expect(note?.replyTo).toBeUndefined();
        value(await use.actOnJourney({ actor: facilitator, act: { kind: 'state', journey: 'all', state: 'done' }, session, language: 'En' }));
        const model = value(await use.sessionState({ session })).requests.at(-1);
        expect(String(model?.body)).toBe('“全体” is complete.\nChoose another journey from the journeys.');
        expect(model?.journeyNote?.command).toBeUndefined();
    });

    test('the current journey chosen by a person is recorded; the same again, or none, is not', async () => {
        const { use, session, records } = await open();
        const key = value(C.makeGuideJourneyKey('es:Issue'));
        value(await use.chooseJourney({ session, actor: facilitator, journey: key, labels }));
        value(await use.chooseJourney({ session, actor: facilitator, journey: key, labels }));
        value(await use.chooseJourney({ session, actor: facilitator }));
        expect((await records()).map((r) => r.fact)).toEqual([
            { kind: 'CurrentChosen', journey: { journey: 'es:Issue', label: '交付' } },
        ] as unknown as C.RecordFact[]);
    });
});

describe('a participant’s request', () => {
    test('recorded when made, waiting; its outcome written on the same record; decided once', async () => {
        const { use, session, records } = await open();
        value(
            await use.recordJourneyRequest({
                session,
                actor: bob,
                request: REQUEST,
                act: { kind: 'goal', journey: 'es:Issue', goal: 'DesignLevel' },
                file: FILE,
                labels,
            }),
        );
        expect(await use.openJourneyRequests({ session })).toMatchObject([
            { id: REQUEST, by: bobId, act: { kind: 'goal', journey: 'es:Issue', goal: 'DesignLevel' } },
        ]);
        const decided = value(await use.decideJourneyRequest({ session, request: REQUEST, outcome: 'Approved', by: facilitatorId }));
        expect(decided?.fact).toMatchObject({ kind: 'JourneyRequested', outcome: 'Approved', decidedBy: facilitatorId });
        expect(decided?.revisedAt).toBeInstanceOf(Date);
        expect(await use.openJourneyRequests({ session })).toEqual([]);
        // decided already: nothing changes
        expect(value(await use.decideJourneyRequest({ session, request: REQUEST, outcome: 'Denied', by: facilitatorId }))).toBeUndefined();
        expect(await records()).toHaveLength(1);
        const soFar = value(await use.sessionSoFar({ session })).text;
        expect(soFar).toContain('Bob asks to set the goal of “交付” to Design Level');
        expect(soFar).toContain("Ada approved Bob's request");
    });
});

describe('the journey file changed outside dt', () => {
    test('recorded with what changed; nothing when nothing that matters did', async () => {
        const { use, session, records } = await open();
        const after: JourneyFile = { ...FILE, modeling: [{ ...FILE.modeling[0]!, goal: 'commands' }] };
        expect(value(await use.recordJourneyFileChange({ session, before: FILE, after: FILE, unreadable: false }))).toBeUndefined();
        value(await use.recordJourneyFileChange({ session, before: FILE, after, unreadable: false, labels }));
        expect((await records()).map((r) => [r.by, r.fact])).toEqual([
            [
                undefined,
                {
                    kind: 'FileChangedOutside',
                    changes: [{ kind: 'Goal', journey: { journey: 'all', label: '全体' }, from: 'invariants', to: 'commands' }],
                    more: 0,
                    unreadable: false,
                },
            ],
        ] as unknown as [undefined, C.RecordFact][]);
        expect(value(await use.sessionSoFar({ session })).text).toContain('The journey file changed outside dt (goal of “全体”: Invariants → Commands)');
    });
});

describe('persistence', () => {
    test('the records are kept in the session’s database: read back after it is opened again', async () => {
        const file = path.join(await mkdtemp(path.join(tmpdir(), 'dt-records-')), 'session.db');
        const { use, session } = await open(file);
        value(await use.actOnJourney({ actor: facilitator, act: { kind: 'goal', journey: 'all', goal: 'contextMap' }, session, labels }));
        value(await use.recordJourneyRequest({ session, actor: bob, request: REQUEST, act: { kind: 'choose', journey: 'es:Issue' }, file: FILE, labels }));
        const again = await createUnitOfWork(openDatabase(file)).transaction((s) => s.records.listBySession(session));
        expect(again.map((r) => r.fact.kind)).toEqual(['GoalChanged', 'JourneyRequested']);
        expect(again[0]?.at).toBeInstanceOf(Date);
    });
});

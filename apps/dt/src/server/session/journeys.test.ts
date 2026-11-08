// The journey file in the session server (journeys.ts) over the real use cases and store: dt's own writes are not
// recorded as changes from outside, any other change is; a participant's request is recorded and, after a restart,
// rebuilt from its record (still waiting), then decided.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
    Collaboration as C,
    createCollaboration,
    createUnitOfWork,
    openSessionDatabase,
    writeJourney,
    type Actor,
    type JourneyFile,
} from '@domaintrail/collaboration';
import type { JourneyBody } from '@domaintrail/collaboration/protocol';
import { createSessionJourneys, rememberWrites } from './journeys.js';

const made = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
};
const ada = made(C.makeParticipantId('local:facilitator'));
const bob = made(C.makeParticipantId('dev:bob'));
const facilitator: Actor = { kind: 'participant', participant: ada, role: 'Facilitator' };
const participant: Actor = { kind: 'participant', participant: bob, role: 'Participant' };

const FILE: JourneyFile = {
    version: 1,
    stormings: { Issue: { purpose: '交付の流れ', participants: [], use: 'align', level: 'BigPicture', state: 'active', marks: [] } },
    modeling: [],
};

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup() {
    const dir = await mkdtemp(path.join(tmpdir(), 'dt-journeys-'));
    dirs.push(dir);
    let text: string | undefined = writeJourney(FILE);
    const disk = {
        read: async (): Promise<string | undefined> => text,
        write: async (next: string, expected: string | undefined): Promise<boolean> => (text === expected ? ((text = next), true) : false),
        /** Another tool writes the file. */
        edit: (next: string): void => {
            text = next;
        },
    };
    const store = rememberWrites(disk);
    let n = 0;
    let t = Date.parse('2026-11-04T09:00:00Z');
    const collaboration = createCollaboration({
        uow: createUnitOfWork(await openSessionDatabase(dir)),
        journeys: store,
        workspace: { read: async () => ({ files: [], symlinks: [] }), write: async () => ({ ok: true }) },
        blobs: { put: async () => undefined, get: async () => undefined },
        validator: { validate: async () => ({ diagnostics: [], model: undefined, stormings: [], stormingsComplete: true }) },
        clock: { now: () => new Date((t += 1000)) },
        ids: { newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` },
    });
    const session = made(await collaboration.openSession({ mode: 'Collab', facilitator: ada, name: made(C.makeDisplayName('Ada')) })).session.id;
    made(await collaboration.joinSession({ session, participant: bob, name: made(C.makeDisplayName('Bob')) }));
    const server = async () => {
        let body: JourneyBody | undefined;
        const journeys = createSessionJourneys({
            session,
            store,
            collaboration,
            labels: (key) => (key === 'es:Issue' ? '交付' : undefined),
            changed: (b) => (body = b),
            now: () => new Date(t),
            log: () => {},
        });
        await journeys.reload();
        await journeys.restore();
        return { journeys, body: () => body ?? journeys.body() };
    };
    const kinds = async (): Promise<string[]> => made(await collaboration.sessionState({ session })).records.map((r) => r.fact.kind);
    return { disk, server, kinds, collaboration, session };
}

describe('the journey file in the session server', () => {
    test("dt's own write is not a change from outside; another tool's is, with what changed", async () => {
        const { disk, server, kinds } = await setup();
        const { journeys } = await server();
        expect(await journeys.act(facilitator, 'Ada', { kind: 'goal', journey: 'es:Issue', goal: 'DesignLevel' }, 'ja')).toEqual({ done: true });
        // the watcher reads it again: dt wrote it
        await journeys.reload();
        expect(await kinds()).toEqual(['GoalChanged']);
        disk.edit(writeJourney({ ...FILE, stormings: { Issue: { ...FILE.stormings.Issue!, state: 'done' } } }));
        await journeys.reload();
        expect(await kinds()).toEqual(['GoalChanged', 'FileChangedOutside']);
        // the same text read again: nothing new
        await journeys.reload();
        expect(await kinds()).toEqual(['GoalChanged', 'FileChangedOutside']);
    });

    test('a request kept across a restart: rebuilt from its record, then approved (done as the facilitator’s)', async () => {
        const { server, kinds, collaboration, session } = await setup();
        const first = await server();
        const asked = await first.journeys.act(participant, 'Bob', { kind: 'state', journey: 'es:Issue', state: 'done' });
        expect(asked).toMatchObject({ done: false, request: { by: bob } });
        const id = 'request' in asked && asked.request ? asked.request.id : '';
        // a new server (a restart): the request still waits, named by the participant's name in the session
        const again = await server();
        expect(again.body().requests).toMatchObject([{ id, by: bob, byName: 'Bob', act: { kind: 'state', journey: 'es:Issue', state: 'done' } }]);
        expect(await again.journeys.decide(facilitator, id, true, 'en')).toEqual({ done: true });
        expect(again.body().requests).toEqual([]);
        expect(await kinds()).toEqual(['JourneyRequested', 'StateChanged']);
        const state = made(await collaboration.sessionState({ session }));
        expect(state.records[0]?.fact).toMatchObject({ outcome: 'Approved', decidedBy: ada });
        // done: dt's note in the facilitator's language, /es:recap for an ES journey to align
        expect(state.requests.at(-1)).toMatchObject({ body: '“交付” is complete.\nNext, recap what you have.', journeyNote: { command: 'EsRecap' } });
    });

    test('a participant BP→DL request invites only after facilitator approval', async () => {
        const { server, collaboration, session } = await setup();
        const { journeys } = await server();
        const asked = await journeys.act(participant, 'Bob', { kind: 'goal', journey: 'es:Issue', goal: 'DesignLevel' });
        const invitations = async () => made(await collaboration.sessionState({ session })).requests.filter((r) => r.journeyNote?.invitation);
        expect(await invitations()).toHaveLength(0);
        const id = 'request' in asked && asked.request ? asked.request.id : '';
        expect(await journeys.decide(facilitator, id, true, 'ja')).toEqual({ done: true });
        expect(await invitations()).toHaveLength(1);
        expect(await journeys.act(facilitator, 'Ada', { kind: 'goal', journey: 'es:Issue', goal: 'DesignLevel' }, 'ja')).toEqual({ done: true });
        expect(await invitations()).toHaveLength(1);
    });
});

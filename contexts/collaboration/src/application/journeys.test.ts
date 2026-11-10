// The journey file's use cases (journeys.ts) over the real store (in-memory SQLite) and a journey file in memory: the
// acts on the file and the current journey, the facilitator's (in Solo the one person's) and refused for a
// participant; dt's writes never over a file that changed or does not read; the guide's marks the file's, the
// session's old ✓ marks ignored.
import { describe, expect, test } from 'bun:test';
import { Collaboration as C, type Result } from '../generated/index.js';
import { sha256Hex } from '../domain/sha256.js';
import { readJourney, writeJourney, type JourneyFile } from '../domain/journey.js';
import { analyzeDomain } from '@domaintrail/modeling';
import { createUnitOfWork, openDatabase } from '../infrastructure/sqlite.js';
import type { Actor } from './actor.js';
import { journeyFileMarks, updateJourneys } from './journeys.js';
import type { CollaborationDeps, JourneyFileStore } from './ports.js';
import { createCollaboration, type CollaborationUseCases } from './use-cases.js';

const value = <T, E>(r: Result<T, E>): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};
const error = <T, E>(r: Result<T, E>): E => {
    if (r.ok) throw new Error(`expected an error, got ${JSON.stringify(r.value)}`);
    return r.error;
};

const facilitatorId = value(C.makeParticipantId('local:facilitator'));
const bobId = value(C.makeParticipantId('dev:bob'));
const facilitator: Actor = { kind: 'participant', participant: facilitatorId, role: 'Facilitator' };
const bob: Actor = { kind: 'participant', participant: bobId, role: 'Participant' };

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

/** A journey file in memory, written only over the text read; `meddle` changes it between a read and a write. */
function memoryJourneys(initial?: string): JourneyFileStore & { text(): string | undefined; meddle(times: number): void } {
    let text = initial;
    let meddling = 0;
    return {
        read: async () => text,
        write: async (next, expected) => {
            if (meddling > 0) {
                meddling -= 1;
                text = `${text ?? ''} `;
            }
            if (text !== expected) return false;
            text = next;
            return true;
        },
        text: () => text,
        meddle: (times) => (meddling = times),
    };
}

function collaboration(journeys: JourneyFileStore): CollaborationUseCases {
    const files = new Map<string, Uint8Array>([['sales/order.dt', new TextEncoder().encode('context Sales {}\n')]]);
    let t = Date.parse('2026-11-03T09:00:00Z');
    let n = 0;
    const deps: CollaborationDeps = {
        uow: createUnitOfWork(openDatabase(':memory:')),
        journeys,
        workspace: {
            read: async () => ({ files: [...files].map(([path, bytes]) => ({ path, bytes, hash: sha256Hex(bytes) })), symlinks: [] }),
            write: async () => ({ ok: true }),
        },
        blobs: { put: async () => undefined, get: async () => undefined },
        validator: { validate: async () => ({ diagnostics: [], model: undefined, stormings: [], stormingsComplete: true }) },
        clock: { now: () => new Date((t += 1000)) },
        ids: { newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` },
    };
    return createCollaboration(deps);
}

async function open(mode: C.SessionMode, journeys = memoryJourneys(writeJourney(FILE))) {
    const use = collaboration(journeys);
    const name = value(C.makeDisplayName('Ada'));
    const session = value(await use.openSession({ mode, facilitator: facilitatorId, name })).session.id;
    if (mode === 'Collab') value(await use.joinSession({ session, participant: bobId, name: value(C.makeDisplayName('Bob')) }));
    return { use, session, journeys };
}

describe('the acts on the journey file', () => {
    test('Collab: the facilitator changes the goal, the state, a mark; a participant is refused (the server asks the facilitator)', async () => {
        const { use, journeys } = await open('Collab');
        expect(error(await use.actOnJourney({ actor: bob, act: { kind: 'goal', journey: 'es:Issue', goal: 'DesignLevel' } }))).toEqual({
            type: 'Collaboration.FacilitatorOnly',
        });
        expect(readJourney(journeys.text() ?? '').file.stormings.Issue?.level).toBe('BigPicture');
        value(await use.actOnJourney({ actor: facilitator, act: { kind: 'goal', journey: 'es:Issue', goal: 'DesignLevel' } }));
        value(await use.actOnJourney({ actor: facilitator, act: { kind: 'mark', journey: 'all', step: 'bcSplit', done: true } }));
        value(await use.actOnJourney({ actor: facilitator, act: { kind: 'state', journey: 'all', state: 'done' } }));
        const file = readJourney(journeys.text() ?? '').file;
        expect(file.stormings.Issue?.level).toBe('DesignLevel');
        expect(file.modeling[0]).toMatchObject({ state: 'done', marks: { steps: ['bcSplit'], contexts: {} } });
        expect(error(await use.actOnJourney({ actor: facilitator, act: { kind: 'goal', journey: 'all', goal: 'commands' } }))).toEqual({
            type: 'NotAJourneyGoal',
            goal: 'commands',
        });
    });

    test('Solo: the one person is the facilitator', async () => {
        const { use, journeys } = await open('Solo');
        value(await use.actOnJourney({ actor: facilitator, act: { kind: 'mark', journey: 'es:Issue', step: 'questions', done: true } }));
        expect(readJourney(journeys.text() ?? '').file.stormings.Issue?.marks).toEqual(['questions']);
    });

    test('never over a file that changed meanwhile (once more from the file as it is), nor over one that does not read', async () => {
        const once = memoryJourneys(writeJourney(FILE));
        once.meddle(1);
        expect(await updateJourneys(once, (f) => ({ ok: true, value: { file: { ...f, modeling: [] }, value: 1 } }))).toMatchObject({ ok: true });
        expect(readJourney(once.text() ?? '').file.modeling).toEqual([]);
        const always = memoryJourneys(writeJourney(FILE));
        always.meddle(2);
        expect(await updateJourneys(always, (f) => ({ ok: true, value: { file: f, value: 1 } }))).toMatchObject({ ok: true });
        always.meddle(2);
        expect(await updateJourneys(always, (f) => ({ ok: true, value: { file: { ...f, modeling: [] }, value: 1 } }))).toEqual({
            ok: false,
            error: { type: 'JourneyFileChanged' },
        });
        const broken = memoryJourneys('{ "version": 2 }');
        expect(await updateJourneys(broken, (f) => ({ ok: true, value: { file: f, value: 1 } }))).toMatchObject({
            ok: false,
            error: { type: 'JourneyFileInvalid' },
        });
        expect(broken.text()).toBe('{ "version": 2 }');
        // no file yet: written from nothing
        const none = memoryJourneys();
        value(await updateJourneys(none, (f) => ({ ok: true, value: { file: { ...f, stormings: FILE.stormings }, value: 1 } })));
        expect(readJourney(none.text() ?? '').file.stormings).toEqual(FILE.stormings);
    });

    test("the guide's marks are the journey file's: read from it, set and cleared as acts", async () => {
        const journeys = memoryJourneys(writeJourney(FILE));
        const store = journeyFileMarks(journeys, FILE);
        expect(store.read()).toEqual([]);
        value(await store.set({ journey: 'all', step: 'contexts', context: 'Sales' }));
        value(await store.set({ journey: 'es:Issue', step: 'exceptions' }));
        const file = readJourney(journeys.text() ?? '').file;
        expect(journeyFileMarks(journeys, file).read()).toEqual([
            { journey: 'es:Issue', step: 'exceptions' },
            { journey: 'all', step: 'contexts', context: 'Sales' },
        ]);
        value(await store.clear({ journey: 'es:Issue', step: 'exceptions' }));
        expect(readJourney(journeys.text() ?? '').file.stormings.Issue?.marks).toEqual([]);
        expect(error(await store.set({ journey: 'all', step: 'terms' }))).toEqual({ type: 'NotAJourneyMark', step: 'terms' });
    });
});

describe('the current journey', () => {
    test('Collab: the facilitator chooses it (none: the default), a participant is refused; Solo: the person', async () => {
        const { use, session } = await open('Collab');
        const all = value(C.makeGuideJourneyKey('all'));
        expect(error(await use.chooseJourney({ session, actor: bob, journey: all }))).toEqual({ type: 'Collaboration.FacilitatorOnly' });
        expect(value(await use.chooseJourney({ session, actor: facilitator, journey: all })).currentJourney as string | undefined).toBe('all');
        expect(value(await use.sessionState({ session })).session.currentJourney as string | undefined).toBe('all');
        expect(value(await use.chooseJourney({ session, actor: facilitator })).currentJourney).toBeUndefined();
        const events = await use.eventsAfter({ session, cursor: 0, limit: 100 });
        expect(events.map((e) => e.event.type).filter((x) => x === 'JourneyChosen')).toHaveLength(2);
        const solo = await open('Solo');
        expect(value(await solo.use.chooseJourney({ session: solo.session, actor: facilitator, journey: all })).currentJourney as string | undefined).toBe(
            'all',
        );
    });
});

describe("the session's old ✓ marks", () => {
    test('ignored: the guide reads the journey file only', async () => {
        const { use, session, journeys } = await open('Solo');
        // an older session's Done mark on a step of the journey `all`
        value(
            await use.setMark({
                session,
                actor: facilitator,
                target: { kind: 'GuideStep', journey: value(C.makeGuideJourneyKey('all')), step: value(C.makeGuideStepKey('bcSplit')) },
                sign: { kind: 'Done' },
                placed: true,
            }),
        );
        const domain = await analyzeDomain([{ path: 'sales.dt', text: 'context Sales {\n  id OrderId: UUID\n}' }]);
        const workspace = (file: JourneyFile) => ({ model: domain.model ?? null, stormings: [], diagnostics: [], journey: file });
        const guide = async (file: JourneyFile) => {
            const started = value(
                await use.startCommand({
                    session,
                    actor: facilitator,
                    kind: 'Guide',
                    body: value(C.makeText('ガイド')),
                    language: 'Ja',
                    workspace: workspace(file),
                }),
            );
            value(await use.stopCommand({ command: started.command.id, actor: facilitator }));
            return started.command.guide?.maps[0]?.steps.find((s) => s.key === 'bcSplit');
        };
        expect(await guide(FILE)).toMatchObject({ state: 'Todo', marked: false });
        value(await use.actOnJourney({ actor: facilitator, act: { kind: 'mark', journey: 'all', step: 'bcSplit', done: true } }));
        expect(await guide(readJourney(journeys.text() ?? '').file)).toMatchObject({ state: 'Done', marked: true });
    });
});

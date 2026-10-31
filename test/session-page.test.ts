import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { EventMessage, Presence, SessionStateBody, ViewLocation } from '@domaintrail/collaboration/protocol';
import { analyze } from '@domaintrail/modeling/core/analyze';
import type { DomainModel } from '@domaintrail/modeling/model/model';
import { parseStormings } from '@domaintrail/modeling/storming/parse';
import type { LaidOutGraph } from '@domaintrail/visualization/domain/graph/ir';
import { projectView } from '@domaintrail/visualization/domain/storming/render';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { loadWorkspace } from '@domaintrail/workspace/infrastructure/files';
import { createMemoryDrafts, editDraft, newDraft, sendable, sortDrafts } from '@domaintrail/web/session/drafts';
import { layoutKeyOf, NO_LAYOUT, sameLocation, shortHash, viewLocation } from '@domaintrail/web/session/location';
import { cursorsOn, initials, listedParticipants, NO_PEERS, receivePresence, throttle, whereabouts } from '@domaintrail/web/session/presence';
import { adopt, applyEvent, disconnected, INITIAL_SESSION, latestRevision, receive } from '@domaintrail/web/session/state';
import { SessionApiError } from '@domaintrail/web/session/api';
import { chooseForComparison, comparisonPair, diffLines, restoreProblem, timeline } from '@domaintrail/web/session/timeline';
import { occurrenceNode, selectionOf, targetKey, targetOfSelection, WORKSPACE_TARGET } from '@domaintrail/web/session/targets';
import { EXAMPLES } from './helpers.js';

const SAMPLE = await readFile(path.join(import.meta.dir, 'fixtures', 'dtes', 'delivery-cancellation.dtes'), 'utf8');
const { stormings: parsed } = await parseStormings([{ path: 'es.dtes', text: SAMPLE }]);
const storming = parsed[0];
const stormingViews = [{ id: storming.id, storming }] as unknown as StormingView[];
const workspace = await loadWorkspace(EXAMPLES);
const model = (await analyze(workspace)).model as DomainModel;
const sources = workspace.map((f) => ({ path: f.path, text: f.text }));

const graph = (id: string, signature = 'sig'): LaidOutGraph => ({ id, signature }) as LaidOutGraph;

describe('ViewLocation', () => {
    test('a .dt view is its view key and layout; the catalog has no canvas', () => {
        expect(viewLocation({ view: { kind: 'structure' }, viewKey: 'structure:detail', graph: graph('structure'), storming: undefined })).toEqual({
            kind: 'dt',
            viewKey: 'structure:detail',
            layoutKey: `structure@${shortHash('sig')}`,
        });
        expect(viewLocation({ view: { kind: 'catalog' }, viewKey: 'catalog:false', graph: null, storming: undefined })).toEqual({
            kind: 'dt',
            viewKey: 'catalog',
            layoutKey: NO_LAYOUT,
        });
    });

    test('a storming view is its storming, level and timeline', () => {
        const at = (level: 'big-picture' | 'design-level', timelineId?: string): ViewLocation =>
            viewLocation({
                view: { kind: 'storming' },
                viewKey: 'x',
                graph: graph(`storming:S:${level}:${timelineId ?? '*'}`),
                storming: { id: 'S', options: { level, ...(timelineId && { timelineId }) } },
            });
        expect(at('design-level', 'Normal')).toEqual({
            kind: 'dtes',
            stormingId: 'S',
            level: 'design-level',
            timelineId: 'Normal',
            layoutKey: `storming:S:design-level:Normal@${shortHash('sig')}`,
        });
        expect(at('big-picture')).toEqual({ kind: 'dtes', stormingId: 'S', level: 'big-picture', layoutKey: `storming:S:big-picture:*@${shortHash('sig')}` });
        expect(sameLocation(at('design-level', 'Normal'), at('design-level', 'Normal'))).toBe(true);
        // another timeline, the integrated canvas, another level: never the same view
        expect(sameLocation(at('design-level', 'Normal'), at('design-level', 'Failure'))).toBe(false);
        expect(sameLocation(at('design-level', 'Normal'), at('design-level'))).toBe(false);
        expect(sameLocation(at('big-picture'), at('design-level'))).toBe(false);
    });

    test('a layout key stays short, whatever the signature, and changes with it', () => {
        const long = 'x|'.repeat(5000);
        expect(layoutKeyOf(graph('structure', long)).length).toBeLessThan(64);
        expect(layoutKeyOf(graph('structure', long))).not.toBe(layoutKeyOf(graph('structure', `${long}y`)));
        expect(layoutKeyOf(graph('g'.repeat(600))).length).toBeLessThan(64);
    });

    test('equal only with the same layout and view key, and never between a .dt and a storming view', () => {
        const dt = (viewKey: string, layoutKey: string): ViewLocation => ({ kind: 'dt', viewKey, layoutKey });
        expect(sameLocation(dt('structure:detail', 'a@1'), dt('structure:detail', 'a@1'))).toBe(true);
        expect(sameLocation(dt('structure:detail', 'a@1'), dt('structure:detail', 'a@2'))).toBe(false);
        expect(sameLocation(dt('structure:detail', 'a@1'), dt('structure:overview', 'a@1'))).toBe(false);
        expect(sameLocation(dt('x', 'a@1'), { kind: 'dtes', stormingId: 'x', level: 'x', layoutKey: 'a@1' })).toBe(false);
        expect(sameLocation(undefined, dt('x', 'a@1'))).toBe(false);
    });
});

describe('targets from the selection', () => {
    const ctx = { model, stormings: stormingViews, sources };
    const aggregate = Object.values(model.elements).find((e) => e.kind === 'aggregate' && e.states?.length && e.commands?.length)!;

    test('a .dt element, state or command by its model ID, with its label and source range', () => {
        const t = targetOfSelection({ ...ctx, selected: aggregate.id })!;
        expect(t.target).toEqual({ kind: 'DtElement', element: aggregate.id });
        expect(t.label).toContain(aggregate.id);
        expect(t.range).toMatchObject({
            path: aggregate.location.file,
            startLine: aggregate.location.line,
            startColumn: 1,
            endLine: aggregate.location.endLine,
        });
        expect(t.range!.endColumn).toBeGreaterThan(0);
        const state = aggregate.states![0];
        expect(targetOfSelection({ ...ctx, selected: state.id })?.target).toEqual({ kind: 'DtElement', element: state.id });
        const command = aggregate.commands![0];
        expect(targetOfSelection({ ...ctx, selected: command.id })?.target).toEqual({ kind: 'DtElement', element: command.id });
    });

    test('nothing for no selection, a file, a context, a storming itself or an unknown element', () => {
        expect(targetOfSelection({ ...ctx, selected: undefined })).toBeUndefined();
        expect(targetOfSelection({ ...ctx, selected: `file:${aggregate.location.file}` })).toBeUndefined();
        expect(targetOfSelection({ ...ctx, selected: model.contexts[0] })).toBeUndefined();
        expect(targetOfSelection({ ...ctx, selected: `es/${storming.id}` })).toBeUndefined();
        expect(targetOfSelection({ ...ctx, selected: `es/${storming.id}/Nope` })).toBeUndefined();
        expect(targetOfSelection({ ...ctx, selected: 'Nope.Nope' })).toBeUndefined();
    });

    test('a storming element by storming and local ID, with its range', () => {
        const t = targetOfSelection({ ...ctx, selected: 'es/DeliveryCancellation/CancelShipment' })!;
        expect(t.target).toEqual({ kind: 'DtesElement', storming: 'DeliveryCancellation', local: 'CancelShipment' });
        expect(t.label).toBe('DeliveryCancellation / 配送キャンセル (CancelShipment)');
        expect(t.range?.path).toBe('es.dtes');
        expect(t.range!.startLine).toBeLessThan(t.range!.endLine);
    });

    test("an occurrence only in a timeline's view: the selected note's occurrence in that timeline", () => {
        const render = projectView(storming, { level: 'design-level', timelineId: 'Normal' });
        const timelineView = { stormingId: storming.id, timelineId: 'Normal', render };
        const nodeOf = (eventId: string): string => render.nodes.find((n) => n.type === 'event' && n.eventId === eventId)!.id;
        const at = (eventId: string) =>
            targetOfSelection({ ...ctx, selected: `es/DeliveryCancellation/${eventId}`, timelineView, selectedNode: nodeOf(eventId) })!;
        expect(at('ShipmentCancelled').target).toEqual({
            kind: 'DtesOccurrence',
            storming: 'DeliveryCancellation',
            timeline: 'Normal',
            eventName: 'ShipmentCancelled',
            occurrence: '0',
        });
        // an event of a group: the step and its index in the group
        expect(at('SlotReleased').target).toMatchObject({ kind: 'DtesOccurrence', timeline: 'Normal', occurrence: '1.1' });
        expect(at('SlotReleased').label).toContain('@ Normal #2.2');
        // the render node drawing it, found again from the target (navigation)
        const occ = at('BikeReleased').target;
        if (occ.kind !== 'DtesOccurrence') throw new Error('not an occurrence');
        expect(occurrenceNode(render, occ)).toBe(nodeOf('BikeReleased'));
        expect(selectionOf(occ)).toBe('es/DeliveryCancellation/BikeReleased');
    });

    test('the integrated canvas, or a selection not drawn as that note, targets the element', () => {
        const integrated = projectView(storming, { level: 'design-level' });
        const note = integrated.nodes.find((n) => n.type === 'event' && n.eventId === 'ShipmentCancelled')!.id;
        // no timeline view: never an occurrence, whatever note is selected
        expect(targetOfSelection({ ...ctx, selected: 'es/DeliveryCancellation/ShipmentCancelled', selectedNode: note })?.target.kind).toBe('DtesElement');
        // a timeline view, but the selection came from elsewhere (the explorer: no note selected)
        const render = projectView(storming, { level: 'design-level', timelineId: 'Normal' });
        const timelineView = { stormingId: storming.id, timelineId: 'Normal', render };
        expect(targetOfSelection({ ...ctx, selected: 'es/DeliveryCancellation/ShipmentCancelled', timelineView })?.target.kind).toBe('DtesElement');
        // another element in a timeline's view is an element
        const element = render.nodes.find((n) => n.type === 'element')!;
        if (element.type !== 'element') throw new Error('not an element node');
        expect(
            targetOfSelection({ ...ctx, selected: `es/DeliveryCancellation/${element.elementId}`, timelineView, selectedNode: element.id })?.target.kind,
        ).toBe('DtesElement');
    });

    test('target keys tell targets apart', () => {
        expect(targetKey(WORKSPACE_TARGET.target)).toBe('workspace:');
        expect(targetKey({ kind: 'DtElement', element: 'A.B' })).not.toBe(targetKey({ kind: 'DtesElement', storming: 'A', local: 'B' }));
        expect(selectionOf(WORKSPACE_TARGET.target)).toBeUndefined();
    });
});

describe('drafts', () => {
    const alice = { session: 's1', participant: 'dev:alice' };
    const bob = { session: 's1', participant: 'dev:bob' };

    test('kept per session and participant, replaced on save, removed by ID', async () => {
        const store = createMemoryDrafts();
        const a = newDraft('a', WORKSPACE_TARGET, 2);
        const b = newDraft('b', WORKSPACE_TARGET, 1);
        await store.save(alice, a);
        await store.save(alice, b);
        await store.save(bob, newDraft('c', WORKSPACE_TARGET, 3));
        expect((await store.load(alice)).map((d) => d.id)).toEqual(['b', 'a']);
        expect((await store.load({ session: 's2', participant: 'dev:alice' })).length).toBe(0);
        await store.save(alice, { ...a, body: 'edited' });
        expect((await store.load(alice)).find((d) => d.id === 'a')?.body).toBe('edited');
        await store.remove(alice, 'a');
        expect((await store.load(alice)).map((d) => d.id)).toEqual(['b']);
        expect((await store.load(bob)).map((d) => d.id)).toEqual(['c']);
    });

    test('editing changes one draft; only selected drafts with a text are sent, each on its own', () => {
        const drafts = sortDrafts([newDraft('x', WORKSPACE_TARGET, 1), newDraft('y', WORKSPACE_TARGET, 1), newDraft('z', WORKSPACE_TARGET, 0)]);
        expect(drafts.map((d) => d.id)).toEqual(['z', 'x', 'y']);
        const edited = editDraft(editDraft(drafts, 'x', { body: 'one' }, 5), 'y', { body: '  ' }, 6);
        expect(edited.find((d) => d.id === 'x')).toMatchObject({ body: 'one', updatedAt: 5, createdAt: 1 });
        expect(edited.find((d) => d.id === 'z')?.updatedAt).toBe(0);
        expect(sendable(edited, new Set(['x', 'y'])).map((d) => d.id)).toEqual(['x']);
        expect(sendable(edited, new Set()).length).toBe(0);
    });
});

describe('the session state from the socket', () => {
    const at = '2026-10-31T10:00:00.000Z';
    const revision = {
        id: 'r1',
        session: 's1',
        origin: { kind: 'SessionStart', session: 's1' },
        contentHash: 'h',
        files: [],
        validation: { dtErrors: 0, dtesErrors: 0, dtesWarnings: 0, linkWarnings: 0, stale: false },
        takenAt: at,
        state: 'Recorded',
    };
    const base = {
        session: {
            id: 's1',
            facilitator: 'local:facilitator',
            participants: [{ id: 'local:facilitator', name: 'Facilitator', role: 'Facilitator', joinedAt: at }],
            startedAt: at,
            state: 'Open',
        },
        requests: [],
        runs: [],
        revisions: [revision],
        seq: 3,
    } as unknown as SessionStateBody;
    const me = { session: 's1', participant: { id: 'dev:a', name: 'A', role: 'participant' } } as unknown as Parameters<typeof adopt>[2];
    const target = { target: { kind: 'Workspace' }, sourceRevision: 'r1' };
    const sent = (seq: number, id: string): EventMessage =>
        ({
            type: 'request.sent',
            seq,
            event: { type: 'RequestSent', requestId: id, session: 's1', author: 'dev:a', target, body: 'b', sentAt: at },
        }) as EventMessage;
    const message = (seq: number, event: object): EventMessage => ({ type: 'x', seq, event }) as unknown as EventMessage;

    test('events before the state wait for it; those it includes are skipped', () => {
        let m = receive(INITIAL_SESSION, sent(2, 'old'));
        m = receive(m, sent(4, 'new'));
        expect(m.state).toBeUndefined();
        m = receive(m, { type: 'session.state', state: base, me: me! });
        expect(m.state!.requests.map((r) => r.id)).toEqual(['new']);
        expect(m.state!.seq).toBe(4);
        expect(m.me).toBe(me);
    });

    test('applying an event twice changes nothing', () => {
        const once = applyEvent(base, sent(4, 'q1')).state;
        expect(applyEvent(once, sent(4, 'q1')).state).toBe(once);
        // the same change again under a later seq (a state fetched while it was on its way) is not doubled
        expect(applyEvent(once, sent(5, 'q1')).state.requests.length).toBe(1);
        const dismissed = applyEvent(once, message(6, { type: 'RequestDismissed', requestId: 'q1', dismissedBy: 'dev:a', dismissedAt: at })).state;
        expect(dismissed.requests[0]).toMatchObject({ state: 'Dismissed', dismissedBy: 'dev:a' });
        expect(
            applyEvent(dismissed, message(7, { type: 'RequestDismissed', requestId: 'q1', dismissedBy: 'dev:b', dismissedAt: at })).state.requests[0],
        ).toMatchObject({
            dismissedBy: 'dev:a',
        });
        const joined = applyEvent(base, message(4, { type: 'ParticipantJoined', sessionId: 's1', participant: 'dev:b', name: 'B', joinedAt: at })).state;
        expect(
            applyEvent(joined, message(5, { type: 'ParticipantJoined', sessionId: 's1', participant: 'dev:b', name: 'B', joinedAt: at })).state.session
                .participants.length,
        ).toBe(2);
    });

    test('runs move through their states; what an event does not carry asks for the state again', () => {
        const queued = applyEvent(
            base,
            message(4, { type: 'RunQueued', runId: 'run1', session: 's1', requests: ['q1'], queuedBy: 'local:facilitator', queuedAt: at }),
        );
        expect(queued.refetch).toBe(true);
        expect(queued.state.runs.length).toBe(0);
        const run = { id: 'run1', session: 's1', input: { requests: [] }, queuedBy: 'local:facilitator', queuedAt: at, state: 'Queued' };
        const held = { ...base, runs: [run] } as unknown as SessionStateBody;
        const started = applyEvent(held, message(4, { type: 'RunStarted', runId: 'run1', baseRevision: 'r1', startedAt: at }));
        expect(started).toMatchObject({ refetch: false, state: { runs: [{ state: 'Running', baseRevision: 'r1' }] } });
        expect(
            applyEvent(started.state, message(5, { type: 'RunCompleted', runId: 'run1', resultRevision: 'r1', changed: false, finishedAt: at })).refetch,
        ).toBe(true);
        const failed = applyEvent(started.state, message(5, { type: 'RunFailed', runId: 'run1', reason: 'AgentError', finishedAt: at }));
        expect(failed).toMatchObject({ refetch: false, state: { runs: [{ state: 'Failed', reason: 'AgentError' }] } });
        const cancelled = applyEvent(started.state, message(5, { type: 'RunCancelled', runId: 'run1', cancelledBy: 'local:facilitator', cancelledAt: at }));
        expect(cancelled.state.runs[0]).toMatchObject({ state: 'Cancelled', baseRevision: 'r1' });
        // a cancel after the run ended changes nothing
        expect(applyEvent(failed.state, message(6, { type: 'RunCancelled', runId: 'run1', cancelledBy: 'x', cancelledAt: at })).state.runs[0].state).toBe(
            'Failed',
        );
    });

    test('a fetched state is taken only when it is not older; after a disconnect events wait for the next state', () => {
        let m = receive(INITIAL_SESSION, { type: 'session.state', state: base, me: me! });
        m = receive(m, sent(5, 'q1'));
        expect(adopt(m, { ...base, seq: 4 }, undefined, false)).toBe(m);
        expect(adopt(m, { ...base, seq: 6 }, undefined, false).state!.seq).toBe(6);
        m = disconnected(m);
        m = receive(m, sent(9, 'q2'));
        expect(m.state!.requests.map((r) => r.id)).toEqual(['q1']);
        m = receive(m, { type: 'session.state', state: { ...base, seq: 8 }, me: me! });
        expect(m.state!.requests.map((r) => r.id)).toEqual(['q2']);
        expect(latestRevision(m.state!)?.id).toBe('r1');
    });
});

describe('presence', () => {
    const where = (timelineId?: string, level = 'design-level'): ViewLocation => ({
        kind: 'dtes',
        stormingId: 'S',
        level,
        ...(timelineId && { timelineId }),
        layoutKey: 'g@1',
    });
    const peer = (connection: string, id: string, location: ViewLocation, cursor = { x: 1, y: 2 }): Presence => ({
        connection,
        participant: { id, name: id.toUpperCase(), role: 'participant' } as Presence['participant'],
        location,
        cursor,
    });

    test('snapshot, update and leave by connection', () => {
        let peers = receivePresence(NO_PEERS, { type: 'presence.snapshot', peers: [peer('c1', 'a', where('T'))] });
        peers = receivePresence(peers, { type: 'presence.update', presence: peer('c2', 'b', where('U')) });
        peers = receivePresence(peers, { type: 'presence.update', presence: peer('c1', 'a', where('U')) });
        expect([...peers.keys()]).toEqual(['c1', 'c2']);
        expect(peers.get('c1')?.location).toEqual(where('U'));
        peers = receivePresence(peers, { type: 'presence.leave', connection: 'c2' });
        expect([...peers.keys()]).toEqual(['c1']);
        expect(receivePresence(peers, { type: 'presence.leave', connection: 'nope' })).toBe(peers);
    });

    test('cursors only on the same view: not across timelines, levels or into the catalog', () => {
        const peers = new Map(
            [peer('c1', 'a', where('T')), peer('c2', 'b', where('U')), peer('c3', 'c', where('T', 'big-picture')), peer('c4', 'd', where())].map((p) => [
                p.connection,
                p,
            ]),
        );
        expect(cursorsOn(peers, where('T')).map((c) => c.name)).toEqual(['A']);
        expect(cursorsOn(peers, where()).map((c) => c.name)).toEqual(['D']);
        expect(cursorsOn(peers, { kind: 'dt', viewKey: 'catalog', layoutKey: NO_LAYOUT })).toEqual([]);
        const seen = whereabouts(peers, where('T'));
        expect(seen.get('a')).toBe('same-view');
        expect(seen.get('b')).toBe('another-view');
    });

    test('the participants once each: the facilitator’s holder is folded into the facilitator, under its name', () => {
        const at = '2026-10-31T00:00:00.000Z';
        const session = {
            facilitator: 'local:facilitator',
            participants: [
                { id: 'local:facilitator', name: 'Facilitator', role: 'Facilitator', joinedAt: at },
                { id: 'dev:ada', name: 'Ada', role: 'Participant', joinedAt: at },
                { id: 'dev:bob', name: 'Bob', role: 'Participant', joinedAt: at },
            ],
        } as unknown as SessionStateBody['session'];
        const rows = (holder?: string) =>
            listedParticipants({ session, ...(holder && { facilitatorHolder: holder }) }).map((p) => `${p.id} ${p.name} ${p.role}`);
        expect(rows()).toEqual(['local:facilitator Facilitator facilitator', 'dev:ada Ada participant', 'dev:bob Bob participant']);
        expect(rows('dev:ada')).toEqual(['local:facilitator Ada facilitator', 'dev:bob Bob participant']);
        // a holder that is not a listed participant changes nothing
        expect(rows('dev:nobody')).toEqual(rows());
        expect(rows('local:facilitator')).toEqual(rows());
    });

    test('initials, and updates throttled to the latest value', () => {
        expect(initials('Ada Lovelace')).toBe('AL');
        expect(initials('山田')).toBe('山田');
        let now = 0;
        const sent: number[] = [];
        const timers: (() => void)[] = [];
        const real = globalThis.setTimeout;
        globalThis.setTimeout = ((f: () => void) => (timers.push(f), 0)) as unknown as typeof setTimeout;
        try {
            const t = throttle<number>(
                50,
                (v) => sent.push(v),
                () => now,
            );
            t.push(1);
            t.push(2);
            t.push(3);
            expect(sent).toEqual([1]);
            now = 50;
            timers.shift()!();
            expect(sent).toEqual([1, 3]);
        } finally {
            globalThis.setTimeout = real;
        }
    });
});

describe('the revision timeline (S7)', () => {
    const v = { dtErrors: 0, dtesErrors: 0, dtesWarnings: 0, linkWarnings: 0, stale: false };
    const rev = (id: string, minute: number, origin: Record<string, string>, hash = id): SessionStateBody['revisions'][number] =>
        ({
            id,
            session: 's',
            origin,
            contentHash: hash,
            files: [],
            validation: v,
            takenAt: `2026-10-31T09:${String(minute).padStart(2, '0')}:00.000Z`,
            state: 'Recorded',
        }) as unknown as SessionStateBody['revisions'][number];
    const runs = [
        { id: 'run-b', queuedAt: '2026-10-31T09:05:00.000Z' },
        { id: 'run-a', queuedAt: '2026-10-31T09:01:00.000Z' },
    ] as unknown as SessionStateBody['runs'];
    const revisions = [
        rev('r1', 0, { kind: 'SessionStart', session: 's' }, 'h1'),
        rev('r2', 2, { kind: 'RunBase', run: 'run-a' }, 'h1'),
        rev('r3', 3, { kind: 'RunResult', run: 'run-a' }, 'h3'),
        rev('r4', 4, { kind: 'Manual', takenBy: 'p' }, 'h4'),
        rev('r5', 6, { kind: 'PreRestore', restoring: 'r1' }, 'h4'),
        rev('r6', 7, { kind: 'Restored', restoredFrom: 'r1', preRestore: 'r5' }, 'h1'),
    ];

    test('newest first, numbered in the order taken, with the runs and revisions an origin refers to', () => {
        const t = timeline({ revisions: [...revisions].reverse(), runs });
        expect(t.map((e) => [e.number, e.origin, e.latest, e.sameAsLatest])).toEqual([
            [6, { kind: 'Restored', from: 1, preRestore: 5 }, true, true],
            [5, { kind: 'PreRestore', restoring: 1 }, false, false],
            [4, { kind: 'Manual', by: 'p' }, false, false],
            [3, { kind: 'RunResult', run: 1 }, false, false],
            [2, { kind: 'RunBase', run: 1 }, false, true],
            [1, { kind: 'SessionStart' }, false, true],
        ]);
    });

    test('two revisions are chosen for a comparison, the earlier taken first; a third replaces the first chosen', () => {
        let chosen = chooseForComparison([], 'r4', true);
        expect(comparisonPair(chosen, revisions)).toBeUndefined();
        chosen = chooseForComparison(chosen, 'r2', true);
        expect(comparisonPair(chosen, revisions)).toEqual(['r2', 'r4']);
        chosen = chooseForComparison(chosen, 'r6', true);
        expect([chosen, comparisonPair(chosen, revisions)]).toEqual([
            ['r2', 'r6'],
            ['r2', 'r6'],
        ]);
        expect(chooseForComparison(chosen, 'r2', false)).toEqual(['r6']);
    });

    test('what a restore that did not go through asks next', () => {
        expect(restoreProblem(new SessionApiError('ExternalChangesSinceSnapshot', 409, undefined, { paths: ['a.dt', 1] }))).toEqual({
            kind: 'external',
            paths: ['a.dt'],
        });
        expect(restoreProblem(new SessionApiError('RunInProgress', 409, undefined, { run: 'run-a' }))).toEqual({ kind: 'run', run: 'run-a' });
        expect(restoreProblem(new SessionApiError('ManualRecoveryNeeded', 500, 'EIO', { preRestore: 'r5', cause: 'WriteFailed' }))).toEqual({
            kind: 'manual',
            preRestore: 'r5',
            cause: 'WriteFailed',
            message: 'EIO',
        });
        expect(restoreProblem(new SessionApiError('FacilitatorOnly', 403, 'Only the facilitator may do this.'))).toEqual({
            kind: 'other',
            message: 'FacilitatorOnly: Only the facilitator may do this.',
        });
    });

    test('the lines of a unified diff by kind', () => {
        expect(diffLines('@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b').map((l) => l.kind)).toEqual(['hunk', 'context', 'remove', 'note', 'add']);
        expect(diffLines('')).toEqual([]);
    });
});

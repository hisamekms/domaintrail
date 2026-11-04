// The guide's marks in the session (guide-marks.ts): read from the marks placed, set and cleared through setMark.
import { describe, expect, test } from 'bun:test';
import { err, ok, type Collaboration } from '../generated/index.js';
import { guideMarkTarget, sessionGuideMarks } from './guide-marks.js';
import type { Actor } from './actor.js';

describe("the session's guide marks", () => {
    const actor = { participant: 'ada', role: 'Facilitator' } as unknown as Actor;

    test('read from the placed marks; set and cleared as done marks; a key of no target refused', async () => {
        const calls: unknown[] = [];
        const store = sessionGuideMarks({
            placed: [{ participant: 'ada', target: { kind: 'GuideStep', journey: 'j', step: 'contexts', context: 'Sales' }, sign: { kind: 'Done' } }],
            actor,
            setMark: async (input) => {
                calls.push([input.target, input.sign, input.placed]);
                return input.target.kind === 'GuideStep' && input.target.step === 'events' ? err({ type: 'MarkTargetNotFound' as const }) : ok({});
            },
        });
        expect(store.read()).toEqual([{ journey: 'j', step: 'contexts', context: 'Sales' }]);
        expect(await store.set({ journey: 'j', step: 'bcSplit' })).toEqual(ok(undefined));
        expect(await store.clear({ journey: 'j', step: 'contexts', context: 'Sales' })).toEqual(ok(undefined));
        expect(await store.set({ journey: 'j', step: 'events' })).toEqual(err({ type: 'MarkTargetNotFound' }));
        expect(await store.set({ journey: '', step: 'bcSplit' })).toEqual(err({ type: 'NotAGuideMark' }));
        expect(calls).toEqual([
            [{ kind: 'GuideStep', journey: 'j', step: 'bcSplit' }, { kind: 'Done' }, true],
            [{ kind: 'GuideStep', journey: 'j', step: 'contexts', context: 'Sales' }, { kind: 'Done' }, false],
            [{ kind: 'GuideStep', journey: 'j', step: 'events' }, { kind: 'Done' }, true],
        ]);
        expect(guideMarkTarget({ journey: 'j', step: 'not a key' })).toBeUndefined();
        expect(guideMarkTarget({ journey: 'j', step: 'bcSplit' }) as Collaboration.MarkTarget).toEqual({
            kind: 'GuideStep',
            journey: 'j',
            step: 'bcSplit',
        } as never);
    });
});

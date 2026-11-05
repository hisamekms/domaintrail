// The stages before the extractor (ADR 0031, section 3): the mechanical one goes on for a person's message that is not
// surely nothing or for the AI's; the light model's reply read without trusting it, anything but a sure no going on.
import { describe, expect, test } from 'bun:test';
import type { TalkMessage } from './extractor.js';
import { gateGoesOn, gateJsonSchema, type GateInput, mechanicalStage, readGateReply } from './stages.js';

const talk = (key: string, isNew: boolean): TalkMessage => ({
    key,
    id: `r-${key}`,
    at: '2026-11-05T09:00:00.000Z',
    from: 'person',
    author: 'P1',
    text: key,
    stickies: [],
    isNew,
});
const input: GateInput = { session: 's', number: 1, messages: [talk('m1', false), talk('m2', true), talk('m3', true)], stickies: [] };

describe('the mechanical stage', () => {
    test('surely-nothing messages alone stop; another message of a person, or of the AI, goes on', () => {
        expect(mechanicalStage([{ from: 'person', nothing: true }])).toEqual({ go: false, people: 0, nothing: 1, ai: 0 });
        expect(mechanicalStage([{ from: 'person', nothing: true }, { from: 'person' }])).toEqual({ go: true, people: 1, nothing: 1, ai: 0 });
        expect(mechanicalStage([{ from: 'ai' }])).toEqual({ go: true, people: 0, nothing: 0, ai: 1 });
        expect(mechanicalStage([]).go).toBe(false);
    });
});

describe("the light model's reply", () => {
    test('its verdict and the new messages it named, in the order of the talk; other keys left out', () => {
        expect(readGateReply({ verdict: 'yes', messages: ['m3', 'm1', 'm7', 5] }, input)).toEqual({ verdict: 'yes', named: ['r-m3'], malformed: false });
        expect(readGateReply({ verdict: 'no' }, input)).toEqual({ verdict: 'no', named: [], malformed: false });
    });

    test('a reply that is not one is unsure, and goes on; only a sure no stops', () => {
        for (const raw of [undefined, 'no', { verdict: 'nope' }, ['no']])
            expect(readGateReply(raw, input)).toEqual({ verdict: 'unsure', named: [], malformed: true });
        expect(gateGoesOn({ verdict: 'unsure', named: [], malformed: true })).toBe(true);
        expect(gateGoesOn({ verdict: 'no', named: [], malformed: false })).toBe(false);
        expect(gateJsonSchema()).toMatchObject({ required: ['verdict', 'messages'], additionalProperties: false });
    });
});

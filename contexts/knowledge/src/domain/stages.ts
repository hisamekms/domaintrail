// The first two stages of an extraction (ADR 0031, section 3), so that the extractor — the stronger model — runs only
// when there is something to extract, like the triage of ADR 0030:
//
// 1. **Mechanical**, pure (`mechanicalStage`): go on only if, among the messages since the last extraction, there is a
//    person's message that is not surely nothing, or the AI finished work (an answer). "Surely nothing" is the
//    triage's stage 1 (empty, emoji only, a fixed acknowledgement), judged where the message's body is read (the
//    session's talk port) and handed here as `nothing`: the list is the triage's, not copied.
// 2. **The light model** (Haiku by default, through Claude Code with no tools), given the new messages, the talk just
//    before them (shorter than the extractor's) and the names of the stickies they point at (not the items): whether
//    there is a finding (`yes`, `no` or `unsure`) and in which of the new messages. Only a sure `no` stops; `unsure` and
//    a reply that is not one (`readGateReply`) go on to the extractor, which reads the messages it named first.
//
// The reply is AI output: read without trusting it, a key that is not one of the new messages left out.
import type { TalkMessage } from './extractor.js';

// ---- stage 1: mechanical --------------------------------------------------------------------------------------------

/** What stage 1 reads of a new message: who wrote it, and whether it is surely nothing (the triage's stage 1). */
export interface StageMessage {
    readonly from: 'person' | 'ai';
    readonly nothing?: boolean;
}

/** Stage 1's outcome: whether to go on, with the counts it decided on (recorded with the extraction). */
export interface MechanicalOutcome {
    readonly go: boolean;
    /** People's messages that are not surely nothing. */
    readonly people: number;
    /** People's messages that are surely nothing. */
    readonly nothing: number;
    /** The AI's messages (its answers: work finished). */
    readonly ai: number;
}

/** Stage 1 over the messages since the last extraction (see the head of this file). */
export function mechanicalStage(fresh: readonly StageMessage[]): MechanicalOutcome {
    const ai = fresh.filter((m) => m.from === 'ai').length;
    const nothing = fresh.filter((m) => m.from === 'person' && m.nothing === true).length;
    const people = fresh.length - ai - nothing;
    return { go: people > 0 || ai > 0, people, nothing, ai };
}

// ---- stage 2: the light model ---------------------------------------------------------------------------------------

/** What the light model answers: whether the new messages hold a finding. */
export const GATE_VERDICTS = ['yes', 'no', 'unsure'] as const;
export type GateVerdict = (typeof GATE_VERDICTS)[number];

/** What the light model is given: the talk keyed `m1…` (`isNew` for the messages since the last extraction), and the stickies' names. */
export interface GateInput {
    readonly session: string;
    readonly number: number;
    readonly messages: readonly TalkMessage[];
    /** The names of the stickies the messages point at (their labels, else their refs). */
    readonly stickies: readonly string[];
}

/** The most messages the light model may name. */
export const GATE_MAX_NAMED = 150;

/** The JSON schema of the light model's reply (`--json-schema`): `{ verdict, messages }`. */
export function gateJsonSchema(): Record<string, unknown> {
    return {
        type: 'object',
        properties: {
            verdict: { type: 'string', enum: [...GATE_VERDICTS] },
            messages: { type: 'array', maxItems: GATE_MAX_NAMED, items: { type: 'string', pattern: '^m[0-9]+$' } },
        },
        required: ['verdict', 'messages'],
        additionalProperties: false,
    };
}

/** The light model's reply, read: its verdict, the IDs of the new messages it named, and whether the reply was not one. */
export interface GateReading {
    readonly verdict: GateVerdict;
    /** The session's IDs of the new messages named, in the talk's order. */
    readonly named: readonly string[];
    /** The reply was not `{ verdict, messages }`: read as `unsure`, nothing named. */
    readonly malformed: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The light model's reply read against what it was given: a reply that is not an object with a verdict is `unsure`
 * (malformed: the extractor runs); the named keys that are not new messages are left out.
 */
export function readGateReply(raw: unknown, input: GateInput): GateReading {
    const verdict = isObject(raw) ? GATE_VERDICTS.find((v) => v === raw.verdict) : undefined;
    if (!isObject(raw) || verdict === undefined) return { verdict: 'unsure', named: [], malformed: true };
    const keys = new Set(Array.isArray(raw.messages) ? raw.messages.filter((k): k is string => typeof k === 'string') : []);
    const named = input.messages.filter((m) => m.isNew && keys.has(m.key)).map((m) => m.id);
    return { verdict, named, malformed: false };
}

/** Whether the cascade goes on to the extractor after the light model: unless it is sure there is nothing. */
export const gateGoesOn = (reading: GateReading): boolean => reading.verdict !== 'no';

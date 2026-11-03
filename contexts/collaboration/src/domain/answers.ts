// What the answerer role returns (ADR 0030, decision 6; the plan's "Stage 3" and "Stage 4"): stage 3's verdict (a light
// model, no tools) and the read-only answerer's reply to an answer job (an answer, or "this is a request" with a
// proposal, or "neither"). Like the run's reply (`reply.ts`): AI output, untrusted, validated against its shape and the
// limits before anything is kept; the JSON schemas the agent is given come from the same limits.
import { err, ok, type Result } from '../generated/index.js';
import type { Collaboration } from '../generated/index.js';
import { proposalJsonSchema, readProposal, type ProposalProblem } from './proposals.js';
import { REPLY_LIMITS } from './reply.js';

/** Stage 3's kinds on the wire (the model's JSON), and the verdicts they are. */
export const TRIAGE_KINDS = {
    consultation: 'Consultation',
    change_request: 'ChangeRequest',
    neither: 'NotForAi',
    unknown: 'Unknown',
} as const satisfies Record<string, Collaboration.TriageVerdict>;

export type TriageKindData = keyof typeof TRIAGE_KINDS;

/** The most characters of the model's reason. */
export const TRIAGE_REASON_LIMIT = 300;

/** Stage 3's answer as validated: the verdict, how sure (0–1), and why. */
export interface TriageAnswer {
    readonly verdict: Collaboration.TriageVerdict;
    readonly confidence: number;
    readonly reason: string;
}

/** What went wrong reading an answerer's output: where in it, and what. */
export type AnswerProblem = ProposalProblem;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Only `keys`: the schema's `additionalProperties: false`. */
function extra(v: Record<string, unknown>, keys: readonly string[], path: string): AnswerProblem | undefined {
    const k = Object.keys(v).find((x) => !keys.includes(x));
    return k === undefined ? undefined : { path: `${path}.${k}`, message: 'Unknown field.' };
}

/** A non-blank string within `max` characters, trimmed. */
function text(v: unknown, path: string, max: number): Result<string, AnswerProblem> {
    if (typeof v !== 'string' || !v.trim()) return err({ path, message: 'Expected a non-empty string.' });
    const t = v.trim();
    return t.length > max ? err({ path, message: `At most ${max} characters.` }) : ok(t);
}

/** Stage 3's JSON (`{ kind, confidence, reason }`), validated. */
export function readTriageAnswer(raw: unknown): Result<TriageAnswer, AnswerProblem> {
    if (!isObject(raw)) return err({ path: 'triage', message: 'Expected an object.' });
    const unknown = extra(raw, ['kind', 'confidence', 'reason'], 'triage');
    if (unknown) return err(unknown);
    const kind = Object.keys(TRIAGE_KINDS).find((k): k is TriageKindData => k === raw.kind);
    if (!kind) return err({ path: 'triage.kind', message: `Expected one of ${Object.keys(TRIAGE_KINDS).join(', ')}.` });
    const c = raw.confidence;
    if (typeof c !== 'number' || !(c >= 0 && c <= 1)) return err({ path: 'triage.confidence', message: 'Expected a number from 0 to 1.' });
    const reason = text(raw.reason, 'triage.reason', TRIAGE_REASON_LIMIT);
    if (!reason.ok) return reason;
    return ok({ verdict: TRIAGE_KINDS[kind], confidence: c, reason: reason.value });
}

/** The JSON schema of stage 3's answer. */
export function triageJsonSchema(): Record<string, unknown> {
    return {
        type: 'object',
        properties: {
            kind: { type: 'string', enum: Object.keys(TRIAGE_KINDS) },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string', minLength: 1, maxLength: TRIAGE_REASON_LIMIT },
        },
        required: ['kind', 'confidence', 'reason'],
        additionalProperties: false,
    };
}

/** The read-only answerer's reply to an answer job. */
export type AnswererReply =
    | { readonly kind: 'answer'; readonly answer: string }
    | { readonly kind: 'proposal'; readonly proposal: Collaboration.ProposalContent; readonly reason?: string }
    | { readonly kind: 'neither'; readonly reason?: string };

/** The answerer's JSON (`{ kind: 'answer', answer }`, `{ kind: 'proposal', proposal, reason? }`, `{ kind: 'neither', reason? }`), validated. */
export function readAnswererReply(raw: unknown): Result<AnswererReply, AnswerProblem> {
    if (!isObject(raw)) return err({ path: 'reply', message: 'Expected an object.' });
    const reasonOf = (): Result<string | undefined, AnswerProblem> =>
        raw.reason === undefined ? ok(undefined) : text(raw.reason, 'reply.reason', TRIAGE_REASON_LIMIT);
    switch (raw.kind) {
        case 'answer': {
            const unknown = extra(raw, ['kind', 'answer'], 'reply');
            if (unknown) return err(unknown);
            const answer = text(raw.answer, 'reply.answer', REPLY_LIMITS.answer);
            return answer.ok ? ok({ kind: 'answer', answer: answer.value }) : answer;
        }
        case 'proposal': {
            const unknown = extra(raw, ['kind', 'proposal', 'reason'], 'reply');
            if (unknown) return err(unknown);
            const proposal = readProposal(raw.proposal, 'reply.proposal');
            if (!proposal.ok) return proposal;
            const reason = reasonOf();
            if (!reason.ok) return reason;
            return ok({ kind: 'proposal', proposal: proposal.value, ...(reason.value !== undefined && { reason: reason.value }) });
        }
        case 'neither': {
            const unknown = extra(raw, ['kind', 'reason'], 'reply');
            if (unknown) return err(unknown);
            const reason = reasonOf();
            if (!reason.ok) return reason;
            return ok({ kind: 'neither', ...(reason.value !== undefined && { reason: reason.value }) });
        }
        default:
            return err({ path: 'reply.kind', message: 'Expected answer, proposal or neither.' });
    }
}

/** The JSON schema of the answerer's reply to an answer job (one object with a `kind` and its fields). */
export function answererJsonSchema(): Record<string, unknown> {
    const reason = { type: 'string', minLength: 1, maxLength: TRIAGE_REASON_LIMIT };
    return {
        type: 'object',
        properties: {
            kind: { type: 'string', enum: ['answer', 'proposal', 'neither'] },
            answer: { type: 'string', minLength: 1, maxLength: REPLY_LIMITS.answer },
            proposal: proposalJsonSchema(),
            reason,
        },
        required: ['kind'],
        additionalProperties: false,
    };
}

/** The JSON schema of a propose job's reply (`{ proposal }`). */
export function proposeJsonSchema(): Record<string, unknown> {
    return { type: 'object', properties: { proposal: proposalJsonSchema() }, required: ['proposal'], additionalProperties: false };
}

/** A propose job's reply (`{ proposal }`), validated. */
export function readProposeReply(raw: unknown): Result<Collaboration.ProposalContent, AnswerProblem> {
    if (!isObject(raw)) return err({ path: 'reply', message: 'Expected an object.' });
    const unknown = extra(raw, ['proposal'], 'reply');
    if (unknown) return err(unknown);
    return readProposal(raw.proposal, 'reply.proposal');
}

// The review's way in to propose retiring items (ADR 0031, section 12): a review of the AI's work reads the knowledge
// as reference (the store's lists, which leave the retired items out), and when an item disagrees with what the run
// found — a decision, a sticky's change, a message —, it proposes to retire it. People decide in the list of 廃止の候補.
//
// The review's model replies with JSON; `readRetirementCandidates` reads it without trusting it (each proposal on its
// own, a malformed one dropped with why), names the review as the proposer, and `proposeRetirements` hands each to the
// store (`KnowledgeStore.propose`), which decides it as it decides the extractor's (`admitProposal`): a candidate on an
// AS-IS item whose evidence is only the TO-BE, the same as one dismissed, or a moot one is refused, never an error.
import { Knowledge, type Result } from '../generated/index.js';
import type { ProposalRejection, RetirementCandidate } from '../domain/retirement.js';
import { evidence as evidenceOf, itemId, WireError, type Decoder } from '../protocol.js';
import type { KnowledgeStore } from './ports.js';

/** A proposal of the review's reply that is not one: where, and what is wrong. */
export interface CandidateProblem {
    readonly path: string;
    readonly message: string;
}

const RETIREMENT_REASONS: readonly Knowledge.RetirementReason[] = ['replaced', 'obsolete', 'wrong'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A value read with a decoder of the wire, or the problem. */
function read<T>(d: Decoder<T>, v: unknown, at: string): Result<T, CandidateProblem> {
    try {
        return { ok: true, value: d(v, at) };
    } catch (e) {
        if (e instanceof WireError) return { ok: false, error: { path: at, message: e.message } };
        throw e;
    }
}

/**
 * The candidates of a review's reply, `[{ item, action, reason?, replacedBy?, explanation, evidence: [...] }]` (the
 * evidence as `Knowledge.Evidence`: `{ kind: 'Decision', item }`, `{ kind: 'StickyChange', sticky, change }`,
 * `{ kind: 'Said', session, message, quote }`), each proposed by `review`. A malformed one is left out with why.
 */
export function readRetirementCandidates(
    raw: unknown,
    review: Knowledge.ReviewRef,
): { readonly candidates: readonly RetirementCandidate[]; readonly rejected: readonly CandidateProblem[] } {
    const candidates: RetirementCandidate[] = [];
    const rejected: CandidateProblem[] = [];
    if (!Array.isArray(raw)) return { candidates, rejected: [{ path: 'proposals', message: 'Expected a list of proposals.' }] };
    for (const [i, p] of raw.entries()) {
        const at = `proposals[${i}]`;
        if (!isObject(p)) {
            rejected.push({ path: at, message: 'Expected an object.' });
            continue;
        }
        const item = read(itemId, p.item, `${at}.item`);
        if (!item.ok) {
            rejected.push(item.error);
            continue;
        }
        const action = p.action === 'retire' || p.action === 'unretire' ? p.action : undefined;
        const reason = RETIREMENT_REASONS.find((r) => r === p.reason);
        const replacedBy = p.replacedBy === undefined ? undefined : read(itemId, p.replacedBy, `${at}.replacedBy`);
        const said = typeof p.explanation === 'string' ? Knowledge.makeReason(p.explanation.trim().slice(0, 2000)) : undefined;
        const explanation = said?.ok ? said.value : undefined;
        const evidence = Array.isArray(p.evidence) ? p.evidence.map((e, j) => read(evidenceOf, e, `${at}.evidence[${j}]`)) : [];
        const [first, ...rest] = evidence.flatMap((e) => (e.ok ? [e.value] : []));
        const problem =
            action === undefined
                ? 'Expected the action retire or unretire.'
                : action === 'retire' && reason === undefined
                  ? 'Expected the reason replaced, obsolete or wrong.'
                  : replacedBy && !replacedBy.ok
                    ? replacedBy.error.message
                    : explanation === undefined
                      ? 'Expected an explanation.'
                      : first === undefined
                        ? 'Expected evidence: a decision, a sticky changed, or a message.'
                        : undefined;
        for (const e of evidence) if (!e.ok) rejected.push(e.error);
        if (problem !== undefined || action === undefined || explanation === undefined || first === undefined) {
            rejected.push({ path: at, message: problem ?? 'Not a proposal.' });
            continue;
        }
        candidates.push({
            item: item.value,
            action,
            ...(action === 'retire' && reason && { reason }),
            ...(replacedBy?.ok && { replacedBy: replacedBy.value }),
            explanation,
            evidence: [first, ...rest],
            proposedBy: { kind: 'Review', review },
        });
    }
    return { candidates, rejected };
}

/** A candidate and what the store answered: the proposal (new, or the one made before), or why it was not taken. */
export interface ProposalOutcome {
    readonly candidate: RetirementCandidate;
    readonly result: Result<Knowledge.RetirementProposal, ProposalRejection>;
}

/** Proposes each candidate to the store, in order; a refusal is an outcome, a store that fails rejects. */
export async function proposeRetirements(
    store: KnowledgeStore,
    project: Knowledge.ProjectName,
    candidates: readonly RetirementCandidate[],
): Promise<readonly ProposalOutcome[]> {
    const outcomes: ProposalOutcome[] = [];
    for (const candidate of candidates) outcomes.push({ candidate, result: await store.propose(project, candidate) });
    return outcomes;
}

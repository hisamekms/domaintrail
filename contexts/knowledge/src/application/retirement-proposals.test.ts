// The review's way in: its reply read without trusting it, each candidate proposed by the review, decided by the store.
import { describe, expect, test } from 'bun:test';
import { Knowledge } from '../generated/index.js';
import { proposeRetirements, readRetirementCandidates } from './retirement-proposals.js';
import { liveItem, memoryStore } from '../test-helpers.js';
import { admitProposal } from '../domain/retirement.js';

const review = 'review-7' as Knowledge.ReviewRef;
const project = 'shop' as Knowledge.ProjectName;

describe("the review's proposals", () => {
    test('read on their own: a malformed one is left out with why; the review is the proposer', () => {
        const { candidates, rejected } = readRetirementCandidates(
            [
                {
                    item: 'kn_00000001',
                    action: 'retire',
                    reason: 'replaced',
                    replacedBy: 'kn_00000002',
                    explanation: '新しい決定に置き換わった',
                    evidence: [
                        { kind: 'Decision', item: 'kn_00000009' },
                        { kind: 'StickyChange', sticky: 'Ordering.Accept', change: '消した' },
                        { kind: 'Nope' },
                    ],
                },
                { item: 'kn_00000001', action: 'retire', explanation: 'x', evidence: [{ kind: 'Decision', item: 'kn_00000009' }] },
                { item: 'kn_00000001', action: 'unretire', explanation: 'x', evidence: [] },
                'nope',
            ],
            review,
        );
        expect<unknown>(candidates).toEqual([
            {
                item: 'kn_00000001',
                action: 'retire',
                reason: 'replaced',
                replacedBy: 'kn_00000002',
                explanation: '新しい決定に置き換わった',
                evidence: [
                    { kind: 'Decision', item: 'kn_00000009' },
                    { kind: 'StickyChange', sticky: 'Ordering.Accept', change: '消した' },
                ],
                proposedBy: { kind: 'Review', review },
            },
        ]);
        expect(rejected.map((r) => r.path)).toEqual(['proposals[0].evidence[2]', 'proposals[1]', 'proposals[2]', 'proposals[3]']);
        expect(readRetirementCandidates({}, review).rejected).toHaveLength(1);
    });

    test('each proposed to the store, a refusal an outcome', async () => {
        const store = memoryStore([liveItem('kn_00000001')]);
        const proposals: Knowledge.RetirementProposal[] = [];
        const proposing = {
            ...store,
            propose: async (_p: Knowledge.ProjectName, c: Parameters<typeof admitProposal>[0]) => {
                const r = admitProposal(c, { lookup: (id) => store.items.get(id), proposals }, new Date());
                if (r.ok) proposals.push(r.value.proposal);
                return r.ok ? { ok: true as const, value: r.value.proposal } : r;
            },
        };
        const { candidates } = readRetirementCandidates(
            [
                {
                    item: 'kn_00000001',
                    action: 'retire',
                    reason: 'obsolete',
                    explanation: 'もうしていない',
                    evidence: [{ kind: 'StickyChange', sticky: 'A.B', change: 'x' }],
                },
                {
                    item: 'kn_00000009',
                    action: 'retire',
                    reason: 'obsolete',
                    explanation: 'x',
                    evidence: [{ kind: 'StickyChange', sticky: 'A.B', change: 'x' }],
                },
            ],
            review,
        );
        const outcomes = await proposeRetirements(proposing, project, candidates);
        // the test item is AS-IS: a sticky's change alone does not retire it
        expect(outcomes.map((o) => (o.result.ok ? 'proposed' : o.result.error))).toEqual([
            { type: 'Knowledge.ProposalRefused', reason: 'asIsAgainstStickies' },
            { type: 'Knowledge.ProposalRefused', reason: 'itemUnavailable' },
        ]);
    });
});

// Runs the contract tests generated from the knowledge model (contexts/knowledge/src/generated/tests) against the
// hand-written commands of contexts/knowledge/src/domain, registered with bun:test like Collaboration's. The examples
// reach the outcomes the random inputs rarely meet: an operation on the version the extraction saw, an update in place
// and as a new version, a conflict linked to an item with a source.
import { Knowledge as K } from './generated/index.js';
import { Knowledge as Contract, register } from './generated/tests/index.js';
import { knowledgeItemCommands } from './domain/items.js';
import { retirementProposalCommands } from './domain/retirement.js';
import { at, content, extraction, itemId, liveItem, reason, sessionRef, source, userName, version } from './test-helpers.js';

const by = extraction('s1', 2);
const ofThisSession = liveItem('kn_00000001', { createdIn: 's1' });
const ofEarlier = liveItem('kn_00000002', { createdIn: 's0' });
const deleted: K.DeletedKnowledgeItem = { ...ofThisSession, state: 'Deleted', deletedBy: userName('a@example.com'), deletedAt: at };
const retired: K.LiveKnowledgeItem = { ...ofEarlier, retirement: { reason: 'obsolete', by: userName('a@example.com'), at } };
const known = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error('invalid test value');
    return r.value;
};
const proposalId = known(K.makeRetirementProposalId('rp_00000001'));
const said: K.Evidence = { kind: 'Said', session: sessionRef('s1'), message: known(K.makeMessageRef('m4')), quote: known(K.makeQuote('もうやらない')) };
const open: K.OpenRetirementProposal = {
    state: 'Open',
    id: proposalId,
    item: ofEarlier.id,
    action: 'retire',
    reason: 'obsolete',
    explanation: reason('no longer done'),
    evidence: [said],
    proposedBy: { kind: 'Extraction', extraction: by },
    proposedAt: at,
};

register(
    Contract.contract(
        {
            make: {
                KnowledgeItemId: K.makeKnowledgeItemId,
                ImageId: K.makeImageId,
                ProjectName: K.makeProjectName,
                ItemText: K.makeItemText,
                Quote: K.makeQuote,
                Perspective: K.makePerspective,
                Reason: K.makeReason,
                StickyRef: K.makeStickyRef,
                SessionRef: K.makeSessionRef,
                MessageRef: K.makeMessageRef,
                UserName: K.makeUserName,
                ItemVersion: K.makeItemVersion,
                ExtractionNumber: K.makeExtractionNumber,
                RetirementProposalId: K.makeRetirementProposalId,
                ReviewRef: K.makeReviewRef,
                EvidenceNote: K.makeEvidenceNote,
            },
            KnowledgeItem: knowledgeItemCommands,
            RetirementProposal: retirementProposalCommands,
        },
        {
            examples: {
                KnowledgeItem: {
                    states: { Live: [ofThisSession, ofEarlier, retired], Deleted: [deleted] },
                    commands: {
                        add: [[{ id: itemId('kn_00000003'), content: content('new'), sources: [source('s1', 'm3')], by, reason: reason('said once'), at }]],
                        addConflicting: [[{ id: itemId('kn_00000003'), content: content('new'), sources: [source('s1', 'm3')], other: ofEarlier.id, by, at }]],
                        addSource: [
                            [ofThisSession, { source: source('s1', 'm9'), agreed: true, base: version(1), by, at }],
                            [ofEarlier, { source: source('s1', 'm9'), agreed: false, base: version(1), by, at }],
                        ],
                        update: [
                            [ofThisSession, { revised: content('more precise'), newSources: [source('s1', 'm8')], base: version(1), by, at }],
                            [
                                ofEarlier,
                                { revised: content('more precise'), newSources: [source('s1', 'm8')], base: version(1), by, reason: reason('the numbers'), at },
                            ],
                        ],
                        linkConflict: [[ofEarlier, { other: itemId('kn_00000003'), base: version(1), by, at }]],
                        correct: [[ofThisSession, { corrected: content('as it is'), by: userName('a@example.com'), at }]],
                        delete: [[ofThisSession, { by: userName('a@example.com'), at }]],
                        restore: [[deleted, { by: userName('a@example.com'), at }]],
                        retire: [
                            [ofThisSession, { reason: 'replaced', replacedBy: ofEarlier.id, by: userName('a@example.com'), at }],
                            [ofEarlier, { by: userName('a@example.com'), at }],
                        ],
                        unretire: [[retired, { proposal: proposalId, by: userName('a@example.com'), at }]],
                    },
                },
                RetirementProposal: {
                    states: { Open: [open] },
                    commands: {
                        propose: [
                            [
                                {
                                    id: proposalId,
                                    item: ofEarlier.id,
                                    action: 'retire',
                                    reason: 'obsolete',
                                    explanation: reason('no longer done'),
                                    evidence: [said],
                                    proposedBy: { kind: 'Extraction', extraction: by },
                                    proposedAt: at,
                                },
                            ],
                        ],
                        approve: [[open, { by: userName('a@example.com'), at }]],
                        dismiss: [[open, { by: userName('a@example.com'), at }]],
                    },
                },
            },
        },
    ),
);

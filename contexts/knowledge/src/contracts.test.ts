// Runs the contract tests generated from the knowledge model (contexts/knowledge/src/generated/tests) against the
// hand-written commands of contexts/knowledge/src/domain, registered with bun:test like Collaboration's. The examples
// reach the outcomes the random inputs rarely meet: an operation on the version the extraction saw, an update in place
// and as a new version, a conflict linked to an item with a source.
import { Knowledge as K } from './generated/index.js';
import { Knowledge as Contract, register } from './generated/tests/index.js';
import { knowledgeItemCommands } from './domain/items.js';
import { at, content, extraction, itemId, liveItem, reason, source, userName, version } from './test-helpers.js';

const by = extraction('s1', 2);
const ofThisSession = liveItem('kn_00000001', { createdIn: 's1' });
const ofEarlier = liveItem('kn_00000002', { createdIn: 's0' });
const deleted: K.DeletedKnowledgeItem = { ...ofThisSession, state: 'Deleted', deletedBy: userName('a@example.com'), deletedAt: at };

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
            },
            KnowledgeItem: knowledgeItemCommands,
        },
        {
            examples: {
                KnowledgeItem: {
                    states: { Live: [ofThisSession, ofEarlier], Deleted: [deleted] },
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
                    },
                },
            },
        },
    ),
);

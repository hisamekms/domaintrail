// The knowledge side of the review at a run's end (ADR 0034, ./knowledge-review.ts): the items the agent is given
// (decisions and rules first, never AS-IS, newest first, bounded, cut), and the links moved to a renamed sticky, on a
// real `files` store.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createFilesKnowledgeStore, Knowledge } from '@domaintrail/knowledge';
import { proposeReviewRetirements, RELINKED_BY, relinkRenamed, REVIEW_KNOWLEDGE_TEXT, reviewKnowledgeOf } from './knowledge-review';

const known = <T>(made: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!made.ok) throw new Error(`invalid test value: ${JSON.stringify(made.error)}`);
    return made.value;
};

/** A live item of `kind` and `when`, made at minute `minute`, about `about`. */
const item = (
    id: string,
    kind: Knowledge.KnowledgeKind,
    when: Knowledge.When,
    minute: number,
    text = `${kind} ${when}`,
    about = ['Returns.Deadline'],
): Knowledge.LiveKnowledgeItem => ({
    state: 'Live',
    id: known(Knowledge.makeKnowledgeItemId(id)),
    content: {
        title: known(Knowledge.makeItemTitle(`${kind} ${minute}`)),
        text: known(Knowledge.makeItemText(text)),
        labels: { when, kind, origin: 'said' },
        about: about.map((a) => known(Knowledge.makeStickyRef(a))),
    },
    sources: [],
    version: known(Knowledge.makeItemVersion(1)),
    conflictsWith: [],
    createdAt: new Date(Date.UTC(2026, 10, 7, 9, minute)),
    updatedAt: new Date(Date.UTC(2026, 10, 7, 9, minute)),
});

describe('the items a review gives the agent', () => {
    test('decisions, then rules, then the rest, each newest first; never AS-IS', () => {
        const given = reviewKnowledgeOf([
            item('kn_00000001', 'pain', 'to_be', 5),
            item('kn_00000002', 'rule', 'none', 1),
            item('kn_00000003', 'decision', 'to_be', 2),
            item('kn_00000004', 'decision', 'as_is', 9),
            item('kn_00000005', 'rule', 'to_be', 3),
            item('kn_00000006', 'decision', 'none', 4),
        ]);
        expect(given.map((g) => g.id)).toEqual(['kn_00000006', 'kn_00000003', 'kn_00000005', 'kn_00000002', 'kn_00000001']);
        expect(given[0]).toEqual({
            id: 'kn_00000006',
            title: 'decision 4',
            text: 'decision none',
            kind: 'decision',
            when: 'none',
            about: ['Returns.Deadline'],
            createdAt: '2026-11-07T09:04:00.000Z',
        });
    });

    test('bounded, the long text cut', () => {
        const many = Array.from({ length: 20 }, (_, i) => item(`kn_000001${String(i).padStart(2, '0')}`, 'rule', 'to_be', i, 'あ'.repeat(1000)));
        const given = reviewKnowledgeOf(many, 3);
        expect(given).toHaveLength(3);
        expect(given[0].text).toHaveLength(REVIEW_KNOWLEDGE_TEXT + 1);
        expect(given[0].text.endsWith('…')).toBe(true);
        expect(reviewKnowledgeOf([])).toEqual([]);
    });
});

describe('the links of a renamed sticky', () => {
    const dirs: string[] = [];
    afterAll(async () => {
        for (const d of dirs) await rm(d, { recursive: true, force: true });
    });

    test('moved to its new name, by dt, as a new version; the other stickies and the text stay', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'dt-relink-'));
        dirs.push(root);
        const project = known(Knowledge.makeProjectName('shop'));
        const store = createFilesKnowledgeStore({ dir: path.join(root, 'knowledge'), project, stateDir: path.join(root, 'state') });
        const session = known(Knowledge.makeSessionRef('s1'));
        await store.applyExtraction(project, {
            by: { session, number: known(Knowledge.makeExtractionNumber(1)) },
            operations: [
                {
                    kind: 'Add',
                    id: known(Knowledge.makeKnowledgeItemId('kn_00000001')),
                    content: item('kn_00000001', 'decision', 'to_be', 0, '返品は30日まで', ['Returns.ReturnRequested', 'Returns.Deadline']).content,
                    sources: [{ session, message: known(Knowledge.makeMessageRef('m1')), at: new Date(), quote: known(Knowledge.makeQuote('30日')) }],
                },
            ],
        });
        const log: string[] = [];
        const relinked = await relinkRenamed(store, project, [{ storming: 'Returns', from: 'ReturnRequested', to: 'ReturnAsked' }], (l) => log.push(l));
        expect(relinked).toBe(1);
        const got = await store.get(project, known(Knowledge.makeKnowledgeItemId('kn_00000001')));
        expect<unknown>(got?.item.content.about).toEqual(['Returns.ReturnAsked', 'Returns.Deadline']);
        expect<unknown>(got?.item.content.text).toBe('返品は30日まで');
        expect<unknown>(got?.item.version).toBe(2);
        const audit = await store.audit(project, {});
        expect(JSON.stringify(audit.items[0])).toContain(RELINKED_BY);
        // nothing about the old name: nothing to do
        expect(await relinkRenamed(store, project, [{ storming: 'Returns', from: 'Gone', to: 'Other' }], (l) => log.push(l))).toBe(0);
        expect(log).toEqual([]);
    });
});

describe('the retirements a review proposes', () => {
    const dirs: string[] = [];
    afterAll(async () => {
        for (const d of dirs) await rm(d, { recursive: true, force: true });
    });

    test('proposed by the review of the run; an AS-IS item against a sticky changed refused by the store, as the extractor’s', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'dt-review-retire-'));
        dirs.push(root);
        const project = known(Knowledge.makeProjectName('shop'));
        const store = createFilesKnowledgeStore({ dir: path.join(root, 'knowledge'), project, stateDir: path.join(root, 'state') });
        const session = known(Knowledge.makeSessionRef('s1'));
        const source = { session, message: known(Knowledge.makeMessageRef('m1')), at: new Date(), quote: known(Knowledge.makeQuote('x')) };
        await store.applyExtraction(project, {
            by: { session, number: known(Knowledge.makeExtractionNumber(1)) },
            operations: [
                {
                    kind: 'Add',
                    id: known(Knowledge.makeKnowledgeItemId('kn_00000001')),
                    content: item('kn_00000001', 'decision', 'to_be', 0).content,
                    sources: [source],
                },
                {
                    kind: 'Add',
                    id: known(Knowledge.makeKnowledgeItemId('kn_00000002')),
                    content: item('kn_00000002', 'rule', 'as_is', 0).content,
                    sources: [source],
                },
            ],
        });
        const evidence = [{ kind: 'StickyChange' as const, sticky: 'Returns.Deadline', change: '30日にした' }];
        const log: string[] = [];
        const outcome = await proposeReviewRetirements(
            store,
            project,
            'r1',
            [
                { item: 'kn_00000001', reason: 'obsolete', explanation: '30日になった', evidence },
                { item: 'kn_00000002', reason: 'wrong', explanation: '今は違う', evidence },
            ],
            new Set(['kn_00000001', 'kn_00000002']),
            (l) => log.push(l),
        );
        expect(outcome).toEqual({ proposed: 1, refused: 1 });
        expect(log).toEqual(['knowledge: run r1: a retirement not proposed (asIsAgainstStickies)']);
        expect<unknown>((await store.proposals(project)).map((p) => [p.item, p.proposedBy])).toEqual([['kn_00000001', { kind: 'Review', review: 'run:r1' }]]);
    });
});

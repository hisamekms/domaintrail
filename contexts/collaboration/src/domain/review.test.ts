// The review at the end of a run (domain/review.ts, ADR 0034): stage 0's rules from the stormings' diff, the renames,
// and the neighbourhood.
import { describe, expect, test } from 'bun:test';
import { check } from '../test-helpers.js';
import { findingData, reviewFindings, reviewStormings, runReview, type ReviewFindingData } from './review.js';
import { readReply, readReviewReply, replyJsonSchema, requestNumber } from './reply.js';

const storming = (body: string, id = 'Returns'): string => `storming ${id} "返品" {\n${body}}\n`;

const review = async (before: Record<string, string>, after: Record<string, string>): Promise<ReturnType<typeof reviewStormings>> => {
    const a = await check(before);
    const b = await check(after);
    return reviewStormings(a.stormings, b.stormings);
};

/** A finding as one line: its kind, the sticky, its counterpart and the wording before. */
const line = (f: ReviewFindingData): string =>
    `${f.kind} ${f.storming}.${f.element}${f.other ? ` ~ ${f.other.storming}.${f.other.element}` : ''}${f.was ? ` was "${f.was}"` : ''}`;

const BASE = `  event ReturnRequested "返品が依頼された"
  event ItemReceived "返品の商品が届いた"
  hotspot Deadline "返品は注文から何日まで？" {
    on ReturnRequested
  }
`;

describe('stage 0: a hotspot and its sticky', () => {
    test('a hotspot resolved while its sticky stayed as it was', async () => {
        const after = BASE.replace('    on ReturnRequested\n', '    on ReturnRequested\n    status resolved\n    resolution "30日まで"\n');
        const r = await review({ 'r.dtes': storming(BASE) }, { 'r.dtes': storming(after) });
        expect(r.findings.map(line)).toEqual(['ResolvedUnchanged Returns.Deadline ~ Returns.ReturnRequested']);
    });

    test('a hotspot resolved with its sticky changed is no finding', async () => {
        const after = BASE.replace('"返品が依頼された"', '"返品が依頼された（30日以内）"').replace(
            '    on ReturnRequested\n',
            '    on ReturnRequested\n    status resolved\n    resolution "30日まで"\n',
        );
        const r = await review({ 'r.dtes': storming(BASE) }, { 'r.dtes': storming(after) });
        expect(r.findings).toEqual([]);
    });

    test('a sticky changed under a hotspot left open', async () => {
        const after = BASE.replace('"返品が依頼された"', '"返品が依頼された（30日以内）"');
        const r = await review({ 'r.dtes': storming(BASE) }, { 'r.dtes': storming(after) });
        expect(r.findings.map(line)).toEqual(['ChangedOpen Returns.Deadline ~ Returns.ReturnRequested']);
    });

    test('a hotspot added or rewritten with its sticky is no finding', async () => {
        const rewritten = BASE.replace('"返品が依頼された"', '"返品が依頼された（30日以内）"').replace('返品は注文から何日まで？', '30日を超えたら？');
        expect((await review({ 'r.dtes': storming(BASE) }, { 'r.dtes': storming(rewritten) })).findings).toEqual([]);
        const added = `  event ReturnRequested "返品が依頼された（30日以内）"\n  hotspot Late "30日を超えたら？" {\n    on ReturnRequested\n  }\n`;
        expect((await review({ 'r.dtes': storming('  event ReturnRequested "返品が依頼された"\n') }, { 'r.dtes': storming(added) })).findings).toEqual([]);
    });
});

describe('stage 0: wording', () => {
    test('a label changed here, still another sticky’s of the same kind elsewhere', async () => {
        const other = storming('  event ReturnRequested "返品が依頼された"\n', 'Refunds');
        const after = BASE.replace('"返品が依頼された"', '"返品を受け付けた"');
        const r = await review({ 'r.dtes': storming(BASE), 'f.dtes': other }, { 'r.dtes': storming(after), 'f.dtes': other });
        expect(r.findings.map(line)).toContain('StaleWording Refunds.ReturnRequested ~ Returns.ReturnRequested was "返品が依頼された"');
    });

    test('a rename: found by the same label or the same relations, its old name still another storming’s', async () => {
        const other = storming('  event ReturnRequested "返品の依頼"\n', 'Refunds');
        const after = BASE.replaceAll('ReturnRequested', 'ReturnAsked');
        const r = await review({ 'r.dtes': storming(BASE), 'f.dtes': other }, { 'r.dtes': storming(after), 'f.dtes': other });
        expect(r.renames).toEqual([{ storming: 'Returns', from: 'ReturnRequested', to: 'ReturnAsked' }]);
        expect(r.findings.map(line)).toContain('StaleWording Refunds.ReturnRequested ~ Returns.ReturnAsked was "ReturnRequested"');
        // renamed and relabelled at once: matched by the hotspot that is on it
        const both = BASE.replaceAll('ReturnRequested', 'ReturnAsked').replace('"返品が依頼された"', '"返品を受け付けた"');
        expect((await review({ 'r.dtes': storming(BASE) }, { 'r.dtes': storming(both) })).renames).toEqual([
            { storming: 'Returns', from: 'ReturnRequested', to: 'ReturnAsked' },
        ]);
    });

    test('no rename without a match, or with two', async () => {
        const two = `  event A "一"\n  event B "一"\n`;
        const r = await review({ 'r.dtes': storming('  event X "一"\n') }, { 'r.dtes': storming(two) });
        expect(r.renames).toEqual([]);
    });

    test('a sticky added with the label of another one', async () => {
        const after = `${BASE}  event Requested "返品が依頼された"\n`;
        const r = await review({ 'r.dtes': storming(BASE) }, { 'r.dtes': storming(after) });
        expect(r.findings.map(line)).toEqual(['DuplicateLabel Returns.Requested ~ Returns.ReturnRequested']);
    });
});

describe('the neighbourhood', () => {
    test('the stickies changed, their hotspots, one step of relations, what stage 0 found', async () => {
        const design = `  actor Customer "お客さま"
  command RequestReturn "返品を依頼する" {
    by Customer
    handledBy Return
    emits ReturnRequested
  }
  aggregate Return "返品"
  event ReturnRequested "返品が依頼された"
  event ItemReceived "返品の商品が届いた"
  hotspot Deadline "返品は注文から何日まで？" {
    on ReturnRequested
  }
`;
        const after = design.replace('"返品が依頼された"', '"返品を受け付けた"');
        const r = await review({ 'r.dtes': storming(design) }, { 'r.dtes': storming(after) });
        expect(r.neighbourhood.map((n) => `${n.why} ${n.element}${n.status ? ` ${n.status}` : ''}`)).toEqual([
            'changed ReturnRequested',
            'hotspot Deadline open',
            'next RequestReturn',
        ]);
    });

    test('nothing changed: no finding, nothing to look at', async () => {
        const r = await review({ 'r.dtes': storming(BASE) }, { 'r.dtes': storming(BASE) });
        expect(r).toEqual({ findings: [], renames: [], neighbourhood: [] });
    });
});

describe('what a run keeps of its review', () => {
    const resolved: ReviewFindingData = {
        kind: 'ResolvedUnchanged',
        storming: 'Returns',
        element: 'Deadline',
        other: { storming: 'Returns', element: 'ReturnRequested' },
    };

    test('found when the agent was asked, left when the run ended, and what the agent says', () => {
        const review = runReview({ found: reviewFindings([resolved]), left: [], report: { fixed: ['ラベルを直した' as never], kept: [] } });
        expect<unknown>(review).toEqual({ found: reviewFindings([resolved]), left: [], fixed: ['ラベルを直した'], kept: [], asked: true });
        expect(review?.found.map(findingData)).toEqual([resolved]);
    });

    test('not asked: what is left is what was found; nothing found and not asked: no review', () => {
        expect(runReview({ found: undefined, left: [resolved], report: undefined })).toMatchObject({ found: reviewFindings([resolved]), asked: false });
        expect(runReview({ found: undefined, left: [], report: undefined })).toBeUndefined();
        // asked and nothing found: kept, so that the card can say the agent checked
        expect(runReview({ found: [], left: [], report: { fixed: [], kept: [] } })).toMatchObject({ asked: true });
    });
});

describe("the agent's report of its review in the reply", () => {
    const reply = { outcome: 'done', title: '期限', summary: '見直した', requests: [] };

    test('read within its limits, its knowledge by ID and sticky; the schema offers it', () => {
        const read = readReply(
            {
                ...reply,
                review: {
                    fixed: ['@{es:Returns/ReturnRequested} を直した'],
                    kept: [{ what: '重複', why: '別のもの' }],
                    knowledge: [{ item: 'kn_00000001', sticky: 'Returns.ReturnRequested', why: '14日のまま' }],
                },
            },
            requestNumber(1),
            1,
        );
        expect(read.ok && read.value.review).toEqual({
            fixed: ['@{es:Returns/ReturnRequested} を直した'],
            kept: [{ what: '重複', why: '別のもの' }],
            knowledge: [{ item: 'kn_00000001', sticky: 'Returns.ReturnRequested', why: '14日のまま' }],
            retire: [],
        });
        expect(Object.keys((replyJsonSchema(1) as { properties: object }).properties)).toContain('review');
    });

    test('a retirement it proposes: a reason, an explanation and evidence (a sticky changed, or a decision); never a message', () => {
        const retire = {
            item: 'kn_00000001',
            reason: 'replaced',
            replacedBy: 'kn_00000002',
            explanation: '30日に決めた',
            evidence: [
                { kind: 'StickyChange', sticky: 'Returns.Deadline', change: '解決: 30日' },
                { kind: 'Decision', item: 'kn_00000002' },
            ],
        };
        expect<unknown>(readReviewReply({ retire: [retire] })).toEqual({ ok: true, value: { fixed: [], kept: [], knowledge: [], retire: [retire] } });
        expect(readReviewReply({ retire: [{ ...retire, evidence: [] }] })).toMatchObject({ ok: false, error: { path: 'reply.review.retire[0].evidence' } });
        expect(readReviewReply({ retire: [{ ...retire, reason: 'obsolete' }] })).toMatchObject({
            ok: false,
            error: { path: 'reply.review.retire[0].replacedBy' },
        });
        expect(readReviewReply({ retire: [{ ...retire, evidence: [{ kind: 'Said', session: 's', message: 'm', quote: 'q' }] }] })).toMatchObject({ ok: false });
    });

    test('a bad item ID, a sticky that is no reference, a kept finding without why: refused', () => {
        expect(readReviewReply({ knowledge: [{ item: 'kn_X', sticky: 'Returns.ReturnRequested', why: 'x' }] })).toMatchObject({ ok: false });
        expect(readReviewReply({ knowledge: [{ item: 'kn_00000001', sticky: 'ReturnRequested', why: 'x' }] })).toMatchObject({ ok: false });
        expect(readReviewReply({ kept: [{ what: 'x' }] })).toMatchObject({ ok: false, error: { path: 'reply.review.kept[0].why' } });
        expect(readReviewReply({})).toEqual({ ok: true, value: { fixed: [], kept: [], knowledge: [], retire: [] } });
    });
});

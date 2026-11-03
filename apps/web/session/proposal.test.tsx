// A change proposal's card (apps/web/session/proposal.tsx, proposal-view.ts): its targets named with their kind and
// where they are, the first three and 「ほか n」, the option it stands with, the how it shows; and the card as the
// facilitator sees it (options to pick, one set of buttons) and as its requester does (read-only, waiting, 取り下げ).
import { beforeAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyze } from '@domaintrail/analysis';
import { MESSAGES } from '../i18n';
import { exampleSources } from '../test-helpers';
import type { ProposalJson } from './ai';
import { ChatProvider, type ChatContextValue } from './chat-context';
import { TargetNamingProvider } from './naming';
import { ProposalCard } from './proposal';
import { chosenIndex, editableHow, headHow, shownOptionHow, shownTargets, targetLabel } from './proposal-view';
import type { ModelTarget, NamingContext } from './targets';

const dt = (element: string): ModelTarget => ({ kind: 'DtElement', element });
const order = dt('Sales.Order');
const t = MESSAGES.ja;
const at = '2026-11-03T09:00:00.000Z';

let naming: NamingContext;
beforeAll(async () => {
    const a = await analyze(await exampleSources());
    naming = { mode: 'label', model: a.model ?? null, stormings: a.stormings.stormings.map((s) => ({ id: s.id, storming: s })) };
});

const proposal = (content: Partial<ProposalJson['content']>, extra: object = {}): ProposalJson =>
    ({
        state: 'Open',
        id: 'p1',
        session: 's',
        triage: 't1',
        request: 'm1',
        requestedBy: 'bob',
        content: { targets: [], how: 'ラベルを「注文」→「受注」に変える', options: [], ...content },
        proposedAt: at,
        ...extra,
    }) as unknown as ProposalJson;

const options: ProposalJson['content']['options'] = [
    { label: '集約だけ', targets: [order], recommended: true },
    {
        label: '付箋も揃える',
        targets: [order, { kind: 'DtesElement', storming: 'Returns', local: 'ReturnRequested' }],
        how: '付箋のラベルも揃える',
        recommended: false,
    },
    {
        label: '「注文」を含む名前をすべて',
        targets: ['Sales.Order', 'Sales.OrderId', 'Sales.Order#Draft', 'Sales.Order:confirm', 'Sales.Gone'].map(dt),
        recommended: false,
    },
] as unknown as ProposalJson['content']['options'];

describe('a proposal as its card shows it', () => {
    test('targets named in the display setting with their kind and where they are; unknown ones as their identifier', () => {
        expect(targetLabel(order, naming, t)).toEqual({ name: '注文', detail: '集約・販売', resolved: true });
        expect(targetLabel(dt('Sales.Order#Draft'), naming, t)).toMatchObject({ detail: '状態・注文', resolved: true });
        expect(targetLabel({ kind: 'DtesElement', storming: 'Returns', local: 'ReturnRequested' }, naming, t)).toMatchObject({
            detail: expect.stringContaining('イベント・'),
            resolved: true,
        });
        // not there (yet): to be added by the change, or gone
        expect(targetLabel(dt('Sales.ReturnCancelled'), naming, t)).toEqual({ name: 'Sales.ReturnCancelled', resolved: false });
        expect(targetLabel({ kind: 'DtesElement', storming: 'Returns', local: 'Gone' }, naming, t)).toEqual({ name: 'Gone', resolved: false });
        // a whole storming: by its title, as a storming
        expect(targetLabel({ kind: 'DtesStorming', storming: 'Returns' }, naming, t)).toEqual({ name: '返品', detail: 'ストーミング', resolved: true });
        expect(targetLabel({ kind: 'DtesStorming', storming: 'Gone' }, naming, t)).toEqual({ name: 'Gone', resolved: false });
    });

    test('the first three targets, then how many more', () => {
        expect(shownTargets([1, 2])).toEqual({ shown: [1, 2], more: 0 });
        expect(shownTargets([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2, 3], more: 2 });
    });

    test('the option it stands with: the pick while open, else the recommendation; once approved, the one approved with', () => {
        const p = proposal({ options });
        expect(chosenIndex(p, undefined)).toBe(0);
        expect(chosenIndex(p, 2)).toBe(2);
        expect(chosenIndex(p, 7)).toBe(0);
        expect(chosenIndex(proposal({}), 1)).toBeUndefined();
        const approved = proposal({ options }, { state: 'Approved', option: 1, editedHow: '付箋だけ揃える', approvedBy: 'f', approvedAt: at, run: 'r' });
        expect(chosenIndex(approved, 0)).toBe(1);
        // the edit goes with the option approved; the how on top stays the proposal's
        expect([shownOptionHow(approved, 1), shownOptionHow(approved, 0), headHow(approved)]).toEqual([
            '付箋だけ揃える',
            undefined,
            'ラベルを「注文」→「受注」に変える',
        ]);
        // without options, the edit is the how on top
        expect(headHow(proposal({ targets: [order] }, { state: 'Approved', editedHow: 'x', approvedBy: 'f', approvedAt: at, run: 'r' }))).toBe('x');
        // what 編集 starts from: the chosen option's how, else the proposal's
        expect([editableHow(p.content, 1), editableHow(p.content, 0), editableHow(p.content, undefined)]).toEqual([
            '付箋のラベルも揃える',
            'ラベルを「注文」→「受注」に変える',
            'ラベルを「注文」→「受注」に変える',
        ]);
    });
});

/** The card rendered as `me` sees it (the facilitator `f` decides). */
function render(p: ProposalJson, me: 'f' | 'bob'): string {
    const chat = {
        tx: t.session,
        session: {
            status: 'live',
            me: { participant: { id: me, role: me === 'f' ? 'facilitator' : 'participant' } },
            state: { session: { state: 'Open', mode: 'Collab' }, proposals: [p], requests: [], runs: [] },
        },
        control: me === 'f',
        actions: { busy: false },
        onNavigate: () => {},
        nameOf: (id: string) => id,
        jump: () => {},
        reveal: { clamps: () => true, open: () => {} },
        proposalPicks: { ids: new Set(), toggle: () => {}, clear: () => {}, options: new Map(), choose: () => {} },
    } as unknown as ChatContextValue;
    return renderToStaticMarkup(
        <TargetNamingProvider value={naming}>
            <ChatProvider value={chat}>
                <ProposalCard proposal={p} continues={false} />
            </ChatProvider>
        </TargetNamingProvider>,
    );
}

/** The visible text of some markup, its tags dropped. */
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe("the proposal's card", () => {
    test('without options: the targets as chips, then the how; no field labels, no files', () => {
        const html = render(proposal({ targets: [order] }), 'f');
        expect(text(html)).toContain('#注文 集約・販売');
        expect(text(html)).toContain('ラベルを「注文」→「受注」に変える');
        for (const gone of ['何を', 'どこを', 'どう', '.dt']) expect(text(html)).not.toContain(gone);
        expect(html).toContain('class="chat-chip chat-target proposal-target"');
        expect(html).not.toContain('type="radio"');
        expect((html.match(/chat-small primary/g) ?? []).length).toBe(1);
    });

    test('with options, for the facilitator: a radio per option, the recommendation chosen and marked, one 承認', () => {
        const html = render(proposal({ options }), 'f');
        expect((html.match(/type="radio"/g) ?? []).length).toBe(3);
        expect(html.match(/<input type="radio"[^>]*checked=""/g)?.length).toBe(1);
        expect(html).toMatch(/class="proposal-option chosen"><input type="radio"[^>]*checked=""/);
        expect((html.match(/AI の勧め/g) ?? []).length).toBe(1);
        // one set of buttons for the card, none per option
        expect(text(html).match(/承認/g)?.length).toBe(2); // 承認 and the state 承認待ち
        expect(text(html)).toContain('編集');
        expect(text(html)).toContain('却下');
        // the first three targets, then ほか n
        expect(text(html)).toContain('ほか 2');
        expect(text(html)).not.toContain('ファシリテーターの承認待ち');
        expect(text(html)).not.toContain('取り下げ');
    });

    test('with options, for the requester: read-only, the recommendation marked, waiting for the facilitator, 取り下げ', () => {
        const html = render(proposal({ options }), 'bob');
        expect(html).not.toContain('type="radio"');
        expect(html).toContain('role="list"');
        expect((html.match(/AI の勧め/g) ?? []).length).toBe(1);
        expect(text(html)).toContain('ファシリテーターの承認待ち');
        expect(text(html)).toContain('取り下げ');
        expect(text(html)).not.toContain('編集');
        expect(text(html)).not.toContain('却下');
    });

    test('approved with an option: that option stays marked, its how as edited', () => {
        const html = render(
            proposal({ options }, { state: 'Approved', option: 1, editedHow: '付箋だけ揃える', approvedBy: 'f', approvedAt: at, run: 'r' }),
            'bob',
        );
        expect(html).toContain('aria-label="選んだ案"');
        expect(text(html)).toContain('付箋だけ揃える');
        expect(text(html)).toContain('承認（編集あり）');
        expect(text(html)).not.toContain('ファシリテーターの承認待ち');
    });

    test('a proposal stored before options: its former texts as the how', () => {
        const html = render(proposal({ how: '取り消しのコマンド\n@{Sales.Order}\nConfirmed から Cancelled へ' }), 'f');
        expect(text(html)).toContain('取り消しのコマンド');
        // its element reference is a link, by its name
        expect(html).toContain('class="reply-element"');
    });
});

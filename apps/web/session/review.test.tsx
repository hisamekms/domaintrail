// The review at a run's end on its card (ADR 0034, session/review.ts and review-line.tsx): a line per kind dt found,
// fixed or left; what the AI fixed and kept and why; 見直しを頼む for the facilitator while something is left, and the
// message it sends.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MESSAGES } from '../i18n';
import { ChatProvider, type ChatContextValue } from './chat-context';
import { leftStickies, reviewGroups, reviewRequestBody, reviewShown, type RunReviewJson } from './review';
import { ReviewLine } from './review-line';

const resolved = {
    kind: 'ResolvedUnchanged',
    sticky: { storming: 'Returns', element: 'Deadline' },
    other: { storming: 'Returns', element: 'ReturnRequested' },
} as const;
const open = { kind: 'ChangedOpen', sticky: { storming: 'Returns', element: 'Late' }, other: { storming: 'Returns', element: 'ItemReceived' } } as const;

const review = (over: Partial<RunReviewJson> = {}): RunReviewJson => ({ found: [resolved, open], left: [open], fixed: [], kept: [], asked: true, ...over });

describe('what the card shows of a review', () => {
    test('a line per kind: how many found, and whether it was fixed or how many are left', () => {
        expect(reviewGroups(review())).toEqual([
            { kind: 'ResolvedUnchanged', found: 1, left: 0 },
            { kind: 'ChangedOpen', found: 1, left: 1 },
        ]);
        // found only once the run ended: counted, and left
        const stale = { kind: 'StaleWording', sticky: { storming: 'Refunds', element: 'X' }, was: '旧' } as const;
        expect(reviewGroups(review({ found: [], left: [stale] }))).toEqual([{ kind: 'StaleWording', found: 1, left: 1 }]);
    });

    test('nothing found, fixed or kept: nothing shown', () => {
        expect(reviewShown(review({ found: [], left: [] }))).toBe(false);
        expect(reviewShown(review({ found: [], left: [], kept: [{ what: 'x', why: 'y' }] }))).toBe(true);
    });

    test('見直しを頼む: a message to the AI replying to the run, the stickies of what is left as its targets', () => {
        expect(leftStickies(review())).toEqual(['Returns.Late', 'Returns.ItemReceived']);
        const body = reviewRequestBody({
            run: 'run-1',
            review: review(),
            label: (s) => (s === 'Returns.Late' ? '遅れたら？' : '返品の商品が届いた'),
            revision: 'rev-9',
            aiName: 'AI',
            text: MESSAGES.ja.session.chat.review.askText,
        });
        expect(body).toEqual({
            targets: [
                { target: { kind: 'DtesElement', storming: 'Returns', local: 'Late' }, label: '遅れたら？', sourceRevision: 'rev-9' },
                { target: { kind: 'DtesElement', storming: 'Returns', local: 'ItemReceived' }, label: '返品の商品が届いた', sourceRevision: 'rev-9' },
            ],
            body: '@AI[p1] 見直しで残ったものを確かめて、直すか、直さないわけを書いてください #遅れたら？[1] #返品の商品が届いた[2]',
            mentions: ['ai'],
            replyTo: { kind: 'Run', run: 'run-1' },
        });
    });
});

function render(r: RunReviewJson, offer: boolean): string {
    const chat = {
        tx: MESSAGES.ja.session,
        session: { status: 'live', state: { runs: [], revisions: [], session: { facilitator: 'facilitator', state: 'Open' } } },
        control: true,
        solo: false,
        onNavigate: () => {},
        nameOf: (id: string) => id,
    } as unknown as ChatContextValue;
    return renderToStaticMarkup(
        <ChatProvider value={chat}>
            <ReviewLine run="run-1" review={r} offer={offer} />
        </ChatProvider>,
    );
}

describe('the review line', () => {
    test('見直し, the kinds with fixed or left, what the AI fixed and kept and why', () => {
        const html = render(review({ fixed: ['ラベルに期限を書いた'], kept: [{ what: '遅れたら？ は開いたまま', why: 'まだ決めていない' }] }), true);
        expect(html).toContain('見直し');
        expect(html).toContain('解決したが付箋はそのまま 1 件');
        expect(html).toContain(' · 直した');
        expect(html).toContain('付箋を変えたがホットスポットは開いたまま 1 件');
        expect(html).toContain(' · 残り 1 件');
        expect(html).toContain('✓ ');
        expect(html).toContain('ラベルに期限を書いた');
        expect(html).toContain('まだ決めていない');
        expect(html).toContain('見直しを頼む');
    });

    test('nothing left, or not the facilitator’s to offer: no 見直しを頼む', () => {
        expect(render(review({ left: [] }), true)).not.toContain('見直しを頼む');
        expect(render(review(), false)).not.toContain('見直しを頼む');
    });
});

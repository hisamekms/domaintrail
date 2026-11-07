// Following in a session (session/follow.tsx): a participant's view and camera, the AI from a request or a proposal, and
// how it shows (the toggles, the people button, the participants' rows).
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Presence, SessionStateBody, ViewLocation } from '@domaintrail/collaboration/protocol';
import type { Lang } from '@domaintrail/visualization';
import { I18nProvider } from '../i18n';
import { AI_FOLLOWEE, type Followee } from '../view/follow';
import { followedFirst } from './collab-menu';
import { aiToggle, approvedProposalsOf, followedPage, FollowFrame, followeeColor, FollowToggle, personMove, presentParticipants } from './follow';
import { ParticipantsList } from './participants';
import { cameraBounds, participantColor, sameCamera } from './presence';
import type { ParticipantRow, ViewScope } from './views';

const storming = (stormingId: string, layoutKey = `${stormingId}@1`): ViewLocation => ({ kind: 'dtes', stormingId, level: 'big-picture', layoutKey });
const scope: ViewScope = {
    mode: 'label',
    contexts: ['Sales'],
    contextLabels: {},
    stormings: [
        { id: 'Dispatch', label: '配車', timelines: [] },
        { id: 'Returns', label: '返品', timelines: [] },
    ],
};
const page = (connection: string, id: string, location: ViewLocation, camera?: Presence['camera']): Presence => ({
    connection,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fields following reads
    participant: { id, name: id, role: 'participant' } as Presence['participant'],
    location,
    ...(camera && { camera }),
});
const camera = { x: 100, y: 50, w: 1200, h: 700 };

describe("following a participant's page", () => {
    test('on their view, their camera is fitted here', () => {
        expect(personMove({ location: storming('Dispatch'), camera }, storming('Dispatch'), scope, false)).toEqual({ camera });
        // nothing until they sent one (a page before the camera)
        expect(personMove({ location: storming('Dispatch') }, storming('Dispatch'), scope, false)).toEqual({});
    });

    test('on another view, theirs is opened here (the camera follows once it is drawn)', () => {
        expect(personMove({ location: storming('Returns'), camera }, storming('Dispatch'), scope, false)).toEqual({
            view: { kind: 'storming', stormingId: 'Returns', level: 'big-picture' },
        });
        expect(personMove({ location: { kind: 'dt', viewKey: 'structure:overview', layoutKey: 's@1' } }, storming('Dispatch'), scope, false)).toEqual({
            view: { kind: 'structure', level: 'overview' },
        });
    });

    test('their 詰めて表示 too, so that the same layout takes their camera', () => {
        expect(personMove({ location: storming('Dispatch', 'Dispatch@1~compact') }, storming('Dispatch'), scope, false)).toEqual({ compact: true });
        expect(personMove({ location: storming('Dispatch') }, storming('Dispatch', 'Dispatch@1~compact'), scope, true)).toEqual({ compact: false });
    });

    test('nothing while they are where no canvas is, or on a view this page cannot open: the following goes on', () => {
        expect(personMove({ location: { kind: 'dt', viewKey: 'catalog', layoutKey: '-' } }, storming('Dispatch'), scope, false)).toEqual({});
        expect(personMove({ location: storming('Gone'), camera }, storming('Dispatch'), scope, false)).toEqual({});
        expect(
            personMove({ location: { kind: 'dt', viewKey: 'structure:focus:Billing||detail', layoutKey: 'f@1' } }, storming('Dispatch'), scope, false),
        ).toEqual({});
    });

    test('of a participant with several pages, the one showing a camera; those present', () => {
        const peers = new Map([
            ['c1', page('c1', 'dev:sato', { kind: 'dt', viewKey: 'catalog', layoutKey: '-' })],
            ['c2', page('c2', 'dev:sato', storming('Dispatch'), camera)],
            ['c3', page('c3', 'dev:tanaka', storming('Returns'))],
        ]);
        expect(followedPage(peers, 'dev:sato')?.connection).toBe('c2');
        expect(followedPage(peers, 'dev:tanaka')?.connection).toBe('c3');
        expect(followedPage(peers, 'dev:gone')).toBeUndefined();
        expect(presentParticipants(peers)).toEqual(new Set(['dev:sato', 'dev:tanaka']));
    });
});

describe('the camera a page sends', () => {
    test('the part of the page its canvas shows, to a tenth; none for a canvas not laid out', () => {
        expect(cameraBounds({ x: 10.04, y: -3.06, w: 800.55, h: 600 })).toEqual({ x: 10, y: -3.1, w: 800.6, h: 600 });
        expect(cameraBounds({ x: 0, y: 0, w: 0, h: 600 })).toBeUndefined();
        expect(cameraBounds({ x: Number.NaN, y: 0, w: 10, h: 10 })).toBeUndefined();
        expect(sameCamera({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 4 })).toBe(true);
        expect(sameCamera({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 5 })).toBe(false);
        expect(sameCamera(undefined, { x: 1, y: 2, w: 3, h: 4 })).toBe(false);
    });
});

describe('the AI followed from a request', () => {
    type ProposalJson = NonNullable<SessionStateBody['proposals']>[number];
    const proposal = (id: string, requestedBy: string, state: string): ProposalJson =>
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fields following reads
        ({ id, requestedBy, state }) as unknown as ProposalJson;

    test("the reader's own proposals approved (each runs); not another's, nor one still open or rejected", () => {
        const proposals = [
            proposal('p1', 'dev:me', 'Approved'),
            proposal('p2', 'dev:sato', 'Approved'),
            proposal('p3', 'dev:me', 'Open'),
            proposal('p4', 'dev:me', 'Rejected'),
        ];
        expect(approvedProposalsOf(proposals, 'dev:me')).toEqual(['p1']);
    });

    test("the app bar's toggle: beside the AI's status while it works; idle, only while followed, faint; never while no agent is connected", () => {
        const connected = { kind: 'connected' } as const;
        const missing = { kind: 'missing', role: 'all', waiting: 0 } as const;
        const running = { kind: 'running', since: '2026-11-06T09:00:00.000Z' } as const;
        expect(aiToggle(running, connected, null)).toBe('shown');
        expect(aiToggle({ kind: 'queued' }, connected, AI_FOLLOWEE)).toBe('shown');
        expect(aiToggle({ kind: 'idle' }, connected, null)).toBe('none');
        expect(aiToggle({ kind: 'idle' }, connected, AI_FOLLOWEE)).toBe('faint');
        expect(aiToggle({ kind: 'idle' }, connected, { kind: 'person', participant: 'dev:sato' })).toBe('none');
        expect(aiToggle(running, missing, null)).toBe('none');
        expect(aiToggle(running, missing, AI_FOLLOWEE)).toBe('faint');
    });
});

describe('how following shows', () => {
    const render = (node: React.ReactNode, lang: Lang = 'ja'): string => renderToStaticMarkup(<I18nProvider lang={lang}>{node}</I18nProvider>);
    const sato: Followee = { kind: 'person', participant: 'dev:sato' };

    test('the toggle is named by what a press does, in the followee’s color: ◉ pressed, ○ not', () => {
        const on = render(<FollowToggle followee={AI_FOLLOWEE} name="AI" on onToggle={() => {}} />);
        expect(on).toContain('aria-label="AI を追うのをやめる"');
        expect(on).toContain('aria-pressed="true"');
        expect(on).toContain('class="icon-button follow-toggle on"');
        expect(on).toContain('--follow-color:var(--agent-active)');
        expect(render(<FollowToggle followee={sato} name="佐藤" on={false} faint onToggle={() => {}} />)).toContain('aria-label="佐藤を追う"');
        expect(render(<FollowToggle followee={AI_FOLLOWEE} name="AI" on={false} onToggle={() => {}} />, 'en')).toContain('aria-label="Follow AI"');
        expect(render(<FollowToggle followee={sato} name="Sato" on onToggle={() => {}} />, 'en')).toContain('aria-label="Stop following Sato"');
    });

    test("the canvas's frame in the followee's color, faint while the AI followed is idle; none while no one is followed", () => {
        expect(render(<FollowFrame followee={sato} faint={false} />)).toBe(
            `<div class="follow-frame" style="--follow-color:${participantColor('dev:sato')}" aria-hidden="true"></div>`,
        );
        expect(render(<FollowFrame followee={AI_FOLLOWEE} faint />)).toContain('class="follow-frame faint"');
        expect(render(<FollowFrame followee={null} faint={false} />)).toBe('');
        expect(followeeColor(AI_FOLLOWEE)).toBe('var(--agent-active)');
    });

    test('the people button shows the participant followed first', () => {
        const rows = [{ id: 'dev:me' }, { id: 'dev:tanaka' }, { id: 'dev:sato' }];
        expect(followedFirst(rows, sato).map((r) => r.id)).toEqual(['dev:sato', 'dev:me', 'dev:tanaka']);
        expect(followedFirst(rows, AI_FOLLOWEE).map((r) => r.id)).toEqual(['dev:me', 'dev:tanaka', 'dev:sato']);
    });

    test('the participants: you, then the AI, then the others; each one online but you with ○ / ◉, the followed one marked', () => {
        const row = (id: string, name: string, where: ParticipantRow['where'], me = false): ParticipantRow => ({ id, name, role: 'participant', me, where });
        const rows = [row('dev:me', '自分', 'here', true), row('dev:sato', '佐藤', 'same-view'), row('dev:gone', '退出', 'away')];
        const html = render(
            <ParticipantsList
                rows={rows}
                scope={scope}
                onOpenView={() => {}}
                focus={undefined}
                follow={{ followee: sato, choose: () => {} }}
                aiStatus="実行中 1:24"
            />,
        );
        const order = ['data-participant="自分"', 'data-participant="AI"', 'data-participant="佐藤"'].map((s) => html.indexOf(s));
        expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))).toBe(true);
        expect(html).toContain('実行中 1:24');
        expect(html).toContain('aria-label="AI を追う"');
        expect(html).toContain('aria-label="佐藤を追うのをやめる"');
        expect(html).toContain('chat-person where-same-view followed');
        // not yourself, nor the offline (listed folded)
        expect(html).not.toContain('自分を追う');
        expect(html).not.toContain('退出を追う');
    });
});

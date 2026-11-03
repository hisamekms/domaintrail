// The current journey in the app bar and the journeys panel (journey-panel.tsx, journey-view.ts, journey-detail.tsx):
// the chip's states (none: ゴールを決める; the journey · here → the goal; reached; missing; the requests waiting) and
// how it narrows; the panel as the facilitator and a participant see it (the brief, the map, the actions, the other
// journeys, the archived, the requests); the goals offered; the journeys of a storming and of a context in the detail.
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyze } from '@domaintrail/analysis';
import type { GuideWorkspace, JourneyFile } from '@domaintrail/collaboration';
import type { JourneyRequestBody } from '@domaintrail/collaboration/protocol';
import { MESSAGES } from '../i18n';
import { exampleSources } from '../test-helpers';
import { ChatProvider, type ChatContextValue } from './chat-context';
import { JourneyDetail } from './journey-detail';
import { GoalMenu, JourneyChipButton, JourneysPanel } from './journey-panel';
import { goalChoices, journeyOverview, journeysOfContext, journeysOfStorming, type JourneyOverview } from './journey-view';
import { TargetNamingProvider } from './naming';
import type { NamingContext } from './targets';

const t = MESSAGES.ja;
let naming: NamingContext;
let workspace: GuideWorkspace;
beforeAll(async () => {
    const a = await analyze(await exampleSources());
    naming = { mode: 'label', model: a.model ?? null, stormings: a.stormings.stormings.map((s) => ({ id: s.id, storming: s })) };
    workspace = { model: a.model ?? null, stormings: a.stormings.stormings, diagnostics: a.diagnostics };
});

const FILE: JourneyFile = {
    version: 1,
    stormings: {
        Returns: {
            purpose: '返品を速く',
            scope: '受付から返金まで',
            participants: ['窓口担当', '経理'],
            use: 'modeling',
            level: 'BigPicture',
            state: 'active',
            marks: [],
        },
    },
    modeling: [
        {
            id: 'shop',
            name: 'ショップ',
            purpose: '注文から請求まで',
            participants: [],
            pattern: 'FromStorming',
            from: { stormings: ['Returns'] },
            goal: 'invariants',
            state: 'active',
            marks: { steps: [], contexts: {} },
        },
        {
            id: 'billing',
            name: 'Billing の深掘り',
            purpose: '請求を正す',
            constraints: '会計はそのまま',
            participants: [],
            pattern: 'OneContext',
            from: { context: 'Billing' },
            goal: 'commands',
            state: 'active',
            marks: { steps: [], contexts: {} },
        },
        {
            id: 'old',
            name: '前の見直し',
            purpose: '古い',
            participants: [],
            pattern: 'Review',
            goal: 'invariants',
            state: 'archived',
            marks: { steps: [], contexts: {} },
        },
    ],
};

const overviewOf = (file: JourneyFile | null, current?: string): JourneyOverview => journeyOverview({ ...workspace, ...(file && { journey: file }) }, current);

function chat(me: 'f' | 'bob', file: JourneyFile | null, current?: string, requests: JourneyRequestBody[] = [], acts: unknown[] = []): ChatContextValue {
    return {
        tx: t.session,
        session: {
            status: 'live',
            me: { participant: { id: me, role: me === 'f' ? 'facilitator' : 'participant' } },
            state: { session: { state: 'Open', mode: 'Collab' }, slashCommands: [], interviews: [], requests: [], runs: [], marks: [], revisions: [] },
        },
        journeys: {
            body: { file, problems: [], requests },
            workspace: { ...workspace, ...(file && { journey: file }) },
            overview: overviewOf(file, current),
            open: false,
            setOpen: () => {},
            act: (a: unknown) => acts.push(a),
            choose: (j: unknown) => acts.push({ choose: j }),
            decide: () => {},
            seeGuide: () => {},
            notice: undefined,
        },
        putCommand: () => {},
        onNavigate: () => {},
        openView: () => {},
    } as unknown as ChatContextValue;
}

const render = (node: React.ReactNode, value: ChatContextValue): string =>
    renderToStaticMarkup(
        <TargetNamingProvider value={naming}>
            <ChatProvider value={value}>{node}</ChatProvider>
        </TargetNamingProvider>,
    );
const text = (html: string): string => html.replace(/<[^>]*>/g, '');

describe('the chip', () => {
    test('none: ゴールを決める; the current journey · the step here → the goal; reached; a missing subject dashed', () => {
        expect(text(render(<JourneyChipButton />, chat('f', null)))).toBe('ゴールを決める');
        const shop = render(<JourneyChipButton />, chat('f', FILE, 'shop'));
        expect(text(shop)).toBe('ショップ·ES を見直す→不変条件');
        expect(shop).toContain('aria-label="いまの旅: ショップ、いま ES を見直す、ゴール 不変条件（旅程を開く）"');
        expect(shop).toContain('lucide-compass');
        expect(shop).toContain('lucide-map-pin');
        expect(shop).toContain('lucide-flag');
        // the ES journey: its level as the goal
        expect(text(render(<JourneyChipButton />, chat('f', FILE, 'es:Returns')))).toBe('返品·例外→ビッグピクチャー');
        // a journey whose context is gone
        const gone = { ...FILE, modeling: [{ ...FILE.modeling[1]!, from: { context: 'Nowhere' } }] };
        expect(render(<JourneyChipButton />, chat('f', gone, 'billing'))).toContain('class="journey-chip missing"');
        // the default: the most recently created active journey
        expect(text(render(<JourneyChipButton />, chat('f', FILE)))).toStartWith('Billing の深掘り');
    });

    test('the requests waiting: a badge for the facilitator only', () => {
        const request: JourneyRequestBody = {
            id: 'r1',
            by: 'bob',
            byName: 'Bob',
            act: { kind: 'goal', journey: 'shop', goal: 'commands' },
            at: '2026-11-03T10:00:00Z',
        };
        expect(render(<JourneyChipButton />, chat('f', FILE, 'shop', [request]))).toContain(
            '<span class="journey-chip-badge" aria-label="お願い 1 件">1</span>',
        );
        expect(render(<JourneyChipButton />, chat('bob', FILE, 'shop', [request]))).not.toContain('journey-chip-badge');
    });

    test('narrowed by the app bar: 🧭 and the journey, then 🧭 alone (container queries)', async () => {
        const css = await readFile(path.join(import.meta.dir, '..', 'styles.css'), 'utf8');
        const rule = (max: string, selector: string): RegExp =>
            new RegExp(`@container app-bar \\(max-width: ${max}\\) \\{\\s*\\${selector} \\{\\s*display: none;`);
        expect(css).toMatch(rule('72rem', '.journey-chip-where'));
        expect(css).toMatch(rule('48rem', '.journey-chip-name'));
        expect(css).toMatch(/\.app-bar \{\s*container: app-bar \/ inline-size;/);
    });
});

describe('the journeys panel', () => {
    test("the facilitator: the current journey's brief, its map and actions; the others to choose; the new ones; the archived counted", () => {
        const html = render(<JourneysPanel onClose={() => {}} />, chat('f', FILE, 'billing'));
        expect(html).toContain('role="dialog" aria-label="旅程"');
        const current = html.slice(html.indexOf('journeys-current'), html.indexOf('journeys-others'));
        expect(text(current)).toContain('Billing の深掘り');
        expect(text(current)).toContain('目的請求を正す');
        expect(text(current)).toContain('制約会計はそのまま');
        expect(text(current)).toContain('もとBilling');
        expect(current).toContain('guide-path');
        for (const action of ['ガイドを見る', 'ゴールを変える', 'ブリーフを見直す', '完了にする', 'しまう']) expect(text(current)).toContain(action);
        const others = html.slice(html.indexOf('journeys-others'), html.indexOf('journeys-new'));
        expect([...others.matchAll(/<span class="journeys-row-name">([^<]*)<\/span>/g)].map((m) => m[1])).toEqual(['返品', 'ショップ']);
        expect(others.match(/>この旅にする<\/button>/g)).toHaveLength(2);
        expect(text(html)).toContain('/es:start');
        expect(text(html)).toContain('/model:start');
        expect(text(html)).toContain('しまった旅 1 件');
        expect(html).not.toContain('ファシリテーターが決めます');
    });

    test('a participant reads the same panel; their requests wait (withdraw), the facilitator approves or denies', () => {
        const mine: JourneyRequestBody = {
            id: 'r1',
            by: 'bob',
            byName: 'Bob',
            act: { kind: 'goal', journey: 'shop', goal: 'commands' },
            at: '2026-11-03T10:00:00Z',
        };
        const theirs: JourneyRequestBody = {
            id: 'r2',
            by: 'carol',
            byName: 'Carol',
            act: { kind: 'choose', journey: 'es:Returns' },
            at: '2026-11-03T10:01:00Z',
        };
        const bob = render(<JourneysPanel onClose={() => {}} />, chat('bob', FILE, 'shop', [mine, theirs]));
        expect(text(bob)).toContain('ファシリテーターが決めます');
        expect(text(bob)).toContain('あなた が「ショップ」のゴールを コマンド に');
        expect(text(bob)).not.toContain('Carol');
        expect(text(bob)).toContain('取り下げ');
        expect(bob).not.toContain('>承認</button>');
        // the actions are offered to everyone: a participant's become requests
        expect(text(bob)).toContain('ゴールを変える');
        const ada = render(<JourneysPanel onClose={() => {}} />, chat('f', FILE, 'shop', [mine, theirs]));
        expect(text(ada)).toContain('Bob が「ショップ」のゴールを コマンド に');
        expect(text(ada)).toContain('Carol が「返品」をいまの旅に');
        expect(ada.match(/>承認<\/button>/g)).toHaveLength(2);
        expect(ada.match(/>却下<\/button>/g)).toHaveLength(2);
    });

    test('no journey: said so, with the new ones; an ES journey that reached its goal with use modeling: /model:start', () => {
        expect(text(render(<JourneysPanel onClose={() => {}} />, chat('f', null)))).toContain('まだ旅がありません');
        const reached: JourneyFile = { ...FILE, stormings: { Returns: { ...FILE.stormings.Returns!, marks: ['exceptions', 'questions'] } } };
        const html = render(<JourneysPanel onClose={() => {}} />, chat('f', reached, 'es:Returns'));
        expect(text(html)).toContain('ゴールに着きました。ここからモデリングへ/model:start');
    });

    test('ゴールを変える: the ES levels, or the goals of the pattern, the current one checked', () => {
        const overview = overviewOf(FILE, 'shop');
        const shop = render(<GoalMenu item={overview.current!} onDone={() => {}} />, chat('f', FILE, 'shop'));
        expect([...shop.matchAll(/aria-checked="(true|false)"[^>]*>.*?<\/svg>([^<]*)<\/button>/g)].map((m) => `${m[2]}:${m[1]}`)).toEqual([
            '集約:false',
            'コマンド:false',
            '不変条件:true',
        ]);
        expect(goalChoices({ kind: 'es' })).toEqual(['BigPicture', 'DesignLevel']);
        expect(goalChoices({ kind: 'model', pattern: 'OneContext' })).toEqual(['commands', 'invariants']);
    });
});

describe('the journeys in the detail', () => {
    test('a storming: its ES journey (and the modeling journeys carved from it); a context: the modeling journeys over it', () => {
        expect(journeysOfStorming(FILE, 'Returns').map((j) => j.key)).toEqual(['es:Returns', 'shop']);
        expect(journeysOfContext(FILE, 'Billing').map((j) => j.key)).toEqual(['shop', 'billing']);
        expect(journeysOfContext(FILE, 'Sales').map((j) => j.key)).toEqual(['shop']);
        const overview = overviewOf(FILE, 'billing');
        const items = [overview.current!, ...overview.others].filter((j) => j.summary.key === 'es:Returns');
        const html = renderToStaticMarkup(<JourneyDetail items={items} current="billing" onOpen={() => {}} empty />);
        expect(text(html)).toContain('返品を速く');
        expect(text(html)).toContain('例外');
        expect(text(html)).toContain('ビッグピクチャー');
        expect(renderToStaticMarkup(<JourneyDetail items={[]} onOpen={() => {}} empty />)).toContain('まだ旅がありません');
        expect(renderToStaticMarkup(<JourneyDetail items={[]} onOpen={() => {}} />)).toBe('');
        const billing = renderToStaticMarkup(<JourneyDetail items={[overview.current!]} current="billing" onOpen={() => {}} />);
        expect(billing).toContain('class="journey-detail-row current"');
        expect(text(billing)).toContain('Billing の深掘り · 1つの BC を深掘り');
    });
});

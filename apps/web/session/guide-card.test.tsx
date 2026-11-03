// The guide's card (guide-card.tsx, guide-view.ts): the map and what is known at once as soon as it starts, the AI
// thinking, then its advice with its actions; the ES map and the modeling map with its BC rows (from the engine fed a
// goal directly), the ✓ marks (the facilitator's, the latest card's), the picker of several journeys, the note on an
// older card; and what the actions do: open a view, send the question to the AI.
import { beforeAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyze } from '@domaintrail/analysis';
import { guideMarks, guideSnapshot, NO_MARKS, type GuideGoal, type GuideWorkspace } from '@domaintrail/collaboration';
import { MESSAGES } from '../i18n';
import { exampleSources } from '../test-helpers';
import { ChatProvider, type ChatContextValue } from './chat-context';
import { GuideCard } from './guide-card';
import { askBody, guideAnswers, latestGuide, viewTargetOfShown, withMarks, type GuideMapJson, type GuideSnapshotJson } from './guide-view';
import { TargetNamingProvider } from './naming';
import type { NamingContext } from './targets';

const t = MESSAGES.ja;
const at = (m: number): string => `2026-11-03T09:0${m}:00.000Z`;

let naming: NamingContext;
let workspace: GuideWorkspace;
beforeAll(async () => {
    const a = await analyze(await exampleSources());
    naming = { mode: 'label', model: a.model ?? null, stormings: a.stormings.stormings.map((s) => ({ id: s.id, storming: s })) };
    workspace = { model: a.model ?? null, stormings: a.stormings.stormings, diagnostics: a.diagnostics };
});

const MODEL_VIEW = { view: { kind: 'ContextMap', all: false } } as never;
const STORMING_VIEW = { view: { kind: 'Storming', storming: 'Returns', level: 'BigPicture', exceptions: true } } as never;

/** The snapshot the server keeps, as the page reads it (its JSON). */
const snapshot = (goal: GuideGoal, viewedAt: never, marks = NO_MARKS): GuideSnapshotJson =>
    JSON.parse(JSON.stringify(guideSnapshot({ workspace, goal, marks, viewedAt }))) as GuideSnapshotJson;

const guide = (more: object = {}): never => ({ id: 'g1', kind: 'Guide', state: 'Working', startedBy: 'bob', opening: 'o', startedAt: at(1), ...more }) as never;

function chat(me: 'f' | 'bob', slashCommands: unknown[], marks: unknown[] = []): ChatContextValue {
    return {
        tx: t.session,
        session: {
            status: 'live',
            me: { participant: { id: me, role: me === 'f' ? 'facilitator' : 'participant' } },
            state: { session: { state: 'Open', mode: 'Collab' }, slashCommands, requests: [], runs: [], marks, revisions: [] },
        },
        onNavigate: () => {},
        openView: () => {},
        nameOf: (id: string) => id,
        putCommand: () => {},
        marking: { set: () => {} },
    } as unknown as ChatContextValue;
}

const render = (command: never, value: ChatContextValue): string =>
    renderToStaticMarkup(
        <TargetNamingProvider value={naming}>
            <ChatProvider value={value}>
                <GuideCard command={command} continues={false} />
            </ChatProvider>
        </TargetNamingProvider>,
    );

/** The steps' labels with their states, as the map shows them. */
const steps = (html: string): string[] =>
    [...html.matchAll(/<li class="guide-step ([^"]*)"[^>]*>.*?<span class="guide-step-label">([^<]*)<\/span>/g)].map((m) => `${m[2]}:${m[1]}`);

describe("the guide's card", () => {
    test('as it starts: the compass and ガイド, the map (no goal: set it), what is known at once with where to go, the AI thinking', () => {
        const command = guide({ guide: snapshot({}, STORMING_VIEW) });
        const html = render(command, chat('bob', [command]));
        expect(html).toContain('class="chat-guide-mark" role="img" aria-label="ガイド"');
        expect(html).toContain('lucide-compass');
        expect(steps(html)).toEqual(['ゴールを決める:here', '…:todo after']);
        expect(html).toContain('ゴール: 未定');
        // the start of the storming's goal, into the composer
        expect(html).toMatch(/<button[^>]*class="chat-small primary guide-command"[^>]*>.*?\/es:start<\/button>/);
        // what the files show: Returns has two open questions, its flow no exception
        expect(html).toContain('すぐ分かること');
        expect(html).toContain('未解決の問い 2');
        expect(html).toContain('「返品」の流れに例外がない');
        expect(html).toContain('aria-label="未解決の問い 2: 見る"');
        expect(html).toContain('ガイドが考えています…');
        // its starter stops it
        expect(html).toContain('>中止</button>');
        expect(render(command, chat('bob', [guide({ id: 'g0', startedAt: at(0) }), command]))).not.toContain('これより新しいガイドがあります');
    });

    test('the ES map with its goal: the steps to Big Picture, Design Level past it, here where the storming is', () => {
        const command = guide({ guide: snapshot({ es: { Returns: { level: 'BigPicture' } } }, STORMING_VIEW) });
        const html = render(command, chat('f', [command]));
        expect(steps(html)).toEqual(['ブリーフ:done', '出来事:done', '流れ・段階:done', '例外:here', '問い:todo goal', 'デザインレベル:todo after']);
        expect(html).toContain('ゴール: ビッグピクチャー');
        expect(html).toContain('aria-current="step"');
    });

    test('the modeling map (B) with its BC rows; the facilitator marks the steps the files cannot tell, the rows too', () => {
        const goal: GuideGoal = { model: [{ id: 'shop', name: 'ショップ', pattern: 'FromStorming' }] };
        const command = guide({ guide: snapshot(goal, MODEL_VIEW, guideMarks([{ journey: 'shop', step: 'review' }])) });
        const marks = [{ participant: 'f', target: { kind: 'GuideStep', journey: 'shop', step: 'review' }, sign: { kind: 'Done' } }];
        const html = render(command, chat('f', [command], marks));
        expect(steps(html)[0]).toBe('ES を見直す:done');
        expect(html).toContain('ゴール: 不変条件（ES から）');
        // a row per context
        expect([...html.matchAll(/<tr class="guide-row-[^"]*"><th scope="row">(\w+)/g)].map((m) => m[1])).toEqual(['Billing', 'Common', 'Sales']);
        expect(html).toContain('aria-label="ES を見直す: 済みを外す"');
        expect(html).toContain('aria-label="Billing: 済みにする"');
        // a participant sees the marks, sets none
        const theirs = render(command, chat('bob', [command], marks));
        expect(theirs).not.toContain('済みにする');
        expect(theirs).toContain('aria-label="人が済みにした"');
    });

    test('several modeling journeys: a picker, the first shown', () => {
        const goal: GuideGoal = {
            model: [
                { id: 'billing', name: 'Billing の深掘り', pattern: 'OneContext', context: 'Billing' },
                { id: 'all', name: '全体の見直し', pattern: 'Review' },
            ],
        };
        const command = guide({ guide: snapshot(goal, MODEL_VIEW) });
        const html = render(command, chat('f', [command]));
        expect(html).toContain('<select class="guide-journeys" aria-label="道のり">');
        expect(html).toContain('<option value="billing" selected="">Billing の深掘り</option>');
        expect(html).toContain('<option value="all">全体の見直し</option>');
        expect(html).toContain('· Billing の深掘り');
    });

    test('its advice: the status, the steps with reasons, the command, the places, 「聞くことをメモ」; an older card says so', () => {
        const next = {
            status: '例外を出すところです',
            steps: [
                { text: '例外を出す', reason: '本流が固まった', command: 'EsExceptions', targets: [{ kind: 'DtesStorming', storming: 'Returns' }] },
                {
                    text: '窓口に聞く',
                    reason: '答えで分かれ方が変わる',
                    targets: [{ kind: 'DtesElement', storming: 'Returns', local: 'Deadline' }],
                    ask: '返品は何日まで？',
                },
            ],
        };
        const command = guide({ state: 'Answered', answer: 'a1', next, guide: snapshot({}, STORMING_VIEW) });
        const html = render(command, chat('bob', [command, guide({ id: 'g2', startedAt: at(5) })]));
        expect(html).toContain('<p class="guide-status">例外を出すところです</p>');
        expect(html.match(/<li class="guide-advice-step">/g)).toHaveLength(2);
        expect(html).toMatch(/class="chat-small primary guide-command"[^>]*>.*?\/es:exceptions<\/button>/);
        expect(html).toContain('aria-label="返品 を見る"');
        expect(html).toContain('aria-label="聞くことをメモ: 返品は何日まで？"');
        expect(html).toContain('「返品は何日まで？」');
        expect(html).not.toContain('ガイドが考えています');
        // a newer guide is below
        expect(html).toContain('これより新しいガイドがあります');
        // stopped
        expect(render(guide({ state: 'Stopped' }), chat('bob', []))).toContain('中止しました');
    });
});

describe('what the card reads and does', () => {
    test('the latest guide, and the answers its card shows', () => {
        const state = { slashCommands: [guide({ id: 'a', startedAt: at(1), state: 'Answered', answer: 'm1' }), guide({ id: 'b', startedAt: at(2) })] };
        expect((latestGuide(state as never) as { id: string }).id).toBe('b');
        expect([...guideAnswers(state as never)]).toEqual(['m1']);
    });

    test("the marks as they are now over the latest card's map: set, cleared, here placed again", () => {
        const map = {
            world: 'Model',
            journey: 'j',
            steps: [
                { key: 'terms', state: 'Done', goal: false, after: false, markable: false, marked: false },
                { key: 'subdomains', state: 'Done', goal: false, after: false, markable: true, marked: true },
                { key: 'bcSplit', state: 'Here', goal: false, after: false, markable: true, marked: false },
                { key: 'contextMap', state: 'Todo', goal: true, after: false, markable: true, marked: false },
            ],
            contexts: [{ context: 'Sales', shared: false, aggregates: 1, commands: 0, invariants: 0, state: 'Todo', marked: false }],
            contextsAt: 'contexts',
        } as GuideMapJson;
        const now = withMarks(map, [
            { journey: 'j', step: 'bcSplit' },
            { journey: 'j', step: 'contexts', context: 'Sales' },
            { journey: 'other', step: 'contextMap' },
        ]);
        // subdomains no longer marked: to do again, and here; bcSplit marked now; another journey's mark counts not
        expect(now.steps.map((s) => `${s.key}:${s.state}`)).toEqual(['terms:Done', 'subdomains:Here', 'bcSplit:Done', 'contextMap:Todo']);
        expect(now.contexts[0]).toMatchObject({ state: 'Done', marked: true });
        expect(withMarks({ ...map, journey: undefined } as GuideMapJson, [])).toEqual({ ...map, journey: undefined } as GuideMapJson);
    });

    test("a finding's view as the page opens it", () => {
        expect(viewTargetOfShown({ kind: 'Storming', storming: 'S', level: 'BigPicture', stage: 'Prep', exceptions: true })).toEqual({
            kind: 'storming',
            stormingId: 'S',
            level: 'big-picture',
            timelineId: '@Prep',
        });
        expect(viewTargetOfShown({ kind: 'Structure', level: 'Detail', focus: ['Sales'] })).toEqual({
            kind: 'structure',
            level: 'detail',
            focus: { contexts: ['Sales'], hidden: [] },
        });
        expect(viewTargetOfShown({ kind: 'ContextMap', all: true })).toEqual({ kind: 'contextMap', all: true });
    });

    test("「聞くことをメモ」: a message to the AI, at the step's first place, asking for the question", () => {
        const texts = t.session.chat.guide;
        expect(
            askBody({
                ask: '何日？',
                at: { target: { kind: 'DtesStorming', storming: 'Returns' } as never, name: '返品' },
                revision: 'r1',
                texts,
                aiName: 'AI',
            }),
        ).toEqual({
            targets: [{ target: { kind: 'DtesStorming', storming: 'Returns' }, label: '返品', sourceRevision: 'r1' }],
            body: '@AI[p1] #返品[1] に問いを足して: 何日？',
            mentions: ['ai'],
        } as never);
        expect(askBody({ ask: 'How long?', revision: 'r1', texts: MESSAGES.en.session.chat.guide, aiName: 'AI' }).body).toBe(
            '@AI[p1] Add as a question: How long?',
        );
    });
});

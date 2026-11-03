// The guide's card (guide-card.tsx, guide-view.ts): the map and what is known at once as soon as it starts, the AI
// thinking, then its advice with its actions; the ES map and the modeling map with its BC rows (from the engine fed a
// journey file), the ✓ marks (the journey file's, on the latest card: anyone's, a participant's a request), the session's
// current journey (its name opens the journeys panel, its 🏁 changes the goal), the note on an older card; and what the
// actions do: open a view, send the question to the AI.
import { beforeAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyze } from '@domaintrail/analysis';
import { goalOf, guideMarks, guideSnapshot, journeyMarks, NO_MARKS, type GuideGoal, type GuideWorkspace, type JourneyFile } from '@domaintrail/collaboration';
import { journeyOverview } from './journey-view';
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
const snapshot = (goal: GuideGoal, viewedAt: never, marks = NO_MARKS, file?: JourneyFile): GuideSnapshotJson =>
    JSON.parse(JSON.stringify(guideSnapshot({ workspace: { ...workspace, ...(file && { journey: file }) }, goal, marks, viewedAt }))) as GuideSnapshotJson;

const guide = (more: object = {}): never => ({ id: 'g1', kind: 'Guide', state: 'Working', startedBy: 'bob', opening: 'o', startedAt: at(1), ...more }) as never;

/** A journey file of one ES journey and one modeling journey (B on the shop), its marks as given. */
const FILE = (marks: readonly string[] = [], current: 'es' | 'model' = 'es'): JourneyFile => ({
    version: 1,
    stormings: { Returns: { purpose: '返品を速く', participants: ['窓口担当'], use: 'modeling', level: 'BigPicture', state: 'active', marks: [] } },
    modeling:
        current === 'model'
            ? [
                  {
                      id: 'shop',
                      name: 'ショップ',
                      purpose: '注文から請求まで',
                      participants: [],
                      pattern: 'FromStorming',
                      from: { stormings: ['Returns'] },
                      goal: 'invariants',
                      state: 'active',
                      marks: { steps: marks, contexts: {} },
                  },
              ]
            : [],
});

/** The journeys as the chat holds them: the file, its overview now (the current journey: `current`), the acts recorded. */
function journeys(file: JourneyFile | null, current?: string, acts: unknown[] = []): ChatContextValue['journeys'] {
    const ws = { ...workspace, ...(file && { journey: file }) };
    return {
        body: { file, problems: [], requests: [] },
        workspace: ws,
        overview: journeyOverview(ws, current),
        open: false,
        setOpen: (open: boolean) => acts.push({ open }),
        act: (a) => acts.push(a),
        choose: (j) => acts.push({ choose: j }),
        decide: () => {},
        seeGuide: () => {},
        notice: undefined,
    };
}

function chat(me: 'f' | 'bob', slashCommands: unknown[], file: JourneyFile | null = null, current?: string): ChatContextValue {
    return {
        journeys: journeys(file, current),
        tx: t.session,
        session: {
            status: 'live',
            me: { participant: { id: me, role: me === 'f' ? 'facilitator' : 'participant' } },
            state: { session: { state: 'Open', mode: 'Collab' }, slashCommands, requests: [], runs: [], marks: [], revisions: [] },
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
        const file = FILE();
        const command = guide({ guide: snapshot(goalOf(file), STORMING_VIEW, NO_MARKS, file) });
        const html = render(command, chat('f', [command], file));
        expect(steps(html)).toEqual(['ブリーフ:done', '出来事:done', '流れ・段階:done', '例外:here', '問い:todo goal', 'デザインレベル:todo after']);
        expect(html).toContain('ゴール: ビッグピクチャー');
        expect(html).toContain('aria-current="step"');
        // the heading: the 🏁 changes the goal, the journey's name opens the journeys panel
        expect(html).toContain('class="guide-goal-button" aria-expanded="false" data-tooltip="ゴールを変える"');
        expect(html).toMatch(/class="guide-journey-button" data-tooltip="旅程を開く">.*?返品<\/button>/);
        // the exceptions and the questions: marked by a person when the files cannot tell
        expect(html).toContain('aria-label="例外: 済みにする"');
    });

    test("the modeling map (B) with its BC rows; the marks are the journey file's, set by anyone (a participant's: a request)", () => {
        const file = FILE(['review'], 'model');
        const command = guide({ guide: snapshot(goalOf(file), MODEL_VIEW, guideMarks(journeyMarks(file)), file) });
        const html = render(command, chat('f', [command], file, 'shop'));
        expect(steps(html)[0]).toBe('ES を見直す:done');
        expect(html).toContain('ゴール: 不変条件（ES から）');
        // a row per context
        expect([...html.matchAll(/<tr class="guide-row-[^"]*"><th scope="row">(\w+)/g)].map((m) => m[1])).toEqual(['Billing', 'Common', 'Sales']);
        expect(html).toContain('aria-label="ES を見直す: 済みを外す"');
        expect(html).toContain('aria-label="Billing: 済みにする"');
        // the session's old ✓ marks count not: the file has none, the step is to do
        const unmarked = FILE([], 'model');
        expect(render(command, chat('f', [command], unmarked, 'shop'))).toContain('aria-label="ES を見直す: 済みにする"');
        // a participant marks too (the facilitator is asked)
        expect(render(command, chat('bob', [command], file, 'shop'))).toContain('aria-label="Billing: 済みにする"');
        // a card in history: the map as kept, no marking
        const older = render(command, chat('bob', [command, guide({ id: 'g2', startedAt: at(5) })], file, 'shop'));
        expect(older).not.toContain('済みにする');
        expect(older).toContain('aria-label="人が済みにした"');
    });

    test("the session's current journey: the card draws it (no picker); one changed later shows on the latest card", () => {
        const file = FILE(['review'], 'model');
        const command = guide({ guide: snapshot(goalOf(file), MODEL_VIEW, guideMarks(journeyMarks(file)), file) });
        const shop = render(command, chat('f', [command], file, 'shop'));
        expect(shop).not.toContain('<select');
        expect(shop).toContain('ショップ');
        // made current in the panel: the latest card draws the storming's journey
        const es = render(command, chat('f', [command], file, 'es:Returns'));
        expect(steps(es)[0]).toBe('ブリーフ:done');
        expect(es).toContain('ゴール: ビッグピクチャー');
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
        // subdomains no longer marked: before bcSplit, marked now, it is unconfirmed; here moves after the last done step;
        // another journey's mark counts not
        expect(now.steps.map((s) => `${s.key}:${s.state}`)).toEqual(['terms:Done', 'subdomains:Unconfirmed', 'bcSplit:Done', 'contextMap:Here']);
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

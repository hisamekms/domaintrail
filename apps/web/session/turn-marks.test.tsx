// What a turn changed, marked on the storming canvas (session/turn-marks.tsx): which run is the latest turn, and the bar.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { I18nProvider } from '../i18n';
import type { StormingChoice } from '../storming';
import { actKinds, viewPayloads } from '../test-helpers';
import { NO_MARKS, type ChangeMarks } from '../view/change-marks';
import { latestEnded, TurnMarksBar, type TurnMarks } from './turn-marks';

type RunJson = SessionStateBody['runs'][number];

const at = (minute: number): string => `2026-11-06T09:${String(minute).padStart(2, '0')}:00.000Z`;
const run = (id: string, state: string, base: string, result: string, finished: number): RunJson =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fields the marks read
    ({ id, state, baseRevision: base, resultRevision: result, finishedAt: at(finished) }) as unknown as RunJson;

describe('the latest turn', () => {
    const runs = [run('r1', 'Completed', 'a', 'b', 1), run('r2', 'Completed', 'b', 'b', 3), run('r3', 'NeedsClarification', 'b', 'c', 2)];

    test('of the runs that ended having changed the sources since the page knew them, the one that ended last', () => {
        expect(latestEnded(runs, new Set())).toEqual({ id: 'r3', base: 'b', result: 'c' });
        expect(latestEnded(runs, new Set(['r3']))).toEqual({ id: 'r1', base: 'a', result: 'b' });
    });

    test('none when no such run ended since: one that changed nothing, failed or still runs is not a turn that changed', () => {
        expect(latestEnded(runs, new Set(['r1', 'r3']))).toBeUndefined();
        expect(latestEnded([run('r4', 'Failed', 'a', 'b', 4), run('r5', 'Running', 'a', 'a', 5)], new Set())).toBeUndefined();
    });
});

describe('the bar over the storming canvas', () => {
    const marks: ChangeMarks = { ...NO_MARKS, added: ['es/Returns/A', 'es/Returns/B'], changed: ['es/Returns/C'], removed: ['es/Returns/D'] };
    const turn = (name?: string): TurnMarks => ({
        shown: { marks: { key: '1', reveal: 'ifNoneVisible', marks }, name },
        see: () => {},
        clear: () => {},
        elsewhere: () => {},
    });
    const choice: StormingChoice = { stormingId: 'Returns', level: 'big-picture', timelines: {} };
    const bar = (t: TurnMarks): string =>
        renderToStaticMarkup(
            <I18nProvider lang="ja">
                <TurnMarksBar canvas={null} marks={t} stormings={[]} choice={choice} />
            </I18nProvider>,
        );

    test('names the latest turn and counts what it did, in the marks’ words; 印を消す is reached by the keyboard', () => {
        const html = bar(turn());
        expect(html).toContain('role="group" aria-label="作業で変わった付箋の印"');
        expect(html).toContain('直前の作業：');
        expect(html).toContain('<b class="turn-marks-added">新 2</b><b class="turn-marks-changed">変 1</b><b class="turn-marks-removed">削除 1</b>');
        expect(actKinds(html)).toEqual(['open']);
        expect(html).toContain('<button type="button" class="act act-open">印を消す</button>');
    });

    test('names a card’s changes shown from its 図で見る, and leaves out a kind with none', () => {
        const html = renderToStaticMarkup(
            <I18nProvider lang="ja">
                <TurnMarksBar
                    canvas={null}
                    marks={{
                        ...turn('不在のケース'),
                        shown: { marks: { key: '2', reveal: 'always', marks: { ...marks, changed: [], removed: [] } }, name: '不在のケース' },
                    }}
                    stormings={[]}
                    choice={choice}
                />
            </I18nProvider>,
        );
        expect(html).toContain('作業「不在のケース」：');
        expect(html).not.toContain('turn-marks-changed');
    });

    test('ほかに n 件の変更 → for the stickies this view does not draw (a command, at Big Picture)', async () => {
        const [payload] = await viewPayloads([
            { path: 'returns.dtes', text: 'storming Returns {\n  event A\n  event B\n  command C {\n    emits A\n  }\n}\n' },
        ]);
        const html = renderToStaticMarkup(
            <I18nProvider lang="ja">
                <TurnMarksBar canvas={null} marks={turn()} stormings={payload!.stormings} choice={choice} />
            </I18nProvider>,
        );
        expect(actKinds(html)).toEqual(['see', 'open']);
        expect(html).toContain('ほかに 1 件の変更 →');
    });

    test('nothing while nothing is marked', () => {
        expect(bar({ ...turn(), shown: undefined })).toBe('');
    });
});

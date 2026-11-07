// The storming navigator (storming-navigator.tsx): the stormings › stages › timelines, a filter, and the view it shows
// in step with the view bar's place and flow (a row chooses through `chooseScope`; the row shown is read back from them).
import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createViewService, ElkLayoutEngine } from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { groupCount } from './explorer';
import { I18nProvider } from './i18n';
import { chooseFlow, choosePlace, chooseScope, shownScope, shownStorming, stageChoice, type StormingChoice } from './storming';
import { navigatorRows, StormingNavigator, stormingNavigatorTree, type NavigatorNode } from './storming-navigator';

const engine = new ElkLayoutEngine();
afterAll(() => engine.dispose());

const fixture = (...parts: string[]): Promise<string> => readFile(path.join(import.meta.dir, '..', '..', 'test', 'fixtures', ...parts), 'utf8');

/** The stormings of a workspace holding the stages' fixture and a storming without stages. */
const stormings: StormingView[] = (
    await createViewService({
        root: '/workspace',
        engine,
        workspace: {
            readSources: async () => [
                { path: 'stages.dtes', text: await fixture('stages', 'convenience-store-stages.dtes') },
                { path: 'delivery.dtes', text: await fixture('dtes', 'delivery-cancellation.dtes') },
            ],
        },
        layoutStore: { load: async () => new Map(), save: async () => {} },
        git: {
            resolveCommit: (ref) => Promise.reject(new Error(`no git: ${ref}`)),
            sourcesAt: async () => [],
            listRefs: async () => ({ branches: [], tags: [], commits: [] }),
            gitDirs: async () => undefined,
        },
    }).refresh()
).stormings;

/** A tree as lines: its depth as indentation, an exception marked with `!`. */
const outline = (nodes: readonly NavigatorNode[], depth = 0): string[] =>
    nodes.flatMap((n) => [`${'  '.repeat(depth)}${n.kind}:${n.exception ? '!' : ''}${n.id}`, ...outline(n.children, depth + 1)]);

const STAGED = 'ConvenienceStoreIssuance';

/** localStorage of a browser, in memory. */
function storage(saved: Record<string, string> = {}): void {
    const items = new Map(Object.entries(saved));
    Object.assign(globalThis, {
        localStorage: { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) },
    });
}
const choice: StormingChoice = { stormingId: undefined, level: 'big-picture', timelines: {} };

describe('the tree of the storming navigator', () => {
    test('a storming with stages: its stages in order, each with its main flow then its exceptions, marked', () => {
        const staged = stormingNavigatorTree(stormings, 'label').find((n) => n.id === STAGED);
        if (!staged) throw new Error('no staged storming');
        expect(staged.children.map((n) => `${n.kind}:${n.id}`)).toEqual(['stage:Preparation', 'stage:Issuance', 'stage:Submission']);
        const issuance = outline(staged.children[1]?.children ?? []);
        expect(issuance[0]).toBe('timeline:IssuanceFlow');
        expect(issuance.slice(1).every((l) => l.startsWith('timeline:!'))).toBe(true);
        expect(issuance).toContain('timeline:!PinForgottenBranch');
        expect(staged.children[1]).toMatchObject({ scope: stageChoice('Issuance'), name: 'コンビニでの発行' });
    });

    test('a storming without stages: its timelines right under it', () => {
        const plain = stormingNavigatorTree(stormings, 'label').find((n) => n.id !== STAGED);
        if (!plain) throw new Error('no storming without stages');
        expect(plain.children.length).toBeGreaterThan(0);
        expect(plain.children.every((n) => n.kind === 'timeline' && n.children.length === 0)).toBe(true);
        expect(plain.children.map((n) => n.scope)).toEqual(plain.children.map((n) => n.id));
    });

    test('names follow the name display; the scope a row opens: the integrated canvas, a stage, a timeline', () => {
        const [byLabel] = stormingNavigatorTree(stormings, 'label');
        const [byName] = stormingNavigatorTree(stormings, 'name');
        expect(byLabel).toMatchObject({ kind: 'storming', scope: '', name: '住民票などのコンビニ交付（ビッグピクチャ）' });
        expect(byName).toMatchObject({ name: STAGED });
    });

    test('the filter keeps the matching rows with their ancestors; a matching stage keeps its timelines', () => {
        expect(outline(stormingNavigatorTree(stormings, 'label', '暗証番号を忘れた'))).toEqual([
            `storming:${STAGED}`,
            '  stage:Issuance',
            '    timeline:!PinForgottenBranch',
        ]);
        const stage = stormingNavigatorTree(stormings, 'label', '提出');
        expect(outline(stage)).toEqual([`storming:${STAGED}`, '  stage:Submission', '    timeline:SubmissionFlow', '    timeline:!CertificateRejectedBranch']);
        expect(navigatorRows(stage)).toBe(4);
        expect(stormingNavigatorTree(stormings, 'label', 'nothing like this')).toEqual([]);
        // by ID too, whatever the case
        expect(outline(stormingNavigatorTree(stormings, 'label', 'pinlocked')).at(-1)).toBe('    timeline:!PinLockedBranch');
    });
});

describe('the navigator, the breadcrumb and the flow show the same view', () => {
    test('a storming’s or a stage’s row opens the place with every flow; an exception’s, its case at its stage; a main flow’s, it alone', () => {
        const stage = chooseScope(stormings, choice, STAGED, stageChoice('Issuance'));
        expect(stage).toEqual({ ...choice, stormingId: STAGED, timelines: { [STAGED]: '@Issuance' }, flow: 'all' });
        expect(shownStorming(stormings, stage)?.options).toEqual({ level: 'big-picture', stageId: 'Issuance' });
        expect(shownScope(stormings, stage)).toEqual({ stormingId: STAGED, scope: '@Issuance' });
        // an exception: the place is its stage, the flow its case (the row selected, its stage marked faintly)
        const exception = chooseScope(stormings, choice, STAGED, 'PinLockedBranch');
        expect(shownStorming(stormings, exception)).toMatchObject({ stageId: 'Issuance', flow: { exception: 'PinLockedBranch' } });
        expect(shownStorming(stormings, exception)?.options).toEqual({ level: 'big-picture', stageId: 'Issuance' });
        expect(shownScope(stormings, exception)).toEqual({ stormingId: STAGED, scope: 'PinLockedBranch', place: '@Issuance' });
        // a main flow: drawn alone, in its stage
        const main = chooseScope(stormings, exception, STAGED, 'IssuanceFlow');
        expect(shownStorming(stormings, main)).toMatchObject({
            stageId: 'Issuance',
            flow: { main: 'IssuanceFlow' },
            options: { level: 'big-picture', timelineId: 'IssuanceFlow' },
        });
        expect(shownScope(stormings, main)).toEqual({ stormingId: STAGED, scope: 'IssuanceFlow', place: '@Issuance' });
        // the storming's own row: back to the whole storming with every flow, the others' places kept
        const other = stormings.find((s) => s.id !== STAGED)?.id ?? '';
        const both = chooseScope(stormings, chooseScope(stormings, main, other, ''), STAGED, '');
        expect(both.timelines).toEqual({});
        expect(both.flow).toBe('all');
        expect(chooseScope(stormings, { ...choice, timelines: { [other]: 'X' } }, STAGED, '').timelines).toEqual({ [other]: 'X' });
        expect(shownScope(stormings, both)).toEqual({ stormingId: STAGED, scope: '' });
    });

    test('one row selected, as the view bar shows it; the place of an exception or a main flow marked faintly', () => {
        const render = (c: StormingChoice): string =>
            renderToStaticMarkup(
                <I18nProvider lang="ja">
                    <StormingNavigator stormings={stormings} choice={c} mode="label" onChoose={() => {}} onSelect={() => {}} onClose={() => {}} />
                </I18nProvider>,
            );
        const current = (html: string): string[] =>
            [...html.matchAll(/class="tree-item storming-nav-(\w+) selected"[^>]*aria-current="true"[^>]*title="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
        const within = (html: string): string[] =>
            [...html.matchAll(/class="tree-item storming-nav-(\w+) within"[^>]*title="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
        const stage = chooseScope(stormings, choice, STAGED, stageChoice('Issuance'));
        expect(current(render(stage))).toEqual(['stage:Issuance']);
        expect(within(render(stage))).toEqual([]);
        const exception = chooseScope(stormings, choice, STAGED, 'PinForgottenBranch');
        expect(current(render(exception))).toEqual(['timeline:PinForgottenBranch']);
        expect(within(render(exception))).toEqual(['stage:Issuance']);
        // the breadcrumb and the flow switch move the same row: every flow at the stage is the stage's row again
        expect(current(render(chooseFlow(stormings, exception, 'all')))).toEqual(['stage:Issuance']);
        expect(current(render(chooseFlow(stormings, stage, 'main')))).toEqual(['stage:Issuance']);
        // an exception chosen on the whole storming: its row, the storming's marked
        const whole = chooseFlow(stormings, chooseScope(stormings, choice, STAGED, ''), { exception: 'PinForgottenBranch' });
        expect(current(render(whole))).toEqual(['timeline:PinForgottenBranch']);
        expect(within(render(whole))).toEqual([`storming:${STAGED}`]);
        // nothing chosen yet: the first storming's whole
        expect(current(render(choice))).toEqual([`storming:${STAGED}`]);
        const html = render(choice);
        expect(html).toContain('aria-label="例外"');
        expect(html).toContain('placeholder="フィルタ"');
        // everything open: nothing counts its rows
        expect(html).not.toContain('tree-count');
    });

    test('another place keeps the exception chosen when it has it, else every flow; one main flow chosen is the main flows', () => {
        const exception = chooseScope(stormings, choice, STAGED, 'PinLockedBranch');
        // the whole storming has it: still its case
        expect(shownStorming(stormings, choosePlace(stormings, exception, ''))).toMatchObject({ stageId: undefined, flow: { exception: 'PinLockedBranch' } });
        // another stage has not: every flow
        expect(shownStorming(stormings, choosePlace(stormings, exception, stageChoice('Submission')))).toMatchObject({ stageId: 'Submission', flow: 'all' });
        const main = chooseScope(stormings, choice, STAGED, 'IssuanceFlow');
        expect(shownStorming(stormings, choosePlace(stormings, main, stageChoice('Submission')))).toMatchObject({ stageId: 'Submission', flow: 'main' });
    });

    test('a stage counts its timelines only while collapsed, after its name, as the model tree’s groups do', () => {
        storage({ 'domaintrail.stormingNavigator.collapsed': JSON.stringify([`${STAGED}@Issuance`]) });
        try {
            const html = renderToStaticMarkup(
                <I18nProvider lang="ja">
                    <StormingNavigator stormings={stormings} choice={choice} mode="label" onChoose={() => {}} onSelect={() => {}} onClose={() => {}} />
                </I18nProvider>,
            );
            // the same element as the model tree's collapsed group count, and only on the collapsed stage
            expect(html).toContain(`コンビニでの発行<span class="muted tree-count"> ${groupCount(9)}</span>`);
            expect(html.match(/tree-count/g)?.length).toBe(1);
        } finally {
            Reflect.deleteProperty(globalThis, 'localStorage');
        }
    });

    test('without stormings it says how to start one', () => {
        const html = renderToStaticMarkup(
            <I18nProvider lang="ja">
                <StormingNavigator stormings={[]} choice={choice} mode="label" onChoose={() => {}} onSelect={() => {}} onClose={() => {}} />
            </I18nProvider>,
        );
        expect(html).toContain('ストーミングがありません');
    });
});

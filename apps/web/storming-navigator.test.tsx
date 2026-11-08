// The storming navigator (storming-navigator.tsx): the stormings › stages › timelines, a filter, and the rows of what
// the canvas shows (ADR 0032 §11), in step with the view bar.
import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createViewService, ElkLayoutEngine } from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { groupCount } from './explorer';
import { I18nProvider } from './i18n';
import { chooseTimeline, focusOn, scopeView, stageChoice, type StormingChoice, type StormingFocus } from './storming';
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

describe('the navigator shows what the canvas shows', () => {
    const render = (c: StormingChoice, focus: StormingFocus | null = null): string =>
        renderToStaticMarkup(
            <I18nProvider lang="ja">
                <StormingNavigator stormings={stormings} choice={c} focus={focus} mode="label" onScope={() => {}} onSelect={() => {}} onClose={() => {}} />
            </I18nProvider>,
        );
    const current = (html: string): string[] =>
        [...html.matchAll(/class="tree-item storming-nav-(\w+) selected"[^>]*aria-current="true"[^>]*title="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);

    test('a storming’s row while all its timelines are shown (its one main flow too); an exception’s while emphasized', () => {
        expect(current(render(choice))).toEqual([`storming:${STAGED}`]);
        // the trunk through every stage is its only main flow: the canvas carries all of it
        expect(current(render(chooseTimeline(choice, STAGED, 'PreparationFlow')))).toEqual([`storming:${STAGED}`]);
        const { choice: c, focus } = focusOn(stormings, choice, STAGED, 'PinLockedBranch');
        expect(current(render(c, focus))).toEqual(['timeline:PinLockedBranch']);
        const html = render(choice);
        expect(html).toContain('aria-label="例外"');
        expect(html).toContain('placeholder="フィルタ"');
        // everything open: nothing counts its rows
        expect(html).not.toContain('tree-count');
    });

    test('a row shows its scope (`scopeView`): a stage’s frame on the same canvas, a main flow, an exception emphasized', () => {
        expect(scopeView(stormings, choice, null, STAGED, stageChoice('Issuance')).frame).toEqual({ stage: 'Issuance' });
        expect(scopeView(stormings, choice, null, STAGED, 'IssuanceFlow').choice.timelines).toEqual({});
        expect(scopeView(stormings, choice, null, STAGED, 'PinForgottenBranch').focus).toEqual({ stormingId: STAGED, exceptionId: 'PinForgottenBranch' });
    });

    test('a stage counts its timelines only while collapsed, after its name, as the model tree’s groups do', () => {
        storage({ 'domaintrail.stormingNavigator.collapsed': JSON.stringify([`${STAGED}@Issuance`]) });
        try {
            const html = renderToStaticMarkup(
                <I18nProvider lang="ja">
                    <StormingNavigator
                        stormings={stormings}
                        choice={choice}
                        mode="label"
                        focus={null}
                        onScope={() => {}}
                        onSelect={() => {}}
                        onClose={() => {}}
                    />
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
                <StormingNavigator stormings={[]} choice={choice} mode="label" focus={null} onScope={() => {}} onSelect={() => {}} onClose={() => {}} />
            </I18nProvider>,
        );
        expect(html).toContain('ストーミングがありません');
    });
});

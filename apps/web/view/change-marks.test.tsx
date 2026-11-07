// The marks of a turn's changes on the storming canvas (view/change-marks.ts): which stickies, drawn how, and where the
// camera goes when they appear.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ElementChange } from '@domaintrail/collaboration/protocol';
import { stormingViewKey } from '@domaintrail/visualization';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import { NodeContent } from '../diagram-items';
import { I18nProvider, MESSAGES } from '../i18n';
import type { Rect } from '../scene';
import { stormingGraph, type StormingChoice } from '../storming';
import { viewPayloads } from '../test-helpers';
import {
    ghostGraph,
    markedRects,
    marksAppearMove,
    marksMove,
    marksView,
    notDrawn,
    NO_MARKS,
    outOfView,
    sceneWithMarks,
    stormingChangeMarks,
    type ChangeMarks,
} from './change-marks';

const es = (change: ElementChange['change'], local: string, kind: string, label?: string, was?: { name: string; label?: string }): ElementChange =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a storming element kind written as text
    ({
        language: 'Dtes',
        storming: 'Returns',
        local,
        kind,
        change,
        name: local,
        ...(label !== undefined && { label }),
        ...(was && { was }),
        owner: { name: 'Returns' },
    }) as ElementChange;

describe('the marks of a span', () => {
    test('its stickies only: not a `.dt` element, nor a timeline or a group', () => {
        const marks = stormingChangeMarks(
            [
                { language: 'Dt', element: 'Sales.Order', kind: 'aggregate', change: 'changed', name: 'Order' },
                es('added', 'Accepted', 'event', '受け付けた'),
                es('changed', 'Flow', 'timeline'),
                es('changed', 'Closing', 'group'),
                es('changed', 'Inspected', 'event', '検品を終えた', { name: 'Inspected', label: '商品を検品した' }),
                es('removed', 'Disposed', 'event', '廃棄した'),
            ],
            'label',
        );
        expect(marks).toEqual({
            added: ['es/Returns/Accepted'],
            changed: ['es/Returns/Inspected'],
            removed: ['es/Returns/Disposed'],
            was: { 'es/Returns/Inspected': '商品を検品した' },
        });
    });

    test('the text before only where it reads differently in the display mode', () => {
        const relabelled = [es('changed', 'Inspected', 'event', '検品を終えた', { name: 'Inspected', label: '商品を検品した' })];
        expect(stormingChangeMarks(relabelled, 'name').was).toEqual({});
        expect(stormingChangeMarks(relabelled, 'both').was).not.toEqual({});
        // changed otherwise (a new `on`): no text before
        expect(stormingChangeMarks([es('changed', 'Deadline', 'hotspot', '期限は？')], 'label').was).toEqual({});
    });
});

const RETURNS = (body: string): { path: string; text: string }[] => [{ path: 'returns.dtes', text: `storming Returns "返品" {\n${body}}\n` }];
const BEFORE = RETURNS(
    '  event Requested "返品が依頼された"\n  event Inspected "商品を検品した"\n  event Disposed "商品を廃棄した"\n  timeline Flow {\n    Requested\n    Inspected\n    Disposed\n  }\n',
);
const AFTER = RETURNS(
    '  event Requested "返品が依頼された"\n  event Inspected "検品を終えた"\n  event Accepted "返品を受け付けた"\n  timeline Flow {\n    Requested\n    Accepted\n    Inspected\n  }\n',
);
const CHANGES = [
    es('added', 'Accepted', 'event', '返品を受け付けた'),
    es('changed', 'Inspected', 'event', '検品を終えた', { name: 'Inspected', label: '商品を検品した' }),
    es('removed', 'Disposed', 'event', '商品を廃棄した'),
];
const [before, after] = (await viewPayloads(BEFORE, AFTER)) as [ViewPayload, ViewPayload];
const [withCommand] = (await viewPayloads(
    RETURNS('  event Accepted "返品を受け付けた"\n  event Inspected\n  command Inspect "検品する" {\n    emits Inspected\n  }\n'),
)) as [ViewPayload];
const CHOICE: StormingChoice = { stormingId: 'Returns', level: 'big-picture', timelines: {} };
const KEY = stormingViewKey({ level: 'big-picture' });
const graphOf = (p: ViewPayload) => stormingGraph(p.stormings, CHOICE)!.graph;
const BADGES = MESSAGES.ja.turnMarks.badges;

describe('the marks drawn on the storming canvas', () => {
    const marks = stormingChangeMarks(CHANGES, 'label');
    const ghosts = ghostGraph(graphOf(after), marks.removed, 'Returns', KEY, [before.stormings, after.stormings]);
    const scene = sceneWithMarks(graphOf(after), { diff: after.diff, diagnostics: [], mode: 'label', lang: 'ja' }, marks, ghosts, BADGES);
    const node = (id: string) => scene.nodes.find((n) => n.elementId === id);

    test('an added sticky has the green ring and 新, a changed one the amber ring, 変 and its label before', () => {
        expect(node('es/Returns/Accepted')?.props).toMatchObject({ change: 'added', badge: '新' });
        expect(node('es/Returns/Inspected')?.props).toMatchObject({ change: 'changed', badge: '変', was: '商品を検品した' });
        expect(node('es/Returns/Requested')?.props).toMatchObject({ change: 'none', badge: '' });
        expect(node('es/Returns/Requested')?.props.was).toBeUndefined();
    });

    test('a removed sticky is a ghost with 削除 where the page last saw it, moved off the note now there', () => {
        const ghost = scene.ghosts.find((g) => g.elementId === 'es/Returns/Disposed')!;
        const was = graphOf(before);
        const at = was.nodeLayout[was.nodes.find((n) => n.elementId === 'es/Returns/Disposed')!.id]!;
        const now = graphOf(after);
        // the incremental layout put the last step (検品を終えた) where 商品を廃棄した was
        const there = now.nodeLayout[now.nodes.find((n) => n.elementId === 'es/Returns/Inspected')!.id]!;
        expect({ x: there.x, y: there.y }).toEqual({ x: at.x, y: at.y });
        expect(ghost).toMatchObject({ type: 'node', ghost: true, x: at.x, y: there.y + there.height + 24, props: { change: 'removed', badge: '削除' } });
    });

    test('a ghost over no note stays where it was', () => {
        const was = graphOf(before);
        const at = was.nodeLayout[was.nodes.find((n) => n.elementId === 'es/Returns/Disposed')!.id]!;
        const empty = { ...graphOf(after), nodes: [], nodeLayout: {} };
        const g = ghostGraph(empty, marks.removed, 'Returns', KEY, [before.stormings])!;
        expect(Object.values(g.nodeLayout)).toEqual([at]);
    });

    test('a page that never saw the removed sticky draws no ghost', () => {
        expect(ghostGraph(graphOf(after), marks.removed, 'Returns', KEY, [after.stormings])).toBeUndefined();
    });

    test('the marked notes and ghosts by element, for the camera and the bar', () => {
        expect([...markedRects(scene, marks).keys()].sort()).toEqual(['es/Returns/Accepted', 'es/Returns/Disposed', 'es/Returns/Inspected']);
    });

    test('a changed sticky draws its label before small and struck through under it, the whole of it in the tooltip', () => {
        const props = node('es/Returns/Inspected')!.props;
        const html = renderToStaticMarkup(
            <I18nProvider lang="ja">
                <NodeContent p={props} Marks={() => null} />
            </I18nProvider>,
        );
        expect(html).toContain('<div class="dn-was" data-tooltip="変更前: 商品を検品した"><del>商品を検品した</del></div>');
        const plain = renderToStaticMarkup(
            <I18nProvider lang="ja">
                <NodeContent p={node('es/Returns/Accepted')!.props} Marks={() => null} />
            </I18nProvider>,
        );
        expect(plain).not.toContain('dn-was');
    });
});

describe('where the marks are shown', () => {
    const marks: ChangeMarks = { ...NO_MARKS, added: ['es/Returns/Accepted'] };

    test('the view shown when it draws any of them; else the integrated canvas at a level that draws them', () => {
        expect(marksView(after.stormings, CHOICE, marks)).toBeUndefined();
        const timeline: StormingChoice = { ...CHOICE, timelines: { Returns: 'Nowhere' } };
        expect(marksView(after.stormings, timeline, marks)).toBeUndefined();
        // a command is drawn at Design Level only
        expect(marksView(withCommand.stormings, CHOICE, { ...NO_MARKS, added: ['es/Returns/Inspect'] })).toEqual({ ...CHOICE, level: 'design-level' });
    });

    test('the marked stickies the view does not draw', () => {
        expect(
            notDrawn(withCommand.stormings, CHOICE, { ...NO_MARKS, added: ['es/Returns/Inspect', 'es/Returns/Accepted'], removed: ['es/Returns/X'] }),
        ).toEqual({
            added: ['es/Returns/Inspect'],
            changed: [],
            removed: [],
        });
    });
});

describe('the camera when marks appear', () => {
    const view: Rect = { x: 0, y: 0, w: 1000, h: 600 };
    const inView: Rect = { x: 100, y: 100, w: 120, h: 80 };
    const right: Rect = { x: 1400, y: 100, w: 120, h: 80 };

    test("a turn's marks leave the camera where it is unless the reader follows the AI (or asked for them)", () => {
        expect(marksAppearMove('stay', false, [right], view, 1)).toEqual({ kind: 'stay' });
        expect(marksAppearMove('always', false, [right], view, 1)).toEqual({ kind: 'fit', bounds: right, maxZoom: 1 });
        // not while the reader drags or pans
        expect(marksAppearMove('always', true, [right], view, 1)).toEqual({ kind: 'stay' });
    });

    test('marks are brought into view unless all of them are', () => {
        expect(marksMove([inView], view, 1)).toEqual({ kind: 'stay' });
        expect(marksMove([], view, 1)).toEqual({ kind: 'stay' });
        expect(marksMove([right], view, 1)).toEqual({ kind: 'fit', bounds: right, maxZoom: 1 });
        expect(marksMove([inView, right], view, 1)).toEqual({ kind: 'fit', bounds: { x: 100, y: 100, w: 1420, h: 80 }, maxZoom: 1 });
    });

    test('never zoomed in further than the reader was, nor past 100%', () => {
        expect(marksMove([right], { ...view, w: 500, h: 300 }, 2)).toMatchObject({ kind: 'fit', maxZoom: 1 });
        expect(marksMove([{ ...right, x: 2500 }], { x: 0, y: 0, w: 2000, h: 1200 }, 0.5)).toMatchObject({ kind: 'fit', maxZoom: 0.5 });
    });

    test('marks too far apart to read once fitted: centered on the nearest, the zoom kept', () => {
        const far: Rect = { x: 9000, y: 100, w: 120, h: 80 };
        expect(marksMove([far, right], view, 1)).toEqual({ kind: 'center', point: { x: 1460, y: 140 } });
    });

    test('ほかに n 件: the marked elements none of whose notes is in view, and the nearest of them', () => {
        const marked = new Map([
            ['a', [inView]],
            ['b', [right, inView]],
            ['c', [right]],
            ['d', [{ x: 3000, y: 100, w: 120, h: 80 }]],
        ]);
        expect(outOfView(marked, view)).toEqual({ count: 2, next: { x: 1460, y: 140 } });
        expect(outOfView(new Map([['a', [inView]]]), view)).toEqual({ count: 0 });
    });
});

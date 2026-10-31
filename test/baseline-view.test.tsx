import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { diffModels } from '../src/graph/diff.js';
import type { DomainModel } from '../src/model/model.js';
import { menuPlacement } from '../web/baseline-picker.js';
import { CommandCard } from '../web/behavior.js';
import { MESSAGES } from '../web/i18n.js';
import { Inspector, type InspectorProps, type InspectorTab } from '../web/inspector.js';
import { namer } from '../web/model-utils.js';
import { diffRows } from '../web/row-diff.js';
import { check } from './helpers.js';

const model = async (body: string): Promise<DomainModel> => (await check({ 'a.dt': `context A {\n${body}\n}\n` })).model!;

const BEFORE = `
  id OrderId: UUID
  error Closed
  event Placed { orderId: OrderId }
  aggregate Order {
    id: OrderId
    note: String
    total: Int
    state Open
    state Done
    create command place(id: OrderId) -> Open emits Placed
    command close() Open -> Done errors Closed
    command drop() Open -> Done
  }`;
const AFTER = `
  id OrderId: UUID
  error Closed
  event Placed { orderId: OrderId }
  aggregate Order {
    id: OrderId
    total: Decimal
    memo: String?
    state Open
    state Done
    create command place(id: OrderId) -> Open emits Placed
    command close(reason: String) Open -> Done
    command reopen() Done -> Open
  }`;

function inspect(after: DomainModel, before: DomainModel | null, selected: string, tab: InspectorTab): string {
    const props: InspectorProps = {
        model: after,
        mode: 'name',
        selected,
        diagnostics: [],
        diff: before ? diffModels(before, after) : { added: [], changed: [], removed: [] },
        base: before,
        sources: [],
        sourceFocus: undefined,
        statesView: () => null,
        stormingView: () => null,
        tab,
        onTab: () => {},
        onSelect: () => {},
        onReveal: () => {},
        onFocusContext: () => {},
        backTo: undefined,
        onBack: () => {},
        onClose: () => {},
    };
    return renderToStaticMarkup(<Inspector {...props} />);
}

/** The text of the rows marked with `change`. */
const marked = (html: string, change: string): string[] =>
    [...html.matchAll(new RegExp(`<(tr|div|code|span) class="[^"]*row-${change}[^"]*"[^>]*>(.*?)</\\1>`, 'g'))].map((m) => m[2].replace(/<[^>]*>/g, ''));

describe('rows compared with the baseline', () => {
    test('marks added, changed and removed rows, keeping removed ones where they were', () => {
        const rows = diffRows([{ k: 'a' }, { k: 'c', v: 2 }, { k: 'd' }], [{ k: 'a' }, { k: 'b' }, { k: 'c', v: 1 }], (x) => x.k);
        expect(rows.map((r) => [r.item.k, r.change])).toEqual([
            ['a', undefined],
            ['b', 'removed'],
            ['c', 'changed'],
            ['d', 'added'],
        ]);
        expect(rows[2].before).toEqual({ k: 'c', v: 1 });
        // without a baseline nothing is marked
        expect(diffRows([{ k: 'a' }], undefined, (x) => x.k).map((r) => r.change)).toEqual([undefined]);
    });

    test('the structure tab marks fields, and strikes through the old type', async () => {
        const html = inspect(await model(AFTER), await model(BEFORE), 'A.Order', 'structure');
        expect(marked(html, 'added').some((t) => t.startsWith('memo'))).toBe(true);
        expect(marked(html, 'removed').some((t) => t.startsWith('note'))).toBe(true);
        expect(marked(html, 'changed').some((t) => t.startsWith('total'))).toBe(true);
        expect(html).toContain('<del class="was">Int</del>Decimal');
    });

    test('the behaviour tab marks commands and their parts', async () => {
        const html = inspect(await model(AFTER), await model(BEFORE), 'A.Order', 'behavior');
        expect(html).toMatch(/class="bcard row-added"[\s\S]*?reopen/);
        expect(html).toMatch(/class="bcard row-removed"[\s\S]*?drop/);
        expect(html).toMatch(/class="bcard row-changed"[\s\S]*?close/);
        // the parameter added to close(), and the error it no longer returns
        expect(marked(html, 'added').some((t) => t.startsWith('reason'))).toBe(true);
    });

    test('nothing is marked without a baseline, or for an added element', async () => {
        const after = await model(AFTER);
        expect(inspect(after, null, 'A.Order', 'structure')).not.toContain('row-');
        const before = await model(AFTER.replace('  event Placed { orderId: OrderId }\n', ''));
        expect(inspect(after, before, 'A.Placed', 'structure')).not.toContain('row-');
    });

    test('a removed item is shown from the baseline', async () => {
        const html = inspect(await model(AFTER), await model(BEFORE), 'A.Order:drop', 'structure');
        expect(html).toContain('inspector-removed');
        expect(html).toContain(MESSAGES.ja.removedFromBaseline);
    });

    test('a command card marks only its changed parts', async () => {
        const after = await model(AFTER);
        const before = await model(BEFORE);
        const agg = after.elements['A.Order'];
        const c = agg.commands!.find((x) => x.name === 'close')!;
        const was = before.elements['A.Order'].commands!.find((x) => x.name === 'close')!;
        const html = renderToStaticMarkup(
            <CommandCard
                agg={agg}
                c={c}
                model={after}
                names={namer('name', after)}
                tx={MESSAGES.ja}
                onSelect={() => {}}
                base={{ model: before, item: was, change: 'changed' }}
            />,
        );
        expect(marked(html, 'added')).toEqual(['reasonString']);
        // the error close() no longer returns
        expect(html).toMatch(/class="row-removed"><a [^>]*><span[^>]*><\/span>Closed<\/a>/);
        expect(html.match(/row-(added|changed|removed)/g)).toEqual(['row-changed', 'row-added', 'row-removed']); // the card, the parameter, the error
    });
});

describe('the baseline menu', () => {
    const viewport = { width: 1600, height: 1000 };
    const rect = (left: number, top: number, width = 200, height = 28) => ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;

    test('opens below a button in the upper half, aligned with its nearer side', () => {
        // the header's button, on the right
        expect(menuPlacement(rect(1340, 8), viewport)).toEqual({ below: true, style: { top: 40, maxHeight: 952, right: 60 } });
    });

    test('opens above a button in the lower half (the heading of the changes, bottom left)', () => {
        expect(menuPlacement(rect(14, 822), viewport)).toEqual({ below: false, style: { bottom: 182, maxHeight: 810, left: 14 } });
    });
});

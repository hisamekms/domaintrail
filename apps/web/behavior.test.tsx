import { beforeAll, describe, expect, test } from 'bun:test';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { commandsOf, elementOf, statesOf, type DomainModel, type ElementModel, type QualifiedName } from '@domaintrail/modeling';
import { analyze } from '@domaintrail/analysis';
import { CommandCard, OutcomeCard, outcomesOf, PolicyReaction, Requirements } from './behavior';
import { MESSAGES } from './i18n';
import { tabsFor } from './inspector';
import { namer, resolve } from './model-utils';
import { check, exampleSources } from './test-helpers';

let model: DomainModel;
let order: ElementModel;
const tx = MESSAGES.ja;
const names = () => namer('both', model);
const command = (name: string) => commandsOf(order).find((c) => c.name === name)!;

beforeAll(async () => {
    model = (await analyze(await exampleSources())).model!;
    order = model.elements.find((e) => e.name === 'Order')!;
});

const text = (node: ReactNode): string => (typeof node === 'string' ? node : renderToStaticMarkup(<>{node}</>)).replace(/<[^>]*>/g, '');

/** Elements with a click handler and their text, expanding the (hook-free) components of the cards. */
function clickables(node: ReactNode): { text: string; click: () => void }[] {
    return Children.toArray(node).flatMap((child) => {
        if (!isValidElement(child)) return [];
        const el = child as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
        if (typeof el.type === 'function') return clickables((el.type as (p: unknown) => ReactNode)(el.props));
        const inner = clickables(el.props.children);
        return el.props.onClick ? [{ text: text(el), click: el.props.onClick }, ...inner] : inner;
    });
}

/** Clicks the elements whose text is `label` (`count` of them) and returns what was selected. */
function clickOn(card: (onSelect: (id: string) => void) => ReactNode, label: string, count = 1): string[] {
    const selected: string[] = [];
    const targets = clickables(card((id) => selected.push(id))).filter((c) => c.text === label);
    expect(targets).toHaveLength(count);
    for (const t of targets) t.click();
    return selected;
}

describe('behaviour cards', () => {
    test('a policy: its event and command, and the cards of the command it runs and of the event it reacts to', () => {
        const policy = elementOf(model, 'Billing.BillConfirmedOrder')!;
        const invoice = elementOf(model, 'Billing.Invoice')!;
        expect(tabsFor({ kind: 'element', el: policy })).toEqual(['structure', 'source']);
        const reaction = (onSelect: (id: string) => void) => <PolicyReaction p={policy} model={model} names={names()} tx={tx} onSelect={onSelect} input />;
        expect(text(reaction(() => {}))).toContain(tx.eventually);
        expect(text(reaction(() => {}))).toContain('billedAmount');
        expect(clickOn(reaction, '注文確定 OrderConfirmed')).toEqual(['Sales.OrderConfirmed']);
        expect(clickOn(reaction, '請求書を発行する Invoice.issue')).toEqual(['Billing.Invoice:issue']);
        const issue = (onSelect: (id: string) => void) => (
            <CommandCard agg={invoice} c={commandsOf(invoice).find((c) => c.name === 'issue')!} model={model} names={names()} tx={tx} onSelect={onSelect} />
        );
        expect(text(issue(() => {}))).toContain(tx.triggeredBy);
        expect(clickOn(issue, '確定した注文に請求する BillConfirmedOrder')).toEqual(['Billing.BillConfirmedOrder']);
        const confirmed = (onSelect: (id: string) => void) => (
            <OutcomeCard id="Sales.OrderConfirmed" commands={[command('confirm')]} model={model} names={names()} tx={tx} onSelect={onSelect} />
        );
        expect(clickOn(confirmed, '確定した注文に請求する BillConfirmedOrder')).toEqual(['Billing.BillConfirmedOrder']);
    });

    test('a command card shows its transition, parameters and outcomes', () => {
        const html = renderToStaticMarkup(<CommandCard agg={order} c={command('confirm')} model={model} names={names()} tx={tx} onSelect={() => {}} />);
        expect(html.match(/class="state-chip"/g)).toHaveLength(2);
        expect(text(html)).toContain('下書き→確定済み');
        expect(html).toContain('bcard-fields');
        expect(text(html)).toContain('at');
        expect(text(html)).toContain('Timestamp');
        expect(text(html)).toContain('⇒');
        expect(text(html)).toContain('✕');
        expect(html).toContain('dot-event');
        expect(html).toContain('dot-error');
    });

    test('in 両方, a command card without labels shows the names alone (no blank heading or chip)', async () => {
        const blank = (
            await check({
                'a.dt': 'context S { id AId: UUID\n aggregate A "" { id: AId\n state Open "  "\n state Done ""\n command close() " " Open -> Done } }',
            })
        ).model!;
        const agg = elementOf(blank, 'S.A')!;
        const html = renderToStaticMarkup(
            <CommandCard agg={agg} c={commandsOf(agg)[0]} model={blank} names={namer('both', blank)} tx={tx} onSelect={() => {}} />,
        );
        expect(html).not.toContain('bcard-name');
        expect(text(html)).toContain('closeOpen→Done');
    });

    test('a factory command shows the creation badge and starts at the initial marker', () => {
        const html = renderToStaticMarkup(<CommandCard agg={order} c={command('place')} model={model} names={names()} tx={tx} onSelect={() => {}} />);
        expect(html).toContain(`factory-badge">${tx.factory}<`);
        expect(text(html)).toContain('●→下書き');
        expect(text(html)).not.toContain('create');
    });

    test('several source states become several chips', () => {
        const html = renderToStaticMarkup(<CommandCard agg={order} c={command('cancel')} model={model} names={names()} tx={tx} onSelect={() => {}} />);
        expect(html.match(/class="state-chip"/g)).toHaveLength(3);
    });

    test('each transition is a row of its own', () => {
        const c = {
            ...command('addItem'),
            transitions: [
                { from: ['Draft'], to: ['Draft'] },
                { from: ['Confirmed'], to: ['Confirmed'] },
            ],
        };
        const html = renderToStaticMarkup(<CommandCard agg={order} c={c} model={model} names={names()} tx={tx} onSelect={() => {}} />);
        expect([...html.matchAll(/<div class="bcard-transition">(.*?)<\/div>/g)].map((m) => text(m[1]))).toEqual(['下書き→下書き', '確定済み→確定済み']);
        expect(names().transition(order, c)).toBe('下書き (Draft) → 下書き (Draft); 確定済み (Confirmed) → 確定済み (Confirmed)');
    });

    test('clicking a command card selects the command, its states and its outcomes', () => {
        const card = (onSelect: (id: string) => void) => CommandCard({ agg: order, c: command('confirm'), model, names: names(), tx, onSelect });
        expect(clickOn(card, '注文を確定するconfirm')).toEqual([command('confirm').id]);
        expect(clickOn(card, '確定済み')).toEqual([statesOf(order).find((s) => s.name === 'Confirmed')!.id]);
        expect(clickOn(card, '注文確定 OrderConfirmed')).toEqual([command('confirm').emits[0].event]);
        // once as the error of its requirement, once among the errors it may return
        expect(clickOn(card, '明細なし EmptyOrder', 2)).toEqual([command('confirm').errors[0], command('confirm').errors[0]]);
    });

    test('a command card lists its requirements with their expression and the error of else', () => {
        const html = renderToStaticMarkup(<CommandCard agg={order} c={command('addItem')} model={model} names={names()} tx={tx} onSelect={() => {}} />);
        expect(html).toContain(`<div class="bcard-caption">${tx.requirements}</div>`);
        expect(html).toContain('<code>all(items, i =&gt; i.sku != item.sku)</code>');
        const card = (onSelect: (id: string) => void) => CommandCard({ agg: order, c: command('addItem'), model, names: names(), tx, onSelect });
        expect(clickOn(card, '商品コードの重複 DuplicateSku', 2)).toEqual(['Sales.DuplicateSku', 'Sales.DuplicateSku']);
        expect(text(html)).toContain('同じ商品コードの明細がない newSku');
    });

    test('a command card shows the multiplicity and `when` of each event, and the event links to it', () => {
        const html = renderToStaticMarkup(<CommandCard agg={order} c={command('cancel')} model={model} names={names()} tx={tx} onSelect={() => {}} />);
        expect(html).toContain('<code class="bcard-emit-when">when Confirmed -&gt;</code>');
        const note = renderToStaticMarkup(<CommandCard agg={order} c={command('changeNote')} model={model} names={names()} tx={tx} onSelect={() => {}} />);
        expect(note).toContain('<code class="bcard-emit-when">?</code>');
        const card = (onSelect: (id: string) => void) => CommandCard({ agg: order, c: command('cancel'), model, names: names(), tx, onSelect });
        expect(clickOn(card, '返金依頼 RefundRequested')).toEqual(['Sales.RefundRequested']);
    });

    test('a requirement without an expression says it is not expressed in the DSL', () => {
        const c = { ...command('addItem'), requires: [{ name: 'inStock', label: '在庫がある', error: 'Sales.DuplicateSku' as QualifiedName }] };
        const html = renderToStaticMarkup(<Requirements c={c} model={model} names={names()} tx={tx} onSelect={() => {}} />);
        expect(html).toContain(`<em class="not-in-dsl">${tx.notInDsl}</em>`);
        expect(html).not.toContain('<code>');
    });

    test('a command without requirements has no requirements part', () => {
        const html = renderToStaticMarkup(<CommandCard agg={order} c={command('changeNote')} model={model} names={names()} tx={tx} onSelect={() => {}} />);
        expect(html).not.toContain(tx.requirements);
    });

    test('an event card shows its commands and payload, and selects them on click', () => {
        const [id, commands] = [...outcomesOf(commandsOf(order), 'emits')].find(([e]) => e.endsWith('OrderCancelled'))!;
        const card = (onSelect: (id: string) => void) => OutcomeCard({ id, commands, model, names: names(), tx, onSelect });
        const html = renderToStaticMarkup(<>{card(() => {})}</>);
        expect(html).toContain('persistence-badge');
        expect(text(html)).toContain(tx.origin);
        expect(text(html)).toContain('reason');
        expect(clickOn(card, '注文を取り消す cancel')).toEqual([command('cancel').id]);
    });
});

describe('inspector tabs', () => {
    test('an aggregate has its events in a tab of their own, right after the behaviour', () => {
        expect(tabsFor(resolve(model, order.id)!)).toEqual(['structure', 'states', 'behavior', 'events', 'references', 'source']);
    });

    test('other items keep their tabs', () => {
        const other = model.elements.find((e) => e.kind === 'valueObject')!;
        expect(tabsFor(resolve(model, other.id)!)).toEqual(['structure', 'references', 'source']);
        expect(tabsFor(resolve(model, command('confirm').id)!)).toEqual(['structure', 'states', 'behavior', 'source']);
    });
});

describe('changes in the DSL', () => {
    /**
     * Work moves Draft -> Review -> Done -> Archived. `draftNo` is in Draft and Review (carried over between them),
     * `reviewer` in Review and Done (carried over) and in Archived with another type (not carried over).
     */
    const work = (commands: string, extra = '') =>
        check({
            'tasks.dt': `context Tasks {
      id WorkId: UUID
      id TagId: UUID
      event Renamed { workId: WorkId }
      error NotReady
      fields Audited { updatedAt: Timestamp? }
      aggregate Work with Audited {
        id: WorkId
        title: String
        note: String?
        tags: String[0..*]
        state Draft { draftNo: Int }
        state Review { draftNo: Int reviewer: String }
        state Done { reviewer: String doneAt: Timestamp }
        state Archived { reviewer: String? }
    ${commands}
      }
      aggregate Tag {
        id: TagId
        name: String
        color: String
        create command make(id: TagId, name: String, color: String)
        command recolor(color: String) changes color
      }
      ${extra}
    }
    `,
        });

    const COMMANDS = `
        create command open(id: WorkId, title: String) -> Draft
        command rename(newTitle: String, at: Timestamp)
          Draft -> Draft, Review -> Review
          requires named { newTitle != "" } else NotReady
          changes title, updatedAt
          emits Renamed
        command submit(reviewer: String) Draft -> Review
        command renumber(n: Int) Draft -> Draft, Review -> Review changes draftNo
        command finish(at: Timestamp) Review -> Done
        command archive() Done -> Archived
        command clearNote() Draft -> Draft changes note
        command touch() Draft -> Draft`;

    test('the command card and the inspector list the fields it changes', async () => {
        const a = await work(COMMANDS);
        const agg = elementOf(a.model!, 'Tasks.Work')!;
        const card = (name: string) =>
            renderToStaticMarkup(
                <CommandCard
                    agg={agg}
                    c={commandsOf(agg).find((c) => c.name === name)!}
                    model={a.model!}
                    names={namer('name', a.model!)}
                    tx={MESSAGES.ja}
                    onSelect={() => {}}
                />,
            );
        expect(card('rename')).toContain(
            `<div class="bcard-caption">${MESSAGES.ja.changedFields}</div><div class="bcard-changes"><code class="bcard-change">title</code><code class="bcard-change">updatedAt</code></div>`,
        );
        expect(card('submit')).not.toContain('bcard-changes');
    });
});

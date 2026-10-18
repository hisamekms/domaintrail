import { beforeAll, describe, expect, test } from 'bun:test';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyze } from '../src/core/analyze.js';
import { loadWorkspace } from '../src/core/files.js';
import type { DomainModel, ElementModel } from '../src/model/model.js';
import { CommandCard, OutcomeCard, outcomesOf } from '../web/behavior.js';
import { MESSAGES } from '../web/i18n.js';
import { tabsFor } from '../web/inspector.js';
import { namer, resolve } from '../web/model-utils.js';
import { EXAMPLES } from './helpers.js';

let model: DomainModel;
let order: ElementModel;
const tx = MESSAGES.ja;
const names = () => namer('both', model);
const command = (name: string) => order.commands!.find((c) => c.name === name)!;

beforeAll(async () => {
    model = (await analyze(await loadWorkspace(EXAMPLES))).model!;
    order = Object.values(model.elements).find((e) => e.name === 'Order')!;
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

/** Clicks the element whose text is `label` and returns what was selected. */
function clickOn(card: (onSelect: (id: string) => void) => ReactNode, label: string): string[] {
    const selected: string[] = [];
    const target = clickables(card((id) => selected.push(id))).filter((c) => c.text === label);
    expect(target).toHaveLength(1);
    target[0].click();
    return selected;
}

describe('behaviour cards', () => {
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

    test('clicking a command card selects the command, its states and its outcomes', () => {
        const card = (onSelect: (id: string) => void) => CommandCard({ agg: order, c: command('confirm'), model, names: names(), tx, onSelect });
        expect(clickOn(card, '注文を確定するconfirm')).toEqual([command('confirm').id]);
        expect(clickOn(card, '確定済み')).toEqual([order.states!.find((s) => s.name === 'Confirmed')!.id]);
        expect(clickOn(card, '注文確定 OrderConfirmed')).toEqual([command('confirm').emits[0]]);
        expect(clickOn(card, '明細なし EmptyOrder')).toEqual([command('confirm').errors[0]]);
    });

    test('an event card shows its commands and payload, and selects them on click', () => {
        const [id, commands] = [...outcomesOf(order.commands!, 'emits')].find(([e]) => e.endsWith('OrderCancelled'))!;
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
        const other = Object.values(model.elements).find((e) => e.kind === 'valueObject')!;
        expect(tabsFor(resolve(model, other.id)!)).toEqual(['structure', 'references', 'source']);
        expect(tabsFor(resolve(model, command('confirm').id)!)).toEqual(['structure', 'states', 'behavior', 'source']);
    });
});

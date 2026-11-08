import { describe, expect, test } from 'bun:test';
import { check } from '../test-helpers.js';
import { contextLabel, fieldLabel, termFor, termOf } from './labels.js';
import { commandsOf, commonFields, fieldsOf, lookup, statesOf, type AggregateDecl, type SourceModel } from './source-model.js';

const SOURCES = {
    'common.dt': `shared context Common {
  terms { amount: "金額" }
  primitive Money "お金": Int
}
`,
    'sales.dt': `context Sales "販売" {
  terms {
    confirmedAt: "確定日時"
    note: "備考"
  }
  id OrderId "注文ID": UUID
  aggregate Customer "顧客" { id: CustomerId }
  id CustomerId: UUID
  aggregate Order {
    id: OrderId
    references customer: CustomerId -> Customer
    note: String? "注文メモ"
    total: Money
    amount: Int
    plain: String
    state Confirmed { confirmedAt: Timestamp }
    command confirm(at: Timestamp "確定する日時", note: String) Confirmed -> Confirmed
  }
}
`,
    'sales2.dt': `context Sales "売上" {
  terms { note: "別の備考" }
}
`,
};

const model = async (): Promise<SourceModel> => (await check(SOURCES)).sourceModel!;

describe('the labels of the model as written', () => {
    test('terms: the first definition of a context, then those of shared contexts', async () => {
        const m = await model();
        expect(termOf(m, 'Sales', 'note')?.label).toBe('備考');
        expect(termOf(m, 'Sales', 'amount')).toBeUndefined();
        expect(termFor(m, 'Sales', 'amount')?.label).toBe('金額');
        expect(termFor(m, 'Common', 'note')).toBeUndefined();
        expect(termFor(m, 'Sales', 'nothing')).toBeUndefined();
    });

    test("a context's label is the first one declared", async () => {
        const m = await model();
        expect(contextLabel(m, 'Sales')).toBe('販売');
        expect(contextLabel(m, 'Common')).toBeUndefined();
    });

    test('fields and parameters: inline label, then term, then the type (or the referenced aggregate)', async () => {
        const m = await model();
        const order = lookup(m, 'Sales.Order') as AggregateDecl;
        const field = (name: string) => [...commonFields(order), ...statesOf(order).flatMap((s) => fieldsOf(s.members))].find((f) => f.name === name)!;
        expect(fieldLabel(m, 'Sales', field('note'))).toEqual({ label: '注文メモ', source: 'inline' });
        expect(fieldLabel(m, 'Sales', field('confirmedAt'))).toEqual({ label: '確定日時', source: 'term' });
        expect(fieldLabel(m, 'Sales', field('amount'))).toEqual({ label: '金額', source: 'term' });
        expect(fieldLabel(m, 'Sales', field('id'))).toEqual({ label: '注文ID', source: 'type' });
        expect(fieldLabel(m, 'Sales', field('customer'))).toEqual({ label: '顧客', source: 'type' });
        expect(fieldLabel(m, 'Sales', field('total'))).toEqual({ label: 'お金', source: 'type' });
        expect(fieldLabel(m, 'Sales', field('plain'))).toBeUndefined();
        const [at, note] = commandsOf(order)[0].params;
        expect(fieldLabel(m, 'Sales', at)).toEqual({ label: '確定する日時', source: 'inline' });
        expect(fieldLabel(m, 'Sales', note)).toEqual({ label: '備考', source: 'term' });
    });
});

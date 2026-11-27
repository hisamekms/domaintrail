import { describe, expect, test } from 'bun:test';
import { fieldId, invariantId, outcomeId, parameterId, requirementId, variantId, enumValueId, onCaseId, parseSemanticId } from './ids.js';

describe('semantic declaration IDs', () => {
    test('uses readable qualified declaration paths', () => {
        expect(String(fieldId('Sales.Order', 'items'))).toBe('Sales.Order.items');
        expect(String(fieldId('Sales.Order#Confirmed', 'confirmedAt'))).toBe('Sales.Order#Confirmed.confirmedAt');
        expect(String(invariantId('Sales.Order', 'hasItems'))).toBe('Sales.Order.invariant.hasItems');
        expect(String(parameterId('Sales.Order:cancel', 'reason'))).toBe('Sales.Order:cancel(reason)');
        expect(String(requirementId('Sales.Order:cancel', 'noteForOther'))).toBe('Sales.Order:cancel.requires.noteForOther');
        expect(String(outcomeId('Sales.Order:cancel', 'cancelledFromDraft'))).toBe('Sales.Order:cancel->cancelledFromDraft');
        expect(String(variantId('Sales.Payment', 'card'))).toBe('Sales.Payment|card');
        expect(String(onCaseId('Sales.Order/Store', 'finish'))).toBe('Sales.Order/Store:on:finish');
        expect(String(enumValueId('Sales.Status', 'Open'))).toBe('Sales.Status=Open');
        for (const id of [
            'Sales.Order.items',
            'Sales.Order#Done',
            'Sales.Order:cancel',
            'Sales.Order/Store',
            'Sales.Order:cancel(reason)',
            'Sales.Order.invariant.x',
            'Sales.Order:cancel.requires.r',
            'Sales.Order:cancel->done',
            'Sales.Payment|card',
            'Sales.Payment|card.pan',
            'Sales.Order/Store:on:finish',
            'Sales.Status=Open',
        ])
            expect(parseSemanticId(id)?.id).toBe(id);
        expect(String(fieldId('Sales.Payment|card', 'last4'))).toBe('Sales.Payment|card.last4');
    });

    test('parses every category emitted by the ID builders', () => {
        const cases = [
            ['context', 'Sales'],
            ['element', 'Sales.Order'],
            ['state', 'Sales.Order#Done'],
            ['command', 'Sales.Order:cancel'],
            ['kind', 'Sales.Order/Store'],
            ['field', fieldId('Sales.Order', 'items')],
            ['invariant', invariantId('Sales.Order', 'valid')],
            ['onCase', onCaseId('Sales.Order/Store', 'finish')],
            ['parameter', parameterId('Sales.Order:cancel', 'reason')],
            ['requirement', requirementId('Sales.Order:cancel', 'allowed')],
            ['outcome', outcomeId('Sales.Order:cancel', 'done')],
            ['variant', variantId('Sales.Payment', 'card')],
            ['variantField', fieldId(variantId('Sales.Payment', 'card'), 'last4')],
            ['enumValue', enumValueId('Sales.Status', 'Open')],
        ] as const;
        for (const [category, id] of cases) expect(parseSemanticId(id)).toEqual({ category, id });
    });

    test('keeps fields and invariants distinct, including reserved-looking field names', () => {
        for (const name of ['x', 'invariant', 'requires', 'changes']) {
            const field = fieldId('Sales.Order', name);
            const invariant = invariantId('Sales.Order', name);
            expect(field).not.toBe(invariant);
            expect(parseSemanticId(field)?.category).toBe('field');
            expect(parseSemanticId(invariant)?.category).toBe('invariant');
        }
    });
});

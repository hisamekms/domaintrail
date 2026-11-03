import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '@domaintrail/kernel';
import type { DomainModel } from '@domaintrail/modeling';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { MESSAGES } from '../i18n';
import { emptyLine, isEmptyView, VIEW_TABS } from './empty';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the number of BCs matters here
const model = (contexts: number): DomainModel => ({ contexts: Array.from({ length: contexts }, () => ({})), elements: [] }) as unknown as DomainModel;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only that there is one matters here
const storming = {} as StormingView;
const error = (file: string): Diagnostic => ({
    file,
    start: { line: 1, column: 1 },
    end: { line: 1, column: 2 },
    severity: 'error',
    code: 'SYNTAX',
    message: 'x',
});
const payload = (p: { model?: DomainModel | null; stormings?: StormingView[]; diagnostics?: Diagnostic[] }): Parameters<typeof isEmptyView>[1] => ({
    model: p.model ?? null,
    stormings: p.stormings ?? [],
    diagnostics: p.diagnostics ?? [],
});

describe('a view with nothing yet', () => {
    test('every tab shows, the storming tab too, even without a storming', () => {
        expect(VIEW_TABS).toEqual(['contextMap', 'structure', 'catalog', 'storming']);
    });

    test('an empty workspace: every view is empty', () => {
        for (const view of VIEW_TABS) expect(isEmptyView(view, payload({}))).toBe(true);
    });

    test("the model's views are empty without a BC, the storming view without a storming", () => {
        const stormingsOnly = payload({ model: model(0), stormings: [storming] });
        expect(isEmptyView('structure', stormingsOnly)).toBe(true);
        expect(isEmptyView('catalog', stormingsOnly)).toBe(true);
        expect(isEmptyView('storming', stormingsOnly)).toBe(false);
        const modelOnly = payload({ model: model(1) });
        expect(isEmptyView('contextMap', modelOnly)).toBe(false);
        expect(isEmptyView('storming', modelOnly)).toBe(true);
    });

    test('a file of the kind with errors is not empty (the view says why it draws nothing)', () => {
        expect(isEmptyView('structure', payload({ diagnostics: [error('a.dt')] }))).toBe(false);
        expect(isEmptyView('storming', payload({ diagnostics: [error('a.dt')] }))).toBe(true);
        expect(isEmptyView('storming', payload({ diagnostics: [error('a.dtes')] }))).toBe(false);
        expect(isEmptyView('structure', payload({ diagnostics: [{ ...error('a.dt'), severity: 'warning' }] }))).toBe(true);
    });

    test('its one line says the chat can make it only while an AI is connected', () => {
        expect(emptyLine(MESSAGES.ja, true)).toBe('まだありません。チャットで頼むと AI が作ります');
        expect(emptyLine(MESSAGES.ja, false)).toBe('まだありません');
    });
});

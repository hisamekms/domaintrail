import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '@domaintrail/kernel';
import type { DomainModel } from '@domaintrail/modeling';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { MESSAGES } from '../i18n';
import { canvasShows, emptyLine, isEmptyView } from './empty';
import { MODEL_VIEWS } from './worlds';

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
const VIEWS = [...MODEL_VIEWS, 'storming'] as const;
const payload = (p: { model?: DomainModel | null; stormings?: StormingView[]; diagnostics?: Diagnostic[] }): Parameters<typeof isEmptyView>[1] => ({
    model: p.model ?? null,
    stormings: p.stormings ?? [],
    diagnostics: p.diagnostics ?? [],
});

describe('a view with nothing yet', () => {
    test('an empty workspace: every view is empty', () => {
        for (const view of VIEWS) expect(isEmptyView(view, payload({}))).toBe(true);
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

    test("the canvas shows nothing under an empty view, never the previous view's graph", () => {
        // stormings only: from the storming view to the empty catalog, context map and structure
        for (const view of VIEWS) expect(canvasShows(view, true, false)).toBe('nothing');
        // a model only: the storming view has no graph either
        expect(canvasShows('storming', true, false)).toBe('nothing');
        // even a graph of an empty view (a context map of no BC) is not drawn
        expect(canvasShows('contextMap', true, true)).toBe('nothing');
    });

    test('a view with something draws its graph; a catalog covers the canvas', () => {
        expect(canvasShows('storming', false, true)).toBe('graph');
        expect(canvasShows('structure', false, true)).toBe('graph');
        expect(canvasShows('structure', false, false)).toBe('nothing');
        expect(canvasShows('catalog', false, false)).toBe('covered');
    });

    test('its one line points to /es in the chat only while an AI is connected', () => {
        expect(emptyLine(MESSAGES.ja, true)).toBe('まだありません。チャットで /es から始められます');
        expect(emptyLine(MESSAGES.en, true)).toBe('Nothing yet. Start with /es in the chat');
        expect(emptyLine(MESSAGES.ja, false)).toBe('まだありません');
    });
});

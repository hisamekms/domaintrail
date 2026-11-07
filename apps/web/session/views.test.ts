// Where the others are (apps/web/session/views.ts): the view a location stands for, its name, whether it opens here, the
// participants' rows, and the chat's small layout rules.
import { describe, expect, test } from 'bun:test';
import type { Me, Presence, SessionStateBody, ViewLocation } from '@domaintrail/collaboration/protocol';
import { canOpen, continued, isMac, participantRows, sentView, viewName, viewTargetOf, type ViewScope, type ViewWords } from './views';

const words: ViewWords = {
    views: { contextMap: 'コンテキストマップ', structure: '構造図', catalog: 'カタログ', storming: 'イベントストーミング' },
    structureLevels: { detail: '詳細', overview: '概観', aggregates: '集約' },
    stormingLevels: { 'big-picture': 'ビッグピクチャー', 'design-level': 'デザインレベル' },
    allContexts: 'すべての BC',
};
const scope: ViewScope = {
    mode: 'label',
    contexts: ['Sales', 'Billing'],
    contextLabels: { Sales: '販売', Billing: '請求' },
    stormings: [{ id: 'Delivery', label: '配送', timelines: [{ id: 'Normal', label: '通常' }, { id: 'Failure' }] }],
};
const dt = (viewKey: string): ViewLocation => ({ kind: 'dt', viewKey, layoutKey: 'g@1' });
const dtes = (stormingId: string, level: string, timelineId?: string): ViewLocation => ({
    kind: 'dtes',
    stormingId,
    level,
    ...(timelineId && { timelineId }),
    layoutKey: 'g@1',
});

describe('the view of a location', () => {
    test('a .dt view by its view key; a storming by its storming, level and timeline', () => {
        expect(viewTargetOf(dt('structure:detail'))).toEqual({ kind: 'structure', level: 'detail' });
        expect(viewTargetOf(dt('structure:focus:Sales+Billing|Shared|overview'))).toEqual({
            kind: 'structure',
            level: 'overview',
            focus: { contexts: ['Sales', 'Billing'], hidden: ['Shared'] },
        });
        expect(viewTargetOf(dt('structure:focus:Sales||aggregates'))).toEqual({
            kind: 'structure',
            level: 'aggregates',
            focus: { contexts: ['Sales'], hidden: [] },
        });
        expect(viewTargetOf(dt('contextMap:true'))).toEqual({ kind: 'contextMap', all: true });
        expect(viewTargetOf(dt('catalog'))).toEqual({ kind: 'catalog' });
        expect(viewTargetOf(dtes('Delivery', 'design-level', 'Normal'))).toEqual({
            kind: 'storming',
            stormingId: 'Delivery',
            level: 'design-level',
            timelineId: 'Normal',
        });
        expect(viewTargetOf(dtes('Delivery', 'big-picture'))).toEqual({ kind: 'storming', stormingId: 'Delivery', level: 'big-picture' });
        for (const unknown of [dt('structure:huge'), dt('nope'), dt('structure:focus:|x|detail'), dtes('Delivery', 'zoomed')])
            expect(viewTargetOf(unknown)).toBeUndefined();
    });

    test('is named readably, in the display mode', () => {
        const name = (l: ViewLocation, s = scope): string => viewName(viewTargetOf(l)!, words, s);
        expect(name(dt('structure:detail'))).toBe('構造図 · 詳細');
        expect(name(dt('structure:focus:Sales+Billing||overview'))).toBe('構造図 · 販売 + 請求 · 概観');
        expect(name(dt('structure:focus:Sales+Billing||overview'), { ...scope, mode: 'name' })).toBe('構造図 · Sales + Billing · 概観');
        expect(name(dt('contextMap:false'))).toBe('コンテキストマップ');
        expect(name(dt('contextMap:true'))).toBe('コンテキストマップ · すべての BC');
        expect(name(dt('catalog'))).toBe('カタログ');
        expect(name(dtes('Delivery', 'design-level', 'Normal'))).toBe('配送 · デザインレベル · 通常');
        expect(name(dtes('Delivery', 'big-picture', 'Failure'))).toBe('配送 · ビッグピクチャー · Failure');
        expect(name(dtes('Gone', 'big-picture'))).toBe('Gone · ビッグピクチャー');
    });

    test('opens here only while its contexts, storming and timeline exist', () => {
        const opens = (l: ViewLocation): boolean => canOpen(viewTargetOf(l)!, scope);
        expect([dt('catalog'), dt('contextMap:true'), dt('structure:detail'), dt('structure:focus:Sales||detail')].map(opens)).toEqual([
            true,
            true,
            true,
            true,
        ]);
        expect(opens(dt('structure:focus:Sales+Gone||detail'))).toBe(false);
        expect(opens(dtes('Delivery', 'big-picture', 'Normal'))).toBe(true);
        expect(opens(dtes('Delivery', 'big-picture', 'Gone'))).toBe(false);
        expect(opens(dtes('Gone', 'big-picture'))).toBe(false);
    });
});

describe('the participants list', () => {
    const at = '2026-10-31T09:00:00.000Z';
    const state = {
        session: {
            id: 's',
            facilitator: 'local:facilitator',
            participants: [
                { id: 'local:facilitator', name: 'Facilitator', role: 'Facilitator', joinedAt: at },
                { id: 'dev:host', name: 'Hana', role: 'Participant', joinedAt: at },
                { id: 'dev:a', name: 'Ann', role: 'Participant', joinedAt: at },
                { id: 'dev:b', name: 'Bob', role: 'Participant', joinedAt: at },
                { id: 'dev:c', name: 'Carol', role: 'Participant', joinedAt: at },
                { id: 'dev:d', name: 'Dan', role: 'Participant', joinedAt: at },
            ],
            startedAt: at,
            state: 'Open',
        },
        facilitatorHolder: 'dev:host',
    } as unknown as Pick<SessionStateBody, 'session' | 'facilitatorHolder'>;
    const me = { session: 's', participant: { id: 'dev:a', name: 'Ann', role: 'participant' } } as unknown as Me;
    const mine = dt('structure:detail');
    const page = (connection: string, id: string, name: string, location: ViewLocation): [string, Presence] => [
        connection,
        { connection, participant: { id, name, role: 'participant' }, location } as unknown as Presence,
    ];
    const peers = new Map([
        page('1', 'dev:b', 'Bob', dtes('Delivery', 'design-level', 'Normal')),
        // Carol has two pages: one on this view
        page('2', 'dev:c', 'Carol', dt('catalog')),
        page('3', 'dev:c', 'Carol', mine),
        page('4', 'local:facilitator', 'Hana', dt('contextMap:false')),
    ]);

    test('me first, then on this view, on another view (with its location), offline; the facilitator under its holder', () => {
        expect(participantRows(state, peers, me, mine).map((r) => [r.name, r.role, r.where, r.location && viewTargetOf(r.location)?.kind])).toEqual([
            ['Ann', 'participant', 'here', undefined],
            ['Carol', 'participant', 'same-view', undefined],
            ['Bob', 'participant', 'another-view', 'storming'],
            ['Hana', 'facilitator', 'another-view', 'contextMap'],
            ['Dan', 'participant', 'away', undefined],
        ]);
    });
});

describe('the layout of the stream', () => {
    test('a bubble continues the one before when the same author wrote it with nothing between', () => {
        expect(continued(['a', 'a', 'b', undefined, 'b', 'agent', 'agent', 'a'])).toEqual([false, true, false, false, false, false, true, false]);
        expect(continued([])).toEqual([]);
    });

    test('the send shortcut is ⌘ on a Mac, Ctrl elsewhere', () => {
        expect(['MacIntel', 'iPhone', 'Win32', 'Linux x86_64'].map(isMac)).toEqual([true, true, false, false]);
    });
});

describe('the view a message is sent from', () => {
    test('each view: the context map, the structure and its focus, the catalog and its filter, a storming and how it is shown', () => {
        expect(sentView({ location: dt('contextMap:true') })).toEqual({ view: { kind: 'ContextMap', all: true } });
        expect(sentView({ location: dt('structure:overview'), states: 'Sales.Order' })).toEqual({
            view: { kind: 'Structure', level: 'Overview', focus: [] },
            states: 'Sales.Order',
        });
        expect(sentView({ location: dt('structure:focus:Sales+Billing||aggregates') })).toEqual({
            view: { kind: 'Structure', level: 'Aggregates', focus: ['Sales', 'Billing'] },
        });
        expect(sentView({ location: dt('catalog'), catalog: { query: ' 注文 ', sections: ['aggregates'], contexts: null } })).toEqual({
            view: { kind: 'Catalog', query: '注文', sections: ['aggregates'], contexts: [] },
        });
        expect(sentView({ location: dt('catalog') })).toEqual({ view: { kind: 'Catalog', sections: [], contexts: [] } });
        expect(sentView({ location: dtes('Delivery', 'design-level'), storming: { stageId: 'Shipping', flow: 'main' } })).toEqual({
            view: { kind: 'Storming', storming: 'Delivery', level: 'DesignLevel', stage: 'Shipping', exceptions: false },
        });
        expect(sentView({ location: dtes('Delivery', 'big-picture', 'Normal') })).toEqual({
            view: { kind: 'Storming', storming: 'Delivery', level: 'BigPicture', timeline: 'Normal', exceptions: true },
        });
    });

    test('nothing for a view this page cannot name', () => {
        expect(sentView({ location: dt('loading') })).toBeUndefined();
    });
});

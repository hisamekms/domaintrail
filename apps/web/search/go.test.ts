// Going where 探す found something (search/go.ts, search/notice.tsx): the moves made, through the reader's own
// navigation and settings — so that following stops — and the line that says what was taken away.
import { describe, expect, test } from 'bun:test';
import { MESSAGES } from '../i18n';
import type { StormingChoice } from '../storming';
import { nextFollowee, readerNavigation, readerSettings, AI_FOLLOWEE, type Followee, type NavigationMoves, type SettingsMoves } from '../view/follow';
import { goToModel, type ModelMoves } from './go';
import { modelTakenText, stormingTaken, stormingTakenText } from './notice';
import type { ModelDestination } from './reveal';

/** The moves, recorded; the navigation and the settings the reader's (each stops following first). */
function recorded(): { moves: ModelMoves; calls: string[]; followee: () => Followee | null } {
    const calls: string[] = [];
    let followee: Followee | null = AI_FOLLOWEE;
    const mine = (): void => {
        followee = nextFollowee(followee, { kind: 'mine' });
    };
    const nav: NavigationMoves = {
        setView: (v) => calls.push(`view ${v.kind}`),
        select: (id, opts) => calls.push(`select ${id}${opts?.highlight === false ? '' : ' +highlight'}`),
        goBack: () => {},
        reveal: () => {},
    };
    const settings: SettingsMoves = {
        setStructureLevel: (l) => calls.push(`level ${l}`),
        setStructureContexts: (c) => calls.push(`contexts ${c === null ? 'all' : c.join('+')}`),
        setHiddenContexts: () => {},
        setMapAll: () => {},
        setStormingChoice: () => {},
        setStormingFocus: () => {},
        setCompact: () => {},
    };
    return {
        calls,
        followee: () => followee,
        moves: {
            nav: readerNavigation(() => nav, mine),
            settings: readerSettings(() => settings, mine),
            clearCatalogFilter: () => calls.push('catalog filter cleared'),
            openInspector: (tab) => calls.push(`inspector ${tab}`),
            show: (id, then) => {
                calls.push(`show ${id}`);
                // the canvas selects it, which the navigation takes as its selection
                calls.push(`select ${id} (canvas)`);
                then();
            },
        },
    };
}

describe('going to an item of the model', () => {
    test('a command: the Structure View, its aggregate selected on the canvas, then the command again, its detail on 状態; following stops', () => {
        const r = recorded();
        const dest: ModelDestination = {
            select: 'Sales.Order:confirm',
            place: { view: 'structure', show: 'Sales.Order', contexts: ['Billing', 'Sales'] },
            inspector: 'states',
        };
        goToModel(dest, r.moves);
        expect(r.calls).toEqual([
            'contexts Billing+Sales',
            'view structure',
            'select Sales.Order:confirm',
            'show Sales.Order',
            'select Sales.Order (canvas)',
            'select Sales.Order:confirm',
            'inspector states',
        ]);
        expect(r.followee()).toBeNull();
    });

    test('an aggregate at another level: the level first, and no second selection', () => {
        const r = recorded();
        goToModel({ select: 'Sales.OrderItem', place: { view: 'structure', show: 'Sales.OrderItem', level: 'detail' } }, r.moves);
        expect(r.calls).toEqual(['level detail', 'view structure', 'select Sales.OrderItem', 'show Sales.OrderItem', 'select Sales.OrderItem (canvas)']);
    });

    test('a catalog’s kind: its filter cleared when it hides it, then the catalog', () => {
        const r = recorded();
        goToModel({ select: 'Sales.Sku', place: { view: 'catalog', clearFilter: true } }, r.moves);
        expect(r.calls).toEqual(['catalog filter cleared', 'view catalog', 'select Sales.Sku']);
        expect(r.followee()).toBeNull();
    });

    test('what no view draws: its source in the detail, the view kept', () => {
        const r = recorded();
        goToModel({ select: 'Sales.FieldSet', place: { view: 'source' }, inspector: 'source' }, r.moves);
        expect(r.calls).toEqual(['select Sales.FieldSet', 'inspector source']);
    });
});

describe('what going to a sticky took away', () => {
    const choice = (over: Partial<StormingChoice>): StormingChoice => ({ stormingId: 'Dispatch', level: 'big-picture', timelines: {}, ...over });
    test('a level that draws it, a main flow left for すべて, the exceptions included, the 絞り込み; nothing else', () => {
        const before = choice({ timelines: { OtC: 'Normal', Dispatch: 'Night' }, hidden: ['exceptions', 'resolvedHotspots'] });
        const after = choice({ stormingId: 'OtC', level: 'design-level', timelines: { Dispatch: 'Night' } });
        const taken = stormingTaken(before, after, 'OtC');
        expect(taken).toEqual({ level: true, timeline: true, exceptions: true, filter: true });
        expect(stormingTakenText(MESSAGES.ja, taken)).toBe('デザインレベルにしました・すべてにしました・例外を含めました・絞り込みを外しました');
        const none = { level: false, timeline: false, exceptions: false, filter: false };
        expect(stormingTaken(choice({}), choice({ stormingId: 'OtC' }), 'OtC')).toEqual(none);
        expect(stormingTakenText(MESSAGES.ja, none)).toBe('');
        // the exceptions included alone (an earlier version's 「例外を表示」 off too)
        expect(stormingTakenText(MESSAGES.ja, stormingTaken(choice({ exceptions: false }), choice({}), 'Dispatch'))).toBe('例外を含めました');
        // back to the big picture is never said (going to a sticky never does it)
        expect(stormingTaken(choice({ level: 'design-level' }), choice({}), 'Dispatch').level).toBe(false);
    });

    test('the model’s: a level, a narrowing', () => {
        expect(modelTakenText(MESSAGES.ja, { level: 'detail', filter: true })).toBe('詳細にしました・絞り込みを外しました');
        expect(modelTakenText(MESSAGES.en, { level: 'overview', filter: false })).toBe('Switched to Overview');
        expect(modelTakenText(MESSAGES.ja, { filter: false })).toBe('');
    });
});

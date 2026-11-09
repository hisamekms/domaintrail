// What a printed or exported diagram says it is (view/sheet.ts): its heading line and its file's name, for each view.
import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createViewService, ElkLayoutEngine } from '@domaintrail/visualization';
import { MESSAGES } from '../i18n';
import type { StormingChoice } from '../storming';
import { canvasSubject, exportFileName, sheetHeading, slug, stormingSubject, type SheetSubject } from './sheet';

const STAGES = await readFile(path.join(import.meta.dir, '..', '..', '..', 'test', 'fixtures', 'stages', 'convenience-store-stages.dtes'), 'utf8');
const engine = new ElkLayoutEngine();
afterAll(() => engine.dispose());

/** The stormings of a workspace holding the stages' fixture. */
async function stormingsOf(text: string) {
    const service = createViewService({
        root: '/workspace',
        engine,
        workspace: { readSources: async () => [{ path: 'stages.dtes', text }] },
        layoutStore: { load: async () => new Map(), save: async () => {} },
        git: {
            resolveCommit: (ref) => Promise.reject(new Error(`no git: ${ref}`)),
            sourcesAt: async () => [],
            listRefs: async () => ({ branches: [], tags: [], commits: [] }),
            gitDirs: async () => undefined,
        },
    });
    return (await service.refresh()).stormings;
}

const ja = MESSAGES.ja;
const en = MESSAGES.en;
const choice = (extra: Partial<StormingChoice> = {}): StormingChoice => ({ stormingId: undefined, level: 'design-level', timelines: {}, ...extra });

describe('the heading of a printed diagram', () => {
    test('an Event Storming view: the storming, its timeline, its level and its exceptions, by display mode', async () => {
        const stormings = await stormingsOf(STAGES);
        // one main flow (the trunk through every stage): no timeline part
        const all = stormingSubject(stormings, choice())!;
        expect(sheetHeading('ws', all, ja, 'label')).toBe(
            'ws › イベントストーミング › 住民票などのコンビニ交付（ビッグピクチャ） · デザインレベル · 例外を含む',
        );
        expect(sheetHeading('ws', all, ja, 'name')).toBe('ws › イベントストーミング › ConvenienceStoreIssuance · デザインレベル · 例外を含む');
        expect(sheetHeading('ws', all, en, 'both')).toBe(
            'ws › Event Storming › 住民票などのコンビニ交付（ビッグピクチャ） (ConvenienceStoreIssuance) · Design Level · with exceptions',
        );
        // without its exceptions' layer (as an earlier version kept it)
        const without = stormingSubject(stormings, choice({ level: 'big-picture', exceptions: false }))!;
        expect(sheetHeading('ws', without, ja, 'label')).toBe(
            'ws › イベントストーミング › 住民票などのコンビニ交付（ビッグピクチャ） · ビッグピクチャー · 例外なし',
        );
        // several main flows: すべて, or the one on the canvas
        const two = await stormingsOf(
            'storming Two "二つ" {\n  event A\n  event B\n  timeline One "一" {\n    A\n  }\n  timeline Other "他" {\n    B\n  }\n}\n',
        );
        expect(sheetHeading('ws', stormingSubject(two, choice())!, ja, 'label')).toBe('ws › イベントストーミング › 二つ › すべて · デザインレベル');
        expect(sheetHeading('ws', stormingSubject(two, choice({ timelines: { Two: 'Other' } }))!, ja, 'label')).toBe(
            'ws › イベントストーミング › 二つ › 他 · デザインレベル',
        );
    });

    test('a storming without timelines has no timeline part, nor exceptions', async () => {
        const stormings = await stormingsOf('storming Tiny "小さな" {\n  event Started "始まった"\n}\n');
        const subject = stormingSubject(stormings, choice())!;
        expect(sheetHeading(undefined, subject, ja, 'label')).toBe('イベントストーミング › 小さな · デザインレベル');
    });

    test('the Context Map, the Structure View and a state view', () => {
        const structure = canvasSubject('structure', { structureLevel: 'overview', mapAll: false, stormingChoice: choice() }, [], null, []);
        expect(sheetHeading('shop', structure!, ja, 'label')).toBe('shop › ドメインモデル › 構造図 · 概観');
        const focused: SheetSubject = { view: 'structure', level: 'detail', contexts: [{ id: 'Sales', label: '販売' }, { id: 'Billing' }] };
        expect(sheetHeading('shop', focused, ja, 'label')).toBe('shop › ドメインモデル › 構造図 › 販売, Billing · 詳細');
        expect(sheetHeading('shop', focused, en, 'name')).toBe('shop › Domain model › Structure › Sales, Billing · Detail');
        expect(sheetHeading('shop', { view: 'contextMap', all: false }, ja, 'label')).toBe('shop › ドメインモデル › コンテキストマップ');
        expect(sheetHeading('shop', { view: 'contextMap', all: true }, ja, 'label')).toBe('shop › ドメインモデル › コンテキストマップ · すべてのコンテキスト');
        const states: SheetSubject = { view: 'states', aggregate: { id: 'Sales.Order', name: 'Order', label: '注文' } };
        expect(sheetHeading('shop', states, ja, 'label')).toBe('shop › ドメインモデル › 状態遷移 › 注文');
        expect(sheetHeading('shop', states, en, 'name')).toBe('shop › Domain model › States › Order');
        const byKind: SheetSubject = { ...states, kind: { id: 'COLLECT', label: '回収のみ' } };
        expect(sheetHeading('shop', byKind, ja, 'label')).toBe('shop › ドメインモデル › 状態遷移 › 注文 · 回収のみ');
        expect(sheetHeading('shop', byKind, en, 'both')).toBe('shop › Domain model › States › 注文 (Order) · 回収のみ (COLLECT)');
        expect(canvasSubject('catalog', { structureLevel: 'detail', mapAll: false, stormingChoice: choice() }, [], null, [])).toBeUndefined();
    });
});

describe('the name of an exported file', () => {
    test('is made of IDs, whatever the display mode, the parts a view does not have left out', async () => {
        const stormings = await stormingsOf(STAGES);
        const all = stormingSubject(stormings, choice({ level: 'big-picture' }))!;
        expect(exportFileName('ws', all, 'svg')).toBe('ws-storming-ConvenienceStoreIssuance-big-picture.svg');
        const without = stormingSubject(stormings, choice({ hidden: ['exceptions'] }))!;
        expect(exportFileName('ws', without, 'png')).toBe('ws-storming-ConvenienceStoreIssuance-design-level-without-exceptions.png');
        expect(exportFileName('shop', { view: 'contextMap', all: false }, 'png')).toBe('shop-context-map.png');
        expect(exportFileName('shop', { view: 'contextMap', all: true }, 'png')).toBe('shop-context-map-all.png');
        expect(exportFileName('shop', { view: 'structure', level: 'detail', contexts: [] }, 'svg')).toBe('shop-structure-detail.svg');
        expect(exportFileName('shop', { view: 'structure', level: 'aggregates', contexts: [{ id: 'Sales' }, { id: 'Billing' }] }, 'svg')).toBe(
            'shop-structure-Sales-Billing-aggregates.svg',
        );
        expect(exportFileName('shop', { view: 'states', aggregate: { id: 'Sales.Order', name: 'Order' } }, 'png')).toBe('shop-states-Sales.Order.png');
        expect(exportFileName('shop', { view: 'states', aggregate: { id: 'Sales.Order', name: 'Order' }, kind: { id: 'COLLECT' } }, 'png')).toBe(
            'shop-states-Sales.Order-COLLECT.png',
        );
        expect(exportFileName(undefined, { view: 'contextMap', all: false }, 'png')).toBe('context-map.png');
    });

    test('keeps letters of any script and digits, and nothing a file system minds', () => {
        expect(slug('my ws/2026')).toBe('my-ws-2026');
        expect(slug('受注 管理')).toBe('受注-管理');
        expect(slug('..a:b*c?..')).toBe('a-b-c');
    });
});

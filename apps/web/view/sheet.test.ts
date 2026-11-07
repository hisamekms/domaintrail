// What a printed or exported diagram says it is (view/sheet.ts): its heading line and its file's name, for each view.
import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createViewService, ElkLayoutEngine } from '@domaintrail/visualization';
import { MESSAGES } from '../i18n';
import { stageChoice, type StormingChoice } from '../storming';
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
    test('an Event Storming view: the storming, its place, its level and its flow, in the view bar’s words, by display mode', async () => {
        const stormings = await stormingsOf(STAGES);
        const id = 'ConvenienceStoreIssuance';
        const stage = stormingSubject(stormings, choice({ timelines: { [id]: stageChoice('Issuance') } }))!;
        expect(sheetHeading('ws', stage, ja, 'label')).toBe(
            'ws › イベントストーミング › 住民票などのコンビニ交付（ビッグピクチャ） › コンビニでの発行 · デザインレベル · 例外も',
        );
        expect(sheetHeading('ws', stage, ja, 'name')).toBe('ws › イベントストーミング › ConvenienceStoreIssuance › Issuance · デザインレベル · 例外も');
        expect(sheetHeading('ws', stage, en, 'both')).toBe(
            'ws › Event Storming › 住民票などのコンビニ交付（ビッグピクチャ） (ConvenienceStoreIssuance) › コンビニでの発行 (Issuance) · Design Level · With exceptions',
        );
        // the whole storming, the main flows only (as an earlier version kept it)
        const all = stormingSubject(stormings, choice({ level: 'big-picture', exceptions: false }))!;
        expect(sheetHeading('ws', all, ja, 'label')).toBe(
            'ws › イベントストーミング › 住民票などのコンビニ交付（ビッグピクチャ） › すべて · ビッグピクチャー · 主な流れ',
        );
        // one exception's case: its stage, and the exception as the flow
        const branch = stormingSubject(stormings, choice({ timelines: { [id]: stageChoice('Issuance') }, flow: { exception: 'PinLockedBranch' } }))!;
        expect(sheetHeading('ws', branch, ja, 'label')).toBe(
            'ws › イベントストーミング › 住民票などのコンビニ交付（ビッグピクチャ） › コンビニでの発行 · デザインレベル · 例外: 暗証番号のロック',
        );
        // one main flow: its stage, and the main flow as the flow
        const main = stormingSubject(stormings, choice({ flow: { main: 'IssuanceFlow' } }))!;
        expect(sheetHeading('ws', main, ja, 'name')).toBe(
            'ws › イベントストーミング › ConvenienceStoreIssuance › Issuance · デザインレベル · 主な流れ: IssuanceFlow',
        );
        // a stage without exceptions: no flow to tell
        const preparation = stormingSubject(stormings, choice({ timelines: { [id]: stageChoice('Preparation') } }))!;
        expect(sheetHeading('ws', preparation, ja, 'name')).toBe('ws › イベントストーミング › ConvenienceStoreIssuance › Preparation · デザインレベル');
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
        expect(canvasSubject('catalog', { structureLevel: 'detail', mapAll: false, stormingChoice: choice() }, [], null, [])).toBeUndefined();
    });
});

describe('the name of an exported file', () => {
    test('is made of IDs, whatever the display mode, the parts a view does not have left out', async () => {
        const stormings = await stormingsOf(STAGES);
        const stage = stormingSubject(stormings, choice({ timelines: { ConvenienceStoreIssuance: stageChoice('Issuance') } }))!;
        expect(exportFileName('ws', stage, 'png')).toBe('ws-storming-ConvenienceStoreIssuance-Issuance-design-level.png');
        const all = stormingSubject(stormings, choice({ level: 'big-picture' }))!;
        expect(exportFileName('ws', all, 'svg')).toBe('ws-storming-ConvenienceStoreIssuance-all-big-picture.svg');
        // the flow: the main flows only, or the exception or the main flow drawn alone
        expect(exportFileName('ws', stormingSubject(stormings, choice({ flow: 'main' }))!, 'svg')).toBe(
            'ws-storming-ConvenienceStoreIssuance-all-main-design-level.svg',
        );
        const branch = stormingSubject(
            stormings,
            choice({ timelines: { ConvenienceStoreIssuance: stageChoice('Issuance') }, flow: { exception: 'PinLockedBranch' } }),
        )!;
        expect(exportFileName('ws', branch, 'png')).toBe('ws-storming-ConvenienceStoreIssuance-Issuance-PinLockedBranch-design-level.png');
        expect(exportFileName('shop', { view: 'contextMap', all: false }, 'png')).toBe('shop-context-map.png');
        expect(exportFileName('shop', { view: 'contextMap', all: true }, 'png')).toBe('shop-context-map-all.png');
        expect(exportFileName('shop', { view: 'structure', level: 'detail', contexts: [] }, 'svg')).toBe('shop-structure-detail.svg');
        expect(exportFileName('shop', { view: 'structure', level: 'aggregates', contexts: [{ id: 'Sales' }, { id: 'Billing' }] }, 'svg')).toBe(
            'shop-structure-Sales-Billing-aggregates.svg',
        );
        expect(exportFileName('shop', { view: 'states', aggregate: { id: 'Sales.Order', name: 'Order' } }, 'png')).toBe('shop-states-Sales.Order.png');
        expect(exportFileName(undefined, { view: 'contextMap', all: false }, 'png')).toBe('context-map.png');
    });

    test('keeps letters of any script and digits, and nothing a file system minds', () => {
        expect(slug('my ws/2026')).toBe('my-ws-2026');
        expect(slug('受注 管理')).toBe('受注-管理');
        expect(slug('..a:b*c?..')).toBe('a-b-c');
    });
});

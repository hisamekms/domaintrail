// The words a drawn diagram says, in the Live View's languages: the change badges, the line above a printed or exported
// diagram (`sheet.ts`) and the legend (`legend.ts`). The Live View's messages take them from here, so that the page and
// `dt export svg` say the same.
import type { StormingElementKind } from '@domaintrail/storming';
import type { Lang, StructureLevel } from '../graph/ir.js';
import type { ViewLevel } from '../storming/ir.js';

export interface DiagramTexts {
    /** The change badges. */
    added: string;
    changed: string;
    removed: string;
    worlds: { model: string; storming: string };
    views: { contextMap: string; structure: string };
    tabs: { states: string };
    /** The line above a printed or exported diagram: what it is and how it is shown. */
    sheet: {
        structureLevels: Record<StructureLevel, string>;
        allContexts: string;
        withExceptions: string;
        withoutExceptions: string;
    };
    stormingLevels: Record<ViewLevel, { label: string; hint: string }>;
    allTimelines: string;
    /** A timeline of a stage in the timeline picker. */
    stageTimeline: (stage: string, timeline: string) => string;
    /** An exception in the timeline picker. */
    exceptionTimeline: (name: string) => string;
    legend: string;
    legendRows: {
        mapReferences: string;
        mapDependsOn: string;
        owns: string;
        focusReferences: string;
        focusValue: string;
        references: string;
        value: string;
        aggregateReferences: string;
        aggregateValue: string;
        transition: string;
        esCausal: string;
        esSequence: string;
        esException: string;
        esRejoin: string;
        esRelated: string;
        esHotspot: string;
    };
    stormingArrowNote: string;
    stubNote: string;
    aggregateStubNote: string;
    arrowNote: string;
    internalNote: string;
    esKinds: Record<StormingElementKind, string>;
    /** A resolved hotspot: its chip in the storming legend's key. */
    resolvedHotspot: string;
}

const ja: DiagramTexts = {
    added: '追加',
    changed: '変更',
    removed: '削除',
    worlds: { model: 'ドメインモデル', storming: 'イベントストーミング' },
    views: { contextMap: 'コンテキストマップ', structure: '構造図' },
    tabs: { states: '状態遷移' },
    sheet: {
        structureLevels: { detail: '詳細', overview: '概観', aggregates: '集約' },
        allContexts: 'すべてのコンテキスト',
        withExceptions: '例外を含む',
        withoutExceptions: '例外を除く',
    },
    stormingLevels: {
        'big-picture': { label: 'ビッグピクチャー', hint: 'イベント・タイムライン・ホットスポットだけを表示' },
        'design-level': { label: 'デザインレベル', hint: 'コマンド・ポリシー・アクター・外部システム・集約・リードモデルも表示' },
    },
    allTimelines: 'すべて（統合）',
    stageTimeline: (stage, timeline) => `${stage} / ${timeline}`,
    exceptionTimeline: (name) => `例外：${name}`,
    legend: '凡例',
    legendRows: {
        mapReferences: 'ID だけで依存（ID 参照の件数）',
        mapDependsOn: '型も借りて依存（型の借用の件数）',
        owns: '所有（集約の内部）',
        focusReferences: '参照（ID で別の集約・BC へ）',
        focusValue: '値・型の借用（値オブジェクト / ユニオン / 列挙型 など）',
        references: '参照（ID で別の集約へ）',
        value: '値（値オブジェクト / ユニオンを持つ）',
        aggregateReferences: '参照（ID で別の集約へ。エンティティや値オブジェクトを経由するものも含む）',
        aggregateValue: '別の集約を値として持つ',
        transition: 'コマンドによる遷移（⇒ 発生させるドメインイベント）',
        esCausal: '型レベルの因果（コマンド → 集約 → イベント → ポリシー → コマンド。起こりうる関係で、実際に起きたとは限らない）',
        esSequence: 'タイムラインの時間順',
        esException: '例外の時間順',
        esRejoin: '例外から本流へ戻る',
        esRelated: 'コマンドのアクター・リードモデル（向きを持たない）',
        esHotspot: 'ホットスポットの対象（向きを持たない）',
    },
    stormingArrowNote: '矢印は因果と時間の向き',
    stubNote: '点線枠の小さな箱は別の BC の要素（スタブ）',
    aggregateStubNote: '点線枠の小さな箱は別の BC の集約（スタブ）',
    arrowNote: '矢印の先が依存先',
    internalNote: '状態の箱の中の ↻ は状態を変えないコマンド',
    esKinds: {
        event: 'イベント',
        command: 'コマンド',
        policy: 'ポリシー',
        actor: 'アクター',
        external: '外部システム',
        aggregate: '集約',
        readmodel: 'リードモデル',
        hotspot: 'ホットスポット',
        timeline: 'タイムライン',
        group: 'グループ',
        stage: '段階',
    },
    resolvedHotspot: '解決済みのホットスポット',
};

const en: DiagramTexts = {
    added: 'Added',
    changed: 'Changed',
    removed: 'Removed',
    worlds: { model: 'Domain model', storming: 'Event Storming' },
    views: { contextMap: 'Context Map', structure: 'Structure' },
    tabs: { states: 'States' },
    sheet: {
        structureLevels: { detail: 'Detail', overview: 'Overview', aggregates: 'Aggregates' },
        allContexts: 'All contexts',
        withExceptions: 'with exceptions',
        withoutExceptions: 'without exceptions',
    },
    stormingLevels: {
        'big-picture': { label: 'Big Picture', hint: 'Events, timelines and hotspots only' },
        'design-level': { label: 'Design Level', hint: 'Also commands, policies, actors, external systems, aggregates and read models' },
    },
    allTimelines: 'All (integrated)',
    stageTimeline: (stage, timeline) => `${stage} / ${timeline}`,
    exceptionTimeline: (name) => `Exception: ${name}`,
    legend: 'Legend',
    legendRows: {
        mapReferences: 'Depends by IDs only (ID references)',
        mapDependsOn: 'Also borrows types (borrowed types)',
        owns: 'Owns (inside an aggregate)',
        focusReferences: 'References (by ID, another aggregate or BC)',
        focusValue: 'Value or borrowed type (Value Object, Union, Enum…)',
        references: 'References (by ID, another aggregate)',
        value: 'Value (holds a Value Object or Union)',
        aggregateReferences: 'References (by ID, another aggregate, also through entities and value objects)',
        aggregateValue: 'Holds another aggregate as a value',
        transition: 'Transition by a command (⇒ events it raises)',
        esCausal: 'Type-level cause (command → aggregate → event → policy → command; a possibility, not something that happened)',
        esSequence: 'Time order of a timeline',
        esException: 'Time order of an exception',
        esRejoin: 'An exception returning to the main flow (then)',
        esRelated: 'A command’s actor or read model (no direction)',
        esHotspot: 'A hotspot’s subject (no direction)',
    },
    stormingArrowNote: 'Arrows point along causes and time',
    stubNote: 'Small dashed boxes are elements of other BCs (stubs)',
    aggregateStubNote: 'Small dashed boxes are aggregates of other BCs (stubs)',
    arrowNote: 'Arrows point at the dependency',
    internalNote: '↻ in a state’s box: a command that keeps the state',
    esKinds: {
        event: 'Event',
        command: 'Command',
        policy: 'Policy',
        actor: 'Actor',
        external: 'External system',
        aggregate: 'Aggregate',
        readmodel: 'Read model',
        hotspot: 'Hotspot',
        timeline: 'Timeline',
        group: 'Group',
        stage: 'Stage',
    },
    resolvedHotspot: 'Resolved hotspot',
};

export const DIAGRAM_TEXTS: Record<Lang, DiagramTexts> = { ja, en };

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
    };
    stormingLevels: Record<ViewLevel, { label: string; hint: string }>;
    /** The whole storming, as the place's picker names it beside its stages. */
    allTimelines: string;
    /** An exception named among the timelines. */
    exceptionTimeline: (name: string) => string;
    /** The flows of a view of a storming (the 流れ beside the place): their names, and one main flow or exception chosen. */
    flows: { main: string; all: string; exceptions: string; mainFlow: (name: string) => string; exception: (name: string) => string };
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
    },
    stormingLevels: {
        'big-picture': { label: 'ビッグピクチャー', hint: 'イベント・タイムライン・ホットスポットだけを表示' },
        'design-level': { label: 'デザインレベル', hint: 'コマンド・ポリシー・アクター・外部システム・集約・リードモデルも表示' },
    },
    allTimelines: 'すべて',
    exceptionTimeline: (name) => `例外：${name}`,
    flows: { main: '主な流れ', all: '例外も', exceptions: '例外', mainFlow: (name) => `主な流れ: ${name}`, exception: (name) => `例外: ${name}` },
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
        esCausal: '流れ（付箋どうしのつながり。線を選ぶと意味が出る）',
        esSequence: '時間の順（置き方で読めないところだけ：例外の分かれ目と元の流れへの戻り）',
        esHotspot: '問い（ホットスポットとその対象）',
    },
    stormingArrowNote: '矢印は流れと時間の向き',
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
    },
    stormingLevels: {
        'big-picture': { label: 'Big Picture', hint: 'Events, timelines and hotspots only' },
        'design-level': { label: 'Design Level', hint: 'Also commands, policies, actors, external systems, aggregates and read models' },
    },
    allTimelines: 'All',
    exceptionTimeline: (name) => `Exception: ${name}`,
    flows: {
        main: 'Main flows',
        all: 'With exceptions',
        exceptions: 'Exception',
        mainFlow: (name) => `Main flow: ${name}`,
        exception: (name) => `Exception: ${name}`,
    },
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
        esCausal: 'Flow (how the stickies connect; select a line for what it means)',
        esSequence: 'Time order (only where the placement cannot show it: an exception branching off, and returning)',
        esHotspot: 'Question (a hotspot and what it is about)',
    },
    stormingArrowNote: 'Arrows point along the flow and time',
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

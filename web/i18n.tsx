import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { DisplayMode, Lang } from '../src/graph/ir';
import type { ElementKind } from '../src/model/model';
import type { Connection } from './useViewSocket';
import type { CatalogSectionKey } from './model-utils';

/** The user's choice: follow the browser, or force a language. */
export type LangPreference = 'auto' | Lang;

/** localStorage key of the preference (JSON, like the other persisted settings). */
export const LANG_KEY = 'domaintrail.lang';

/** Kinds of item shown in the explorer and the inspector. */
export type ItemKind = ElementKind | 'state' | 'command' | 'context';

const ja = {
    added: '追加',
    changed: '変更',
    removed: '削除',
    none: 'なし',
    shared: '共有',
    /** After a context's name. */
    sharedTag: '共有',
    /** Events: declared `persistent`, or not. */
    persistent: '永続化',
    transient: '非永続',
    persistentHint: '永続化される契約のイベント（persistent）',
    transientHint: '永続化しないイベント（persistent の指定なし）',
    noModel: 'モデルがまだありません。',
    noDtFiles: '.dt ファイルがありません',

    // header
    nameDisplay: '名前の表示',
    nameDisplayHint: 'モデルの要素を、ラベル（日本語名など）と名前のどちらで表示するか',
    modes: { label: 'ラベル', name: '名前', both: '両方' } as Record<DisplayMode, string>,
    status: { ok: '正常', invalid: '検証エラー', 'syntax-error': '構文エラー', empty: '.dt なし' } as Record<string, string>,
    settings: '設定',
    closeSettings: '設定を閉じる',
    theme: 'テーマ',
    themes: { auto: '自動', light: 'ライト', dark: 'ダーク' },
    themeAuto: (now: string) => `OS の設定に従う（いまは${now}）`,
    themeHint: '画面の配色',
    language: '言語',
    langAuto: (now: string) => `ブラウザの設定に従う（いまは${now}）`,
    langHint: '画面の表示言語（モデルのラベルは変わりません）',
    fileCount: (n: number) => `${n} ファイル`,
    connection: { connecting: '接続中', open: '接続済み', closed: '切断' } as Record<Connection, string>,
    connectionTitle: (state: string) => `サーバーとの接続: ${state}`,
    stale: (problems: ReactNode): ReactNode => <>構文エラーのため、最後に解析できた図を表示しています。{problems}から該当箇所へ移動できます。</>,

    // panes
    openExplorer: 'エクスプローラを開く',
    closeExplorer: 'エクスプローラを閉じる',
    openInspector: 'インスペクタを開く',
    closeInspector: 'インスペクタを閉じる',
    openBottom: '問題・変更を開く',
    closeBottom: '問題・変更を閉じる',

    // views and their toolbar
    views: { contextMap: 'コンテキストマップ', structure: '構造図', catalog: 'カタログ' },
    showAllContexts: '共有・外部の BC も表示',
    structureMode: '構造図の表示',
    detail: '詳細',
    overview: '概観',
    zoomToFit: '全体表示',
    pickContexts: '表示する BC を選んでください',
    loading: '読み込み中…',
    noDiagram: '表示できる図がありません',

    // BC picker
    contextsToShow: '表示する BC',
    allContexts: 'すべての BC',
    moreContexts: (first: string, n: number) => `${first} ほか ${n} BC`,
    listSeparator: '、',
    hiddenContexts: (n: number) => ` · ${n} BC 非表示`,
    allStubs: 'スタブをまとめて表示',
    showAllStubs: 'すべてスタブとして表示する',
    hideAllStubs: 'すべてのスタブを表示しない',
    contextStubs: (ctx: string) => `${ctx} をスタブとして表示`,
    showStubs: 'スタブとして表示する',
    hideStubs: 'スタブを表示しない',

    // legend
    legend: '凡例',
    openLegend: '凡例を開く',
    closeLegend: '凡例を閉じる',
    legendRows: {
        mapReferences: 'ID だけで依存（ID 参照の件数）',
        mapDependsOn: '型も借りて依存（型の借用の件数）',
        owns: '所有（集約の内部）',
        focusReferences: '参照（ID で別の集約・BC へ）',
        focusValue: '値・型の借用（値オブジェクト / ユニオン / 列挙型 など）',
        references: '参照（ID で別の集約へ）',
        value: '値（値オブジェクト / ユニオンを持つ）',
        transition: 'コマンドによる遷移（⇒ 発生させるドメインイベント）',
    },
    stubNote: '点線枠の小さな箱は別の BC の要素（スタブ）',
    arrowNote: '矢印の先が依存先',

    // explorer
    model: 'モデル',
    files: 'ファイル',
    fileKind: 'ファイル',
    filter: 'フィルタ',
    clearFilter: 'フィルタを消す',
    onlyProblems: '問題のある項目だけ表示',
    onlyChanged: '変更された項目だけ表示',
    noMatches: '一致する項目はありません。',
    /** Kinds of item: the kind badges and the groups of elements. */
    kinds: {
        aggregate: '集約',
        entity: 'エンティティ',
        valueObject: '値オブジェクト',
        union: 'ユニオン',
        primitive: 'ドメインプリミティブ',
        id: 'ID',
        enum: '列挙型',
        event: 'ドメインイベント',
        error: 'エラー',
        state: '状態',
        command: 'コマンド',
        context: 'コンテキスト',
    } as Record<ItemKind, string>,

    // bottom pane
    problems: '問題',
    changes: '変更',
    noProblems: '問題はありません。',
    noChanges: '直前の正常モデルからの変更はありません。',

    // catalog
    catalogSections: {
        aggregates: '集約',
        entities: 'エンティティ',
        values: '値オブジェクト・ユニオン',
        primitives: 'ドメインプリミティブ',
        events: 'ドメインイベント',
        errors: 'エラー',
    } as Record<CatalogSectionKey, string>,
    sharedCatalog: '共有 · どの BC からも名前で参照可',
    catalogEmpty: 'ありません。',
    raisedByNone: '発生させるコマンドはありません',
    returnedByNone: '返すコマンドはありません',
    usedIn: (n: number) => `使用 ${n} 箇所`,

    // source
    copyLocation: 'パスと行をコピー',
    copied: 'コピーしました',
    copy: (text: string) => `${text} をコピー`,

    // inspector
    counted: (title: string, n: number) => `${title}（${n}）`,
    tabs: { structure: '構造', states: '状態遷移', behavior: '振る舞い', references: '参照', source: 'ソース' },
    reveal: { contextMap: 'コンテキストマップ', structure: '構造図', catalog: 'カタログ' },
    back: '戻る',
    forward: '進む',
    notInModel: (id: string) => `${id} は現在のモデルにありません。`,
    pickElement: 'エクスプローラや図で要素やファイルを選ぶと、ここに詳細が出ます。',
    showIn: '見る:',
    commandsInto: 'この状態に入るコマンド',
    commandsOutOf: 'この状態から出るコマンド',
    stateFields: 'この状態固有のフィールド',
    noStateFields: 'この状態固有のフィールドはありません。',
    stateInvariants: '不変条件（この状態のみ）',
    commonFieldsAt: (agg: ReactNode): ReactNode => <>共通フィールドは集約 {agg} を参照。</>,
    transition: '遷移',
    noStates: '（状態なし）',
    mayRaise: '発生し得るドメインイベント（0 件以上）',
    mayReturn: '返し得るエラー',
    params: 'パラメータ',
    noParams: 'パラメータはありません。',
    contract: '契約',
    identifier: 'ドメインプリミティブ（識別子）',
    separator: ' ／ ',
    baseType: '基底型',
    values: '値',
    discriminator: '判別子',
    noFields: 'フィールドはありません。',
    variantInvariants: (variant: string) => `不変条件（${variant}）`,
    commonFields: '共通フィールド',
    payload: 'ペイロード',
    fields: 'フィールド',
    invariants: '不変条件',
    allStateInvariants: '不変条件（全状態共通）',
    valueInvariants: '不変条件（値（value）に適用）',
    commands: 'コマンド',
    states: '状態',
    typeDependency: '型',
    focusContext: 'この BC だけを構造図で見る',
    dependencies: '依存先（この BC が使う）',
    dependents: '依存元（この BC を使う）',
    terms: '用語集（terms）',
    unreferenced: 'どこからも参照されていません。',
    raisedBy: '発生させるコマンド',
    returnedBy: '返すコマンド',
    typeUses: (n: number) => `型として使われている場所（${n}）`,
    idUses: (id: string, n: number) => `ID（${id}）で参照している場所（${n}）`,
    raises: (n: number) => `発生させるドメインイベント（${n}）`,
    returns: (n: number) => `返し得るエラー（${n}）`,
    labelSources: { term: '用語', type: '型' },
};

export type Messages = typeof ja;

const en: Messages = {
    added: 'Added',
    changed: 'Changed',
    removed: 'Removed',
    none: 'None',
    shared: 'Shared',
    sharedTag: 'shared',
    persistent: 'Persistent',
    transient: 'Transient',
    persistentHint: 'Persisted by contract (persistent)',
    transientHint: 'Not persisted (not declared persistent)',
    noModel: 'No model yet.',
    noDtFiles: 'No .dt files',

    nameDisplay: 'Names',
    nameDisplayHint: 'Whether model elements are shown by their labels, their names or both',
    modes: { label: 'Label', name: 'Name', both: 'Both' },
    status: { ok: 'OK', invalid: 'Invalid', 'syntax-error': 'Syntax error', empty: 'No .dt' },
    settings: 'Settings',
    closeSettings: 'Close the settings',
    theme: 'Theme',
    themes: { auto: 'Auto', light: 'Light', dark: 'Dark' },
    themeAuto: (now) => `Follows the OS (now ${now})`,
    themeHint: 'The colors of the screen',
    language: 'Language',
    langAuto: (now) => `Follows the browser (now ${now})`,
    langHint: 'The language of the screen (model labels stay as written)',
    fileCount: (n) => `${n} ${n === 1 ? 'file' : 'files'}`,
    connection: { connecting: 'connecting', open: 'connected', closed: 'disconnected' },
    connectionTitle: (state) => `Connection to the server: ${state}`,
    stale: (problems) => <>Showing the last diagram that could be parsed, because of a syntax error. See {problems} for where it is.</>,

    openExplorer: 'Open the explorer',
    closeExplorer: 'Close the explorer',
    openInspector: 'Open the inspector',
    closeInspector: 'Close the inspector',
    openBottom: 'Open problems and changes',
    closeBottom: 'Close problems and changes',

    views: { contextMap: 'Context Map', structure: 'Structure', catalog: 'Catalog' },
    showAllContexts: 'Also show shared and external BCs',
    structureMode: 'Structure view',
    detail: 'Detail',
    overview: 'Overview',
    zoomToFit: 'Fit',
    pickContexts: 'Pick the BCs to show',
    loading: 'Loading…',
    noDiagram: 'Nothing to draw',

    contextsToShow: 'BCs to show',
    allContexts: 'All BCs',
    moreContexts: (first, n) => `${first} and ${n} more`,
    listSeparator: ', ',
    hiddenContexts: (n) => ` · ${n} hidden`,
    allStubs: 'Show all stubs',
    showAllStubs: 'Show all as stubs',
    hideAllStubs: 'Hide all stubs',
    contextStubs: (ctx) => `Show ${ctx} as stubs`,
    showStubs: 'Show as stubs',
    hideStubs: 'Hide the stubs',

    legend: 'Legend',
    openLegend: 'Open the legend',
    closeLegend: 'Close the legend',
    legendRows: {
        mapReferences: 'Depends by IDs only (ID references)',
        mapDependsOn: 'Also borrows types (borrowed types)',
        owns: 'Owns (inside an aggregate)',
        focusReferences: 'References (by ID, another aggregate or BC)',
        focusValue: 'Value or borrowed type (Value Object, Union, Enum…)',
        references: 'References (by ID, another aggregate)',
        value: 'Value (holds a Value Object or Union)',
        transition: 'Transition by a command (⇒ events it raises)',
    },
    stubNote: 'Small dashed boxes are elements of other BCs (stubs)',
    arrowNote: 'Arrows point at the dependency',

    model: 'Model',
    files: 'Files',
    fileKind: 'File',
    filter: 'Filter',
    clearFilter: 'Clear the filter',
    onlyProblems: 'Show only items with problems',
    onlyChanged: 'Show only changed items',
    noMatches: 'Nothing matches.',
    kinds: {
        aggregate: 'Aggregate',
        entity: 'Entity',
        valueObject: 'Value Object',
        union: 'Union',
        primitive: 'Domain Primitive',
        id: 'ID',
        enum: 'Enum',
        event: 'Event',
        error: 'Error',
        state: 'State',
        command: 'Command',
        context: 'Context',
    },

    problems: 'Problems',
    changes: 'Changes',
    noProblems: 'No problems.',
    noChanges: 'No changes since the last valid model.',

    catalogSections: {
        aggregates: 'Aggregates',
        entities: 'Entities',
        values: 'Value Objects and Unions',
        primitives: 'Domain Primitives',
        events: 'Domain Events',
        errors: 'Errors',
    },
    sharedCatalog: 'Shared · referable by name from any context',
    catalogEmpty: 'None.',
    raisedByNone: 'No command raises it',
    returnedByNone: 'No command returns it',
    usedIn: (n) => `Used in ${n} ${n === 1 ? 'place' : 'places'}`,

    copyLocation: 'Copy the path and line',
    copied: 'Copied',
    copy: (text) => `Copy ${text}`,

    counted: (title, n) => `${title} (${n})`,
    tabs: { structure: 'Structure', states: 'States', behavior: 'Behavior', references: 'References', source: 'Source' },
    reveal: { contextMap: 'Context Map', structure: 'Structure', catalog: 'Catalog' },
    back: 'Back',
    forward: 'Forward',
    notInModel: (id) => `${id} is not in the current model.`,
    pickElement: 'Select an element or a file in the explorer or a diagram to see its details here.',
    showIn: 'Show in:',
    commandsInto: 'Commands into this state',
    commandsOutOf: 'Commands out of this state',
    stateFields: 'Fields of this state',
    noStateFields: 'This state has no fields of its own.',
    stateInvariants: 'Invariants (this state only)',
    commonFieldsAt: (agg) => <>For the common fields, see the aggregate {agg}.</>,
    transition: 'Transition',
    noStates: '(no states)',
    mayRaise: 'Events it may raise (zero or more)',
    mayReturn: 'Errors it may return',
    params: 'Parameters',
    noParams: 'No parameters.',
    contract: 'Contract',
    identifier: 'Domain Primitive (identifier)',
    separator: ' / ',
    baseType: 'Base type',
    values: 'Values',
    discriminator: 'Discriminator',
    noFields: 'No fields.',
    variantInvariants: (variant) => `Invariants (${variant})`,
    commonFields: 'Common fields',
    payload: 'Payload',
    fields: 'Fields',
    invariants: 'Invariants',
    allStateInvariants: 'Invariants (all states)',
    valueInvariants: 'Invariants (on the value)',
    commands: 'Commands',
    states: 'States',
    typeDependency: 'type',
    focusContext: 'Show only this BC in Structure',
    dependencies: 'Dependencies (used by this BC)',
    dependents: 'Dependents (using this BC)',
    terms: 'Terms',
    unreferenced: 'Not referenced anywhere.',
    raisedBy: 'Commands that raise it',
    returnedBy: 'Commands that return it',
    typeUses: (n) => `Used as a type (${n})`,
    idUses: (id, n) => `Referenced by ID ${id} (${n})`,
    raises: (n) => `Events it raises (${n})`,
    returns: (n) => `Errors it may return (${n})`,
    labelSources: { term: 'term', type: 'type' },
};

export const MESSAGES: Record<Lang, Messages> = { ja, en };

/** Names of the languages, each in itself. */
export const LANG_NAMES: Record<Lang, string> = { ja: '日本語', en: 'English' };

const browserLang = (): Lang => (navigator.languages.some((l) => l.toLowerCase().startsWith('ja')) ? 'ja' : 'en');

/** The language to show: the preference, or the browser's for `auto` (kept up to date when it changes). */
export function useResolvedLang(preference: LangPreference): Lang {
    const [browser, setBrowser] = useState(browserLang);
    useEffect(() => {
        const onChange = () => setBrowser(browserLang());
        window.addEventListener('languagechange', onChange);
        return () => window.removeEventListener('languagechange', onChange);
    }, []);
    return preference === 'auto' ? browser : preference;
}

const I18n = createContext<{ lang: Lang; t: Messages }>({ lang: 'ja', t: ja });

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
    useEffect(() => {
        document.documentElement.lang = lang;
    }, [lang]);
    return <I18n.Provider value={{ lang, t: MESSAGES[lang] }}>{children}</I18n.Provider>;
}

/** The Live View's words in the current language. */
export const useT = (): Messages => useContext(I18n).t;
export const useLang = (): Lang => useContext(I18n).lang;

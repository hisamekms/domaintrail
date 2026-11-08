// What a person can do with the stickies of the Event Storming canvas (ADR 0033): one list of actions, from which the
// toolbar above the selection, the menu (「…」 and right-click), the keys and the command palette (⌘K) are all drawn, so
// that an action added here shows everywhere at once. Each action says which stickies it applies to (their kind and
// what they have, e.g. a `ref` to `.dt`), whether it works on several selected at once, and whether it is frequent (a
// button of the toolbar; the others are in 「…」). What an action does is the layer's (`layer.tsx`), by its ID.
//
// ナレッジを見る opens the sticky's knowledge (ADR 0031) in the detail: offered only where the session keeps knowledge and
// the sticky has some.
import { CircleCheck, Eye, Lightbulb, Link, MessageCircleQuestionMark, MessageSquarePlus, PencilLine, type LucideIcon } from 'lucide-react';
import {
    firstDeclarations,
    type NodeElementKind,
    type StormingElementKind,
    stormingTimelines,
    timelineOccurrences,
    type Storming,
} from '@domaintrail/storming';

/** A sticky of the canvas: a storming's element drawn as a note, with what the actions ask of it. */
export interface Sticky {
    /** The selection ID: `es/<Storming>/<Local>`. */
    readonly id: string;
    readonly storming: string;
    readonly local: string;
    readonly kind: NodeElementKind;
    readonly label?: string;
    /** The `.dt` path its `ref` names (`Sales.Order.place`), when it has one. */
    readonly ref?: string;
    /** The timelines it occurs in (an event's), in declaration order. */
    readonly timelines: readonly string[];
    /** A hotspot written `status resolved`. */
    readonly resolved: boolean;
    /** A hotspot's resolution, when it has one. */
    readonly resolution?: string;
}

/** A field of a sticky that a person edits in its window. */
export type StickyFieldId = 'label' | 'name' | 'question' | 'resolution';

export interface StickyField {
    readonly id: StickyFieldId;
    /** One line (an input: Enter saves), or several (a text area: Enter a new line, ⌘/Ctrl+Enter saves). */
    readonly lines: 'one' | 'several';
}

/** The label and the name (with the references a new name rewrites). */
const WORDING: readonly StickyField[] = [
    { id: 'label', lines: 'one' },
    { id: 'name', lines: 'one' },
];

/**
 * The fields a person edits, by kind: the edit window is built from them. A hotspot's name is the system's (provisional,
 * then the AI's): never one of its fields, and editing its question never renames it. A field is added here for a kind.
 */
export const EDIT_FIELDS: Readonly<Record<NodeElementKind, readonly StickyField[]>> = {
    event: WORDING,
    command: WORDING,
    aggregate: WORDING,
    actor: WORDING,
    external: WORDING,
    readmodel: WORDING,
    policy: WORDING,
    hotspot: [
        { id: 'question', lines: 'several' },
        { id: 'resolution', lines: 'several' },
    ],
};

/** Where the actions are offered: what the page can do now. */
export interface ActionContext {
    /** A live session: the files can be written (edits) and the chat takes targets. */
    readonly live: boolean;
    /** The timeline the view shows, if it shows one. */
    readonly timelineShown?: string;
    /** Whether the `.dt` element a sticky's `ref` names is in the model now. */
    readonly hasModelElement: (sticky: Sticky) => boolean;
    /** Whether a sticky has knowledge; absent where the session keeps none (no store): ナレッジを見る is never offered. */
    readonly hasKnowledge?: (sticky: Sticky) => boolean;
}

export type StickyActionId = 'chat' | 'edit' | 'knowledge' | 'seeModel' | 'seeTimeline' | 'addHotspot' | 'resolve' | 'copyLink';

/** A key that runs an action while stickies are selected (and nothing that takes text has the focus). */
export interface Shortcut {
    readonly key: string;
    /** ⌘ on a Mac, Ctrl elsewhere. */
    readonly mod?: boolean;
    readonly shift?: boolean;
}

/** The groups of the menu, in its order. */
export const ACTION_GROUPS = ['frequent', 'see', 'write', 'other'] as const;
export type ActionGroup = (typeof ACTION_GROUPS)[number];

export interface StickyAction {
    readonly id: StickyActionId;
    readonly icon: LucideIcon;
    readonly group: ActionGroup;
    /** A button of the toolbar (the others are in 「…」): always, or for some stickies (a hotspot's 解決を書く). */
    readonly frequent: boolean | ((sticky: Sticky) => boolean);
    /** It applies to several stickies selected at once. */
    readonly multi: boolean;
    readonly shortcut?: Shortcut;
    /** Whether it applies to `sticky` here (for several, to each of them). */
    readonly applies: (sticky: Sticky, context: ActionContext) => boolean;
    /**
     * An action that opens the edit window: which of the kind's fields (`EDIT_FIELDS`) it shows, in the kind's order
     * (編集: the label and the name, or a hotspot's question; 解決を書く: the resolution).
     */
    readonly edits?: readonly StickyFieldId[];
}

/** The fields an editing action's window shows for a sticky: those of its kind the action edits. */
export const windowFields = (action: Pick<StickyAction, 'edits'>, sticky: Pick<Sticky, 'kind'>): StickyField[] =>
    EDIT_FIELDS[sticky.kind].filter((f) => action.edits?.includes(f.id) === true);

/** The kinds a hotspot can be put on: any sticky but a hotspot (the grammar's `hotspot { on <any sticky> }`). */
export const HOTSPOT_TARGETS: readonly NodeElementKind[] = ['event', 'command', 'policy', 'aggregate', 'readmodel', 'actor', 'external'];

/** The kinds whose `ref` names a `.dt` element (docs/dtes-v0.1.md §5.1). */
const REF_KINDS: readonly NodeElementKind[] = ['event', 'command', 'aggregate'];

export const STICKY_ACTIONS: readonly StickyAction[] = [
    { id: 'chat', icon: MessageSquarePlus, group: 'frequent', frequent: true, multi: true, shortcut: { key: 'Enter' }, applies: (_, c) => c.live },
    {
        id: 'edit',
        icon: PencilLine,
        group: 'frequent',
        frequent: true,
        multi: false,
        shortcut: { key: 'F2' },
        applies: (_, c) => c.live,
        edits: ['label', 'name', 'question'],
    },
    { id: 'knowledge', icon: Lightbulb, group: 'see', frequent: false, multi: false, applies: (s, c) => c.hasKnowledge?.(s) === true },
    {
        id: 'seeModel',
        icon: Eye,
        group: 'see',
        frequent: false,
        multi: false,
        applies: (s, c) => REF_KINDS.includes(s.kind) && s.ref !== undefined && c.hasModelElement(s),
    },
    {
        id: 'seeTimeline',
        icon: Eye,
        group: 'see',
        frequent: false,
        multi: false,
        // shown elsewhere than in a timeline it occurs in
        applies: (s, c) => s.timelines.length > 0 && (c.timelineShown === undefined || !s.timelines.includes(c.timelineShown)),
    },
    {
        id: 'addHotspot',
        icon: MessageCircleQuestionMark,
        group: 'write',
        frequent: false,
        multi: false,
        applies: (s, c) => c.live && HOTSPOT_TARGETS.includes(s.kind),
    },
    // a hotspot's own frequent action: on its toolbar beside 編集 (解決を直す once resolved)
    {
        id: 'resolve',
        icon: CircleCheck,
        group: 'write',
        frequent: true,
        multi: false,
        applies: (s, c) => c.live && s.kind === 'hotspot',
        edits: ['resolution'],
    },
    { id: 'copyLink', icon: Link, group: 'other', frequent: false, multi: false, shortcut: { key: 'c', mod: true, shift: true }, applies: () => true },
];

/** The actions that apply to the selected stickies (several: those that work on several, applying to each), in the list's order. */
export function actionsFor(stickies: readonly Sticky[], context: ActionContext, actions: readonly StickyAction[] = STICKY_ACTIONS): StickyAction[] {
    if (stickies.length === 0) return [];
    return actions.filter((a) => (stickies.length === 1 || a.multi) && stickies.every((s) => a.applies(s, context)));
}

/** The actions of the toolbar among those that apply: the frequent ones, for every selected sticky. */
export const toolbarActions = (actions: readonly StickyAction[], stickies: readonly Sticky[]): StickyAction[] =>
    actions.filter((a) => {
        const frequent = a.frequent;
        return typeof frequent === 'function' ? stickies.every((s) => frequent(s)) : frequent;
    });

/** The action a key press runs among `actions`, if any. */
export function actionOfKey(
    e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
    actions: readonly StickyAction[],
    mac: boolean,
): StickyAction | undefined {
    if (e.altKey) return undefined;
    const mod = mac ? e.metaKey : e.ctrlKey;
    return actions.find((a) => {
        const s = a.shortcut;
        if (!s) return false;
        if (e.key.toLowerCase() !== s.key.toLowerCase()) return false;
        return (s.mod === true) === mod && (s.shift === true) === e.shiftKey && (mac ? !e.ctrlKey : !e.metaKey);
    });
}

/** A shortcut as the menu and the tooltips show it: `⌘⇧C` on a Mac, `Ctrl+Shift+C` elsewhere. */
export function shortcutText(s: Shortcut, mac: boolean): string {
    const key = s.key.length === 1 ? s.key.toUpperCase() : s.key;
    if (mac) return `${s.mod ? '⌘' : ''}${s.shift ? '⇧' : ''}${key}`;
    return [...(s.mod ? ['Ctrl'] : []), ...(s.shift ? ['Shift'] : []), key].join('+');
}

/**
 * Whether Escape clears the stickies' selection from where the focus is (the layer's fallback): only when the focus is
 * nowhere — a window, a menu or the palette just closed, a pick of the palette moved it nowhere — with stickies
 * selected and no window or menu open. A focused canvas clears it itself; a field, a button or the palette keeps it.
 */
export function escapeClearsSelection(e: { key: string; isComposing: boolean }, state: { focusNowhere: boolean; selected: number; open: boolean }): boolean {
    return e.key === 'Escape' && !e.isComposing && state.focusNowhere && state.selected > 0 && !state.open;
}

/** Whether the page runs on a Mac (its shortcuts use ⌘). */
export const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const NODE_KINDS: ReadonlySet<StormingElementKind> = new Set(['event', 'actor', 'external', 'command', 'policy', 'aggregate', 'readmodel', 'hotspot']);
const isNodeKind = (k: StormingElementKind): k is NodeElementKind => NODE_KINDS.has(k);

/** The sticky a selection ID names (`es/<Storming>/<Local>`), when it is a node element of a storming shown. */
export function stickyOf(stormings: readonly { readonly id: string; readonly storming: Storming }[], id: string): Sticky | undefined {
    const [prefix, stormingId, local, ...rest] = id.split('/');
    if (prefix !== 'es' || stormingId === undefined || local === undefined || rest.length > 0) return undefined;
    const storming = stormings.find((s) => s.id === stormingId)?.storming;
    const declaration = storming && firstDeclarations(storming).get(local);
    if (!storming || !declaration || !isNodeKind(declaration.kind) || !('clauses' in declaration)) return undefined;
    const ref = declaration.clauses.find((c) => c.type === 'ref');
    const resolution = declaration.clauses.find((c) => c.type === 'resolution');
    const timelines =
        declaration.kind === 'event' ? stormingTimelines(storming).flatMap((t) => (timelineOccurrences(t).some((o) => o.eventId === local) ? [t.id] : [])) : [];
    return {
        id,
        storming: stormingId,
        local,
        kind: declaration.kind,
        ...(declaration.label !== undefined && { label: declaration.label }),
        ...(ref?.type === 'ref' && { ref: ref.path }),
        timelines,
        resolved: declaration.clauses.some((c) => c.type === 'status' && c.value === 'resolved'),
        ...(resolution?.type === 'resolution' && { resolution: resolution.text }),
    };
}

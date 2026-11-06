// Where the others are, as the session's participant list shows it (ADR 0026, Presence), without React: each
// participant's whereabouts seen from this page, the view a location stands for (to name it, to open it, and to send
// it with a message), and the small rules of the chat's layout (consecutive bubbles of one author, the send shortcut's name).
import type { Me, SendRequestBody, SessionStateBody, ViewLocation } from '@domaintrail/collaboration/protocol';
import { type DisplayMode, STRUCTURE_LEVELS, type StructureLevel, VIEW_LEVELS, type ViewLevel } from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { type CatalogFilter, nameIn } from '../model-utils';
import type { View } from '../view/navigation';
import type { ViewSettings } from '../view/settings';
import { sameLocation } from './location';
import { listedParticipants, type Peers, type Whereabouts } from './presence';
import { participantNames } from './stream';

/** The view a location stands for: what opening it shows (its camera is not part of it). */
export type ViewTarget =
    | { readonly kind: 'contextMap'; readonly all: boolean }
    | {
          readonly kind: 'structure';
          readonly level: StructureLevel;
          readonly focus?: { readonly contexts: readonly string[]; readonly hidden: readonly string[] };
      }
    | { readonly kind: 'catalog' }
    | { readonly kind: 'storming'; readonly stormingId: string; readonly level: ViewLevel; readonly timelineId?: string };

const isStructureLevel = (s: string): s is StructureLevel => STRUCTURE_LEVELS.some((l) => l === s);
const isViewLevel = (s: string): s is ViewLevel => VIEW_LEVELS.some((l) => l === s);
const list = (s: string): string[] => (s ? s.split('+') : []);

/**
 * The view of a location: a `.dt` view by its view key (`contextMap:<all>`, `structure:<level>`,
 * `structure:focus:<contexts>|<hidden>|<level>`, `catalog`), a storming by its storming, level and timeline. Undefined
 * for a key this page does not know.
 */
export function viewTargetOf(location: ViewLocation): ViewTarget | undefined {
    if (location.kind === 'dtes') {
        if (!isViewLevel(location.level)) return undefined;
        return {
            kind: 'storming',
            stormingId: location.stormingId,
            level: location.level,
            ...(location.timelineId !== undefined && { timelineId: location.timelineId }),
        };
    }
    const key = location.viewKey;
    if (key === 'catalog') return { kind: 'catalog' };
    if (key === 'contextMap:true' || key === 'contextMap:false') return { kind: 'contextMap', all: key === 'contextMap:true' };
    if (key.startsWith('structure:focus:')) {
        const [contexts, hidden, level] = key.slice('structure:focus:'.length).split('|');
        if (contexts === undefined || hidden === undefined || level === undefined || !isStructureLevel(level) || !contexts) return undefined;
        return { kind: 'structure', level, focus: { contexts: list(contexts), hidden: list(hidden) } };
    }
    if (key.startsWith('structure:')) {
        const level = key.slice('structure:'.length);
        return isStructureLevel(level) ? { kind: 'structure', level } : undefined;
    }
    return undefined;
}

/** What opening a view changes: the view shown, and the settings that make it. */
export interface ViewOpener {
    readonly setView: (v: View) => void;
    readonly settings: Pick<
        ViewSettings,
        'stormingChoice' | 'setStormingChoice' | 'setMapAll' | 'setStructureLevel' | 'setStructureContexts' | 'setHiddenContexts'
    >;
}

/**
 * Opens a view (as it is: not its camera) through `to` — the reader's setters (「→」 on another participant's row, the
 * guide's places) or the bare ones (following a participant).
 */
export function openViewTarget(target: ViewTarget, to: ViewOpener): void {
    const { setView, settings } = to;
    switch (target.kind) {
        case 'catalog':
            return setView({ kind: 'catalog' });
        case 'contextMap':
            settings.setMapAll(target.all);
            return setView({ kind: 'contextMap' });
        case 'structure':
            settings.setStructureLevel(target.level);
            settings.setStructureContexts(target.focus ? [...target.focus.contexts] : null);
            if (target.focus) settings.setHiddenContexts([...target.focus.hidden]);
            return setView({ kind: 'structure' });
        case 'storming': {
            const choice = settings.stormingChoice;
            const { [target.stormingId]: _, ...others } = choice.timelines;
            settings.setStormingChoice({
                ...choice,
                stormingId: target.stormingId,
                level: target.level,
                timelines: target.timelineId === undefined ? others : { ...others, [target.stormingId]: target.timelineId },
            });
            return setView({ kind: 'storming' });
        }
    }
}

/** Longest catalog filter a message carries (the server's `VIEWED_AT_LIMITS.query`). */
const VIEWED_AT_QUERY = 200;

/** Where the page was looking, as a message carries it (`SendRequestBody.viewedAt`). */
export type SentView = NonNullable<SendRequestBody['viewedAt']>;

const STRUCTURE_DETAIL = { detail: 'Detail', overview: 'Overview', aggregates: 'Aggregates' } as const;

/**
 * The view a message is sent from: the location's view (`viewTargetOf`), with what the location does not tell — a
 * storming's stage and whether its exceptions are shown, the catalog's filter — and the aggregate whose state diagram
 * the inspector shows. Undefined for a view this page cannot name (one still loading).
 */
export function sentView(input: {
    readonly location: ViewLocation;
    /** The storming view's stage and exceptions (`ViewOptions`). */
    readonly storming?: { readonly stageId?: string; readonly hideExceptions?: true };
    /** The catalog's filter. */
    readonly catalog?: CatalogFilter;
    /** The aggregate whose state diagram the inspector shows. */
    readonly states?: string;
}): SentView | undefined {
    const target = viewTargetOf(input.location);
    if (!target) return undefined;
    const states = input.states === undefined ? {} : { states: input.states };
    switch (target.kind) {
        case 'contextMap':
            return { view: { kind: 'ContextMap', all: target.all }, ...states };
        case 'structure':
            return { view: { kind: 'Structure', level: STRUCTURE_DETAIL[target.level], focus: target.focus?.contexts ?? [] }, ...states };
        case 'catalog': {
            const f = input.catalog;
            const query = f?.query.trim();
            return {
                view: { kind: 'Catalog', ...(query && { query: query.slice(0, VIEWED_AT_QUERY) }), sections: f?.sections ?? [], contexts: f?.contexts ?? [] },
                ...states,
            };
        }
        case 'storming': {
            const stage = input.storming?.stageId;
            return {
                view: {
                    kind: 'Storming',
                    storming: target.stormingId,
                    level: target.level === 'design-level' ? 'DesignLevel' : 'BigPicture',
                    ...(target.timelineId !== undefined ? { timeline: target.timelineId } : stage !== undefined && { stage }),
                    exceptions: !input.storming?.hideExceptions,
                },
                ...states,
            };
        }
    }
}

/** The words a view's name is made of, in the page's language. */
export interface ViewWords {
    readonly views: Readonly<Record<'contextMap' | 'structure' | 'catalog' | 'storming', string>>;
    readonly structureLevels: Readonly<Record<StructureLevel, string>>;
    readonly stormingLevels: Readonly<Record<ViewLevel, string>>;
    /** The context map with every context. */
    readonly allContexts: string;
}

/** What a view's name and whether it opens depend on: the model's contexts and the stormings, named in the display mode. */
export interface ViewScope {
    readonly mode: DisplayMode;
    readonly contexts: readonly string[];
    readonly contextLabels: Readonly<Record<string, string>>;
    readonly stormings: readonly Pick<StormingView, 'id' | 'label' | 'timelines'>[];
}

/** A readable name of a view: `構造図 · 詳細`, `構造図 · 販売 + 請求`, `配送キャンセル · デザインレベル · 通常キャンセル`. */
export function viewName(target: ViewTarget, words: ViewWords, scope: ViewScope): string {
    switch (target.kind) {
        case 'catalog':
            return words.views.catalog;
        case 'contextMap':
            return target.all ? `${words.views.contextMap} · ${words.allContexts}` : words.views.contextMap;
        case 'structure': {
            const level = words.structureLevels[target.level];
            if (!target.focus) return `${words.views.structure} · ${level}`;
            const contexts = target.focus.contexts.map((c) => nameIn(scope.mode, c, scope.contextLabels[c])).join(' + ');
            return `${words.views.structure} · ${contexts} · ${level}`;
        }
        case 'storming': {
            const storming = scope.stormings.find((s) => s.id === target.stormingId);
            const timeline = target.timelineId === undefined ? undefined : storming?.timelines.find((t) => t.id === target.timelineId);
            return [
                nameIn(scope.mode, target.stormingId, storming?.label),
                words.stormingLevels[target.level],
                ...(target.timelineId === undefined ? [] : [nameIn(scope.mode, target.timelineId, timeline?.label)]),
            ].join(' · ');
        }
    }
}

/** Whether this page can show a view: its contexts, storming and timeline still exist. */
export function canOpen(target: ViewTarget, scope: ViewScope): boolean {
    switch (target.kind) {
        case 'catalog':
        case 'contextMap':
            return true;
        case 'structure':
            return !target.focus || target.focus.contexts.every((c) => scope.contexts.includes(c));
        case 'storming': {
            const storming = scope.stormings.find((s) => s.id === target.stormingId);
            return !!storming && (target.timelineId === undefined || storming.timelines.some((t) => t.id === target.timelineId));
        }
    }
}

/** A participant in the list: where they are, and the location of the view they are on when it is another one. */
export interface ParticipantRow {
    readonly id: string;
    readonly name: string;
    readonly role: 'facilitator' | 'participant';
    readonly me: boolean;
    readonly where: Whereabouts;
    readonly avatarUrl?: string;
    /** Another view's location (one of their pages'). */
    readonly location?: ViewLocation;
}

/**
 * Everyone, one row per person: me first, then those on this view, on another view, and offline, by name within
 * each. A participant with pages on several views is on this view when one of them is.
 */
export function participantRows(
    state: Pick<SessionStateBody, 'session' | 'facilitatorHolder'>,
    peers: Peers,
    me: Me,
    mine: ViewLocation | undefined,
): ParticipantRow[] {
    const names = participantNames(state, peers, me);
    const order: Record<Whereabouts, number> = { here: 0, 'same-view': 1, 'another-view': 2, away: 3 };
    return listedParticipants(state)
        .map((p): ParticipantRow => {
            const pages = [...peers.values()].filter((x) => x.participant.id === p.id);
            const isMe = p.id === me.participant.id;
            const avatarUrl = isMe ? me.participant.avatarUrl : pages.find((x) => x.participant.avatarUrl)?.participant.avatarUrl;
            const base = { id: p.id, name: names.get(p.id) ?? p.name, role: p.role, me: isMe, ...(avatarUrl && { avatarUrl }) };
            if (isMe) return { ...base, where: 'here' };
            if (pages.length === 0) return { ...base, where: 'away' };
            if (pages.some((x) => sameLocation(x.location, mine))) return { ...base, where: 'same-view' };
            return { ...base, where: 'another-view', location: pages[0].location };
        })
        .sort((a, b) => order[a.where] - order[b.where] || a.name.localeCompare(b.name));
}

/** For each bubble of the stream, whether it continues the one before (same author, nothing between): then it shows no avatar nor name. */
export function continued(authors: readonly (string | undefined)[]): boolean[] {
    return authors.map((a, i) => a !== undefined && i > 0 && authors[i - 1] === a);
}

/** Whether the page runs on a Mac (⌘ rather than Ctrl), from `navigator.platform` or the user agent. */
export const isMac = (platform: string): boolean => /mac|iphone|ipad|ipod/i.test(platform);

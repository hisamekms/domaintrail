// The stickies' actions on the Event Storming canvas (ADR 0033), all drawn from the one list of `registry.ts`:
//
// - the toolbar above the selected stickies (below them when there is no room), shown on selection, never on hover:
//   the frequent actions as icon buttons, then 「…」; with several selected, how many and the actions for several only;
// - the menu of every action that applies, by group with their keys, from 「…」 or a right-click on a sticky;
// - the keys while stickies are selected: Enter adds them to the chat, F2 edits, ⌘⇧C copies the link (Escape, which
//   clears the selection, is the canvas's own); a double-click edits;
// - the command palette's items (⌘K): the actions on the selection, and every sticky by name;
// - the windows anchored to a sticky that edit it (`forms.tsx`), and a short status line (「編集しました」).
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, Ellipsis } from 'lucide-react';
import type { DomainModel } from '@domaintrail/modeling';
import type { DisplayMode } from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { useT, type Messages } from '../i18n';
import { namer, nameIn } from '../model-utils';
import { ActionMenu, type MenuItem } from '../shared/menu';
import type { PaletteItem } from '../shared/palette';
import { dtTarget } from '../storming';
import { TOOLTIP_ATTR } from '../tooltip';
import { useCanvasValue, type DiagramCanvas } from '../view/diagram';
import { isTyping } from '../session/selection';
import { EditForm, HotspotForm, ResolveForm, type Anchor, type SaveResult } from './forms';
import { elementLink } from './link';
import {
    actionOfKey,
    actionsFor,
    escapeClearsSelection,
    isMac,
    shortcutText,
    stickyOf,
    toolbarActions,
    type ActionContext,
    type Sticky,
    type StickyAction,
    type StickyActionId,
} from './registry';

/** A person's edit as the page sends it (`POST /api/session/stickies`). */
export type StickyEditRequest =
    | {
          readonly kind: 'wording';
          readonly storming: string;
          readonly element: string;
          readonly expected: { readonly name: string; readonly label?: string };
          readonly label?: string;
          readonly name?: string;
      }
    /** A new hotspot: its name is not asked, the AI (else dt) gives it; the sticky's label and kind are for the AI. */
    | {
          readonly kind: 'addHotspot';
          readonly storming: string;
          readonly on: string;
          readonly label: string;
          readonly onLabel?: string;
          readonly onKind?: string;
      }
    | { readonly kind: 'resolveHotspot'; readonly storming: string; readonly element: string; readonly resolution: string };

/** Why the server refused an edit, as the window says it. */
export interface EditRefusal {
    readonly type: string;
    readonly current?: { readonly name: string; readonly label?: string };
}

/** What an edit wrote, as far as the page needs it: a new hotspot's name. */
export interface StickyWritten {
    readonly hotspot?: string;
}

/** What the session gives the actions: none outside a session (`dt view`), where only seeing and copying are offered. */
export interface StickySession {
    /** The session takes messages and edits now. */
    readonly live: boolean;
    /** The chat's targets: whether the selection is added already, and adding it (the composer opens). */
    readonly chat: { readonly added: boolean; readonly add: () => void };
    /** Hotspots the AI renamed after a person added them (ADR 0033): their provisional selection ID → their name's. */
    readonly renamed: ReadonlyMap<string, string>;
    /** Writes an edit: resolves when written, rejects with the refusal. */
    readonly edit: (edit: StickyEditRequest, body: string) => Promise<StickyWritten>;
}

export interface StickyActionsInput {
    readonly canvas: DiagramCanvas | null;
    readonly stormings: readonly StormingView[];
    readonly model: DomainModel | null;
    readonly mode: DisplayMode;
    /** The canvas shows a storming view (the toolbar and the keys act there only). */
    readonly active: boolean;
    /** The timeline the view shows, if it shows one. */
    readonly timelineShown?: string;
    readonly session: StickySession | undefined;
    /** Shows a `.dt` element in the domain model (the view that suits it), from the sticky `from`. */
    readonly onSeeModel: (dtId: string, from: string) => void;
    /** Shows a timeline of a storming, then selects `then` in it. */
    readonly onSeeTimeline: (storming: string, timeline: string, then: string) => void;
    /** Shows a sticky: its storming's view that draws it, selected. */
    readonly onOpenSticky: (id: string) => void;
    /** The session's knowledge (ADR 0031): which stickies have some, and showing a sticky's in the detail; absent without a store. */
    readonly knowledge?: { readonly has: (id: string) => boolean; readonly open: (id: string) => void };
}

export interface StickyActions {
    /** Drawn over the canvas: the toolbar, the menu, the windows, the status line. */
    readonly overlay: ReactNode;
    /** The command palette's items: the actions on the selection, then every sticky by name. */
    readonly palette: readonly PaletteItem[];
}

type Form = { readonly kind: 'edit' | 'hotspot' | 'resolve'; readonly sticky: Sticky; readonly anchor: Anchor };

/** Gives the canvas the keyboard focus (its own keys: Escape clears the selection), without scrolling the page. */
export const focusCanvas = (canvas: DiagramCanvas): void => canvas.container().focus({ preventScroll: true });

const BAR_HEIGHT = 32;
const GAP = 6;

const isRefusal = (e: unknown): e is EditRefusal => typeof e === 'object' && e !== null && 'type' in e && typeof e.type === 'string';

const errorText = (t: Messages, e: unknown): string => {
    if (!isRefusal(e)) return t.stickies.edit.failed(e instanceof Error ? e.message : String(e));
    if (e.type === 'StickyStale' && e.current) return t.stickies.edit.stale(e.current.label ?? e.current.name);
    return t.stickies.edit.failed(e.type);
};

export function useStickyActions(input: StickyActionsInput): StickyActions {
    const { canvas, stormings, model, mode, session, active } = input;
    const t = useT();
    const s = t.stickies;
    const mac = useMemo(isMac, []);
    const [menu, setMenu] = useState<{ x: number; y: number } | undefined>();
    const [form, setForm] = useState<Form | undefined>();
    const [status, setStatus] = useState<string | undefined>();
    const [follow, setFollow] = useState<string | undefined>();
    const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const say = useCallback((text: string) => {
        setStatus(text);
        clearTimeout(statusTimer.current);
        statusTimer.current = setTimeout(() => setStatus(undefined), 1800);
    }, []);

    // the stickies selected on the canvas, and where the toolbar goes
    const selectedKey = useCanvasValue(
        canvas,
        (c) => (c ? [...new Set(c.selectedIds().flatMap((id) => c.item(id)?.elementId ?? []))].filter((e) => e.startsWith('es/')).join('\n') : ''),
        [],
    );
    const selected = useMemo(() => (selectedKey ? selectedKey.split('\n').flatMap((id) => stickyOf(stormings, id) ?? []) : []), [selectedKey, stormings]);
    const at = useCanvasValue(
        canvas,
        (c) => {
            if (!c || c.isMoving() || c.selectedIds().length === 0) return undefined;
            const b = c.selectionBounds();
            if (!b) return undefined;
            const top = c.pageToViewport({ x: b.x, y: b.y });
            const bottom = c.pageToViewport({ x: b.x, y: b.y + b.h });
            const { w, h } = c.viewportScreenBounds();
            if (top.x > w || bottom.y < 0 || top.y > h) return undefined;
            const above = top.y - BAR_HEIGHT - GAP;
            return { x: Math.max(GAP, Math.min(top.x, w - 200)), y: above >= GAP ? above : Math.min(bottom.y + GAP, h - BAR_HEIGHT - GAP) };
        },
        [],
    );

    const context: ActionContext = useMemo(
        () => ({
            live: session?.live === true,
            ...(input.timelineShown !== undefined && { timelineShown: input.timelineShown }),
            hasModelElement: (sticky) => sticky.ref !== undefined && dtTarget(model, sticky.kind, sticky.ref) !== undefined,
            ...(input.knowledge && { hasKnowledge: (sticky: Sticky) => input.knowledge?.has(sticky.id) === true }),
        }),
        [session?.live, input.timelineShown, model, input.knowledge],
    );
    const available = useMemo(() => actionsFor(selected, context), [selected, context]);
    const stormingOf = useCallback((sticky: Sticky) => stormings.find((v) => v.id === sticky.storming)?.storming, [stormings]);

    /** The sticky's box on the canvas, for a window anchored to it. */
    const anchorOf = useCallback(
        (sticky: Sticky): Anchor | undefined => {
            if (!canvas) return undefined;
            const item = canvas.selectedIds().find((id) => canvas.item(id)?.elementId === sticky.id) ?? canvas.findElement(sticky.id);
            const b = item && canvas.itemBounds(item);
            if (!b) return undefined;
            const p = canvas.pageToViewport({ x: b.x, y: b.y });
            const z = canvas.getZoom();
            const { w, h } = canvas.viewportScreenBounds();
            return { x: p.x, y: p.y, w: b.w * z, h: b.h * z, width: w, height: h };
        },
        [canvas],
    );
    const open = useCallback(
        (kind: Form['kind'], sticky: Sticky | undefined) => {
            const anchor = sticky && anchorOf(sticky);
            if (sticky && anchor) setForm({ kind, sticky, anchor });
        },
        [anchorOf],
    );

    const label = (a: StickyAction): string =>
        a.id === 'chat' && session?.chat.added
            ? s.chatAdded
            : a.id === 'resolve' && selected.length === 1 && selected[0].resolved
              ? s.resolve.redo
              : s.actions[a.id];
    /** What exactly an action does, for its tooltip: where it goes. */
    const hint = (a: StickyAction, sticky: Sticky | undefined): string | undefined => {
        if (!sticky) return undefined;
        if (a.id === 'seeModel' && sticky.ref !== undefined) {
            const dt = dtTarget(model, sticky.kind, sticky.ref);
            return dt ? s.seeModelHint(namer(mode, model).id(dt)) : undefined;
        }
        if (a.id === 'seeTimeline' && sticky.timelines[0] !== undefined) {
            const tl = stormingOf(sticky)
                ?.elements.flatMap((e) => (e.kind === 'stage' ? e.timelines : e.kind === 'timeline' ? [e] : []))
                .find((x) => x.id === sticky.timelines[0]);
            return s.seeTimelineHint(nameIn(mode, sticky.timelines[0], tl?.label));
        }
        return undefined;
    };

    const run = useCallback(
        (id: StickyActionId, stickies: readonly Sticky[] = selected): void => {
            const first = stickies[0];
            switch (id) {
                case 'chat':
                    return session?.chat.add();
                case 'edit':
                    return open('edit', first);
                case 'knowledge':
                    if (first) input.knowledge?.open(first.id);
                    return;
                case 'seeModel': {
                    const dt = first?.ref !== undefined ? dtTarget(model, first.kind, first.ref) : undefined;
                    if (dt && first) input.onSeeModel(dt, first.id);
                    return;
                }
                case 'seeTimeline':
                    if (first?.timelines[0] !== undefined) input.onSeeTimeline(first.storming, first.timelines[0], first.id);
                    return;
                case 'addHotspot':
                    return open('hotspot', first);
                case 'resolve':
                    return open('resolve', first);
                case 'copyLink': {
                    if (!first) return;
                    const link = elementLink(window.location.href, first.id);
                    navigator.clipboard.writeText(link).then(
                        () => say(s.linkCopied),
                        () => say(s.linkNotCopied),
                    );
                    return;
                }
            }
        },
        [selected, session, open, model, input, say, s],
    );

    // the keys, while stickies are selected on a storming view and nothing that takes text has the focus
    useEffect(() => {
        if (!active || form || menu) return;
        const onKey = (e: globalThis.KeyboardEvent): void => {
            if (selected.length === 0 || e.isComposing || isTyping(document.activeElement)) return;
            const focus = document.activeElement;
            // Enter on a focused button or link is that button's
            if (e.key === 'Enter' && focus instanceof HTMLElement && focus.closest('button, a, [role="menuitem"], [role="option"], dialog')) return;
            // Escape with the focus nowhere (a window or a menu just closed, a pick of the palette): the selection is
            // cleared as the canvas's own Escape does when it has the focus
            if (canvas && escapeClearsSelection(e, { focusNowhere: focus === null || focus === document.body, selected: selected.length, open: false })) {
                e.preventDefault();
                canvas.selectNone();
                focusCanvas(canvas);
                return;
            }
            const action = actionOfKey(e, available, mac);
            if (!action) return;
            e.preventDefault();
            e.stopPropagation();
            run(action.id);
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [active, form, menu, selected, available, mac, run, canvas]);

    // a double-click edits the sticky; a right-click opens the menu (the sticky selected first)
    useEffect(() => {
        if (!canvas || !active) return;
        const el = canvas.container();
        const stickyUnder = (): Sticky | undefined => {
            const item = canvas.hoveredId();
            const element = item && canvas.item(item)?.elementId;
            const sticky = element ? stickyOf(stormings, element) : undefined;
            if (sticky && item && !canvas.selectedIds().includes(item)) canvas.select([item]);
            return sticky;
        };
        const onDouble = (e: MouseEvent): void => {
            const sticky = stickyUnder();
            if (!sticky || !session?.live) return;
            e.preventDefault();
            // after the canvas's own handling of the click
            requestAnimationFrame(() => open('edit', sticky));
        };
        const onContext = (e: MouseEvent): void => {
            const sticky = stickyUnder();
            if (!sticky) return;
            e.preventDefault();
            const box = el.getBoundingClientRect();
            setMenu({ x: e.clientX - box.left, y: e.clientY - box.top });
        };
        el.addEventListener('dblclick', onDouble);
        el.addEventListener('contextmenu', onContext);
        return () => {
            el.removeEventListener('dblclick', onDouble);
            el.removeEventListener('contextmenu', onContext);
        };
    }, [canvas, active, stormings, session?.live, open]);

    // a renamed sticky stays selected once the update draws it under its new name
    const { onOpenSticky } = input;
    useEffect(() => {
        if (follow === undefined || !stickyOf(stormings, follow)) return;
        setFollow(undefined);
        onOpenSticky(follow);
    }, [follow, stormings, onOpenSticky]);

    /** Writes an edit, then selects `then` (a selection ID, or one made from what was written) once it is drawn. */
    /** A window closed (saved or cancelled): the focus back on the canvas, the sticky still selected, so that Escape clears it. */
    const closeForm = useCallback((): void => {
        setForm(undefined);
        if (canvas) focusCanvas(canvas);
    }, [canvas]);

    const edit = async (request: StickyEditRequest, body: string, then?: string | ((written: StickyWritten) => string | undefined)): Promise<SaveResult> => {
        if (!session) return s.edit.failed('');
        try {
            const written = await session.edit(request, body);
            say(s.saved);
            const next = typeof then === 'function' ? then(written) : then;
            if (next) setFollow(next);
            return undefined;
        } catch (e) {
            return errorText(t, e);
        }
    };

    const menuItems = (stickies: readonly Sticky[]): MenuItem[] =>
        actionsFor(stickies, context).map((a) => {
            const h = hint(a, stickies[0]);
            return {
                id: a.id,
                label: label(a),
                icon: a.id === 'chat' && session?.chat.added ? Check : a.icon,
                group: s.groups[a.group],
                ...(a.shortcut && { keys: shortcutText(a.shortcut, mac) }),
                ...(h !== undefined && { hint: h }),
                run: () => run(a.id, stickies),
            };
        });

    const frequent = toolbarActions(available, selected);
    const more = available.length > frequent.length;
    const onToolbarKey = (e: KeyboardEvent<HTMLDivElement>): void => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const focused = document.activeElement;
        const i = all.findIndex((b) => b === focused);
        e.preventDefault();
        all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length]?.focus();
    };

    const formStorming = form && stormingOf(form.sticky);
    const resolution = form?.kind === 'resolve' ? resolutionOf(formStorming, form.sticky.local) : undefined;
    const overlay = active ? (
        <div className="sticky-layer">
            {at && selected.length > 0 && !form && available.length > 0 && (
                <div
                    className="sticky-toolbar"
                    role="toolbar"
                    aria-label={s.toolbar}
                    style={{ transform: `translate(${at.x}px, ${at.y}px)` }}
                    // keeps the canvas's selection: the press must not reach the canvas
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={onToolbarKey}
                >
                    {selected.length > 1 && <span className="sticky-toolbar-count">{s.count(selected.length)}</span>}
                    {frequent.map((a) => {
                        const text = label(a);
                        const Icon = a.id === 'chat' && session?.chat.added ? Check : a.icon;
                        const keys = a.shortcut && shortcutText(a.shortcut, mac);
                        return (
                            <button
                                key={a.id}
                                type="button"
                                className={`icon-button sticky-toolbar-button${a.id === 'chat' && session?.chat.added ? ' added' : ''}`}
                                aria-label={text}
                                {...{ [TOOLTIP_ATTR]: keys ? `${text}（${keys}）` : text }}
                                onClick={() => run(a.id)}
                            >
                                <Icon size={15} aria-hidden />
                            </button>
                        );
                    })}
                    {more && (
                        <button
                            type="button"
                            className="icon-button sticky-toolbar-button"
                            aria-label={s.more}
                            aria-haspopup="menu"
                            aria-expanded={menu !== undefined}
                            {...{ [TOOLTIP_ATTR]: s.more }}
                            onClick={(e) => {
                                const box = e.currentTarget.closest('.sticky-layer')?.getBoundingClientRect();
                                const r = e.currentTarget.getBoundingClientRect();
                                setMenu(menu ? undefined : { x: r.left - (box?.left ?? 0), y: r.bottom - (box?.top ?? 0) + 4 });
                            }}
                        >
                            <Ellipsis size={15} aria-hidden />
                        </button>
                    )}
                </div>
            )}
            {menu && selected.length > 0 && <ActionMenu label={s.toolbar} items={menuItems(selected)} at={menu} onClose={() => setMenu(undefined)} />}
            {form?.kind === 'edit' && formStorming && (
                <EditForm
                    sticky={form.sticky}
                    storming={formStorming}
                    anchor={form.anchor}
                    onClose={closeForm}
                    onSave={(change) => {
                        const { sticky } = form;
                        const before = sticky.label ?? sticky.local;
                        const after = change.label ?? change.name ?? before;
                        return edit(
                            {
                                kind: 'wording',
                                storming: sticky.storming,
                                element: sticky.local,
                                expected: { name: sticky.local, ...(sticky.label !== undefined && { label: sticky.label }) },
                                ...change,
                            },
                            s.edit.body(change.label !== undefined ? before : sticky.local, change.label !== undefined ? after : (change.name ?? sticky.local)),
                            change.name !== undefined ? `es/${sticky.storming}/${change.name}` : undefined,
                        );
                    }}
                />
            )}
            {form?.kind === 'hotspot' && (
                <HotspotForm
                    anchor={form.anchor}
                    onClose={closeForm}
                    onSave={(question) =>
                        edit(
                            {
                                kind: 'addHotspot',
                                storming: form.sticky.storming,
                                on: form.sticky.local,
                                label: question,
                                onKind: form.sticky.kind,
                                ...(form.sticky.label !== undefined && { onLabel: form.sticky.label }),
                            },
                            s.hotspot.body(form.sticky.label ?? form.sticky.local, question),
                            (written) => written.hotspot && `es/${form.sticky.storming}/${written.hotspot}`,
                        )
                    }
                />
            )}
            {form?.kind === 'resolve' && (
                <ResolveForm
                    anchor={form.anchor}
                    {...(resolution !== undefined && { resolution })}
                    onClose={closeForm}
                    onSave={(text) =>
                        edit(
                            { kind: 'resolveHotspot', storming: form.sticky.storming, element: form.sticky.local, resolution: text },
                            s.resolve.body(form.sticky.label ?? form.sticky.local, text),
                        )
                    }
                />
            )}
            <div className="sticky-status" role="status" aria-live="polite">
                {status}
            </div>
        </div>
    ) : null;

    // the palette: the actions on the selection, then every sticky of every storming by name
    const palette = useMemo((): PaletteItem[] => {
        const actionItems: PaletteItem[] = actionsFor(selected, context).map((a) => ({
            id: `action:${a.id}`,
            label: label(a),
            detail: s.palette.selected(selected.length),
            icon: a.icon,
            section: s.palette.actions,
            ...(a.shortcut && { keys: shortcutText(a.shortcut, mac) }),
            run: () => run(a.id),
        }));
        const stickyItems: PaletteItem[] = stormings.flatMap((v) =>
            v.storming.elements.flatMap((el): PaletteItem[] =>
                el.kind === 'timeline' || el.kind === 'stage'
                    ? []
                    : [
                          {
                              id: `sticky:${v.id}/${el.id}`,
                              label: nameIn(mode, el.id, el.label),
                              detail: `${t.esKinds[el.kind]} · ${nameIn(mode, v.id, v.label)} · ${el.id}`,
                              section: s.palette.stickies,
                              run: () => onOpenSticky(`es/${v.id}/${el.id}`),
                          },
                      ],
            ),
        );
        return [...actionItems, ...stickyItems];
        // label and run follow the selection and the session, covered by these
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected, context, stormings, mode, mac, session?.chat.added, onOpenSticky, t]);

    return { overlay, palette };
}

/** A hotspot's resolution as written, if any. */
function resolutionOf(storming: StormingView['storming'] | undefined, local: string): string | undefined {
    const el = storming?.elements.find((e) => e.id === local);
    if (!el || el.kind === 'timeline' || el.kind === 'stage') return undefined;
    const r = el.clauses.find((c) => c.type === 'resolution');
    return r?.type === 'resolution' ? r.text : undefined;
}

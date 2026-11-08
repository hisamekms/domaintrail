// Following (docs/live-view.md, "Following"): the camera moves only for the reader and for whom the reader follows —
// the AI (its changes) or another participant (their view and camera). Whom the page follows is its own, never sent,
// and gone on a reload. Here, without the session: whom, how it changes, and the one place that tells the reader's own
// moves from a followee's. Every way the reader moves the camera, selects or switches what is shown goes through the
// canvas, the navigation and the settings the workspace hands out (`readerCanvas`, `readerNavigation`,
// `readerSettings`) or through the canvas's own gestures (`DiagramCanvas.onUserInput`): each of them stops following
// first. A followee's moves use the bare ones (`FollowMoves`), which stop nothing.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiagramCanvas } from './diagram';
import type { Navigation } from './navigation';
import type { ViewSettings } from './settings';

/** Whom the page follows: the AI, or a participant (by ID). */
export type Followee = { readonly kind: 'ai' } | { readonly kind: 'person'; readonly participant: string };

export const AI_FOLLOWEE: Followee = { kind: 'ai' };

/** Whether `f` is the AI, or the participant `id`. */
export const isFollowing = (f: Followee | null, who: 'ai' | { readonly participant: string }): boolean =>
    f !== null && (who === 'ai' ? f.kind === 'ai' : f.kind === 'person' && f.participant === who.participant);

/** What changes whom the page follows. */
export type FollowEvent =
    /** The reader chose (the toggle, a row of the participants): someone, or no one. */
    | { readonly kind: 'choose'; readonly followee: Followee | null }
    /** The reader moved the camera, selected, or switched what is shown. */
    | { readonly kind: 'mine' }
    /** The reader sent a request to the AI (or their proposal was approved and runs). */
    | { readonly kind: 'asked' }
    /** The participants that have a page in the session now: a followee without one left. */
    | { readonly kind: 'present'; readonly participants: ReadonlySet<string> };

/** Whom the page follows after `e`: one at a time, so following someone stops following anyone else. */
export function nextFollowee(f: Followee | null, e: FollowEvent): Followee | null {
    switch (e.kind) {
        case 'choose':
            return e.followee;
        case 'mine':
            return null;
        case 'asked':
            return AI_FOLLOWEE;
        case 'present':
            return f?.kind === 'person' && !e.participants.has(f.participant) ? null : f;
    }
}

/** `f` as the reader's own: `mine` called first. */
const byReader =
    <A extends unknown[]>(mine: () => void, f: (...args: A) => void) =>
    (...args: A): void => {
        mine();
        f(...args);
    };

/**
 * The canvas as the reader's controls get it (the canvas's buttons, the navigator, 「→」, a link, the lines): a camera
 * move or a selection asked through it is the reader's own, `mine` called first. Reading it changes nothing.
 */
export function readerCanvas(canvas: DiagramCanvas, mine: () => void): DiagramCanvas {
    return {
        ...canvas,
        setCamera: (camera, move) => byReader(mine, () => canvas.setCamera(camera, move))(),
        zoomIn: (move) => byReader(mine, () => canvas.zoomIn(move))(),
        zoomOut: (move) => byReader(mine, () => canvas.zoomOut(move))(),
        resetZoom: (move) => byReader(mine, () => canvas.resetZoom(move))(),
        fitContent: (move) => byReader(mine, () => canvas.fitContent(move))(),
        fitBounds: (bounds, opts) => byReader(mine, () => canvas.fitBounds(bounds, opts))(),
        fitSelection: (move) => byReader(mine, () => canvas.fitSelection(move))(),
        centerOn: (point, move) => byReader(mine, () => canvas.centerOn(point, move))(),
        select: (ids) => byReader(mine, () => canvas.select(ids))(),
        selectNone: () => byReader(mine, () => canvas.selectNone())(),
    };
}

/** What the reader's controls switch views with. */
export type NavigationMoves = Pick<Navigation, 'setView' | 'select' | 'goBack' | 'reveal'>;

/**
 * The navigation's moves as the reader's controls get them: showing a view, selecting, going back are the reader's own.
 * `nav` gives the current navigation (the moves keep their identity).
 */
export function readerNavigation(nav: () => NavigationMoves, mine: () => void): NavigationMoves {
    return {
        setView: (v) => byReader(mine, nav().setView)(v),
        select: (id, opts) => byReader(mine, nav().select)(id, opts),
        goBack: () => byReader(mine, nav().goBack)(),
        reveal: (target, id) => byReader(mine, nav().reveal)(target, id),
    };
}

/** What the reader's controls change of what the views draw. */
export type SettingsMoves = Pick<
    ViewSettings,
    'setStructureLevel' | 'setStructureContexts' | 'setHiddenContexts' | 'setMapAll' | 'setStormingChoice' | 'setStormingFocus' | 'setCompact'
>;

/**
 * The settings' changes as the reader's controls get them: every change of what a view draws (a level, a storming, a
 * timeline, the exceptions' layer and the one emphasized, the contexts, 詰めて表示) is the reader's own. `settings` gives the current settings.
 */
export function readerSettings(settings: () => SettingsMoves, mine: () => void): SettingsMoves {
    return {
        setStructureLevel: (level) => byReader(mine, settings().setStructureLevel)(level),
        setStructureContexts: (contexts) => byReader(mine, settings().setStructureContexts)(contexts),
        setHiddenContexts: (contexts) => byReader(mine, settings().setHiddenContexts)(contexts),
        setMapAll: (all) => byReader(mine, settings().setMapAll)(all),
        setStormingChoice: (choice) => byReader(mine, settings().setStormingChoice)(choice),
        setStormingFocus: (focus) => byReader(mine, settings().setStormingFocus)(focus),
        setCompact: (compact) => byReader(mine, settings().setCompact)(compact),
    };
}

/** What a followee's moves work with: the bare canvas, view switch and settings, whose changes stop nothing. */
export interface FollowMoves {
    readonly canvas: DiagramCanvas | null;
    readonly setView: Navigation['setView'];
    readonly settings: ViewSettings;
}

/** Whom the page follows, and the ways to change it. */
export interface Follow {
    readonly followee: Followee | null;
    /** Follows someone, or no one (`null`): the reader's choice. */
    readonly choose: (followee: Followee | null) => void;
    /** The reader sent a request to the AI: the page follows it. */
    readonly asked: () => void;
    /** The participants with a page in the session now (a followee who left is no longer followed). */
    readonly present: (participants: ReadonlySet<string>) => void;
    /** The bare canvas, view switch and settings, for the followee's moves (read when they are made). */
    readonly moves: () => FollowMoves;
}

/**
 * Whom the page follows, with the reader's own canvas, navigation and settings (each move through them stops following),
 * and the bare ones for the followee's moves. `canvas`: the bare canvas, whose own gestures stop following too.
 */
export function useFollow(
    canvas: DiagramCanvas | null,
    nav: Navigation,
    settings: ViewSettings,
): { readonly follow: Follow; readonly canvas: DiagramCanvas | null; readonly nav: Navigation; readonly settings: ViewSettings } {
    const [followee, setFollowee] = useState<Followee | null>(null);
    const on = useCallback((e: FollowEvent) => setFollowee((f) => nextFollowee(f, e)), []);
    const mine = useCallback(() => on({ kind: 'mine' }), [on]);
    useEffect(() => canvas?.onUserInput(mine), [canvas, mine]);
    const bare = useRef({ canvas, nav, settings });
    bare.current = { canvas, nav, settings };
    const reader = useMemo(
        () => ({
            nav: readerNavigation(() => bare.current.nav, mine),
            settings: readerSettings(() => bare.current.settings, mine),
        }),
        [mine],
    );
    const readerCanvasOf = useMemo(() => canvas && readerCanvas(canvas, mine), [canvas, mine]);
    // the ways to change it keep their identity (effects depend on them)
    const ways = useMemo(
        (): Omit<Follow, 'followee'> => ({
            choose: (f) => on({ kind: 'choose', followee: f }),
            asked: () => on({ kind: 'asked' }),
            present: (participants) => on({ kind: 'present', participants }),
            moves: () => ({ canvas: bare.current.canvas, setView: bare.current.nav.setView, settings: bare.current.settings }),
        }),
        [on],
    );
    const follow = useMemo((): Follow => ({ followee, ...ways }), [followee, ways]);
    return { follow, canvas: readerCanvasOf, nav: { ...nav, ...reader.nav }, settings: { ...settings, ...reader.settings } };
}

// What a turn changed, marked on the Event Storming canvas (docs/live-view.md, "What a turn changed"): when a run that
// changed the sources ends while the page is open, the stickies it added, changed and removed are marked, until the
// next such run ends or the reader clears them; a card's 図で見る marks its own changes the same way. The marks are the
// page's own (each viewer's), never the session's: nothing here is sent. The span marked is any pair of revisions, so
// that other units of change (a person's edit of a sticky) can be marked the same way.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import type { DisplayMode } from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import type { StormingChoice } from '../storming';
import { useT } from '../i18n';
import { Act } from '../shared/act';
import { hasMarks, marksCount, marksView, notDrawn, outOfView, stormingChangeMarks, type CanvasMarks, type ChangeMarks } from '../view/change-marks';
import { useCanvasValue, type DiagramCanvas } from '../view/diagram';
import { motionMs } from '../shared/motion';
import type { Workspace } from '../view/workspace';
import { loadModelChanges } from './changes';

type RunJson = SessionStateBody['runs'][number];

/** A span of revisions whose changes are marked, and what the bar calls it. */
export interface MarksSubject {
    readonly base: string;
    readonly result: string;
    /** The card's name when asked from its card (図で見る); none for the latest turn (直前の作業). */
    readonly name?: string;
    readonly reveal: CanvasMarks['reveal'];
    /** Counts the subjects: a subject marked anew is a new appearance (the camera may move). */
    readonly n: number;
}

/** The runs that ended having changed the sources, with when they ended. */
export function changingRuns(runs: readonly RunJson[]): { readonly id: string; readonly base: string; readonly result: string; readonly at: string }[] {
    return runs.flatMap((r) =>
        (r.state === 'Completed' || r.state === 'NeedsClarification' || r.state === 'Declined' || r.state === 'Reverted') && r.baseRevision !== r.resultRevision
            ? [{ id: r.id, base: r.baseRevision, result: r.resultRevision, at: r.finishedAt }]
            : [],
    );
}

/**
 * The run whose changes the page marks now: of the runs that ended having changed the sources and that the page did
 * not know as ended (`known`), the one that ended last. None when no such run ended since.
 */
export function latestEnded(
    runs: readonly RunJson[],
    known: ReadonlySet<string>,
): { readonly id: string; readonly base: string; readonly result: string } | undefined {
    const fresh = changingRuns(runs).filter((r) => !known.has(r.id));
    const latest = fresh.reduce<(typeof fresh)[number] | undefined>((last, r) => (!last || r.at > last.at ? r : last), undefined);
    return latest && { id: latest.id, base: latest.base, result: latest.result };
}

/** The marks of turns on the page: what the canvas marks, what the bar says, and the actions on them. */
export interface TurnMarks {
    /** The marks shown, with what the bar calls them; none while nothing is marked. */
    readonly shown: { readonly marks: CanvasMarks; readonly name: string | undefined } | undefined;
    /** Marks a span's changes and brings them into view (a card's 図で見る). */
    readonly see: (span: { readonly base: string; readonly result: string; readonly name: string }) => void;
    readonly clear: () => void;
    /** Shows the marked stickies the current view does not draw (another storming, timeline or level). */
    readonly elsewhere: () => void;
}

/**
 * The page's marks of turns. `state`: the session's (none outside a session); the runs already ended when it first
 * comes are not marked (the reader did not see them end: a card's 図で見る shows them).
 */
export function useTurnMarks(state: SessionStateBody | undefined, workspace: Workspace, mode: DisplayMode): TurnMarks {
    const [subject, setSubject] = useState<MarksSubject | null>(null);
    const known = useRef<Set<string> | null>(null);
    const count = useRef(0);
    const runs = state?.runs;
    useEffect(() => {
        if (!runs) return;
        if (known.current === null) {
            known.current = new Set(changingRuns(runs).map((r) => r.id));
            return;
        }
        const latest = latestEnded(runs, known.current);
        for (const r of changingRuns(runs)) known.current.add(r.id);
        if (latest) setSubject({ base: latest.base, result: latest.result, reveal: 'ifNoneVisible', n: ++count.current });
    }, [runs]);

    // what the page holds now, for the moment the changes come
    const now = useRef(workspace);
    now.current = workspace;
    const setMarks = workspace.marks.set;
    const [marks, setLoaded] = useState<{ readonly subject: MarksSubject; readonly marks: ChangeMarks } | undefined>();
    useEffect(() => {
        if (!subject) {
            setLoaded(undefined);
            return;
        }
        let current = true;
        loadModelChanges(subject.base, subject.result).then(
            (body) => {
                if (!current) return;
                const m = stormingChangeMarks(body.changes, mode);
                // a turn that changed no sticky leaves nothing marked (the marks are the latest turn's or none)
                if (!hasMarks(m)) return setLoaded(undefined);
                if (subject.reveal === 'always') {
                    const { stormings, settings, nav } = now.current;
                    const choice = marksView(stormings, settings.stormingChoice, m);
                    if (choice) settings.setStormingChoice(choice);
                    if (nav.view.kind !== 'storming') nav.setView({ kind: 'storming' });
                }
                setLoaded({ subject, marks: m });
            },
            () => current && setLoaded(undefined),
        );
        return () => {
            current = false;
        };
    }, [subject, mode]);
    const canvasMarks: CanvasMarks | null = marks ? { key: String(marks.subject.n), reveal: marks.subject.reveal, marks: marks.marks } : null;
    const key = canvasMarks ? `${canvasMarks.key}:${JSON.stringify(canvasMarks.marks)}` : '';
    useEffect(() => {
        setMarks(canvasMarks);
        // the marks are covered by their key
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, setMarks]);

    const see = useCallback((span: { readonly base: string; readonly result: string; readonly name: string }) => {
        setSubject({ ...span, reveal: 'always', n: ++count.current });
    }, []);
    const clear = useCallback(() => setSubject(null), []);
    const elsewhere = useCallback(() => {
        if (!marks) return;
        const { stormings, settings, nav } = now.current;
        const choice = marksView(stormings, settings.stormingChoice, notDrawn(stormings, settings.stormingChoice, marks.marks));
        if (choice) settings.setStormingChoice(choice);
        if (nav.view.kind !== 'storming') nav.setView({ kind: 'storming' });
        // anew, so that the camera brings them into view once their view is drawn
        setSubject({ ...marks.subject, reveal: 'always', n: ++count.current });
    }, [marks]);
    return { shown: canvasMarks ? { marks: canvasMarks, name: marks?.subject.name } : undefined, see, clear, elsewhere };
}

/**
 * The bar over the storming canvas's top right while it marks a turn's changes: whose they are (直前の作業, or the
 * card's name) and how many stickies it added, changed and removed; 「ほかに n 件の変更 →」 while some are out of view or
 * not drawn in this view (one press goes to the nearest drawn one; when none is drawn here, to the view that draws
 * them); 印を消す.
 */
export function TurnMarksBar({
    canvas,
    marks,
    stormings,
    choice,
}: {
    canvas: DiagramCanvas | null;
    marks: TurnMarks;
    /** The stormings and the view shown: what the view does not draw counts among the changes elsewhere. */
    stormings: readonly StormingView[];
    choice: StormingChoice;
}): ReactNode {
    const t = useT().turnMarks;
    const shown = marks.shown;
    const m = shown?.marks.marks;
    const away = useCanvasValue(
        canvas,
        (c) => {
            if (!c || !m) return { count: 0, x: 0, y: 0 };
            const rects = new Map<string, { x: number; y: number; w: number; h: number }[]>();
            for (const id of [...m.added, ...m.changed])
                rects.set(
                    id,
                    c.elementNodes(id).flatMap((n) => c.itemBounds(n) ?? []),
                );
            for (const id of m.removed) {
                const ghost = c.findElement(id);
                const b = ghost && c.item(ghost)?.ghost ? c.itemBounds(ghost) : undefined;
                if (b) rects.set(id, [b]);
            }
            const drawn = new Map([...rects].filter(([, r]) => r.length > 0));
            const out = outOfView(drawn, c.viewportPageBounds());
            // flat, so that an unchanged answer does not render again (`sameValue`)
            return out.next ? { count: out.count, x: out.next.x, y: out.next.y } : { count: 0, x: 0, y: 0 };
        },
        [m],
    );
    if (!shown || !m) return null;
    const elsewhere = notDrawn(stormings, choice, m);
    const more = away.count + elsewhere.added.length + elsewhere.changed.length;
    const n = marksCount(m);
    const go = (): void => {
        if (canvas && away.count > 0) canvas.centerOn({ x: away.x, y: away.y }, { animate: motionMs('--motion-medium') > 0 });
        else marks.elsewhere();
    };
    return (
        <div className="turn-marks-bar" role="group" aria-label={t.label}>
            <span className="turn-marks-what">
                {shown.name === undefined ? t.latest : t.run(shown.name)}
                {'：'}
            </span>
            <span className="turn-marks-counts">
                {n.added > 0 && <b className="turn-marks-added">{t.counts.added(n.added)}</b>}
                {n.changed > 0 && <b className="turn-marks-changed">{t.counts.changed(n.changed)}</b>}
                {n.removed > 0 && <b className="turn-marks-removed">{t.counts.removed(n.removed)}</b>}
            </span>
            {more > 0 && (
                <Act kind="see" data-tooltip={t.moreHint} onClick={go}>
                    {t.more(more)}
                </Act>
            )}
            <Act kind="open" onClick={marks.clear}>
                {t.clear}
            </Act>
        </div>
    );
}

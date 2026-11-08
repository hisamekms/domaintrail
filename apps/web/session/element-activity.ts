// What the session did about one storming element, for the element's detail (docs/plans/layout.md, step 5): the
// messages that target it, the AI's runs about it, and the run that added or changed it. Derived from the session's
// state on the page and the element changes the server lists per run (`changes.ts`); nothing here is sent.
import { useEffect, useState } from 'react';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { MAX_REQUEST_MENTIONS, MAX_REQUEST_TARGETS, tokenName } from '@domaintrail/collaboration';
import { loadModelChanges, type ElementChange } from './changes';
import { bodyText, type ComposerValue } from './mentions';
import { targetKey, type ModelTarget, type TargetDraft } from './targets';

type RunJson = SessionStateBody['runs'][number];
type TargetSnapshotJson = SessionStateBody['requests'][number]['targets'][number];

/** A storming element as the session's targets and changes name it. */
export interface StormingElementRef {
    readonly storming: string;
    readonly local: string;
}

/** What the session did about an element; each part is absent when there is nothing to show. */
export interface ElementActivity {
    /** The messages that target it: how many, and the latest one (its ID and its text on one line). */
    readonly talk?: { readonly count: number; readonly latest: { readonly request: string; readonly text: string } };
    /** The AI's runs whose messages target it or whose changes touched it: how many, and the latest one's ID. */
    readonly runs?: { readonly count: number; readonly latest: string };
    /** The run that added it in this session (else the latest that changed it), and its first message on one line. */
    readonly change?: { readonly change: 'added' | 'changed'; readonly run: string; readonly request: string };
}

/** Whether a target names the element: the element itself, or an occurrence of it (an event in a timeline). */
export function targetsElement(target: ModelTarget, el: StormingElementRef): boolean {
    if (target.kind === 'DtesElement') return target.storming === el.storming && target.local === el.local;
    if (target.kind === 'DtesOccurrence') return target.storming === el.storming && target.eventName === el.local;
    return false;
}

const aboutElement = (targets: readonly TargetSnapshotJson[], el: StormingElementRef): boolean => targets.some((t) => targetsElement(t.target, el));

/** Whether an element change is of the element. */
const changeOf = (c: ElementChange, el: StormingElementRef): boolean => c.language === 'Dtes' && c.storming === el.storming && c.local === el.local;

/** A body on one line, its mentions as `#name` / `@name`. */
const oneLine = (body: string, targets: readonly TargetSnapshotJson[]): string => bodyText(body, targets, MAX_REQUEST_MENTIONS).replace(/\s+/g, ' ').trim();

/** When a run was queued, for ordering (ISO strings compare as times). */
const queuedAt = (run: RunJson): string => run.queuedAt;

/**
 * What the session did about `el`. `changes`: the element changes of each run that changed the sources (by run ID), as
 * far as they are loaded; a run whose changes are not loaded yet counts by its messages only.
 */
export function elementActivity(
    state: Pick<SessionStateBody, 'requests' | 'runs'>,
    changes: ReadonlyMap<string, readonly ElementChange[]>,
    el: StormingElementRef,
): ElementActivity {
    const messages = state.requests.filter((r) => aboutElement(r.targets, el)).sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    const latestMessage = messages.at(-1);
    const touched = (run: RunJson): boolean => (changes.get(run.id) ?? []).some((c) => changeOf(c, el));
    const runs = state.runs
        .filter((run) => run.input.requests.some((r) => aboutElement(r.targets, el)) || touched(run))
        .sort((a, b) => queuedAt(a).localeCompare(queuedAt(b)));
    const latestRun = runs.at(-1);
    // the run that added it, else the latest that changed it
    const byTime = [...state.runs].sort((a, b) => queuedAt(a).localeCompare(queuedAt(b)));
    const found = (kind: 'added' | 'changed'): RunJson | undefined => {
        const list = byTime.filter((run) => (changes.get(run.id) ?? []).some((c) => changeOf(c, el) && c.change === kind));
        return kind === 'added' ? list[0] : list.at(-1);
    };
    const added = found('added');
    const changedBy = added ? undefined : found('changed');
    const by = added ?? changedBy;
    const first = by?.input.requests[0];
    return {
        ...(latestMessage && {
            talk: { count: messages.length, latest: { request: latestMessage.id, text: oneLine(latestMessage.body, latestMessage.targets) } },
        }),
        ...(latestRun && { runs: { count: runs.length, latest: latestRun.id } }),
        ...(by && first && { change: { change: added ? ('added' as const) : ('changed' as const), run: by.id, request: oneLine(first.body, first.targets) } }),
    };
}

/** The revisions a run went from and to, when it changed the sources. */
function changedSpan(run: RunJson): { base: string; result: string } | undefined {
    if (run.state !== 'Completed' && run.state !== 'NeedsClarification' && run.state !== 'Declined' && run.state !== 'Reverted') return undefined;
    return run.baseRevision === run.resultRevision ? undefined : { base: run.baseRevision, result: run.resultRevision };
}

/** The element changes of each run that changed the sources, loaded once per pair of revisions (by run ID). */
export function useRunChanges(state: Pick<SessionStateBody, 'runs'> | undefined): ReadonlyMap<string, readonly ElementChange[]> {
    const [loaded, setLoaded] = useState<ReadonlyMap<string, readonly ElementChange[]>>(new Map());
    const spans = (state?.runs ?? []).flatMap((run) => {
        const span = changedSpan(run);
        return span ? [{ run: run.id, ...span }] : [];
    });
    const key = spans.map((s) => `${s.run}:${s.base}>${s.result}`).join(',');
    useEffect(() => {
        let current = true;
        for (const s of spans) {
            if (loaded.has(s.run)) continue;
            loadModelChanges(s.base, s.result).then(
                (body) => current && setLoaded((m) => new Map(m).set(s.run, body.changes)),
                () => {},
            );
        }
        return () => {
            current = false;
        };
        // the spans are covered by their key
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    return loaded;
}

/**
 * The composer with the beginning of a message about `target` (`write` puts the element's `#` mention in it): the element
 * becomes a target (or keeps its number if it is one), and the beginning goes after what is written already, on a line
 * of its own. The person finishes and sends it.
 */
export function beginMessage(value: ComposerValue, target: TargetDraft, mention: string, write: (target: string) => string): ComposerValue {
    const key = targetKey(target.target);
    const at = value.chips.findIndex((c) => targetKey(c.target.target) === key);
    // no room for one more target: its name as text
    if (at < 0 && value.chips.length >= MAX_REQUEST_TARGETS) return appended(value, write(mention));
    const index = at >= 0 ? at : value.chips.length;
    const chips = at >= 0 ? value.chips.map((c, i) => (i === at ? { ...c, mentioned: true } : c)) : [...value.chips, { target, mentioned: true }];
    return appended({ ...value, chips }, write(`#${tokenName(mention)}[${index + 1}]`));
}

/** `line` after what is written, on a line of its own. */
function appended(value: ComposerValue, line: string): ComposerValue {
    const written = value.text.trimEnd();
    return { ...value, text: written ? `${written}\n${line}` : line };
}

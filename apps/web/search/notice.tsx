// What going to a found item took away so that it shows — a level that draws it, a narrowing that hid it, a timeline
// left for the integrated canvas — said in one short line for a moment, over the page.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { StructureLevel } from '@domaintrail/visualization';
import type { Messages } from '../i18n';
import { hiddenOf, type StormingChoice } from '../storming';
import { shortName } from '../view/workspace';

/** What going to a sticky changed of the storming view: its level, its 絞り込み, its timeline (for the integrated canvas). */
export function stormingTaken(before: StormingChoice, after: StormingChoice, stormingId: string): { level: boolean; filter: boolean; scope: boolean } {
    return {
        level: before.level !== after.level && after.level === 'design-level',
        filter: [...hiddenOf(before)].some((k) => !hiddenOf(after).has(k)),
        scope: before.timelines[stormingId] !== undefined && after.timelines[stormingId] === undefined,
    };
}

/** The line that says it (empty when nothing was taken away). */
export function stormingTakenText(t: Messages, taken: ReturnType<typeof stormingTaken>): string {
    return [
        ...(taken.level ? [t.search.taken.level(t.stormingLevels['design-level'].label)] : []),
        ...(taken.scope ? [t.search.taken.level(t.allTimelines)] : []),
        ...(taken.filter ? [t.search.taken.filter] : []),
    ].join(t.search.taken.join);
}

/** The line for the domain model: a Structure View level that draws it, a narrowing taken away. */
export function modelTakenText(t: Messages, taken: { level?: StructureLevel; filter: boolean }): string {
    return [
        ...(taken.level !== undefined ? [t.search.taken.level(shortName(t.structureLevels[taken.level]))] : []),
        ...(taken.filter ? [t.search.taken.filter] : []),
    ].join(t.search.taken.join);
}

/** How long the line stays. */
const SHOWN_MS = 2600;

/** The line and how to say one (an empty one says nothing). */
export function useNotice(): { readonly text: string | undefined; readonly say: (text: string) => void } {
    const [text, setText] = useState<string | undefined>();
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const say = useCallback((next: string) => {
        if (!next) return;
        setText(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setText(undefined), SHOWN_MS);
    }, []);
    useEffect(() => () => clearTimeout(timer.current), []);
    return { text, say };
}

/** The line, over the page under the app bar. */
export function SearchNotice({ text }: { text: string | undefined }): ReactNode {
    return (
        <div className="search-notice" role="status" aria-live="polite">
            {text}
        </div>
    );
}

// What a unit of work changed, in the model's words (ADR 0026, amendment "changes in the model's words"): the elements
// the server lists between two revisions, named as the target chips are (their own name, in the display mode; their
// whole name in the tooltip), with where each goes, what it is, and the pairs already asked kept (revisions never change).
import { useEffect, useState } from 'react';
import type { ElementChange, ModelChangesBody } from '@domaintrail/collaboration/protocol';
import type { Messages } from '../i18n';
import { nameIn } from '../model-utils';
import { sessionApi } from './api';
import { targetName, targetShortName, type ModelTarget, type NamingContext } from './targets';

export type { ElementChange };

/** The changes of each pair of revisions asked for, kept for the page's life; a failed call is asked again next time. */
const kept = new Map<string, Promise<ModelChangesBody>>();

/** The changes between two revisions, asked once per pair. */
export function loadModelChanges(before: string, after: string): Promise<ModelChangesBody> {
    const key = `${before}>${after}`;
    const found = kept.get(key);
    if (found) return found;
    const asked = sessionApi.modelChanges(before, after);
    kept.set(key, asked);
    asked.catch(() => kept.delete(key));
    return asked;
}

export type ModelChangesState =
    | { readonly kind: 'loading' }
    | { readonly kind: 'loaded'; readonly body: ModelChangesBody }
    | { readonly kind: 'failed'; readonly error: unknown };

/** The changes between two revisions as they arrive. */
export function useModelChanges(before: string, after: string): ModelChangesState {
    const [state, setState] = useState<{ readonly key: string; readonly value: ModelChangesState }>({ key: '', value: { kind: 'loading' } });
    const key = `${before}>${after}`;
    useEffect(() => {
        let current = true;
        loadModelChanges(before, after).then(
            (body) => current && setState({ key, value: { kind: 'loaded', body } }),
            (error: unknown) => current && setState({ key, value: { kind: 'failed', error } }),
        );
        return () => {
            current = false;
        };
    }, [before, after, key]);
    return state.key === key ? state.value : { kind: 'loading' };
}

/** Where a change goes: the element as a request's target names it. */
export function changeTarget(c: ElementChange): ModelTarget {
    return c.language === 'Dt' ? { kind: 'DtElement', element: c.element } : { kind: 'DtesElement', storming: c.storming, local: c.local };
}

/** A change's key in a list: its kind of change and the element's ID. */
export const changeKey = (c: ElementChange): string => `${c.change}:${c.language === 'Dt' ? c.element : `es/${c.storming}/${c.local}`}`;

/** The display mode named in, `name` outside a naming context. */
const modeOf = (naming: NamingContext | undefined): NamingContext['mode'] => naming?.mode ?? 'name';

/** A change's own name (`支払済み`, not `請求書.支払済み`): from the model now while it is there, else as the server gave it. */
export function changeShortName(c: ElementChange, naming: NamingContext | undefined): string {
    const now = c.change !== 'removed' && naming ? targetShortName(changeTarget(c), naming) : undefined;
    return now ?? nameIn(modeOf(naming), c.name, c.label);
}

/** A change's whole name, for its tooltip: from the model now while it is there, else as the server gave it. */
export function changeFullName(c: ElementChange, naming: NamingContext | undefined): string {
    const now = c.change !== 'removed' && naming ? targetName(changeTarget(c), naming) : undefined;
    if (now !== undefined) return now;
    const mode = modeOf(naming);
    const own = nameIn(mode, c.name, c.label);
    if (c.language === 'Dt') return c.owner ? `${nameIn(mode, c.owner.name, c.owner.label)}.${own}` : c.element;
    return c.owner ? `${nameIn(mode, c.owner.name, c.owner.label)} / ${own}` : own;
}

/** What a change is, small beside it: its kind, and what it is in (`返品 の状態`, `集約`, `返品 のイベント`). */
export function changeWhat(
    c: ElementChange,
    t: Pick<Messages, 'kinds' | 'esKinds'>,
    of: (owner: string, what: string) => string,
    naming: NamingContext | undefined,
): string {
    const what = c.language === 'Dt' ? t.kinds[c.kind] : t.esKinds[c.kind];
    return c.owner ? of(nameIn(modeOf(naming), c.owner.name, c.owner.label), what) : what;
}

/** The changes by kind, in the order the server gave them: only the kinds that have some. */
export function changeGroups(changes: readonly ElementChange[]): { readonly change: ElementChange['change']; readonly items: readonly ElementChange[] }[] {
    return (['added', 'changed', 'removed'] as const).flatMap((change) => {
        const items = changes.filter((c) => c.change === change);
        return items.length ? [{ change, items }] : [];
    });
}

/**
 * The narrowings behind each view's 絞り込み button: what each one is, how many are active (not in their default
 * state), and the catalog's kinds as checkboxes. The views keep their own state; these only read it.
 */

/** What each view narrows, as its state is (only the views with a 絞り込み button). */
export type ViewFilters =
    | {
          readonly view: 'contextMap';
          /** Also show shared and ID-only contexts (off by default). */
          readonly mapAll: boolean;
      }
    | {
          readonly view: 'structure';
          /** How many contexts there are, and how many are drawn (all of them by default). */
          readonly contexts: number;
          readonly checked: number;
          /** The contexts whose stubs are hidden, of the ones that apply (none by default). */
          readonly hidden: number;
      }
    | {
          readonly view: 'catalog';
          /** The contexts shown (null: every one). */
          readonly contexts: readonly string[] | null;
          /** The kinds shown (none: every one). */
          readonly kinds: readonly string[];
      }
    | {
          readonly view: 'storming';
          /** How many kinds of thing the view hides (none by default): the exceptions, the resolved hotspots. */
          readonly hidden: number;
      };

/**
 * How many narrowings are active: one per kind of narrowing not in its default state (the contexts, the hidden stubs,
 * the kinds, the shared and external contexts, each kind a storming hides: its exceptions, its resolved hotspots). The catalog's text filter is not counted: it
 * is shown as it is typed.
 */
export function activeFilterCount(f: ViewFilters): number {
    switch (f.view) {
        case 'contextMap':
            return f.mapAll ? 1 : 0;
        case 'structure':
            return (f.checked !== f.contexts ? 1 : 0) + (f.hidden > 0 ? 1 : 0);
        case 'catalog':
            return (f.contexts !== null ? 1 : 0) + (f.kinds.length > 0 ? 1 : 0);
        case 'storming':
            return f.hidden;
    }
}

/** The catalog's kinds that are shown: the chosen ones, or every one when none is chosen. */
export const shownKinds = <K extends string>(all: readonly K[], kinds: readonly K[]): readonly K[] => (kinds.length ? kinds : all);

/**
 * The catalog's kinds after a kind's checkbox is clicked (checked: shown). Every kind shown is the empty choice, as
 * before; the last kind shown cannot be hidden (an empty choice would show them all), so it stays.
 */
export function toggleKind<K extends string>(all: readonly K[], kinds: readonly K[], kind: K): K[] {
    const shown = shownKinds(all, kinds);
    const next = shown.includes(kind) ? shown.filter((k) => k !== kind) : all.filter((k) => k === kind || shown.includes(k));
    if (next.length === 0) return [...kinds];
    return next.length === all.length ? [] : next;
}

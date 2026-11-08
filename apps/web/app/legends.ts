import { useCallback, useState } from 'react';
import type { LegendView } from '../legend';
import { readStored, removeStored, writeStored, type KeyValueStorage } from '../shared/layout';

/**
 * The toolbars that each keep their own legend open or closed: one per view. The structure's levels and its focus are
 * the same toolbar (its controls stay as they are when the level or the focus changes), so they share one.
 */
export type LegendToolbar = 'contextMap' | 'structure' | 'states' | 'storming';

export const LEGEND_TOOLBARS: readonly LegendToolbar[] = ['contextMap', 'structure', 'states', 'storming'];

/** Whether each toolbar's legend is open. */
export type LegendsOpen = Readonly<Record<LegendToolbar, boolean>>;

/** The former key of one legend for the whole page: no longer read, and removed on the first read. */
export const FORMER_LEGEND_KEY = 'domaintrail.layout.legend';

/** The toolbar whose legend `view` shows. */
export function legendToolbar(view: LegendView): LegendToolbar {
    switch (view) {
        case 'structure':
        case 'structureFocus':
        case 'aggregates':
        case 'aggregatesFocus':
            return 'structure';
        default:
            return view;
    }
}

/** Where a toolbar's legend state is remembered (per browser). */
export function legendKey(toolbar: LegendToolbar): string {
    return `domaintrail.legend.${toolbar}`;
}

/** Each toolbar's remembered state, closed where nothing is remembered; the former page-wide key is dropped. */
export function readLegends(storage?: KeyValueStorage & Pick<Storage, 'removeItem'>): LegendsOpen {
    removeStored(FORMER_LEGEND_KEY, storage);
    const open = (toolbar: LegendToolbar): boolean => readStored<unknown>(legendKey(toolbar), false, storage) === true;
    return { contextMap: open('contextMap'), structure: open('structure'), states: open('states'), storming: open('storming') };
}

/** `open` with `view`'s legend toggled (its toolbar's, the others left as they are), remembered under its key. */
export function toggleLegend(open: LegendsOpen, view: LegendView, storage?: KeyValueStorage): LegendsOpen {
    const toolbar = legendToolbar(view);
    const next = !open[toolbar];
    writeStored(legendKey(toolbar), next, storage);
    return { ...open, [toolbar]: next };
}

/** The legends of the views' toolbars: each open or closed on its own, hidden until opened. */
export interface Legends {
    isOpen: (view: LegendView) => boolean;
    toggle: (view: LegendView) => void;
}

export function useLegends(): Legends {
    const [open, setOpen] = useState<LegendsOpen>(() => readLegends());
    const isOpen = useCallback((view: LegendView): boolean => open[legendToolbar(view)], [open]);
    const toggle = useCallback((view: LegendView): void => setOpen(toggleLegend(open, view)), [open]);
    return { isOpen, toggle };
}

// What a view's legend says: the kinds of edge it draws and what each means there, its notes, and for an Event
// Storming the kinds of note. The Live View draws it under its 凡例 button and on a printed sheet; the portable SVG
// under the diagram.
import type { StormingElementKind } from '@domaintrail/storming';
import type { EdgeKind } from '../graph/ir.js';
import type { DiagramTexts } from './texts.js';

/** The canvas views a legend is for (the structure's levels, focused or not, read differently). */
export type LegendView = 'contextMap' | 'structure' | 'structureFocus' | 'aggregates' | 'aggregatesFocus' | 'states' | 'storming';

/** One kind of edge of a view, with what it means there. */
export interface LegendRow {
    readonly kind: EdgeKind;
    readonly text: string;
}

/** The kinds of edge a view draws, with what each means in it: the legend's rows, and the edges' hover hints. */
export function legendRows(view: LegendView, words: DiagramTexts['legendRows']): readonly LegendRow[] {
    switch (view) {
        case 'contextMap':
            return [
                { kind: 'references', text: words.mapReferences },
                { kind: 'dependsOn', text: words.mapDependsOn },
            ];
        case 'structureFocus':
            return [
                { kind: 'owns', text: words.owns },
                { kind: 'references', text: words.focusReferences },
                { kind: 'value', text: words.focusValue },
            ];
        case 'aggregates':
        case 'aggregatesFocus':
            return [
                { kind: 'references', text: words.aggregateReferences },
                { kind: 'value', text: words.aggregateValue },
            ];
        case 'structure':
            return [
                { kind: 'owns', text: words.owns },
                { kind: 'references', text: words.references },
                { kind: 'value', text: words.value },
            ];
        case 'storming':
            return [
                { kind: 'esCausal', text: words.esCausal },
                { kind: 'esSequence', text: words.esSequence },
                { kind: 'esException', text: words.esException },
                { kind: 'esRejoin', text: words.esRejoin },
                { kind: 'esRelated', text: words.esRelated },
                { kind: 'esFeeds', text: words.esFeeds },
                { kind: 'esHotspot', text: words.esHotspot },
            ];
        case 'states':
            return [{ kind: 'transition', text: words.transition }];
    }
}

/** A chip of the storming legend's key: a kind of note, or a resolved hotspot (a hotspot toned down, with a check). */
export type LegendKind = StormingElementKind | 'resolvedHotspot';

/**
 * The storming's kinds in the legend's key, in the convention's order: the core notes (event orange, command blue,
 * policy purple, aggregate yellow, read model green, hotspot red, then a resolved one), then the actor, the external
 * system, a timeline's group and a stage's frame. A timeline itself is its arrows (the rows above).
 */
export const STORMING_LEGEND_KINDS: readonly LegendKind[] = [
    'event',
    'command',
    'policy',
    'aggregate',
    'readmodel',
    'hotspot',
    'resolvedHotspot',
    'actor',
    'external',
    'group',
    'stage',
];

/** What a view's legend says: its edges' rows, its notes, and for an Event Storming the kinds of note. */
export interface LegendContent {
    readonly rows: readonly LegendRow[];
    /** Notes under the rows (what the stubs and the ↻ rows are). */
    readonly notes: readonly string[];
    /** The storming's kinds of note, in the key's order (an Event Storming only). */
    readonly kinds: readonly LegendKind[];
    /** The last note: which way the arrows point. */
    readonly arrows: string;
}

/** The names of the legend key's chips, in the Live View's language. */
export const legendKindNames = (t: DiagramTexts): Record<LegendKind, string> => ({ ...t.esKinds, resolvedHotspot: t.resolvedHotspot });

/** The legend of `view`: on the screen, on a printed sheet and in an exported image. */
export function legendContent(view: LegendView, t: DiagramTexts): LegendContent {
    const note = view === 'structureFocus' ? t.stubNote : view === 'aggregatesFocus' ? t.aggregateStubNote : view === 'states' ? t.internalNote : undefined;
    return {
        rows: legendRows(view, t.legendRows),
        notes: note ? [note] : [],
        kinds: view === 'storming' ? STORMING_LEGEND_KINDS : [],
        arrows: view === 'storming' ? t.stormingArrowNote : t.arrowNote,
    };
}

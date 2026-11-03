import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import type { StormingElementKind } from '@domaintrail/storming';
import type { EdgeKind } from '@domaintrail/visualization';
import { checkPath, RESOLVED_MARK } from './diagram-items';
import { useT, type Messages } from './i18n';

/** The canvas views a legend is for (the structure's levels, focused or not, read differently). */
export type LegendView = 'contextMap' | 'structure' | 'structureFocus' | 'aggregates' | 'aggregatesFocus' | 'states' | 'storming';

/** One kind of edge of a view, with what it means there. */
export interface LegendRow {
    readonly kind: EdgeKind;
    readonly text: string;
}

/** The kinds of edge a view draws, with what each means in it: the legend's rows, and the edges' hover hints. */
export function legendRows(view: LegendView, words: Messages['legendRows']): readonly LegendRow[] {
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
export const legendKindNames = (t: Messages): Record<LegendKind, string> => ({ ...t.esKinds, resolvedHotspot: t.resolvedHotspot });

/** The legend of `view`: on the screen, on a printed sheet and in an exported image. */
export function legendContent(view: LegendView, t: Messages): LegendContent {
    const note = view === 'structureFocus' ? t.stubNote : view === 'aggregatesFocus' ? t.aggregateStubNote : view === 'states' ? t.internalNote : undefined;
    return {
        rows: legendRows(view, t.legendRows),
        notes: note ? [note] : [],
        kinds: view === 'storming' ? STORMING_LEGEND_KINDS : [],
        arrows: view === 'storming' ? t.stormingArrowNote : t.arrowNote,
    };
}

/**
 * Key for the edges of the canvas views (and, for an Event Storming, the colour of each kind of note); every edge
 * points from the dependent to its dependency (in an Event Storming, along causes and time). It opens upward from the
 * 凡例 button of the canvas's bottom-left controls.
 */
export function Legend({ view, open, onToggle }: { view: LegendView; open: boolean; onToggle: () => void }) {
    const t = useT();
    return (
        // closed, it folds down into its button: the slot's height goes to nothing as the legend fades (styles.css)
        <div className={`legend-slot${open ? ' open' : ''}`} inert={!open}>
            <div className="legend-clip">
                <div className="legend">
                    <div className="legend-title">
                        {t.legend}
                        <button className="icon-button" onClick={onToggle} data-tooltip={t.closeLegend} aria-label={t.closeLegend}>
                            <ChevronDown size={14} aria-hidden />
                        </button>
                    </div>
                    <LegendBody view={view} />
                </div>
            </div>
        </div>
    );
}

/** The legend's rows, notes and kinds (under its title, on the screen and on a printed sheet). */
export function LegendBody({ view }: { view: LegendView }): ReactNode {
    const t = useT();
    const { rows, notes, kinds, arrows } = legendContent(view, t);
    const names = legendKindNames(t);
    return (
        <>
            {rows.map((r) => (
                <div key={r.kind} className="legend-row">
                    <svg width="56" height="14" className={`de de-${r.kind}`} aria-hidden>
                        <path d="M4,7 L42,7" className="de-line" />
                        {r.kind === 'owns' && <path d="M2,7 L9,3.5 L16,7 L9,10.5 Z" className="de-head de-diamond" />}
                        {r.kind !== 'esHotspot' && <path d="M54,7 L41,0.5 L41,13.5 Z" className="de-head" />}
                    </svg>
                    <span>{r.text}</span>
                </div>
            ))}
            {notes.map((n) => (
                <div key={n} className="legend-note">
                    {n}
                </div>
            ))}
            {kinds.length > 0 && (
                <div className="legend-kinds">
                    {kinds.map((k) => (
                        <span key={k} className={`kind kind-es-${k}`}>
                            {k === 'resolvedHotspot' && <ResolvedChipMark />}
                            {names[k]}
                        </span>
                    ))}
                </div>
            )}
            <div className="legend-note">{arrows}</div>
        </>
    );
}

/** The check of a resolved hotspot, in its legend chip (the note's `RESOLVED_MARK`, smaller). */
function ResolvedChipMark(): ReactNode {
    const r = RESOLVED_MARK.radius - 2;
    return (
        <svg className="dn-resolved-mark-chip" width={2 * r} height={2 * r} viewBox={`0 0 ${2 * r} ${2 * r}`} aria-hidden>
            <circle cx={r} cy={r} r={r} className="dn-resolved-disc" />
            <path d={checkPath(r, r, r)} className="dn-resolved-check" />
        </svg>
    );
}

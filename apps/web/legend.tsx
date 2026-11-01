import { ChevronDown } from 'lucide-react';
import type { EdgeKind } from '@domaintrail/visualization';
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
                { kind: 'esRelated', text: words.esRelated },
                { kind: 'esHotspot', text: words.esHotspot },
            ];
        case 'states':
            return [{ kind: 'transition', text: words.transition }];
    }
}

/**
 * Key for the edges of the canvas views; every edge points from the dependent to its dependency (in an Event Storming,
 * along causes and time). It opens upward from the 凡例 button of the canvas's bottom-left controls.
 */
export function Legend({ view, open, onToggle }: { view: LegendView; open: boolean; onToggle: () => void }) {
    const t = useT();
    const rows = legendRows(view, t.legendRows);
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
                    {view === 'structureFocus' && <div className="legend-note">{t.stubNote}</div>}
                    {view === 'aggregatesFocus' && <div className="legend-note">{t.aggregateStubNote}</div>}
                    {view === 'states' && <div className="legend-note">{t.internalNote}</div>}
                    {view === 'storming' && <div className="legend-note">{t.stormingColorNote}</div>}
                    <div className="legend-note">{view === 'storming' ? t.stormingArrowNote : t.arrowNote}</div>
                </div>
            </div>
        </div>
    );
}

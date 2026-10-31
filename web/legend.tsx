import { BookOpen, ChevronDown } from 'lucide-react';
import { useT } from './i18n';

/**
 * Key for the edges of the canvas views; every edge points from the dependent to its dependency (in an Event Storming,
 * along causes and time). It floats over the canvas while open; the toolbar's `LegendToggle` opens and closes it.
 */
export function Legend({
    view,
    open,
    onToggle,
}: {
    view: 'contextMap' | 'structure' | 'structureFocus' | 'aggregates' | 'aggregatesFocus' | 'states' | 'storming';
    open: boolean;
    onToggle: () => void;
}) {
    const t = useT();
    const words = t.legendRows;
    const rows =
        view === 'contextMap'
            ? [
                  { kind: 'references', text: words.mapReferences },
                  { kind: 'dependsOn', text: words.mapDependsOn },
              ]
            : view === 'structureFocus'
              ? [
                    { kind: 'owns', text: words.owns },
                    { kind: 'references', text: words.focusReferences },
                    { kind: 'value', text: words.focusValue },
                ]
              : view === 'aggregates' || view === 'aggregatesFocus'
                ? [
                      { kind: 'references', text: words.aggregateReferences },
                      { kind: 'value', text: words.aggregateValue },
                  ]
                : view === 'structure'
                  ? [
                        { kind: 'owns', text: words.owns },
                        { kind: 'references', text: words.references },
                        { kind: 'value', text: words.value },
                    ]
                  : view === 'storming'
                    ? [
                          { kind: 'esCausal', text: words.esCausal },
                          { kind: 'esSequence', text: words.esSequence },
                          { kind: 'esRelated', text: words.esRelated },
                          { kind: 'esHotspot', text: words.esHotspot },
                      ]
                    : [{ kind: 'transition', text: words.transition }];
    return (
        <div className={`legend${open ? '' : ' legend-closed'}`} inert={!open}>
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
    );
}

/** The toolbar's button opening and closing the legend that floats over the canvas. */
export function LegendToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
    const t = useT();
    return (
        <button className={`legend-toggle${open ? ' active' : ''}`} aria-pressed={open} onClick={onToggle} data-tooltip={open ? t.closeLegend : t.openLegend}>
            <BookOpen size={14} aria-hidden />
            {t.legend}
        </button>
    );
}

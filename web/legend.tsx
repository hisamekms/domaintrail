import { ChevronDown, ChevronUp } from 'lucide-react';
import { useT } from './i18n';

/**
 * Key for the edges of the canvas views; every edge points from the dependent to its dependency. Closed, it leaves a
 * flat tab on the bottom edge of the canvas that opens it.
 */
export function Legend({ view, open, onToggle }: { view: 'contextMap' | 'structure' | 'structureFocus' | 'aggregates' | 'aggregatesFocus' | 'states'; open: boolean; onToggle: () => void }) {
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
                : [{ kind: 'transition', text: words.transition }];
    return (
        <>
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
                            <path d="M54,7 L41,0.5 L41,13.5 Z" className="de-head" />
                        </svg>
                        <span>{r.text}</span>
                    </div>
                ))}
                {view === 'structureFocus' && <div className="legend-note">{t.stubNote}</div>}
                {view === 'aggregatesFocus' && <div className="legend-note">{t.aggregateStubNote}</div>}
                {view === 'states' && <div className="legend-note">{t.internalNote}</div>}
                <div className="legend-note">{t.arrowNote}</div>
            </div>
            <button className={`legend-tab${open ? '' : ' shown'}`} inert={open} onClick={onToggle} data-tooltip={t.openLegend} aria-label={t.openLegend}>
                <ChevronUp size={14} aria-hidden />
            </button>
        </>
    );
}

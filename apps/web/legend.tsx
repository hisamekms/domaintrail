import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { legendContent, legendKindNames, type LegendView } from '@domaintrail/visualization';
import { checkPath, RESOLVED_MARK } from './diagram-items';
import { useT } from './i18n';

export {
    legendContent,
    legendKindNames,
    legendRows,
    STORMING_LEGEND_KINDS,
    type LegendContent,
    type LegendKind,
    type LegendRow,
    type LegendView,
} from '@domaintrail/visualization';

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

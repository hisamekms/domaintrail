import { useRef, useState, type CSSProperties } from 'react';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import { useLang, useT } from '../i18n';
import { useDismiss } from '../shared/layout';
import { healthOf } from './health';
import type { Connection } from './useViewSocket';

/**
 * The page's health as one dot at the foot of the left pane, with what is wrong next to it when something is; a click
 * shows the status, the file count, the version, the time of the last update and the connection.
 */
export function HealthButton({ current, connection }: { current: ViewPayload | null; connection: Connection }) {
    const t = useT();
    const lang = useLang();
    const [place, setPlace] = useState<CSSProperties | null>(null);
    const root = useRef<HTMLDivElement>(null);
    useDismiss(place !== null, root, () => setPlace(null));
    const warnings = current?.diagnostics.filter((d) => d.severity === 'warning').length ?? 0;
    const health = healthOf({ status: current?.status, connection, stale: current?.stale ?? false, warnings });
    // what is wrong, in a word: the connection first, then the model
    const what =
        connection !== 'open'
            ? t.connection[connection]
            : current && current.status !== 'ok'
              ? t.status[current.status]
              : health === 'ok'
                ? ''
                : t.health[health];
    const label = t.healthLabel(what || t.health[health]);
    return (
        <div className="health" ref={root}>
            <button
                className={`health-button health-${health}`}
                aria-haspopup="dialog"
                aria-expanded={place !== null}
                aria-label={label}
                data-tooltip={label}
                onClick={(e) => {
                    if (place) return setPlace(null);
                    // fixed above the button, so that the collapsing pane never clips it
                    const r = e.currentTarget.getBoundingClientRect();
                    setPlace({ left: Math.max(8, r.left), bottom: window.innerHeight - r.top + 6 });
                }}
            >
                <span className="health-dot" aria-hidden />
                {health !== 'ok' && <span className="health-text">{what}</span>}
            </button>
            {place && (
                <div className="health-popover" role="dialog" aria-label={label} style={place}>
                    <dl>
                        <dt>{t.healthRows.status}</dt>
                        <dd>{current ? <span className={`pill pill-${current.status}`}>{t.status[current.status]}</span> : '—'}</dd>
                        <dt>{t.healthRows.files}</dt>
                        <dd>{current ? t.fileCount(current.files.length) : '—'}</dd>
                        <dt>{t.healthRows.version}</dt>
                        <dd>{current ? `v${current.version}` : '—'}</dd>
                        <dt>{t.healthRows.updated}</dt>
                        <dd>{current ? new Date(current.updatedAt).toLocaleTimeString(lang) : '—'}</dd>
                        <dt>{t.healthRows.connection}</dt>
                        <dd>
                            <span className={`conn conn-${connection}`} aria-hidden /> {t.connection[connection]}
                        </dd>
                    </dl>
                </div>
            )}
        </div>
    );
}

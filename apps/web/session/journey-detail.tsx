// The journeys in the detail (the plan's "The current journey": "the detail also shows, briefly…"): a storming's ES
// journey — why, how far, where it stands — and the modeling journeys a context is part of (those that name it, and
// those over the whole model). Each row opens the journeys panel. Outside the chat: it reads the overview the page
// computed and the texts.
import type { ReactElement } from 'react';
import { CircleCheck, Compass, Flag, MapPin, TriangleAlert } from 'lucide-react';
import { useT } from '../i18n';
import type { JourneyItem } from './journey-view';

/** The rows of the journeys given, under a heading; none: a line saying so (a storming without its journey). */
export function JourneyDetail(props: {
    readonly items: readonly JourneyItem[];
    readonly current?: string;
    readonly onOpen: () => void;
    readonly empty?: boolean;
}): ReactElement | null {
    const t = useT().session.chat;
    const j = t.journeys;
    const g = t.guide;
    const step = (key: string | undefined, es: boolean): string =>
        key === undefined ? '' : es ? (g.levels[key] ?? g.esGoals[key] ?? g.steps[key] ?? key) : (g.steps[key] ?? key);
    if (props.items.length === 0 && !props.empty) return null;
    return (
        <div className="journey-detail">
            <p className="journey-detail-head">
                <Compass size={12} aria-hidden /> {j.detailHead}
            </p>
            {props.items.length === 0 ? (
                <p className="muted small">{j.detailNone}</p>
            ) : (
                <ul>
                    {props.items.map((item) => {
                        const s = item.summary;
                        const es = s.kind === 'es';
                        return (
                            <li key={s.key}>
                                <button type="button" className={`journey-detail-row${s.key === props.current ? ' current' : ''}`} onClick={props.onOpen}>
                                    <span className="journey-detail-name">
                                        {es ? s.purpose : s.name}
                                        {!es && s.pattern && <span className="muted"> · {g.patterns[s.pattern] ?? s.pattern}</span>}
                                    </span>
                                    <span className="journey-detail-where muted">
                                        {item.missing ? (
                                            <>
                                                <TriangleAlert size={11} aria-hidden /> {j.missing}
                                            </>
                                        ) : item.reached ? (
                                            <>
                                                <CircleCheck size={11} aria-hidden /> {j.reached}
                                            </>
                                        ) : (
                                            <>
                                                <MapPin size={11} aria-hidden /> {step(item.here, false)}
                                            </>
                                        )}
                                        <Flag size={11} aria-hidden /> {step(item.goal, es)}
                                        {s.state !== 'active' && <span> · {j.stateNames[s.state]}</span>}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

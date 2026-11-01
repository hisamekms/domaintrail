// The controls of votes and reactions in the chat (ADR 0026, appendix "Votes and reactions"), within the chat's
// decoration budget: counts are small muted text and line icons, no pills or borders; my own mark is the clickable
// violet (a filled ♥ for my vote), never red. Who marked is not shown until asked: on hover of a count (a tooltip of
// names) and on a click of the vote's count (a small popover, for touch). A reaction's click toggles mine, so its names
// are in its tooltip and, for touch, in the add-reaction popover (☺+), which lists who placed each reaction under the
// four choices.
import { useCallback, useMemo, useRef, useState } from 'react';
import { Check, CircleHelp, Heart, SmilePlus, ThumbsUp, type LucideIcon } from 'lucide-react';
import { useDismiss } from '../shared/layout';
import { sessionApi } from './api';
import { useChat, type ChatContextValue } from './chat-context';
import { failure } from './parts';
import type { SessionData } from './useSession';
import { canVote, markIndex, markKey, names, REACTIONS, reactionsOn, tallyOf, type MarkTargetData, type Reaction, type Sign, type Tally } from './marks';

export const REACTION_ICON: Record<Reaction, LucideIcon> = { Agree: ThumbsUp, Doubt: CircleHelp, Like: Heart, Seen: Check };

const pendingKey = (target: MarkTargetData, sign: Sign): string => `${sign}|${markKey(target)}`;

/** Whether marks can be set now: the session is open and this page is connected. */
function useLive(): boolean {
    const { session } = useChat();
    return session.status === 'live' && session.state.session.state === 'Open';
}

/** A vote's count: the names on hover; a click opens a small list of them (for touch). */
function VoteCount({ tally }: { tally: Tally }) {
    const { tx, nameOf } = useChat();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLSpanElement>(null);
    useDismiss(open, root, () => setOpen(false));
    const v = tx.chat.votes;
    return (
        <span className="mark-who" ref={root}>
            <button
                type="button"
                className="mark-count"
                aria-expanded={open}
                aria-label={`${v.count(tally.count)}: ${names(tally, nameOf, tx.chat.listSeparator)}`}
                data-tooltip={names(tally, nameOf, tx.chat.listSeparator)}
                onClick={() => setOpen(!open)}
            >
                {tally.count}
            </button>
            {open && (
                <span className="mark-who-list motion-pop" role="dialog" aria-label={v.whoTitle}>
                    <span className="mark-who-title">{v.whoTitle}</span>
                    {tally.who.map((id) => (
                        <span key={id} className="mark-who-name">
                            {nameOf(id)}
                        </span>
                    ))}
                </span>
            )}
        </span>
    );
}

/**
 * The vote of a row (a question's option, an assumption kept or an alternative), at its right: `♡ 2`. A participant
 * clicks ♡ to vote (again to take it off; in a single-choice question or an assumption it moves); mine is a filled ♥ in
 * violet. The facilitator, and everyone once the vote closed, only sees the count. Nothing while nobody can vote and
 * nobody voted.
 */
export function VoteMark({ target }: { target: MarkTargetData }) {
    const { tx, session, marking } = useChat();
    const live = useLive();
    const tally = tallyOf(marking.index, target, 'Vote');
    const can = canVote(target, session.state, session.me.participant.role, live);
    if (!can && tally.count === 0) return null;
    const v = tx.chat.votes;
    const heart = <Heart size={12} aria-hidden fill={tally.mine ? 'currentColor' : 'none'} />;
    return (
        <span className={`vote-mark${tally.mine ? ' mine' : ''}${can ? '' : ' frozen'}`}>
            {can ? (
                <button
                    type="button"
                    className="vote-heart"
                    aria-pressed={tally.mine}
                    aria-label={tally.mine ? v.unvote : v.vote}
                    data-tooltip={tally.mine ? v.unvote : v.vote}
                    disabled={marking.pending.has(pendingKey(target, 'Vote'))}
                    onClick={() => marking.set(target, 'Vote', !tally.mine)}
                >
                    {heart}
                </button>
            ) : (
                <span className="vote-heart" role="img" aria-label={v.votes}>
                    {heart}
                </span>
            )}
            {tally.count > 0 && <VoteCount tally={tally} />}
        </span>
    );
}

/** The reactions placed on a message or a turn, under its body: icon and count each; a click toggles mine; the names in the tooltip. */
export function ReactionRow({ target }: { target: MarkTargetData }) {
    const { tx, nameOf, marking } = useChat();
    const live = useLive();
    const placed = reactionsOn(marking.index, target);
    if (placed.length === 0) return null;
    const r = tx.chat.reactions;
    return (
        <div className="reaction-row">
            {placed.map(({ sign, tally }) => {
                const Icon = REACTION_ICON[sign];
                const who = `${r.names[sign]}: ${names(tally, nameOf, tx.chat.listSeparator)}`;
                return (
                    <button
                        key={sign}
                        type="button"
                        className={`reaction${tally.mine ? ' mine' : ''}`}
                        aria-pressed={tally.mine}
                        aria-label={`${who} (${tally.count})`}
                        data-tooltip={who}
                        disabled={!live || marking.pending.has(pendingKey(target, sign))}
                        onClick={() => marking.set(target, sign, !tally.mine)}
                    >
                        <Icon size={13} aria-hidden />
                        <span className="reaction-count">{tally.count}</span>
                    </button>
                );
            })}
        </div>
    );
}

/**
 * ☺+ at the right end of a message or a turn (shown on hover or focus, always on touch): a small popover of the four
 * reactions to toggle mine, and under them who placed each reaction there is (where touch reads the names).
 */
export function AddReaction({ target }: { target: MarkTargetData }) {
    const { tx, nameOf, marking } = useChat();
    const live = useLive();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    useDismiss(open, root, () => setOpen(false));
    if (!live) return null;
    const r = tx.chat.reactions;
    const placed = reactionsOn(marking.index, target);
    return (
        <div className="reaction-add" ref={root}>
            <button
                type="button"
                className="icon-button reaction-add-button"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={r.add}
                data-tooltip={r.add}
                onClick={() => setOpen(!open)}
            >
                <SmilePlus size={14} aria-hidden />
            </button>
            {open && (
                <div className="reaction-picker motion-pop" role="dialog" aria-label={r.add}>
                    <div className="reaction-choices">
                        {REACTIONS.map((sign) => {
                            const Icon = REACTION_ICON[sign];
                            const mine = tallyOf(marking.index, target, sign).mine;
                            return (
                                <button
                                    key={sign}
                                    type="button"
                                    className={`reaction-choice${mine ? ' mine' : ''}`}
                                    aria-pressed={mine}
                                    aria-label={r.names[sign]}
                                    data-tooltip={r.names[sign]}
                                    disabled={marking.pending.has(pendingKey(target, sign))}
                                    onClick={() => {
                                        marking.set(target, sign, !mine);
                                        setOpen(false);
                                    }}
                                >
                                    <Icon size={15} aria-hidden />
                                </button>
                            );
                        })}
                    </div>
                    {placed.length > 0 && (
                        <ul className="reaction-who">
                            {placed.map(({ sign, tally }) => {
                                const Icon = REACTION_ICON[sign];
                                return (
                                    <li key={sign}>
                                        <Icon size={12} aria-label={r.names[sign]} />
                                        <span>{names(tally, nameOf, tx.chat.listSeparator)}</span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * The chat's marking: the session's placed marks counted, and setting one of mine — one call per click, without an
 * optimistic change (the server sends the change to every page, this one too, before it answers); a mark being set is
 * not clickable again until then. The last failure, if any.
 */
export function useMarking(session: SessionData): ChatContextValue['marking'] & { readonly error: string | undefined } {
    const me = session.me.participant.id;
    const index = useMemo(() => markIndex(session.state, me), [session.state, me]);
    const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
    const [error, setError] = useState<string | undefined>();
    const set = useCallback((target: MarkTargetData, sign: Sign, placed: boolean): void => {
        const key = pendingKey(target, sign);
        setPending((p) => new Set([...p, key]));
        sessionApi
            .setMark({ target, sign, placed })
            .then(
                () => setError(undefined),
                (e: unknown) => setError(failure(e)),
            )
            .finally(() =>
                setPending((p) => {
                    const next = new Set(p);
                    next.delete(key);
                    return next;
                }),
            );
    }, []);
    return useMemo(() => ({ index, set, pending, error }), [index, set, pending, error]);
}

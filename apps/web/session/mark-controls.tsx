// The controls of votes and reactions in the chat (ADR 0026, appendix "Votes and reactions"), within the chat's
// decoration budget: votes are small muted text with a line ♡, my vote the clickable violet (a filled ♥), never red.
// Reactions are emoji the participants choose — the app gives none a meaning — drawn in colour (the one exception to
// the budget), each with a small muted count and no pill; mine has its count in violet with a faint violet outline and
// background. Who marked is not shown until asked: on hover of a count or a reaction (a tooltip: the emoji and the
// names) and on a click of the vote's count (a small popover, for touch). A reaction's click toggles mine, so for touch
// its names are in the add-reaction popover (☺+): the quick emoji (`session.quickReactions`), [＋] for any other one
// typed or pasted (the OS emoji picker works there), and who placed each reaction there is.
import { useCallback, useMemo, useRef, useState } from 'react';
import { Heart, Plus, SmilePlus } from 'lucide-react';
import { useDismiss } from '../shared/layout';
import { sessionApi } from './api';
import { useChat, type ChatContextValue } from './chat-context';
import { failure } from './parts';
import type { SessionData } from './useSession';
import {
    canVote,
    markIndex,
    markKey,
    MAX_REACTION_EMOJI,
    names,
    quickReactions,
    reaction,
    reactionFits,
    reactionsOn,
    readEmoji,
    signKey,
    tallyOf,
    VOTE,
    type MarkTargetData,
    type Sign,
    type Tally,
} from './marks';

const pendingKey = (target: MarkTargetData, sign: Sign): string => `${signKey(sign)}|${markKey(target)}`;

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
 * violet. The facilitator, and everyone once the vote closed, only sees the count. The ♡ is always there and the count
 * has a slot of its own (two digits wide), so that the hearts of a reply's rows stand in one column, counted or not.
 */
export function VoteMark({ target }: { target: MarkTargetData }) {
    const { tx, session, marking } = useChat();
    const live = useLive();
    const tally = tallyOf(marking.index, target, VOTE);
    const can = canVote(target, session.state, session.me.participant.role, live);
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
                    disabled={marking.pending.has(pendingKey(target, VOTE))}
                    onClick={() => marking.set(target, VOTE, !tally.mine)}
                >
                    {heart}
                </button>
            ) : (
                <span className="vote-heart" role="img" aria-label={v.votes}>
                    {heart}
                </span>
            )}
            <span className="vote-count">{tally.count > 0 && <VoteCount tally={tally} />}</span>
        </span>
    );
}

/** The reactions placed on a message or a turn, under its body: each emoji and its count; a click toggles mine; the emoji and names in the tooltip. */
export function ReactionRow({ target }: { target: MarkTargetData }) {
    const { tx, nameOf, marking } = useChat();
    const live = useLive();
    const placed = reactionsOn(marking.index, target);
    if (placed.length === 0) return null;
    return (
        <div className="reaction-row">
            {placed.map(({ emoji, tally }) => {
                const sign = reaction(emoji);
                const who = `${emoji} ${names(tally, nameOf, tx.chat.listSeparator)}`;
                return (
                    <button
                        key={emoji}
                        type="button"
                        className={`reaction${tally.mine ? ' mine' : ''}`}
                        aria-pressed={tally.mine}
                        aria-label={`${who} (${tally.count})`}
                        data-tooltip={who}
                        disabled={!live || marking.pending.has(pendingKey(target, sign))}
                        onClick={() => marking.set(target, sign, !tally.mine)}
                    >
                        <span className="reaction-emoji" aria-hidden>
                            {emoji}
                        </span>
                        <span className="reaction-count">{tally.count}</span>
                    </button>
                );
            })}
        </div>
    );
}

/**
 * [＋] of the add-reaction popover opened: a small field for any one emoji, typed or pasted (the OS emoji picker works
 * there). Enter adds it (as mine; nothing when it is mine already), Escape closes the field. Not one emoji, or one more
 * than a target holds: a short hint, and the field stays.
 */
function EmojiField({ target, onAdd, onClose }: { target: MarkTargetData; onAdd: (emoji: string) => void; onClose: () => void }) {
    const { tx, marking } = useChat();
    const r = tx.chat.reactions;
    const [text, setText] = useState('');
    const [hint, setHint] = useState<string | undefined>();
    return (
        <div className="reaction-field">
            <input
                className="reaction-input"
                // the field is opened by a click on [＋]: focus moves to it
                // oxlint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                value={text}
                placeholder={r.typePlaceholder}
                aria-label={r.typeLabel}
                aria-invalid={hint !== undefined}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                    setText(e.target.value);
                    setHint(undefined);
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                        // the field closes; the popover stays (a second Escape closes it)
                        e.stopPropagation();
                        onClose();
                    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        const emoji = readEmoji(text);
                        if (emoji === undefined) setHint(r.notOneEmoji);
                        else if (!reactionFits(marking.index, target, emoji)) setHint(r.limit(MAX_REACTION_EMOJI));
                        else onAdd(emoji);
                    }
                }}
            />
            {hint && (
                <span className="reaction-hint" role="alert">
                    {hint}
                </span>
            )}
        </div>
    );
}

/**
 * ☺+ at the right end of a message or a turn (shown on hover or focus, always on touch): a small popover with the quick
 * emoji to toggle mine and [＋] for any other one, and under them who placed each reaction there is (where touch reads
 * the names).
 */
export function AddReaction({ target }: { target: MarkTargetData }) {
    const { tx, nameOf, marking, session } = useChat();
    const live = useLive();
    const [open, setOpen] = useState(false);
    const [typing, setTyping] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const close = useCallback(() => {
        setOpen(false);
        setTyping(false);
    }, []);
    useDismiss(open, root, close);
    if (!live) return null;
    const r = tx.chat.reactions;
    const placed = reactionsOn(marking.index, target);
    const toggle = (emoji: string, mine: boolean): void => {
        marking.set(target, reaction(emoji), !mine);
        close();
    };
    return (
        <div className="reaction-add" ref={root}>
            <button
                type="button"
                className="icon-button reaction-add-button"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={r.add}
                data-tooltip={r.add}
                onClick={() => (open ? close() : setOpen(true))}
            >
                <SmilePlus size={14} aria-hidden />
            </button>
            {open && (
                <div className="reaction-picker motion-pop" role="dialog" aria-label={r.add}>
                    <div className="reaction-choices">
                        {quickReactions(session.state).map((emoji) => {
                            const mine = tallyOf(marking.index, target, reaction(emoji)).mine;
                            return (
                                <button
                                    key={emoji}
                                    type="button"
                                    className={`reaction-choice${mine ? ' mine' : ''}`}
                                    aria-pressed={mine}
                                    aria-label={emoji}
                                    disabled={marking.pending.has(pendingKey(target, reaction(emoji))) || !reactionFits(marking.index, target, emoji)}
                                    onClick={() => toggle(emoji, mine)}
                                >
                                    <span aria-hidden>{emoji}</span>
                                </button>
                            );
                        })}
                        <button
                            type="button"
                            className="reaction-choice reaction-other"
                            aria-expanded={typing}
                            aria-label={r.other}
                            data-tooltip={r.other}
                            onClick={() => setTyping(!typing)}
                        >
                            <Plus size={14} aria-hidden />
                        </button>
                    </div>
                    {typing && (
                        <EmojiField
                            target={target}
                            onAdd={(emoji) => (tallyOf(marking.index, target, reaction(emoji)).mine ? close() : toggle(emoji, false))}
                            onClose={() => setTyping(false)}
                        />
                    )}
                    {placed.length > 0 && (
                        <ul className="reaction-who">
                            {placed.map(({ emoji, tally }) => (
                                <li key={emoji}>
                                    <span className="reaction-emoji">{emoji}</span>
                                    <span>{names(tally, nameOf, tx.chat.listSeparator)}</span>
                                </li>
                            ))}
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

// Pieces the session's chat and the facilitator's panel share: avatars, errors, and a request's targets and body
// (a row of its targets as chips with each one's status, mentions of elements and people as links).
import { Fragment } from 'react';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import type { TargetStatus } from '@domaintrail/collaboration';
import type { Messages } from '../i18n';
import { SessionApiError } from './api';
import { parseBody } from './mentions';
import { useTargetNaming } from './naming';
import { initials, participantColor } from './presence';
import { targetText } from './stream';
import { targetKey, targetShortName, type ModelTarget } from './targets';

type Tx = Messages['session'];
type FrozenRequest = SessionStateBody['runs'][number]['input']['requests'][number];

/** An error of a session call as one line. */
export const failure = (e: unknown): string =>
    e instanceof SessionApiError ? (e.message && e.message !== e.type ? `${e.type}: ${e.message}` : e.type) : String(e);

export function Avatar({ id, name, url }: { id: string; name: string; url?: string }) {
    // only an https avatar is shown; anything else gets the initials
    if (url?.startsWith('https://')) return <img className="session-avatar" src={url} alt="" referrerPolicy="no-referrer" />;
    return (
        <span className="session-avatar" style={{ background: participantColor(id) }} aria-hidden>
            {initials(name)}
        </span>
    );
}

type Snapshot = FrozenRequest['targets'][number];

/**
 * A target of a sent request as a read-only chip, `#` and its own name (`#支払済み (Paid)`; its whole name, as a mention
 * of it in the body reads, in the tooltip): a link to it while it is in the sources, else its name marked stale or unknown.
 */
export function TargetChip({
    target,
    status,
    onNavigate,
    tx,
}: {
    target: Snapshot;
    status: TargetStatus | undefined;
    onNavigate: (t: ModelTarget) => void;
    tx: Tx;
}) {
    const naming = useTargetNaming();
    const text = targetText(target, tx.workspace, naming);
    const shown = <span className="chat-chip-name">#{(naming && targetShortName(target.target, naming)) ?? text}</span>;
    const kind = `chat-chip chat-target kind-${target.target.kind}`;
    if (status === 'current' && target.target.kind !== 'Workspace')
        return (
            <a className={kind} onClick={() => onNavigate(target.target)} data-tooltip={`${text}\n${tx.targetStatusHint.current}`}>
                {shown}
            </a>
        );
    return (
        <span
            className={`${kind}${status === 'stale' ? ' stale' : ''}`}
            data-tooltip={status && status !== 'current' ? `${text}\n${tx.targetStatusHint[status]}` : text}
        >
            {shown}
        </span>
    );
}

/**
 * A request's targets above its body as a row of read-only chips (`#請求書` `#支払済み`, wrapping), each with its status;
 * none (the whole workspace): no row.
 */
export function TargetChips(props: {
    targets: readonly Snapshot[];
    statuses: readonly TargetStatus[] | undefined;
    onNavigate: (t: ModelTarget) => void;
    tx: Tx;
}) {
    const { targets, tx } = props;
    if (targets.length === 0) return null;
    return (
        <div className="chat-targets" role="group" aria-label={tx.chat.target}>
            {targets.map((t, i) => (
                <TargetChip key={targetKey(t.target)} target={t} status={props.statuses?.[i]} onNavigate={props.onNavigate} tx={tx} />
            ))}
        </div>
    );
}

/**
 * A body with its mentions as links: an element to its target (named as the chips are, `#注文`), a person to their row
 * among the participants (`@佐藤`, by the name they have now); the rest stays text.
 */
export function MentionedText(props: {
    body: string;
    targets: readonly Snapshot[];
    statuses: readonly TargetStatus[] | undefined;
    onNavigate: (t: ModelTarget) => void;
    /** The people the message mentions (`@name[pN]` is the N-th); none for a body that names no one. */
    mentions?: readonly string[];
    /** A person's name now. */
    nameOf?: (id: string) => string;
    /** Shows a mentioned person among the participants. */
    onPerson?: (id: string) => void;
    tx: Tx;
}) {
    const naming = useTargetNaming();
    const { targets, tx } = props;
    const mentions = props.mentions ?? [];
    return (
        <>
            {parseBody(props.body, { targets: targets.length, people: mentions.length }).map((seg, i) => {
                if (seg.kind === 'text') return <Fragment key={i}>{seg.text}</Fragment>;
                if (seg.kind === 'person') {
                    const id = mentions[seg.index];
                    const name = `@${props.nameOf?.(id) ?? seg.name}`;
                    const { onPerson } = props;
                    return onPerson ? (
                        <a key={i} className="chat-mention person" data-person={id} onClick={() => onPerson(id)}>
                            {name}
                        </a>
                    ) : (
                        <span key={i} className="chat-mention person">
                            {name}
                        </span>
                    );
                }
                const target = targets[seg.index];
                const name = `#${naming ? targetText(target, tx.workspace, naming) : seg.name}`;
                return props.statuses?.[seg.index] === 'current' ? (
                    <a key={i} className="chat-mention" onClick={() => props.onNavigate(target.target)}>
                        {name}
                    </a>
                ) : (
                    <span key={i} className="chat-mention stale">
                        {name}
                    </span>
                );
            })}
        </>
    );
}

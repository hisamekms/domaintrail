// Pieces the session's chat and the facilitator's panel share: avatars, errors, and a request's targets and body
// (a line of its targets with each one's status, mentions as links).
import { Fragment } from 'react';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import type { TargetStatus } from '@domaintrail/collaboration/domain/targets';
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
 * A target of a sent request, by its own name (its whole name in the tooltip): a link to it while it is in the sources,
 * else its name marked stale or unknown.
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
    const shown = (naming && targetShortName(target.target, naming)) ?? text;
    const kind = `chat-target kind-${target.target.kind}`;
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

/** A request's targets on one line above its body (`→ 注文、請求書`), each with its status; none: the whole workspace. */
export function TargetChips(props: {
    targets: readonly Snapshot[];
    statuses: readonly TargetStatus[] | undefined;
    onNavigate: (t: ModelTarget) => void;
    tx: Tx;
}) {
    const { targets, tx } = props;
    return (
        <p className="chat-targets">
            <span aria-hidden>→ </span>
            {targets.length === 0 ? (
                <span className="chat-target kind-Workspace">{tx.workspace}</span>
            ) : (
                targets.map((t, i) => (
                    <Fragment key={targetKey(t.target)}>
                        {i > 0 && tx.chat.listSeparator}
                        <TargetChip target={t} status={props.statuses?.[i]} onNavigate={props.onNavigate} tx={tx} />
                    </Fragment>
                ))
            )}
        </p>
    );
}

/** A body with its mentions as links to their targets (named as the chips are); the rest stays text. */
export function MentionedText(props: {
    body: string;
    targets: readonly Snapshot[];
    statuses: readonly TargetStatus[] | undefined;
    onNavigate: (t: ModelTarget) => void;
    tx: Tx;
}) {
    const naming = useTargetNaming();
    const { targets, tx } = props;
    return (
        <>
            {parseBody(props.body, targets.length).map((seg, i) => {
                if (seg.kind === 'text') return <Fragment key={i}>{seg.text}</Fragment>;
                const target = targets[seg.index];
                const name = `@${naming ? targetText(target, tx.workspace, naming) : seg.name}`;
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

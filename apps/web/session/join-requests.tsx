// The join requests of the `link` identity mode, in the chat's head of the facilitator's page: one compact row per
// person waiting (their name, marked when someone has the same name, when they asked, 許可, 拒否), as the server pushes
// them (`join.requests`), and a line once the invite link is used up. Nothing for anyone else, nor when nothing waits.
import { useState } from 'react';
import { Users, UserPlus } from 'lucide-react';
import { sessionApi } from './api';
import { useChat } from './chat-context';
import { failure } from './parts';
import type { SessionData } from './useSession';
import { Act } from '../shared/act';

export function JoinRequests(props: { session: SessionData }) {
    const { tx } = useChat();
    const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
    const [error, setError] = useState<string | undefined>();
    const requests = props.session.joining?.requests ?? [];
    const usedUp = props.session.joining?.inviteUsedUp ?? false;
    if (props.session.me.participant.role !== 'facilitator' || (requests.length === 0 && !usedUp)) return null;
    const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const decide = (id: string, decision: 'approve' | 'deny') => (): void => {
        setBusy((b) => new Set(b).add(id));
        setError(undefined);
        sessionApi
            .decideJoin(id, decision)
            .catch((e: unknown) => setError(tx.error(failure(e))))
            .finally(() =>
                setBusy((b) => {
                    const next = new Set(b);
                    next.delete(id);
                    return next;
                }),
            );
    };
    return (
        <div className="join-requests" role="region" aria-label={tx.chat.joinRequests} aria-live="polite">
            {requests.map((r) => (
                <div key={r.id} className="join-request" data-join-request={r.name}>
                    <UserPlus size={14} aria-hidden className="muted" />
                    <span className="join-request-name">{r.name}</span>
                    {r.duplicate && (
                        <span className="join-request-same" role="img" aria-label={tx.chat.sameName} data-tooltip={tx.chat.sameName}>
                            <Users size={13} aria-hidden />
                        </span>
                    )}
                    <time className="join-request-time muted small" dateTime={r.requestedAt}>
                        {time(r.requestedAt)}
                    </time>
                    <Act kind="decide" disabled={busy.has(r.id)} onClick={decide(r.id, 'approve')}>
                        {tx.chat.joinApprove}
                    </Act>
                    <Act kind="danger" disabled={busy.has(r.id)} onClick={decide(r.id, 'deny')}>
                        {tx.chat.joinDeny}
                    </Act>
                </div>
            ))}
            {usedUp && (
                <p className="small muted join-requests-used-up" data-tooltip={tx.chat.inviteUsedUpHint}>
                    {tx.chat.inviteUsedUp}
                </p>
            )}
            {error && <p className="small error">{error}</p>}
        </div>
    );
}

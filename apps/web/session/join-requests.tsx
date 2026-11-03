// The join requests of the `link` identity mode, in the chat's head of the facilitator's page: one compact row per
// person waiting (their name, 許可, 拒否), as the server pushes them (`join.requests`). Nothing for anyone else, nor
// when no one waits.
import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { sessionApi } from './api';
import { useChat } from './chat-context';
import { failure } from './parts';
import type { SessionData } from './useSession';

export function JoinRequests(props: { session: SessionData }) {
    const { tx } = useChat();
    const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
    const [error, setError] = useState<string | undefined>();
    const requests = props.session.joining?.requests ?? [];
    if (props.session.me.participant.role !== 'facilitator' || requests.length === 0) return null;
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
                    <button className="chat-small primary" disabled={busy.has(r.id)} onClick={decide(r.id, 'approve')}>
                        {tx.chat.joinApprove}
                    </button>
                    <button className="chat-small" disabled={busy.has(r.id)} onClick={decide(r.id, 'deny')}>
                        {tx.chat.joinDeny}
                    </button>
                </div>
            ))}
            {error && <p className="small error">{error}</p>}
        </div>
    );
}

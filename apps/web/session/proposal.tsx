// A change proposal in the chat (ADR 0030, 変更案): what the AI proposes to change for a participant's 依頼 — what, where
// (elements as links) and how — on the AI's bubble under the message, shown to everyone. The facilitator approves it as
// it is or edited, rejects it with an optional note, or chooses several to approve together (one run); its requester
// withdraws it while it waits. Its state is in the status slot while it waits, then who decided and when under it (the
// time of an approval a link to its run, whose card follows in the stream).
import { useState } from 'react';
import { Bot, Check, Pencil, X } from 'lucide-react';
import type { ProposalBody } from '@domaintrail/collaboration/protocol';
import { AI_NAME, openProposals, proposalContent, type ProposalJson } from './ai';
import { Bubble } from './bubble';
import { DecidedLine } from './card';
import { useChat } from './chat-context';
import { ReplyText } from './reply';
import { StatusSlot } from './status-slot';

const FIELDS = ['what', 'where', 'how'] as const;

/** The AI's mark, as on its turns. */
export const AiAvatar = () => (
    <span className="session-avatar chat-agent-avatar" aria-hidden>
        <Bot size={13} />
    </span>
);

export function ProposalCard({ proposal: p, continues }: { proposal: ProposalJson; continues: boolean }) {
    const { tx, session, control, actions, onNavigate, proposalPicks } = useChat();
    const t = tx.chat.proposal;
    const live = session.status === 'live' && session.state.session.state === 'Open';
    const open = p.state === 'Open';
    const content = proposalContent(p);
    const [mode, setMode] = useState<'view' | 'edit' | 'reject'>('view');
    const [draft, setDraft] = useState<ProposalBody>(content);
    const [note, setNote] = useState('');
    const deciding = control && live && open;
    const mine = p.requestedBy === session.me.participant.id;
    // choosing several to approve together, only when there is more than one to choose from
    const several = deciding && openProposals(session.state).length > 1;
    const picked = proposalPicks.ids.has(p.id);
    const edited = FIELDS.some((f) => draft[f].trim() !== content[f]);
    const approve = (): void => {
        const body = edited ? { proposal: p.id, edited: { what: draft.what.trim(), where: draft.where.trim(), how: draft.how.trim() } } : { proposal: p.id };
        void actions.approveProposals([body]).then((ok) => ok && setMode('view'));
    };
    const side = (open || p.state === 'Withdrawn') && (
        <div className="chat-message-side">
            <StatusSlot>
                <span className={`chat-state proposal-state-${p.state}`}>{t.states[p.state]}</span>
            </StatusSlot>
        </div>
    );
    return (
        <div className={`chat-row proposal-row state-${p.state}${picked ? ' selected' : ''}`}>
            {several && (
                <input
                    type="checkbox"
                    className="chat-select"
                    checked={picked}
                    onChange={() => proposalPicks.toggle(p.id)}
                    aria-label={t.select}
                    data-tooltip={t.select}
                />
            )}
            <Bubble avatar={<AiAvatar />} who={AI_NAME} at={p.proposedAt} continues={continues} className="chat-bubble-ai" side={side}>
                <section className="proposal" aria-label={t.label}>
                    <p className="proposal-label">{t.label}</p>
                    {mode === 'edit' ? (
                        <form
                            className="proposal-edit"
                            onSubmit={(e) => {
                                e.preventDefault();
                                approve();
                            }}
                        >
                            {FIELDS.map((f) => (
                                <label key={f} className="proposal-field">
                                    <span className="proposal-key">{t[f]}</span>
                                    <textarea
                                        className="session-text"
                                        value={draft[f]}
                                        rows={f === 'how' ? 4 : 2}
                                        maxLength={f === 'how' ? 2000 : f === 'where' ? 500 : 300}
                                        onChange={(e) => setDraft({ ...draft, [f]: e.target.value })}
                                    />
                                </label>
                            ))}
                            <div className="reply-actions">
                                <button type="submit" className="chat-small primary" disabled={actions.busy || FIELDS.some((f) => draft[f].trim() === '')}>
                                    <Check size={12} aria-hidden /> {t.approve}
                                </button>
                                <button type="button" className="chat-small" onClick={() => setMode('view')}>
                                    {t.cancel}
                                </button>
                            </div>
                        </form>
                    ) : (
                        <dl className="proposal-fields">
                            {FIELDS.map((f) => (
                                <div key={f} className="proposal-field">
                                    <dt className="proposal-key">{t[f]}</dt>
                                    <dd className="chat-text">
                                        <ReplyText text={content[f]} onNavigate={onNavigate} />
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    )}
                    {mode === 'reject' && (
                        <form
                            className="chat-apply-note"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void actions.rejectProposal(p.id, note).then((ok) => ok && setMode('view'));
                            }}
                        >
                            <input
                                className="session-text"
                                autoFocus
                                value={note}
                                maxLength={2000}
                                placeholder={t.note}
                                aria-label={t.note}
                                onChange={(e) => setNote(e.target.value)}
                            />
                            <button type="submit" className="chat-small danger" disabled={actions.busy}>
                                {t.reject}
                            </button>
                            <button type="button" className="icon-button" onClick={() => setMode('view')} aria-label={t.cancel}>
                                <X size={13} aria-hidden />
                            </button>
                        </form>
                    )}
                    {mode === 'view' && deciding && (
                        <div className="reply-actions">
                            <button type="button" className="chat-small primary" disabled={actions.busy} onClick={approve}>
                                <Check size={12} aria-hidden /> {t.approve}
                            </button>
                            <button
                                type="button"
                                className="chat-small ghost"
                                onClick={() => {
                                    setDraft(content);
                                    setMode('edit');
                                }}
                            >
                                <Pencil size={12} aria-hidden /> {t.edit}
                            </button>
                            <button type="button" className="chat-small ghost" onClick={() => setMode('reject')}>
                                {t.reject}
                            </button>
                        </div>
                    )}
                    {open && live && mine && (
                        <div className="reply-actions">
                            <button type="button" className="chat-small ghost" disabled={actions.busy} onClick={() => void actions.withdrawProposal(p.id)}>
                                {t.withdraw}
                            </button>
                        </div>
                    )}
                    {p.state === 'Approved' && (
                        <DecidedLine label={p.edited ? t.approvedEdited : t.states.Approved} by={p.approvedBy} at={p.approvedAt} run={p.run} />
                    )}
                    {p.state === 'Rejected' && (
                        <>
                            <DecidedLine label={t.states.Rejected} by={p.rejectedBy} at={p.rejectedAt} />
                            {p.note && <p className="decided-line proposal-note">{p.note}</p>}
                        </>
                    )}
                </section>
            </Bubble>
        </div>
    );
}

// A change proposal in the chat (ADR 0030, 変更案): what the AI proposes to change for a participant's 依頼 — the model
// elements it touches as chips (`#注文` 集約・販売, linked to the element; the first three and 「ほか n」) and how, in a
// line or two, without field labels or files — on the AI's bubble under the message, shown to everyone. When the AI
// was unsure it offers two or three options (a label, its elements, its own how if any), its recommendation marked and
// chosen first: the facilitator picks one and approves it (編集 edits the chosen option's how, then approves), rejects
// the proposal with an optional note, or chooses several proposals to approve together (one run); everyone else sees
// the options read-only, and its requester withdraws it while it waits. Who decided and when is under it (the time of
// an approval a link to its run, whose card follows in the stream), and the option approved with stays marked.
import { useState } from 'react';
import { Bot, Check, Pencil, X } from 'lucide-react';
import { useT } from '../i18n';
import { AI_NAME, openProposals, type ProposalJson } from './ai';
import { Bubble, Clamped } from './bubble';
import { DecidedLine } from './card';
import { useChat } from './chat-context';
import { useTargetNaming } from './naming';
import { chosenIndex, editableHow, existingTargets, headHow, shownOptionHow, shownTargets, targetLabel } from './proposal-view';
import { ReplyText } from './reply';
import { StatusSlot } from './status-slot';
import { targetKey, type ModelTarget } from './targets';
import { Act } from '../shared/act';

/** The AI's mark, as on its turns. */
export const AiAvatar = () => (
    <span className="session-avatar chat-agent-avatar" aria-hidden>
        <Bot size={13} />
    </span>
);

/** One target as a chip: `#` and its own name, then what it is and where; a link while it resolves. */
function TargetChip({ target }: { target: ModelTarget }) {
    const { onNavigate } = useChat();
    const naming = useTargetNaming();
    const label = targetLabel(target, naming, useT());
    const inner = (
        <>
            <span className="chat-chip-name">#{label.name}</span>
            {label.detail && <span className="proposal-target-detail">{label.detail}</span>}
        </>
    );
    return label.resolved ? (
        <a className="chat-chip chat-target proposal-target" onClick={() => onNavigate(target)} {...(label.path && { 'data-tooltip': label.path })}>
            {inner}
        </a>
    ) : (
        <span className="chat-chip chat-target proposal-target unresolved">{inner}</span>
    );
}

/**
 * The targets of a proposal or an option as a row of chips: the first three, then 「ほか n」 (the rest in its tooltip).
 * `existing`: only those that resolve now (a candidate's: one to be added is named by its label and how, not by an
 * identifier the person never wrote).
 */
export function TargetRow({ targets: all, existing = false }: { targets: readonly ModelTarget[]; existing?: boolean }) {
    const { tx } = useChat();
    const naming = useTargetNaming();
    const t = useT();
    const targets = existing ? existingTargets(all, naming, t) : all;
    if (targets.length === 0) return null;
    const { shown, more } = shownTargets(targets);
    const rest = targets
        .slice(shown.length)
        .map((x) => `#${targetLabel(x, naming, t).name}`)
        .join(' ');
    return (
        <span className="chat-targets proposal-targets">
            {shown.map((x) => (
                <TargetChip key={targetKey(x)} target={x} />
            ))}
            {more > 0 && (
                <span className="chat-chip chat-target proposal-more" data-tooltip={rest}>
                    {tx.chat.proposal.more(more)}
                </span>
            )}
        </span>
    );
}

/**
 * The options of a proposal: the facilitator's radio buttons while it waits (`pick`), read-only otherwise. The chosen
 * one (`chosen`) is marked; the AI's recommendation says so.
 */
function Options({ p, chosen, pick }: { p: ProposalJson; chosen: number | undefined; pick?: (i: number) => void }) {
    const { tx, onNavigate } = useChat();
    const t = tx.chat.proposal;
    return (
        <div className="proposal-options" role={pick ? 'radiogroup' : 'list'} aria-label={t.options}>
            {p.content.options.map((o, i) => {
                const how = shownOptionHow(p, i);
                const body = (
                    <span className="proposal-option-body">
                        <span className="proposal-option-head">
                            <span className="proposal-option-label">{o.label}</span>
                            {o.recommended && <span className="proposal-recommended">{t.recommended}</span>}
                        </span>
                        <TargetRow targets={o.targets} />
                        {how && (
                            <span className="proposal-option-how">
                                <ReplyText text={how} onNavigate={onNavigate} />
                            </span>
                        )}
                    </span>
                );
                const className = `proposal-option${i === chosen ? ' chosen' : ''}`;
                return pick ? (
                    <label key={i} className={className}>
                        <input type="radio" name={`proposal-option:${p.id}`} checked={i === chosen} onChange={() => pick(i)} />
                        {body}
                    </label>
                ) : (
                    <div key={i} className={className} role="listitem" {...(i === chosen && { 'aria-current': true })}>
                        {p.state === 'Approved' && i === chosen && (
                            <span className="proposal-option-mark" role="img" aria-label={t.chosen}>
                                <Check size={12} aria-hidden />
                            </span>
                        )}
                        {body}
                    </div>
                );
            })}
        </div>
    );
}

export function ProposalCard({ proposal: p, continues }: { proposal: ProposalJson; continues: boolean }) {
    const { tx, session, control, actions, onNavigate, proposalPicks } = useChat();
    const t = tx.chat.proposal;
    const live = session.status === 'live' && session.state.session.state === 'Open';
    const open = p.state === 'Open';
    const [mode, setMode] = useState<'view' | 'edit' | 'reject'>('view');
    const [draft, setDraft] = useState('');
    const [note, setNote] = useState('');
    const deciding = control && live && open;
    const mine = p.requestedBy === session.me.participant.id;
    const hasOptions = p.content.options.length > 0;
    const chosen = chosenIndex(p, proposalPicks.options.get(p.id));
    // choosing several to approve together, only when there is more than one to choose from
    const several = deciding && openProposals(session.state).length > 1;
    const picked = proposalPicks.ids.has(p.id);
    const approve = (how?: string): void => {
        const edited = how !== undefined && how.trim() !== editableHow(p.content, chosen) ? { how: how.trim() } : {};
        const body = { proposal: p.id, ...(chosen !== undefined && { option: chosen }), ...edited };
        void actions.approveProposals([body]).then((ok) => ok && setMode('view'));
    };
    // the state in the status slot for the one who decides; everyone else reads that it waits for the facilitator
    const side = ((open && deciding) || p.state === 'Withdrawn') && (
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
                    {!hasOptions && <TargetRow targets={p.content.targets} />}
                    {!(mode === 'edit' && !hasOptions) && (
                        <Clamped tx={tx} revealKey={`proposal:${p.id}`}>
                            <ReplyText text={headHow(p)} onNavigate={onNavigate} />
                        </Clamped>
                    )}
                    {hasOptions && (
                        <Options p={p} chosen={chosen} {...(deciding && mode === 'view' && { pick: (i: number) => proposalPicks.choose(p.id, i) })} />
                    )}
                    {mode === 'edit' && (
                        <form
                            className="proposal-edit"
                            onSubmit={(e) => {
                                e.preventDefault();
                                approve(draft);
                            }}
                        >
                            <textarea
                                className="session-text"
                                autoFocus
                                value={draft}
                                rows={3}
                                maxLength={2000}
                                aria-label={t.how}
                                onChange={(e) => setDraft(e.target.value)}
                            />
                            <div className="reply-actions">
                                <Act kind="decide" type="submit" icon={<Check size={12} aria-hidden />} disabled={actions.busy || draft.trim() === ''}>
                                    {t.approve}
                                </Act>
                                <Act kind="stop" onClick={() => setMode('view')}>
                                    {t.cancel}
                                </Act>
                            </div>
                        </form>
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
                            <Act kind="danger" type="submit" disabled={actions.busy}>
                                {t.reject}
                            </Act>
                            <button type="button" className="icon-button" onClick={() => setMode('view')} aria-label={t.cancel}>
                                <X size={13} aria-hidden />
                            </button>
                        </form>
                    )}
                    {mode === 'view' && deciding && (
                        <div className="reply-actions">
                            <Act kind="decide" icon={<Check size={12} aria-hidden />} disabled={actions.busy} onClick={() => approve()}>
                                {t.approve}
                            </Act>
                            <Act
                                kind="open"
                                icon={<Pencil size={12} aria-hidden />}
                                onClick={() => {
                                    setDraft(editableHow(p.content, chosen));
                                    setMode('edit');
                                }}
                            >
                                {t.edit}
                            </Act>
                            <Act kind="danger" onClick={() => setMode('reject')}>
                                {t.reject}
                            </Act>
                        </div>
                    )}
                    {open && !deciding && <p className="proposal-waiting">{t.waiting}</p>}
                    {open && live && mine && !deciding && (
                        <div className="reply-actions">
                            <Act kind="stop" disabled={actions.busy} onClick={() => void actions.withdrawProposal(p.id)}>
                                {t.withdraw}
                            </Act>
                        </div>
                    )}
                    {p.state === 'Approved' && (
                        <DecidedLine label={p.editedHow ? t.approvedEdited : t.states.Approved} by={p.approvedBy} at={p.approvedAt} run={p.run} />
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

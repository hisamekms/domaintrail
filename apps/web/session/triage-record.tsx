// The facilitator's record of a message's triage (ADR 0030, 仕分けの記録), for debugging: how the message was addressed,
// then each stage that ran — its answer, how sure, the model, the time, and why (or its error) — in small muted lines
// under the message. Participants never get the stages (the server sends them only the outcome).
import { X } from 'lucide-react';
import type { TriageRecord } from './ai';
import { useChat } from './chat-context';
import { approvedLabel } from './proposal-view';
import { ReplyText } from './reply';

const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function TriageRecordPanel({ triage, onClose }: { triage: TriageRecord; onClose: () => void }) {
    const { tx, nameOf, session, onNavigate } = useChat();
    const t = tx.chat.triage;
    // a 依頼 that went to a proposal approved with one of its options: the option chosen
    const outcome = triage.state === 'Decided' ? triage.outcome : undefined;
    const proposal = outcome?.kind === 'Proposal' ? session.state.proposals?.find((p) => p.id === outcome.proposal) : undefined;
    const chosen = proposal && approvedLabel(proposal);
    const head = [
        t.addressedBy[triage.addressedBy],
        nameOf(triage.addressedByParticipant),
        triage.state === 'Decided' ? `→ ${t.verdicts[triage.kind]}` : t.pending,
        ...(chosen ? [`${tx.chat.proposal.chosen}: ${chosen}`] : []),
    ].join(' · ');
    return (
        <section className="triage-record" aria-label={t.open}>
            <p className="triage-record-head">
                <span>{head}</span>
                <button type="button" className="icon-button" onClick={onClose} aria-label={t.close} data-tooltip={t.close}>
                    <X size={12} aria-hidden />
                </button>
            </p>
            <ol className="triage-steps">
                {triage.steps.map((s, i) => (
                    <li key={i} className={`triage-step${triage.state === 'Decided' && triage.decidedBy === s.stage ? ' decided' : ''}`}>
                        <span className="triage-step-line">
                            <span className="triage-stage">{t.stages[s.stage]}</span>
                            <span className="triage-verdict">{t.verdicts[s.verdict]}</span>
                            {[s.confidence !== undefined ? Number(s.confidence).toFixed(2) : undefined, s.model, t.ms(s.durationMs), time(s.at)]
                                .filter((x) => x !== undefined)
                                .join(' · ')}
                        </span>
                        {s.error !== undefined ? (
                            <span className="triage-reason session-error">{s.error}</span>
                        ) : (
                            // the model's reason names elements as the AI does (`@{es:…}`): by their names, as links
                            s.reason && (
                                <span className="triage-reason">
                                    <ReplyText text={s.reason} onNavigate={onNavigate} />
                                </span>
                            )
                        )}
                    </li>
                ))}
            </ol>
        </section>
    );
}

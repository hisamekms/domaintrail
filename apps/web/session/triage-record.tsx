// The facilitator's record of a message's triage (ADR 0030, 仕分けの記録), for debugging: how the message was addressed,
// then each stage that ran — its answer, how sure, the model, the time, and why (or its error) — in small muted lines
// under the message. Participants never get the stages (the server sends them only the outcome).
import { X } from 'lucide-react';
import type { TriageRecord } from './ai';
import { useChat } from './chat-context';

const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function TriageRecordPanel({ triage, onClose }: { triage: TriageRecord; onClose: () => void }) {
    const { tx, nameOf } = useChat();
    const t = tx.chat.triage;
    const head = [
        t.addressedBy[triage.addressedBy],
        nameOf(triage.addressedByParticipant),
        triage.state === 'Decided' ? `→ ${t.verdicts[triage.kind]}` : t.pending,
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
                        {(s.error ?? s.reason) && <span className={`triage-reason${s.error ? ' session-error' : ''}`}>{s.error ?? s.reason}</span>}
                    </li>
                ))}
            </ol>
        </section>
    );
}

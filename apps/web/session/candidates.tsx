// A candidate command's card in the chat (`/es:exceptions`, `/es:gaps`, `/es:levels`, `/es:names`, the plan's
// "Built-in ES commands", phases 1 and 2): on the AI's bubble under the opening message, the command's name, then —
// while the AI works — that it thinks; once it listed them, the candidates (a label, the elements it touches that exist
// as chips — one to be added is named by the label and how, not by its identifier —, how in a line, why), each with a
// checkbox for the facilitator (whoever started it: applying is the approval), none checked at first, and
// 「採用したものを反映」 / 中止; the others read them with 「ファシリテーターが選んで反映します」. Its starter or the facilitator
// stops it.
// Applied, the ones chosen stay checked, the others dimmed, with a link to the run. Nothing to work on (no storming in
// view) or no candidate: one short line, an answer command's too (a hint
// stored from when `/guide` was `/es:next` and needed a storming). An answer command (`/es:recap`) has a card
// otherwise only while the AI works, in Collab (in Solo its pending slot under the message says so); its answer is the
// AI's message.
import { useState } from 'react';
import { Check, LoaderCircle, X } from 'lucide-react';
import { slashCommandName, slashCommandSpec } from '@domaintrail/collaboration';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { AI_NAME, type AiSlot } from './ai';
import { Bubble } from './bubble';
import { DecidedLine } from './card';
import { useChat } from './chat-context';
import { failure } from './parts';
import { AiAvatar, TargetRow } from './proposal';
import { ReplyText } from './reply';
import { sessionApi } from './api';
import type { SlashCommandJson } from './slash';
import { Act } from '../shared/act';

/**
 * The AI's card under a command's opening message (Solo): an answer command's answer, or pending while the AI works on
 * it; `none` for a candidate command (its own card follows) or one stopped. Undefined for any other message.
 */
export function commandSlot(
    state: Pick<SessionStateBody, 'slashCommands'>,
    request: Pick<SessionStateBody['requests'][number], 'id'>,
): AiSlot | 'none' | undefined {
    const c = (state.slashCommands ?? []).find((x) => x.opening === request.id);
    if (!c) return undefined;
    // a guide's card follows, its answer in it
    if (c.kind === 'Guide') return 'none';
    if (c.state === 'Answered') return { kind: 'answer', answer: c.answer };
    if (c.state === 'Working' && slashCommandSpec(c.kind).type === 'answer') return { kind: 'pending' };
    return 'none';
}

export function CandidatesCard({ command: c, continues }: { command: SlashCommandJson; continues: boolean }) {
    const { tx, session, onNavigate } = useChat();
    const t = tx.chat.candidates;
    const live = session.status === 'live' && session.state.session.state === 'Open';
    const facilitator = live && session.me.participant.role === 'facilitator';
    // stops it: its starter, or the facilitator
    const mine = facilitator || (live && c.startedBy === session.me.participant.id);
    const name = slashCommandName(c.kind);
    const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const act = async (work: () => Promise<unknown>): Promise<void> => {
        setBusy(true);
        try {
            await work();
            setError(undefined);
        } catch (e) {
            setError(failure(e));
        } finally {
            setBusy(false);
        }
    };
    const toggle = (i: number): void =>
        setChecked((s) => {
            const next = new Set(s);
            if (next.has(i)) next.delete(i);
            else next.add(i);
            return next;
        });
    const candidates = c.state === 'Listed' || c.state === 'Applied' ? c.candidates : [];
    const chosen = new Set<number>(c.state === 'Applied' ? c.chosen : []);
    const choosing = c.state === 'Listed' && facilitator;
    const empty = c.state === 'Listed' && candidates.length === 0;
    const stop = (label: string) => (
        <Act kind="stop" disabled={busy} onClick={() => void act(() => sessionApi.stopCommand(c.id))}>
            {label}
        </Act>
    );
    return (
        <div className={`chat-row proposal-row candidates-row state-${c.state}`}>
            <Bubble avatar={<AiAvatar />} who={AI_NAME} at={c.startedAt} continues={continues} className="chat-bubble-ai">
                <section className="proposal candidates" aria-label={tx.chat.slash.commands[name]}>
                    <p className="proposal-label">
                        {tx.chat.slash.commands[name]}
                        {c.scope && <span className="candidates-scope muted"> · {c.scope}</span>}
                    </p>
                    {c.state === 'Working' && (
                        <p className="candidates-line muted">
                            <LoaderCircle size={12} aria-hidden className="spin" /> {t.thinking}
                        </p>
                    )}
                    {empty && (
                        <p className="candidates-line muted">{c.scope === undefined && slashCommandSpec(c.kind).needsStorming ? t.noStorming : t.none}</p>
                    )}
                    {c.state === 'Stopped' && <p className="candidates-line muted">{t.stopped}</p>}
                    {candidates.length > 0 && (
                        <div className="proposal-options" role={choosing ? 'group' : 'list'}>
                            {candidates.map((x, i) => {
                                const on = choosing ? checked.has(i) : chosen.has(i);
                                const body = (
                                    <span className="proposal-option-body">
                                        <span className="proposal-option-head">
                                            <span className="proposal-option-label">{x.label}</span>
                                        </span>
                                        <TargetRow targets={x.targets} existing />
                                        <span className="proposal-option-how">
                                            <ReplyText text={x.how} onNavigate={onNavigate} />
                                        </span>
                                        {x.reason && (
                                            <span className="candidates-reason muted">
                                                <ReplyText text={x.reason} onNavigate={onNavigate} />
                                            </span>
                                        )}
                                    </span>
                                );
                                const className = `proposal-option candidate${on ? ' chosen' : ''}${c.state === 'Applied' && !on ? ' dropped' : ''}`;
                                return choosing ? (
                                    <label key={i} className={className}>
                                        <input type="checkbox" checked={on} onChange={() => toggle(i)} />
                                        {body}
                                    </label>
                                ) : (
                                    <div key={i} className={className} role="listitem">
                                        {on && (
                                            <span className="proposal-option-mark" role="img" aria-label={t.chosen}>
                                                <Check size={12} aria-hidden />
                                            </span>
                                        )}
                                        {body}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    {choosing && !empty && (
                        <div className="reply-actions">
                            <Act
                                kind="decide"
                                icon={<Check size={12} aria-hidden />}
                                disabled={busy || checked.size === 0}
                                onClick={() => void act(() => sessionApi.applyCandidates(c.id, [...checked]))}
                            >
                                {t.apply}
                            </Act>
                            {stop(t.stop)}
                        </div>
                    )}
                    {mine && c.state === 'Working' && <div className="reply-actions">{stop(t.stop)}</div>}
                    {mine && empty && <div className="reply-actions">{stop(t.close)}</div>}
                    {c.state === 'Listed' && !facilitator && !empty && <p className="candidates-line muted">{t.waiting}</p>}
                    {c.state === 'Listed' && !facilitator && !empty && mine && <div className="reply-actions">{stop(t.stop)}</div>}
                    {c.state === 'Applied' && <DecidedLine label={t.applied(c.chosen.length)} by={c.appliedBy ?? c.startedBy} at={c.appliedAt} run={c.run} />}
                    {error && (
                        <p className="session-note session-error">
                            <X size={12} aria-hidden /> {tx.error(error)}
                        </p>
                    )}
                </section>
            </Bubble>
        </div>
    );
}

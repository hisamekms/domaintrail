// A person's edit of a sticky (ADR 0033), in AI の作業 and in the chat: 「◯◯が編集しました」 with its time, what changed
// (old struck through → new; a rename with how many references it rewrote; a hotspot added; a resolution written), the
// note when it was written again after a run that had dropped it, and — when a run's result gave the same sticky other
// wording — both wordings with the choice between them. The facilitator reverts it as any run (打ち消す), through the
// same revert. In the chat it is an activity row of that person (their avatar, no bubble), with the sticky as a `#` chip:
// never a message (the AI is not asked, it counts as nothing unread).
import { useState, type ReactNode } from 'react';
import { PencilLine } from 'lucide-react';
import { TargetLink } from '../shared/reference';
import { revertStatus } from '@domaintrail/collaboration';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { Act } from '../shared/act';
import { useT } from '../i18n';
import { sessionApi } from './api';
import { useChat } from './chat-context';
import { Avatar } from './parts';
import { useTargetNaming } from './naming';
import { targetShortName } from './targets';
import { speakerName } from './stream';
import type { ChangeUnit } from './history';

type RunJson = SessionStateBody['runs'][number];
type EditedRun = Extract<RunJson, { state: 'Edited' }>;
type StickyEditJson = NonNullable<EditedRun['input']['requests'][number]['edit']>;

const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** What one edit changed, line by line (`chat`: the chat's shorter words, the sticky being its chip). */
function EditLines({ edit, chat }: { edit: StickyEditJson; chat: boolean }): ReactNode {
    const h = useT().stickies.history;
    switch (edit.kind) {
        case 'Wording':
            return (
                <>
                    {edit.labelBefore !== edit.labelAfter && (
                        <div className="edit-unit-line">
                            <span className="edit-unit-field">{h.label}</span>
                            <del>{edit.labelBefore ?? h.none}</del> → <span>{edit.labelAfter ?? h.none}</span>
                        </div>
                    )}
                    {edit.nameBefore !== edit.nameAfter && (
                        <div className="edit-unit-line">
                            <span className="edit-unit-field">{h.name}</span>
                            <del className="mono">{edit.nameBefore}</del> → <span className="mono">{edit.nameAfter}</span>
                            {edit.references > 0 && <small className="muted"> · {h.references(edit.references)}</small>}
                        </div>
                    )}
                </>
            );
        case 'HotspotAdded':
            return <div className="edit-unit-line">{chat ? h.chatHotspot(edit.label) : h.hotspotAdded(edit.label, edit.on)}</div>;
        case 'HotspotResolved':
            return <div className="edit-unit-line">{chat ? `${h.chatResolved}: ${edit.resolution}` : h.resolved(edit.hotspot, edit.resolution)}</div>;
    }
}

/** The sticky an edit is about, as the chat's `#` chip: a click selects it. */
export function editedSticky(edit: StickyEditJson): { readonly storming: string; readonly local: string; readonly label?: string } {
    switch (edit.kind) {
        case 'Wording':
            return { storming: edit.storming, local: edit.nameAfter, ...(edit.labelAfter !== undefined && { label: edit.labelAfter }) };
        case 'HotspotAdded':
            return { storming: edit.storming, local: edit.hotspot, label: edit.label };
        case 'HotspotResolved':
            return { storming: edit.storming, local: edit.hotspot };
    }
}

/** What changed, the re-application, the conflict with its choice, and 打ち消す (the facilitator's). */
function EditDetails({ run, chat }: { run: EditedRun; chat: boolean }): ReactNode {
    const { session, nameOf, control } = useChat();
    const t = useT();
    const h = t.stickies.history;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const edits = run.input.requests.flatMap((r) => (r.edit ? [r.edit] : []));
    const reverted = revertStatus(run, session.state.runs);
    const conflict = run.conflict;
    const wording = edits.find((e): e is Extract<StickyEditJson, { kind: 'Wording' }> => e.kind === 'Wording');
    const act = (work: () => Promise<unknown>): void => {
        setBusy(true);
        setError(undefined);
        work().then(
            () => setBusy(false),
            (e: unknown) => {
                setBusy(false);
                setError(e instanceof Error ? e.message : String(e));
            },
        );
    };
    const revert = (): void => act(() => sessionApi.revertRun(run.id, h.revertBody(run.input.requests[0]?.body ?? nameOf(run.queuedBy))));
    // the person's wording written again over the run's (a new edit), then the choice recorded
    const usePeople = (): void =>
        act(async () => {
            if (!wording || !conflict) return;
            if (conflict.runLabel !== undefined && wording.labelAfter !== undefined)
                await sessionApi.editSticky(
                    {
                        kind: 'wording',
                        storming: wording.storming,
                        element: wording.nameAfter,
                        expected: { name: wording.nameAfter, label: conflict.runLabel },
                        label: wording.labelAfter,
                    },
                    t.stickies.edit.body(conflict.runLabel, wording.labelAfter),
                );
            await sessionApi.settleConflict(run.id);
        });
    return (
        <div className="edit-unit-body">
            {edits.map((e, i) => (
                <EditLines key={i} edit={e} chat={chat} />
            ))}
            {run.reapplies !== undefined && <small className="muted">{h.reapplied}</small>}
            {conflict && !conflict.settled && wording && (
                <div className="edit-unit-conflict" role="group" aria-label={h.conflict}>
                    <p>{h.conflict}</p>
                    <div className="edit-unit-line">
                        <span className="edit-unit-field">{h.people}</span>
                        {wording.labelAfter ?? wording.nameAfter}
                    </div>
                    <div className="edit-unit-line">
                        <span className="edit-unit-field">{h.ai}</span>
                        {conflict.runLabel ?? conflict.runName}
                    </div>
                    <div className="edit-unit-actions">
                        <Act kind="decide-sub" disabled={busy} onClick={() => act(() => sessionApi.settleConflict(run.id))}>
                            {h.keepAi}
                        </Act>
                        <Act kind="decide" disabled={busy} onClick={usePeople}>
                            {h.usePeople}
                        </Act>
                    </div>
                </div>
            )}
            {conflict?.settled && <small className="muted">{h.settled}</small>}
            {control && reverted.kind === 'none' && (
                <div className="edit-unit-actions">
                    <Act kind="danger" disabled={busy} onClick={revert}>
                        {h.revert}
                    </Act>
                </div>
            )}
            {reverted.kind !== 'none' && <small className="muted">{reverted.kind === 'reverted' ? h.revertDone : h.revertPending}</small>}
            {error !== undefined && <small className="sticky-form-error">{error}</small>}
        </div>
    );
}

/** The unit of a person's edit in AI の作業. */
export function EditUnit({ unit }: { unit: ChangeUnit }): ReactNode {
    const { session, nameOf } = useChat();
    const h = useT().stickies.history;
    const run = unit.runs[unit.runs.length - 1].run;
    if (run.state !== 'Edited') return null;
    const reverted = revertStatus(run, session.state.runs);
    return (
        <li className={`chat-unit edit-unit outcome-edited${reverted.kind === 'reverted' ? ' reverted' : ''}`} data-unit={unit.key}>
            <div className="edit-unit-head">
                <PencilLine size={14} className="chat-unit-icon" aria-hidden />
                <span className="edit-unit-who">{h.edited(nameOf(run.queuedBy))}</span>
                <time className="muted" dateTime={run.finishedAt}>
                    {time(run.finishedAt)}
                </time>
            </div>
            <EditDetails run={run} chat={false} />
        </li>
    );
}

/**
 * A person's edit in the chat, where it happened: an activity row of theirs — their avatar, 「◯◯が編集しました」 with the
 * sticky's `#` chip and its time, the change under it — not a bubble; continuing their messages as theirs do.
 */
export function EditRow({ run, continues }: { run: EditedRun; continues: boolean }): ReactNode {
    const { session, nameOf, avatarOf, onNavigate, solo, tx } = useChat();
    const h = useT().stickies.history;
    const reverted = revertStatus(run, session.state.runs);
    const naming = useTargetNaming();
    const stickies = run.input.requests.flatMap((r) => (r.edit ? [editedSticky(r.edit)] : []));
    // the sticky as the chat names it now (its own name in the display mode), else as the edit wrote it
    const shortName = (s: { storming: string; local: string; label?: string }): string =>
        (naming && targetShortName({ kind: 'DtesElement', storming: s.storming, local: s.local }, naming)) ?? s.label ?? s.local;
    // named as the chat names the person of a message (あなた for me)
    const who = speakerName(run.queuedBy, session.me.participant.id, nameOf, tx.chat.you);
    const avatar = avatarOf(run.queuedBy);
    return (
        <div className={`chat-message chat-edit${continues ? ' continued' : ''}${reverted.kind === 'reverted' ? ' reverted' : ''}`}>
            {continues ? (
                <span className="chat-avatar-space" aria-hidden />
            ) : (
                <Avatar
                    id={run.queuedBy}
                    name={nameOf(run.queuedBy)}
                    {...(avatar !== undefined && { url: avatar })}
                    facilitator={!solo && run.queuedBy === session.state.session.facilitator}
                />
            )}
            <div className="chat-message-main">
                <div className="chat-edit-head">
                    <PencilLine size={13} className="chat-edit-icon" aria-hidden />
                    <span className="chat-edit-who">{h.edited(who)}</span>
                    {stickies.map((s) => (
                        <TargetLink
                            key={`${s.storming}/${s.local}`}
                            name={shortName(s)}
                            tooltip={s.local}
                            kind="DtesElement"
                            onClick={() => onNavigate({ kind: 'DtesElement', storming: s.storming, local: s.local })}
                        />
                    ))}
                    <time className="chat-time" dateTime={run.finishedAt}>
                        {time(run.finishedAt)}
                    </time>
                </div>
                <EditDetails run={run} chat />
            </div>
        </div>
    );
}

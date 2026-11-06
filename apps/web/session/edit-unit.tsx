// A person's edit of a sticky in AI の作業 (ADR 0033): 「◯◯が編集しました」 with its time, what changed (old struck through
// → new; a rename with how many references it rewrote; a hotspot added; a resolution written), the note when it was
// written again after a run that had dropped it, and — when a run's result gave the same sticky other wording — both
// wordings with the choice between them. The facilitator reverts it as any run (打ち消す), through the same revert.
import { useState, type ReactNode } from 'react';
import { PencilLine } from 'lucide-react';
import { revertStatus } from '@domaintrail/collaboration';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { Act } from '../shared/act';
import { useT } from '../i18n';
import { sessionApi } from './api';
import { useChat } from './chat-context';
import type { ChangeUnit } from './history';

type RunJson = SessionStateBody['runs'][number];
type EditedRun = Extract<RunJson, { state: 'Edited' }>;
type StickyEditJson = NonNullable<EditedRun['input']['requests'][number]['edit']>;

const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** What one edit changed, line by line. */
function EditLines({ edit }: { edit: StickyEditJson }): ReactNode {
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
            return <div className="edit-unit-line">{h.hotspotAdded(edit.label, edit.on)}</div>;
        case 'HotspotResolved':
            return <div className="edit-unit-line">{h.resolved(edit.hotspot, edit.resolution)}</div>;
    }
}

/** The unit of a person's edit in AI の作業. */
export function EditUnit({ unit }: { unit: ChangeUnit }): ReactNode {
    const { session, nameOf, control } = useChat();
    const t = useT();
    const h = t.stickies.history;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const run = unit.runs[unit.runs.length - 1].run;
    if (run.state !== 'Edited') return null;
    const who = nameOf(run.queuedBy);
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
    const revert = (): void => act(() => sessionApi.revertRun(run.id, h.revertBody(unit.runs[0]?.run.input.requests[0]?.body ?? who)));
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
        <li className={`chat-unit edit-unit outcome-edited${reverted.kind === 'reverted' ? ' reverted' : ''}`} data-unit={unit.key}>
            <div className="edit-unit-head">
                <PencilLine size={14} className="chat-unit-icon" aria-hidden />
                <span className="edit-unit-who">{h.edited(who)}</span>
                <time className="muted" dateTime={run.finishedAt}>
                    {time(run.finishedAt)}
                </time>
            </div>
            <div className="edit-unit-body">
                {edits.map((e, i) => (
                    <EditLines key={i} edit={e} />
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
        </li>
    );
}

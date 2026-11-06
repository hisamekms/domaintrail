// People's edits of the stickies (ADR 0033): written by dt itself, no AI run. A person changes a sticky's label or
// name (with every reference to it), puts a hotspot on an event or resolves one; dt plans it on the parsed `.dtes`
// (the `StickyEditor` port: only the tokens concerned change), writes the one file atomically behind the same refusal
// as every write (the sources must be as read), checks that every `.dtes` still parses, and records it as a unit of
// work of its own: a message that is the edit (out of the chat) and a run in the state `Edited`, with its base and
// result revisions, so that it shows in AI の作業 and is reverted as any run is.
//
// Writes are serial: an edit, and the re-application after a run, never interleave (one queue in this application;
// the app adds the watcher's hold). An edit is allowed while a run is running, even on the elements it targets: when
// that run ends, `reapplyEdits` compares, for each wording edit made during it, what the person wrote, what was there
// before, and what the run left (a three-way compare): an edit the run's result dropped (the old label, or the old
// name) is written again, as a new edit attributed to the same person; a label the run changed to something else is
// kept as the run's, and the edit records the conflict for people to choose.
import { Collaboration, err, ok, type Result } from '../generated/index.js';
import { agentRunCommands, requestCommands, revisionCommands } from '../domain/commands.js';
import { knownAgentRunId, knownRequestId, knownRevisionId } from '../domain/ids.js';
import { revertStatus } from '../domain/revert.js';
import { sha256Hex } from '../domain/sha256.js';
import { nonEmpty, workspacePath } from '../domain/snapshot.js';
import type { Actor } from './actor.js';
import type { CollaborationDeps, ScannedFile, StickyEditInput, StickyEditPlan, StickyEditProblem, StickyWording, Stores, WorkspaceScan } from './ports.js';
import { publish } from './queueing.js';
import { capture, writeRefusal, type Captured } from './snapshots.js';
import { storeVerifications } from './verifications.js';

type SessionId = Collaboration.SessionId;
type AgentRunId = Collaboration.AgentRunId;

/** Editing stickies needs the app's `StickyEditor`. */
export interface StickyEditsUnavailable {
    readonly type: 'StickyEditsUnavailable';
}

/** Why a person's edit was not written; the files are as they were. */
export type EditStickyError =
    | StickyEditsUnavailable
    | Collaboration.SessionNotFound
    | Collaboration.SessionAlreadyClosed
    | Collaboration.PathOutsideRoot
    | Collaboration.SymlinkInWorkspace
    | Collaboration.ExternalChangesSinceSnapshot
    | { readonly type: 'StickyNotFound' }
    /** The sticky is no longer as the person saw it (someone, or a run, changed it): what it is now. */
    | { readonly type: 'StickyStale'; readonly current: StickyWording }
    | { readonly type: 'InvalidStickyName'; readonly problem: 'format' | 'keyword' | 'duplicate' }
    | { readonly type: 'InvalidStickyText' }
    | { readonly type: 'WrongStickyKind' }
    | { readonly type: 'NothingToChange' }
    /** The storming's file does not parse now, or would not after the edit: nothing is written. */
    | { readonly type: 'StormingDoesNotParse' };

/** A person's edit, recorded: its message and its run, and how many references a rename rewrote. */
export interface StickyEdited {
    readonly request: Collaboration.Request;
    readonly run: Collaboration.EditedAgentRun;
    readonly references: number;
}

/** What `reapplyEdits` did after a run: the edits it wrote again (one run), and the edits it marked as in conflict. */
export interface EditsReapplied {
    readonly reapplied?: Collaboration.EditedAgentRun;
    readonly conflicts: readonly Collaboration.EditedAgentRun[];
}

/** A person's edit as the agent is told of it: who, and what changed. */
export interface PeopleEdit {
    readonly by: Collaboration.ParticipantId;
    readonly at: Date;
    readonly edit: Collaboration.StickyEdit;
}

export interface StickyUseCases {
    /**
     * A person's edit of a sticky (any participant's): planned, written, checked and recorded as one unit of work
     * (`body`: what the page says it is, the message of the edit and of its revert).
     */
    editSticky(input: {
        readonly session: SessionId;
        readonly actor: Actor;
        readonly edit: StickyEditInput;
        readonly body: Collaboration.Text;
    }): Promise<Result<StickyEdited, EditStickyError>>;
    /**
     * After `run` ended: the wording edits people made while it ran, compared with what it left — written again where
     * it dropped them, marked as a conflict where it changed the same label otherwise. Nothing when there were none.
     */
    reapplyEdits(input: { readonly session: SessionId; readonly run: AgentRunId }): Promise<EditsReapplied>;
    /** People chose about a conflict (the run's wording kept, or theirs written again by a new edit): it is settled. */
    settleConflict(input: {
        readonly session: SessionId;
        readonly run: AgentRunId;
    }): Promise<Result<Collaboration.EditedAgentRun, { readonly type: 'NotFound' } | { readonly type: 'NothingToSettle' }>>;
    /**
     * The people's edits a run is told of (ADR 0033): those recorded since the previous run started (for the first,
     * all of the session's), not reverted, oldest first.
     */
    peopleEditsSince(input: { readonly run: AgentRunId }): Promise<readonly PeopleEdit[]>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The scan with one file's text replaced. */
function replaced(scan: WorkspaceScan, edits: ReadonlyMap<string, string>): WorkspaceScan {
    return {
        ...scan,
        files: scan.files.map((f): ScannedFile => {
            const text = edits.get(f.path);
            if (text === undefined) return f;
            const bytes = encoder.encode(text);
            return { path: f.path, bytes, hash: sha256Hex(bytes) };
        }),
    };
}

const isStorming = (path: string): boolean => path.endsWith('.dtes');

function problem(e: StickyEditProblem): EditStickyError {
    switch (e.type) {
        case 'SyntaxError':
        case 'NoLongerParses':
            return { type: 'StormingDoesNotParse' };
        case 'StormingNotFound':
        case 'NotFound':
            return { type: 'StickyNotFound' };
        case 'Stale':
            return { type: 'StickyStale', current: e.current };
        case 'InvalidName':
            return { type: 'InvalidStickyName', problem: e.problem };
        case 'InvalidLabel':
            return { type: 'InvalidStickyText' };
        case 'WrongKind':
            return { type: 'WrongStickyKind' };
        case 'NothingToChange':
            return { type: 'NothingToChange' };
    }
}

/** A value of the model, or throws: the planner's values were checked already (IDs, labels of bounded length). */
function made<T>(r: Result<T, unknown>, what: string): T {
    if (!r.ok) throw new Error(`An edit's ${what} is not a valid value`);
    return r.value;
}

/** The edit as the model keeps it, from what was planned. */
function stickyEdit(input: StickyEditInput, path: string, plan: StickyEditPlan): Collaboration.StickyEdit {
    const storming = made(Collaboration.makeStormingName(input.storming), 'storming');
    const file = made(workspacePath(path), 'path');
    const local = (n: string): Collaboration.StormingLocalName => made(Collaboration.makeStormingLocalName(n), 'name');
    const text = (t: string): Collaboration.Text => made(Collaboration.makeText(t), 'text');
    switch (input.kind) {
        case 'wording':
            return {
                kind: 'Wording',
                storming,
                path: file,
                nameBefore: local(plan.before?.name ?? input.element),
                nameAfter: local(plan.after.name),
                ...(plan.before?.label !== undefined && { labelBefore: text(plan.before.label) }),
                ...(plan.after.label !== undefined && { labelAfter: text(plan.after.label) }),
                references: made(Collaboration.makeTally(plan.references), 'count'),
            };
        case 'addHotspot':
            return { kind: 'HotspotAdded', storming, path: file, hotspot: local(plan.after.name), label: text(input.label), on: local(input.on) };
        case 'resolveHotspot':
            return { kind: 'HotspotResolved', storming, path: file, hotspot: local(input.element), resolution: text(input.resolution) };
    }
}

export function createStickies(deps: CollaborationDeps): StickyUseCases {
    const { uow, clock, ids } = deps;

    // one write at a time: an edit, the re-application after a run
    let tail: Promise<unknown> = Promise.resolve();
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
        const next = tail.then(work, work);
        tail = next.catch(() => undefined);
        return next;
    };

    const recordRevision = (stores: Stores, session: SessionId, origin: Collaboration.RevisionOrigin, captured: Captured, at: Date): Collaboration.Revision => {
        const taken = revisionCommands.take({
            id: knownRevisionId(ids.newId()),
            session,
            origin,
            contentHash: captured.contentHash,
            files: captured.files,
            validation: captured.validation,
            takenAt: at,
        });
        if (!taken.ok) throw new Error(`Taking a revision failed: ${taken.error.type}`);
        stores.revisions.save(taken.value.Recorded.aggregate);
        publish(stores, session, taken.value.Recorded.events, at);
        return taken.value.Recorded.aggregate;
    };

    /**
     * Writes `edits` (path → text) over `scan`, checked to parse, and records them as one `Edited` run bundling
     * `requests` (made by `makeRequests` inside the transaction): refused, with nothing written, when the sources are
     * no longer as scanned.
     */
    const writeAndRecord = async (
        session: Collaboration.ActiveSession,
        scan: WorkspaceScan,
        edits: ReadonlyMap<string, string>,
        input: {
            readonly by: Collaboration.ParticipantId;
            readonly reapplies?: AgentRunId;
            readonly requests: (stores: Stores, at: Date) => Collaboration.Request[];
        },
    ): Promise<Result<Collaboration.EditedAgentRun, EditStickyError>> => {
        const after = replaced(scan, edits);
        const before = await capture(deps, scan);
        if (!before.ok) return before;
        const written = await capture(deps, after);
        if (!written.ok) return written;
        if (!written.value.analysis.stormingsComplete) return err({ type: 'StormingDoesNotParse' });
        const wrote = await deps.workspace.write(
            after.files.map((f) => ({ path: f.path, bytes: f.bytes })),
            scan.files.map((f) => ({ path: f.path, hash: f.hash })),
        );
        if (!wrote.ok) return err(writeRefusal(wrote.error));
        return uow.transaction(async (stores) => {
            const at = clock.now();
            const id = knownAgentRunId(ids.newId());
            const requests = input.requests(stores, at);
            const verify = storeVerifications(stores);
            const pending: Collaboration.PendingRequest[] = [];
            for (const r of requests) {
                const p = await verify.makePendingRequest(r.id, session);
                if (!p.ok) throw new Error(`The edit ${r.id} is not pending: ${p.error.type}`);
                pending.push(p.value);
            }
            const base = recordRevision(stores, session, { kind: 'RunBase', run: id }, before.value, at);
            const result = recordRevision(stores, session, { kind: 'RunResult', run: id }, written.value, at);
            const bundled = nonEmpty(pending);
            const frozen = nonEmpty(
                requests.map((r): Collaboration.FrozenRequest => ({
                    request: r.id,
                    author: r.author,
                    targets: [],
                    body: r.body,
                    ...(r.edit && { edit: r.edit }),
                })),
            );
            if (!bundled || !frozen) throw new Error('An edit is recorded with its message');
            const recorded = agentRunCommands.recordEdit({
                id,
                session,
                requests: bundled,
                input: { requests: frozen },
                queuedBy: input.by,
                queuedAt: at,
                baseRevision: base.id,
                resultRevision: result.id,
                reapplies: input.reapplies,
                finishedAt: at,
            });
            if (!recorded.ok) throw new Error(`Recording the edit failed: ${recorded.error.type}`);
            stores.runs.enqueue(recorded.value.Edited.aggregate);
            publish(stores, session, recorded.value.Edited.events, at);
            return ok(recorded.value.Edited.aggregate);
        });
    };

    /** Plans the edit in the `.dtes` file that holds the storming. */
    const planIn = (
        stickies: NonNullable<CollaborationDeps['stickies']>,
        scan: WorkspaceScan,
        edit: StickyEditInput,
    ): Result<{ path: string; plan: StickyEditPlan }, EditStickyError> => {
        for (const f of scan.files) {
            if (!isStorming(f.path)) continue;
            const planned = stickies.plan(decoder.decode(f.bytes), edit);
            if (planned.ok) return ok({ path: f.path, plan: planned.value });
            // another file (or one that does not parse) may hold the storming
            if (planned.error.type === 'StormingNotFound' || planned.error.type === 'SyntaxError') continue;
            return err(problem(planned.error));
        }
        return err({ type: 'StickyNotFound' });
    };

    return {
        async editSticky({ session, actor, edit, body }) {
            const stickies = deps.stickies;
            if (!stickies) return err({ type: 'StickyEditsUnavailable' });
            const active = await uow.transaction((stores) => storeVerifications(stores).makeActiveSession(session));
            if (!active.ok) return active;
            return serial(async (): Promise<Result<StickyEdited, EditStickyError>> => {
                let refused: EditStickyError | undefined;
                // a write refused because another write came between the read and it (a run's agent): read again
                for (let attempt = 0; attempt < 3; attempt++) {
                    const scan = await deps.workspace.read();
                    const planned = planIn(stickies, scan, edit);
                    if (!planned.ok) return planned;
                    const { path, plan } = planned.value;
                    let request: Collaboration.Request | undefined;
                    const recorded = await writeAndRecord(active.value, scan, new Map([[path, plan.text]]), {
                        by: actor.participant,
                        requests: (stores, at) => {
                            const sent = requestCommands.recordEdit({
                                id: knownRequestId(ids.newId()),
                                session: active.value,
                                author: actor.participant,
                                body,
                                sentAt: at,
                                edit: stickyEdit(edit, path, plan),
                            });
                            if (!sent.ok) throw new Error('Recording an edit cannot be refused');
                            stores.requests.save(sent.value.Sent.aggregate);
                            publish(stores, session, sent.value.Sent.events, at);
                            request = sent.value.Sent.aggregate;
                            return [request];
                        },
                    });
                    if (recorded.ok) {
                        if (!request) throw new Error('The edit was recorded without its message');
                        return ok({ request, run: recorded.value, references: plan.references });
                    }
                    if (recorded.error.type !== 'ExternalChangesSinceSnapshot') return recorded;
                    refused = recorded.error;
                }
                return err(refused ?? { type: 'StormingDoesNotParse' });
            });
        },

        async reapplyEdits({ session, run }) {
            const stickies = deps.stickies;
            const none: EditsReapplied = { conflicts: [] };
            if (!stickies) return none;
            const found = await uow.transaction((stores) => {
                const ended = stores.runs.load(run)?.run;
                if (!ended || !('startedAt' in ended) || !('finishedAt' in ended)) return undefined;
                const runs = stores.runs.listBySession(session);
                // the wording edits made while the run ran, not reverted since, not the re-applications of this run
                const edits = runs.filter(
                    (r): r is Collaboration.EditedAgentRun =>
                        r.state === 'Edited' &&
                        r.reapplies !== run &&
                        r.finishedAt.getTime() >= ended.startedAt.getTime() &&
                        r.finishedAt.getTime() <= ended.finishedAt.getTime() &&
                        revertStatus(r, runs).kind === 'none',
                );
                const active = stores.sessions.load(session);
                return { edits, open: active?.state === 'Open' };
            });
            if (!found?.open || found.edits.length === 0) return none;
            return serial(async (): Promise<EditsReapplied> => {
                const scan = await deps.workspace.read();
                const texts = new Map(scan.files.filter((f) => isStorming(f.path)).map((f) => [f.path, decoder.decode(f.bytes)]));
                const changed = new Map<string, string>();
                const dropped: Collaboration.EditedAgentRun[] = [];
                const conflicts: { run: Collaboration.EditedAgentRun; conflict: Collaboration.EditConflict }[] = [];
                const textOf = (path: string): string | undefined => changed.get(path) ?? texts.get(path);
                /** The file holding the storming: the edit's own first, else any. */
                const fileOf = (
                    edit: Extract<Collaboration.StickyEdit, { kind: 'Wording' }>,
                    name: string,
                ): { path: string; wording: StickyWording } | undefined => {
                    for (const path of [edit.path, ...texts.keys()]) {
                        const t = textOf(path);
                        const wording = t === undefined ? undefined : stickies.wording(t, edit.storming, name);
                        if (wording) return { path, wording };
                    }
                    return undefined;
                };
                for (const edited of found.edits) {
                    for (const frozen of edited.input.requests) {
                        const edit = frozen.edit;
                        if (edit?.kind !== 'Wording') continue;
                        const renamed = edit.nameAfter !== edit.nameBefore;
                        const kept = fileOf(edit, edit.nameAfter);
                        // the old name left by the run (it wrote the file as it read it before the rename)
                        const left = !kept && renamed ? fileOf(edit, edit.nameBefore) : undefined;
                        const at = kept ?? left;
                        // the sticky is gone, or the run renamed it otherwise: nothing to compare with
                        if (!at) continue;
                        const label = at.wording.label;
                        const labelDropped = edit.labelAfter !== undefined && label !== edit.labelAfter && label === edit.labelBefore;
                        const labelChanged = edit.labelAfter !== undefined && label !== edit.labelAfter && label !== edit.labelBefore;
                        if (labelChanged && label !== undefined)
                            conflicts.push({ run: edited, conflict: { run, runLabel: made(Collaboration.makeText(label), 'label'), settled: false } });
                        if (!left && !labelDropped) continue;
                        const text = textOf(at.path);
                        if (text === undefined) continue;
                        const planned = stickies.plan(text, {
                            kind: 'wording',
                            storming: edit.storming,
                            element: at.wording.name,
                            expected: at.wording,
                            ...(left && { name: edit.nameAfter }),
                            ...(labelDropped && edit.labelAfter !== undefined && { label: edit.labelAfter }),
                        });
                        if (!planned.ok) continue;
                        changed.set(at.path, planned.value.text);
                        if (!dropped.includes(edited)) dropped.push(edited);
                    }
                }
                let reapplied: Collaboration.EditedAgentRun | undefined;
                if (changed.size > 0) {
                    const active = await uow.transaction((stores) => storeVerifications(stores).makeActiveSession(session));
                    if (active.ok) {
                        const requests = dropped.flatMap((d) => d.input.requests.map((r) => r.request));
                        const first = dropped[0];
                        const recorded = await writeAndRecord(active.value, scan, changed, {
                            by: first.queuedBy,
                            reapplies: run,
                            requests: (stores) => requests.flatMap((id) => stores.requests.load(id) ?? []),
                        });
                        // refused (the workspace changed meanwhile, or would not parse): left as the run left it
                        if (recorded.ok) reapplied = recorded.value;
                    }
                }
                const marked = await uow.transaction((stores) => {
                    const out: Collaboration.EditedAgentRun[] = [];
                    const at = clock.now();
                    for (const { run: edited, conflict } of conflicts) {
                        const current = stores.runs.load(edited.id)?.run;
                        if (current?.state !== 'Edited') continue;
                        const noted = agentRunCommands.noteConflict(current, { conflict });
                        if (!noted.ok) continue;
                        stores.runs.save(noted.value.Edited.aggregate);
                        publish(stores, session, noted.value.Edited.events, at);
                        out.push(noted.value.Edited.aggregate);
                    }
                    return out;
                });
                return { ...(reapplied && { reapplied }), conflicts: marked };
            });
        },

        async settleConflict({ session, run }) {
            return uow.transaction((stores) => {
                const edited = stores.runs.load(run)?.run;
                if (edited?.state !== 'Edited' || edited.session !== session) return err({ type: 'NotFound' as const });
                if (!edited.conflict || edited.conflict.settled) return err({ type: 'NothingToSettle' as const });
                const noted = agentRunCommands.noteConflict(edited, { conflict: { ...edited.conflict, settled: true } });
                if (!noted.ok) throw new Error(`Settling the conflict of ${run} failed`);
                stores.runs.save(noted.value.Edited.aggregate);
                publish(stores, session, noted.value.Edited.events, clock.now());
                return ok(noted.value.Edited.aggregate);
            });
        },

        async peopleEditsSince({ run }) {
            return uow.transaction((stores) => {
                const started = stores.runs.load(run)?.run;
                if (!started) return [];
                const runs = stores.runs.listBySession(started.session);
                const startOf = (r: Collaboration.AgentRun): number | undefined => ('startedAt' in r ? r.startedAt.getTime() : undefined);
                const mine = startOf(started) ?? Number.POSITIVE_INFINITY;
                // the latest run that started before this one: what it saw, this one's agent may remember
                const since = runs.reduce<number | undefined>((latest, r) => {
                    const s = startOf(r);
                    return r.id !== started.id && s !== undefined && s < mine && (latest === undefined || s > latest) ? s : latest;
                }, undefined);
                return runs
                    .filter(
                        (r): r is Collaboration.EditedAgentRun =>
                            r.state === 'Edited' &&
                            (since === undefined || r.finishedAt.getTime() >= since) &&
                            r.finishedAt.getTime() <= mine &&
                            revertStatus(r, runs).kind === 'none',
                    )
                    .sort((a, b) => a.finishedAt.getTime() - b.finishedAt.getTime())
                    .flatMap((r) => r.input.requests.flatMap((q) => (q.edit ? [{ by: q.author, at: r.finishedAt, edit: q.edit }] : [])));
            });
        },
    };
}

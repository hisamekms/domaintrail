// The use cases of the `/` commands that are not interviews (`domain/slash-commands.ts`): start one (anyone: the
// starter's message, the command's name, sent without triage), the answerer's candidates or answer (through the agent
// API), apply the candidates checked (the facilitator: one run, on the opening message), stop one (its starter or the
// facilitator), and the command jobs that wait for the
// answerer. As the other use cases: the aggregates loaded and saved in one transaction with their events, the
// commands deciding.
import { Collaboration, err, ok, type Result } from '../generated/index.js';
import { requestCommands } from '../domain/commands.js';
import { knownRequestId, knownSlashCommandId } from '../domain/ids.js';
import { guideMarks, guideSnapshot, journeyMarks, readGuideGoal, type GuideWorkspace } from '../domain/guide.js';
import { chosenIndices, isCommandRunning, runningCommand, slashCommandCommands, slashCommandSpec, stormingInView } from '../domain/slash-commands.js';
import type { Actor } from './actor.js';
import { notAllowed, notFound, type NotAllowed, type NotFound } from './errors.js';
import type { CollaborationDeps, Stores } from './ports.js';
import { publish, queueRequests, type FreezeError } from './queueing.js';
import { sendIn, type SendMessageError } from './conversation.js';
import { storeVerifications } from './verifications.js';

type SessionId = Collaboration.SessionId;
type SlashCommandId = Collaboration.SlashCommandId;

/** A command job (`/agent/answers/events`): the command the AI works on, and its opening message. */
export interface SlashCommandJob {
    readonly kind: 'command';
    readonly command: Collaboration.WorkingSlashCommand;
    /** The starter's message (the command's name, with the view it was sent from). */
    readonly request: Collaboration.Request;
}

/** A command started: the command (its candidates already listed, none, when it has nothing to work on), and its opening message. */
export interface SlashCommandStartedResult {
    readonly command: Collaboration.WorkingSlashCommand | Collaboration.ListedSlashCommand;
    readonly request: Collaboration.SentRequest;
}

type QueueError = FreezeError | Collaboration.FacilitatorOnly | Collaboration.DuplicateRequest | Collaboration.InputMismatch;
type Closed = Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed;

/** A command's kind does not take this result (candidates for an answer command, or the other way round). */
export interface WrongCommandType {
    readonly type: 'WrongCommandType';
}

export interface SlashCommandUseCases {
    /**
     * Starts a candidate or answer command (`/es:exceptions`, `/es:recap`): the starter's opening message (the command's
     * name), sent without triage, and the command waiting for the answerer. Anyone; one of each kind runs at a time
     * (`CommandAlreadyRunning`). A command about the
     * storming in view, with none in view, lists no candidates at once (the AI is not asked): its card then says so.
     * `/guide` needs none: the AI reads where the person is from the session and the view; it keeps the map and what is
     * known at once as they are now (the journey file's goals and marks, the session's current journey first).
     */
    startCommand(input: {
        readonly session: SessionId;
        readonly actor: Actor;
        readonly kind: Collaboration.SlashCommandKind;
        readonly body: Collaboration.Text;
        readonly language: Collaboration.UiLanguage;
        readonly focus?: Collaboration.ModelTarget;
        /** Where the starter was looking: kept on the opening message, and what the command is about. */
        readonly viewedAt?: Collaboration.ViewedAt;
        /**
         * The workspace as it is now (`/guide`): its map and what is known at once are computed from it and kept on the
         * command. Absent: none kept (the AI reads the files all the same).
         */
        readonly workspace?: GuideWorkspace;
    }): Promise<Result<SlashCommandStartedResult, SendMessageError | Collaboration.CommandAlreadyRunning | Closed>>;
    /** The answerer's candidates (a candidate command): they wait for the facilitator to check some and apply them. */
    listCandidates(input: {
        readonly command: SlashCommandId;
        readonly candidates: readonly Collaboration.CommandCandidate[];
    }): Promise<Result<Collaboration.ListedSlashCommand, NotFound | NotAllowed | WrongCommandType | Closed>>;
    /**
     * The answerer's answer (an answer command): a message of the AI replying to the opening message; for `/guide`,
     * with the next steps it was written from (required there, refused elsewhere: `WrongCommandType`).
     */
    answerCommand(input: {
        readonly command: SlashCommandId;
        readonly answer: Collaboration.Text;
        readonly next?: Collaboration.NextAnswer;
    }): Promise<
        Result<
            { readonly command: Collaboration.AnsweredSlashCommand; readonly answer: Collaboration.SentRequest },
            NotFound | NotAllowed | WrongCommandType | Closed
        >
    >;
    /**
     * The facilitator applies the candidates checked (their numbers), whoever started the command — applying is the
     * approval: one run is queued on the opening message, its input carrying them.
     */
    applyCandidates(input: {
        readonly command: SlashCommandId;
        readonly actor: Actor;
        readonly chosen: readonly number[];
    }): Promise<
        Result<
            { readonly command: Collaboration.AppliedSlashCommand; readonly run: Collaboration.QueuedAgentRun },
            NotFound | NotAllowed | Collaboration.NoSuchCandidate | Closed | QueueError
        >
    >;
    /** Its starter or the facilitator stops it (中止), the AI working or its candidates waiting. */
    stopCommand(input: {
        readonly command: SlashCommandId;
        readonly actor: Actor;
    }): Promise<Result<Collaboration.StoppedSlashCommand, NotFound | NotAllowed | Collaboration.NotTheStarter | Closed>>;
    /** The command jobs the answerer role waits for in the session: the commands the AI works on. */
    commandJobs(input: { readonly session: SessionId }): Promise<Result<readonly SlashCommandJob[], NotFound>>;
}

export function createSlashCommands(deps: CollaborationDeps): SlashCommandUseCases {
    const { uow, clock, ids } = deps;

    const load = (stores: Stores, id: SlashCommandId): Result<Collaboration.SlashCommand, NotFound> => {
        const c = stores.slashCommands.load(id);
        return c ? ok(c) : err(notFound('SlashCommand', id));
    };

    const save = (stores: Stores, command: Collaboration.SlashCommand, events: object, at: Date): void => {
        stores.slashCommands.save(command);
        publish(stores, command.session, events, at);
    };

    return {
        async startCommand({ session, actor, kind, body, language, focus, viewedAt, workspace }) {
            const spec = slashCommandSpec(kind);
            return uow.transaction(async (stores) => {
                if (runningCommand(stores.slashCommands.listBySession(session), kind)) return err({ type: 'Collaboration.CommandAlreadyRunning' });
                const sent = await sendIn(stores, { clock, ids }, { session, actor, targets: [], body, ...(viewedAt && { viewedAt }) });
                if (!sent.ok) return sent;
                const active = await storeVerifications(stores).makeActiveSession(session);
                if (!active.ok) return active;
                const at = clock.now();
                const scope = spec.needsStorming ? stormingInView(viewedAt, focus) : undefined;
                // the guide's snapshot: the journey file's goals and marks, the session's current journey first
                const current = stores.sessions.load(session)?.currentJourney;
                const guide =
                    kind === 'Guide' && workspace
                        ? guideSnapshot({
                              workspace,
                              goal: readGuideGoal(workspace),
                              marks: guideMarks(journeyMarks(workspace.journey)),
                              ...(current !== undefined && { current }),
                              ...(viewedAt && { viewedAt }),
                              ...(focus && { focus }),
                          })
                        : undefined;
                const started = slashCommandCommands.start({
                    id: knownSlashCommandId(ids.newId()),
                    session: active.value,
                    kind,
                    startedBy: actor.participant,
                    opening: sent.value.id,
                    scope,
                    language,
                    startedAt: at,
                    guide,
                });
                if (!started.ok) return started;
                const { Working } = started.value;
                save(stores, Working.aggregate, Working.events, at);
                // nothing to work on: no candidates (whatever its type), and the card says why
                if (spec.needsStorming && scope === undefined) {
                    const listed = decided(slashCommandCommands.list(Working.aggregate, { candidates: [], listedAt: at }));
                    save(stores, listed.Listed.aggregate, listed.Listed.events, at);
                    return ok({ command: listed.Listed.aggregate, request: sent.value });
                }
                return ok({ command: Working.aggregate, request: sent.value });
            });
        },

        async listCandidates({ command, candidates }) {
            return uow.transaction(async (stores) => {
                const found = load(stores, command);
                if (!found.ok) return found;
                const c = found.value;
                if (c.state !== 'Working') return err(notAllowed('list', c.state));
                if (slashCommandSpec(c.kind).type !== 'candidates') return err({ type: 'WrongCommandType' });
                const active = await storeVerifications(stores).makeActiveSession(c.session);
                if (!active.ok) return active;
                const at = clock.now();
                const listed = decided(slashCommandCommands.list(c, { candidates, listedAt: at }));
                save(stores, listed.Listed.aggregate, listed.Listed.events, at);
                return ok(listed.Listed.aggregate);
            });
        },

        async answerCommand({ command, answer, next }) {
            return uow.transaction(async (stores) => {
                const found = load(stores, command);
                if (!found.ok) return found;
                const c = found.value;
                if (c.state !== 'Working') return err(notAllowed('answer', c.state));
                const spec = slashCommandSpec(c.kind);
                if (spec.type !== 'answer' || (spec.reply === 'next') !== (next !== undefined)) return err({ type: 'WrongCommandType' });
                const active = await storeVerifications(stores).makeActiveSession(c.session);
                if (!active.ok) return active;
                const at = clock.now();
                const id = knownRequestId(ids.newId());
                const { Sent } = decided(requestCommands.answer({ id, session: active.value, answers: c.opening, body: answer, sentAt: at }));
                stores.requests.save(Sent.aggregate);
                publish(stores, c.session, Sent.events, at);
                const answered = decided(slashCommandCommands.answer(c, { answer: id, next, answeredAt: at }));
                save(stores, answered.Answered.aggregate, answered.Answered.events, at);
                return ok({ command: answered.Answered.aggregate, answer: Sent.aggregate });
            });
        },

        async applyCandidates({ command, actor, chosen }) {
            return uow.transaction(async (stores) => {
                const found = load(stores, command);
                if (!found.ok) return found;
                const c = found.value;
                if (c.state !== 'Listed') return err(notAllowed('apply', c.state));
                // asked before the run is queued (which asks it too), so that the refusal is the command's
                if (actor.role !== 'Facilitator') return err({ type: 'Collaboration.FacilitatorOnly' });
                const indices = chosenIndices(c.candidates, chosen);
                if (!indices) return err({ type: 'Collaboration.NoSuchCandidate' });
                const active = await storeVerifications(stores).makeActiveSession(c.session);
                if (!active.ok) return active;
                const at = clock.now();
                const [first, ...rest] = indices.map((i) => c.candidates[i]).filter((x): x is Collaboration.CommandCandidate => x !== undefined);
                if (!first) return err({ type: 'Collaboration.NoSuchCandidate' });
                const run = await queueRequests(stores, ids, {
                    session: active.value,
                    requests: [c.opening],
                    extra: { candidates: { command: c.id, kind: c.kind, ...(c.scope && { scope: c.scope }), chosen: [first, ...rest] } },
                    queuedBy: actor.participant,
                    queuedByRole: actor.role,
                    at,
                });
                if (!run.ok) return run;
                const applied = slashCommandCommands.apply(c, {
                    appliedBy: actor.participant,
                    appliedByRole: actor.role,
                    chosen: indices,
                    run: run.value.id,
                    appliedAt: at,
                });
                if (!applied.ok) return applied;
                save(stores, applied.value.Applied.aggregate, applied.value.Applied.events, at);
                return ok({ command: applied.value.Applied.aggregate, run: run.value });
            });
        },

        async stopCommand({ command, actor }) {
            return uow.transaction(async (stores) => {
                const found = load(stores, command);
                if (!found.ok) return found;
                const c = found.value;
                if (!isCommandRunning(c)) return err(notAllowed('stop', c.state));
                const active = await storeVerifications(stores).makeActiveSession(c.session);
                if (!active.ok) return active;
                const at = clock.now();
                const stopped = slashCommandCommands.stop(c, { stoppedBy: actor.participant, stoppedByRole: actor.role, stoppedAt: at });
                if (!stopped.ok) return stopped;
                save(stores, stopped.value.Stopped.aggregate, stopped.value.Stopped.events, at);
                return ok(stopped.value.Stopped.aggregate);
            });
        },

        async commandJobs({ session }) {
            return uow.transaction((stores) => {
                const found = stores.sessions.load(session);
                if (!found) return err(notFound('Session', session));
                if (found.state !== 'Open') return ok([]);
                const jobs: SlashCommandJob[] = [];
                for (const command of stores.slashCommands.listBySession(session)) {
                    if (command.state !== 'Working') continue;
                    const request = stores.requests.load(command.opening);
                    if (request) jobs.push({ kind: 'command', command, request });
                }
                return ok(jobs);
            });
        },
    };
}

/** The success value of a command that cannot fail. */
function decided<T>(r: Result<T, never>): T {
    if (!r.ok) throw new Error('A command without errors returned one');
    return r.value;
}

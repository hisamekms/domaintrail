// The `/` commands that are not interviews (the plan's "`/` commands: ways of working with the AI", round 5, and its
// "Built-in ES commands", phases 1 and 2): a candidate command (`/es:exceptions`, `/es:gaps`, `/es:levels`,
// `/es:names`) has the read-only answerer list candidate changes — each a short label, the elements it touches, how in
// one line, why — of which the facilitator checks some and applies them as one run (whoever started it: applying is
// the approval); an answer command
// (`/es:recap`, `/guide`) has it answer in the chat. `/guide` (ガイド, formerly `/hint` and `/es:next`) coaches the person
// through event storming and modeling alike, in a shape of its own (`NextAnswer`: a status and one to three steps,
// each maybe with a command the page offers as a button), from which the server writes the message. Either way the starter's message (the command's name) goes to the answerer with the command's prompt,
// without triage.
//
// Here: the commands' table (their stable English IDs, their type, what they need), the
// decisions, and the answerer's output (candidates or an answer: AI output, untrusted, validated against its shape and
// limits before anything is kept; candidates past the limit are dropped rather than refused, as a proposal's options).
// A new command is a row of the table, an entry of the enum in `command.dt`, its prompt and, for a candidate command,
// its rule for the run. Pure.
import { Collaboration, decide, err, ok, type Result } from '../generated/index.js';
import { elementReference, PROPOSAL_LIMITS, readProposalText, readTargets } from './proposals.js';
import { REPLY_LIMITS } from './reply.js';

/** What a command does: lists candidates to apply as a run, or answers in the chat. */
export type SlashCommandType = 'candidates' | 'answer';

/**
 * What the answerer writes for a command: candidates, an answer in Markdown, or the next steps (`/guide`: an answer
 * the server writes from them).
 */
export type CommandReplyShape = SlashCommandType | 'next';

/** A command's row: what it is in the model, its type, what it is about. */
export interface SlashCommandSpec {
    readonly kind: Collaboration.SlashCommandKind;
    readonly type: SlashCommandType;
    /** What the answerer writes: its type's shape, or the next steps (an answer command). */
    readonly reply: CommandReplyShape;
    /**
     * It is about the storming in view: without one, it lists no candidates at once (an answer command too: nothing is
     * asked, and the card says so).
     */
    readonly needsStorming: boolean;
}

/**
 * The commands by their stable IDs (what one types after `/`): the ES ones in the order of the work on a storming — the
 * flow (exceptions, gaps), then its details (levels, names), then the session (recap) — and `guide`, which has no
 * prefix (it is about the event storming and the modeling alike). Where `/` lists them is the page's.
 */
export const SLASH_COMMANDS = {
    'es:exceptions': { kind: 'EsExceptions', type: 'candidates', reply: 'candidates', needsStorming: true },
    'es:gaps': { kind: 'EsGaps', type: 'candidates', reply: 'candidates', needsStorming: true },
    'es:levels': { kind: 'EsLevels', type: 'candidates', reply: 'candidates', needsStorming: true },
    'es:names': { kind: 'EsNames', type: 'candidates', reply: 'candidates', needsStorming: true },
    'es:recap': { kind: 'EsRecap', type: 'answer', reply: 'answer', needsStorming: false },
    guide: { kind: 'Guide', type: 'answer', reply: 'next', needsStorming: false },
} as const satisfies Record<string, SlashCommandSpec>;

export type SlashCommandName = keyof typeof SLASH_COMMANDS;

/** Whether a string is a command's ID. */
export const isSlashCommandName = (id: string): id is SlashCommandName => Object.hasOwn(SLASH_COMMANDS, id);

/** The commands' IDs, in their order. */
export const SLASH_COMMAND_NAMES: readonly SlashCommandName[] = Object.keys(SLASH_COMMANDS).filter(isSlashCommandName);

/** The ID of a command's kind (`es:exceptions`). */
export function slashCommandName(kind: Collaboration.SlashCommandKind): SlashCommandName {
    const found = SLASH_COMMAND_NAMES.find((n) => SLASH_COMMANDS[n].kind === kind);
    if (!found) throw new Error(`No / command for ${kind}`);
    return found;
}

/** The row of a command's kind. */
export const slashCommandSpec = (kind: Collaboration.SlashCommandKind): SlashCommandSpec => SLASH_COMMANDS[slashCommandName(kind)];

/** The command an ID names; undefined for any other (an interview's included). */
export function slashCommandOf(id: unknown): SlashCommandSpec | undefined {
    return typeof id === 'string' && isSlashCommandName(id) ? SLASH_COMMANDS[id] : undefined;
}

/** The limits of what the answerer writes for a command. */
export const CANDIDATE_LIMITS = {
    /** Candidates kept (more are dropped): a short list to check at a glance. */
    candidates: 12,
    /** A candidate's label: a few words. */
    label: 60,
    /** How, in one line. */
    how: PROPOSAL_LIMITS.how,
    /** Why, in one line. */
    reason: 200,
    /** Targets of one candidate (more are dropped). */
    targets: 20,
} as const;

/** Whether a command is still running: the AI working on it, or its candidates waiting to be checked. */
export const isCommandRunning = (c: Collaboration.SlashCommand): c is Collaboration.WorkingSlashCommand | Collaboration.ListedSlashCommand =>
    c.state === 'Working' || c.state === 'Listed';

/** The command of the same kind running in a session, if any (at most one of each). */
export function runningCommand(
    commands: readonly Collaboration.SlashCommand[],
    kind: Collaboration.SlashCommandKind,
): Collaboration.WorkingSlashCommand | Collaboration.ListedSlashCommand | undefined {
    return commands.find((c): c is Collaboration.WorkingSlashCommand | Collaboration.ListedSlashCommand => c.kind === kind && isCommandRunning(c));
}

/** The storming a command started from the view is about: the view's storming, else the selected element's. */
export function stormingInView(
    viewedAt: Collaboration.ViewedAt | undefined,
    focus: Collaboration.ModelTarget | undefined,
): Collaboration.StormingName | undefined {
    if (viewedAt?.view.kind === 'Storming') return viewedAt.view.storming;
    if (focus && focus.kind !== 'Workspace' && focus.kind !== 'DtElement') return focus.storming;
    return undefined;
}

/** The commands a step of `/guide` may suggest, by their IDs (the interviews included: `/es:start`, `/model:start`). */
export const SUGGESTED_COMMANDS = {
    'es:start': 'EsStart',
    'es:exceptions': 'EsExceptions',
    'es:gaps': 'EsGaps',
    'es:levels': 'EsLevels',
    'es:names': 'EsNames',
    'es:recap': 'EsRecap',
    'model:start': 'ModelStart',
} as const satisfies Record<string, Collaboration.SuggestedCommand>;

export type SuggestedCommandId = keyof typeof SUGGESTED_COMMANDS;

/** Whether a string is the ID of a command a step may suggest. */
const isSuggestedCommandId = (id: string): id is SuggestedCommandId => Object.hasOwn(SUGGESTED_COMMANDS, id);

/** The IDs a step may suggest, in their order. */
export const SUGGESTED_COMMAND_IDS: readonly SuggestedCommandId[] = Object.keys(SUGGESTED_COMMANDS).filter(isSuggestedCommandId);

/** The ID of a suggested command (`es:gaps`): what the page puts in the composer after `/`. */
export function suggestedCommandId(c: Collaboration.SuggestedCommand): SuggestedCommandId {
    const found = SUGGESTED_COMMAND_IDS.find((id) => SUGGESTED_COMMANDS[id] === c);
    if (!found) throw new Error(`No / command for ${c}`);
    return found;
}

/** The limits of `/guide`'s answer. */
export const NEXT_LIMITS = {
    /** Where the work stands, in one line. */
    status: 200,
    /** Steps kept (more are dropped). */
    steps: 3,
    /** A step, in one line. */
    text: 120,
    /** Why that step, in one line. */
    reason: 200,
    /** Where to go for a step (elements, stages): more are dropped. */
    targets: 3,
    /** What to ask the people, a question in one line. */
    ask: 200,
} as const;

/**
 * A step of `/guide` as the answerer sends it: what to do, why, the command's ID when one does it, where to go (element
 * references), what to ask the people.
 */
export interface NextStepData {
    readonly text: string;
    readonly reason: string;
    readonly command?: SuggestedCommandId;
    readonly targets?: readonly string[];
    readonly ask?: string;
}

/** `/guide`'s answer as the answerer sends it. */
export interface NextAnswerData {
    readonly status: string;
    readonly steps: readonly NextStepData[];
}

/** A candidate as the answerer sends it: element references, how in one line, why. */
export interface CandidateData {
    readonly label: string;
    readonly targets: readonly string[];
    readonly how: string;
    readonly reason?: string;
}

/** The answerer's reply to a command: its candidates, or its answer (with the next steps it was written from, `/guide`). */
export type CommandReply =
    | { readonly kind: 'candidates'; readonly candidates: readonly Collaboration.CommandCandidate[] }
    | { readonly kind: 'answer'; readonly answer: string; readonly next?: Collaboration.NextAnswer };

/** What went wrong reading the answerer's output: where, and what. */
export interface CommandProblem {
    readonly path: string;
    readonly message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function extra(v: Record<string, unknown>, keys: readonly string[], path: string): CommandProblem | undefined {
    const k = Object.keys(v).find((x) => !keys.includes(x));
    return k === undefined ? undefined : { path: `${path}.${k}`, message: 'Unknown field.' };
}

/** One candidate: `{ label, targets, how, reason? }`, its references read as a proposal's. */
function readCandidate(raw: unknown, path: string): Result<Collaboration.CommandCandidate, CommandProblem> {
    if (!isObject(raw)) return err({ path, message: 'Expected an object.' });
    const unknown = extra(raw, ['label', 'targets', 'how', 'reason'], path);
    if (unknown) return err(unknown);
    const label = readProposalText(raw.label, `${path}.label`, CANDIDATE_LIMITS.label);
    if (!label.ok) return label;
    if (/[\n\r]/u.test(label.value)) return err({ path: `${path}.label`, message: 'One line.' });
    const made = Collaboration.makeCandidateLabel(label.value);
    if (!made.ok) return err({ path: `${path}.label`, message: 'Not a label.' });
    const targets = readTargets(raw.targets ?? [], `${path}.targets`, CANDIDATE_LIMITS.targets);
    if (!targets.ok) return targets;
    const how = readProposalText(raw.how, `${path}.how`, CANDIDATE_LIMITS.how);
    if (!how.ok) return how;
    const reason = raw.reason === undefined ? undefined : readProposalText(raw.reason, `${path}.reason`, CANDIDATE_LIMITS.reason);
    if (reason && !reason.ok) return reason;
    return ok({ label: made.value, targets: targets.value, how: how.value, ...(reason && { reason: reason.value }) });
}

/** A line of `/guide`: within its limit, its line breaks as spaces (it is shown on one line). */
function readNextLine(v: unknown, path: string, max: number): Result<Collaboration.ProposalText, CommandProblem> {
    return readProposalText(typeof v === 'string' ? v.replace(/\s*[\n\r]+\s*/gu, ' ') : v, path, max);
}

/**
 * One step of `/guide`: `{ text, reason, command?, targets?, ask? }`; a command that is not one of `SUGGESTED_COMMANDS`
 * is dropped, as a malformed reference is.
 */
function readNextStep(raw: unknown, path: string): Result<Collaboration.NextStep, CommandProblem> {
    if (!isObject(raw)) return err({ path, message: 'Expected an object.' });
    const unknown = extra(raw, ['text', 'reason', 'command', 'targets', 'ask'], path);
    if (unknown) return err(unknown);
    const text = readNextLine(raw.text, `${path}.text`, NEXT_LIMITS.text);
    if (!text.ok) return text;
    const reason = readNextLine(raw.reason, `${path}.reason`, NEXT_LIMITS.reason);
    if (!reason.ok) return reason;
    const id = typeof raw.command === 'string' ? raw.command.replace(/^\//u, '') : undefined;
    const command = id !== undefined && isSuggestedCommandId(id) ? SUGGESTED_COMMANDS[id] : undefined;
    const targets = readTargets(raw.targets ?? [], `${path}.targets`, NEXT_LIMITS.targets);
    if (!targets.ok) return targets;
    const ask = raw.ask === undefined ? undefined : readNextLine(raw.ask, `${path}.ask`, NEXT_LIMITS.ask);
    if (ask && !ask.ok) return ask;
    return ok({ text: text.value, reason: reason.value, ...(command && { command }), targets: targets.value, ...(ask && { ask: ask.value }) });
}

/** `/guide`'s reply, `{ kind: 'next', status, steps }`: the first `NEXT_LIMITS.steps` steps kept, none refused. */
function readNextAnswer(raw: Record<string, unknown>): Result<Collaboration.NextAnswer, CommandProblem> {
    const unknown = extra(raw, ['kind', 'status', 'steps'], 'reply');
    if (unknown) return err(unknown);
    const status = readNextLine(raw.status, 'reply.status', NEXT_LIMITS.status);
    if (!status.ok) return status;
    if (!Array.isArray(raw.steps)) return err({ path: 'reply.steps', message: 'Expected a list of steps.' });
    const steps: Collaboration.NextStep[] = [];
    for (const [i, x] of raw.steps.slice(0, NEXT_LIMITS.steps).entries()) {
        const read = readNextStep(x, `reply.steps[${i}]`);
        if (!read.ok) return read;
        steps.push(read.value);
    }
    const [first, ...rest] = steps;
    if (!first) return err({ path: 'reply.steps', message: 'Expected at least one step.' });
    return ok({ status: status.value, steps: [first, ...rest] });
}

/**
 * The message of `/guide`'s answer, in Markdown: the status, then the steps as a numbered list, each with its reason
 * and its command's ID (\`/es:gaps\`), so that the session so far and any reader without the page's buttons read it
 * whole.
 */
export function nextAnswerText(next: Pick<Collaboration.NextAnswer, 'status' | 'steps'>): string {
    const steps = next.steps.map((s, i) => `${i + 1}. **${s.text}** — ${s.reason}${s.command ? ` \`/${suggestedCommandId(s.command)}\`` : ''}`);
    return [next.status, '', ...steps].join('\n');
}

/** `/guide`'s answer as the answerer sends it (and the server reads it again). */
export function nextAnswerData(next: Pick<Collaboration.NextAnswer, 'status' | 'steps'>): NextAnswerData {
    return {
        status: next.status,
        steps: next.steps.map((s) => ({
            text: s.text,
            reason: s.reason,
            ...(s.command && { command: suggestedCommandId(s.command) }),
            ...(s.targets.length > 0 && { targets: s.targets.map(elementReference) }),
            ...(s.ask !== undefined && { ask: s.ask }),
        })),
    };
}

/**
 * The answerer's JSON for a command whose reply is `shape`: `{ kind: 'candidates', candidates }` (the first
 * `CANDIDATE_LIMITS.candidates` kept, none is a list too), `{ kind: 'answer', answer }` (Markdown within the answers'
 * limit) or `{ kind: 'next', status, steps }` (`/guide`: read as an answer, its message written from them),
 * validated. Another kind is refused.
 */
export function readCommandReply(raw: unknown, shape: CommandReplyShape): Result<CommandReply, CommandProblem> {
    if (!isObject(raw)) return err({ path: 'reply', message: 'Expected an object.' });
    if (raw.kind !== shape) return err({ path: 'reply.kind', message: `Expected ${shape}.` });
    if (shape === 'next') {
        const next = readNextAnswer(raw);
        if (!next.ok) return next;
        const answer = nextAnswerText(next.value);
        if (answer.length > REPLY_LIMITS.answer) return err({ path: 'reply', message: `At most ${REPLY_LIMITS.answer} characters.` });
        return ok({ kind: 'answer', answer, next: next.value });
    }
    if (shape === 'answer') {
        const unknown = extra(raw, ['kind', 'answer'], 'reply');
        if (unknown) return err(unknown);
        if (typeof raw.answer !== 'string' || !raw.answer.trim()) return err({ path: 'reply.answer', message: 'Expected a non-empty string.' });
        const answer = raw.answer.trim();
        if (answer.length > REPLY_LIMITS.answer) return err({ path: 'reply.answer', message: `At most ${REPLY_LIMITS.answer} characters.` });
        return ok({ kind: 'answer', answer });
    }
    const unknown = extra(raw, ['kind', 'candidates'], 'reply');
    if (unknown) return err(unknown);
    if (!Array.isArray(raw.candidates)) return err({ path: 'reply.candidates', message: 'Expected a list of candidates.' });
    const candidates: Collaboration.CommandCandidate[] = [];
    for (const [i, c] of raw.candidates.slice(0, CANDIDATE_LIMITS.candidates).entries()) {
        const read = readCandidate(c, `reply.candidates[${i}]`);
        if (!read.ok) return read;
        candidates.push(read.value);
    }
    return ok({ kind: 'candidates', candidates });
}

/** A candidate as the answerer sends it again (the server reads it again), and as the run's prompt shows it. */
export function candidateData(c: {
    readonly label: string;
    readonly targets: readonly Parameters<typeof elementReference>[0][];
    readonly how: string;
    readonly reason?: string;
}): CandidateData {
    return { label: c.label, targets: c.targets.map(elementReference), how: c.how, ...(c.reason !== undefined && { reason: c.reason }) };
}

/** The JSON schema of the answerer's reply to a command whose reply is `shape`. */
export function commandJsonSchema(shape: CommandReplyShape): Record<string, unknown> {
    const str = (maxLength: number): Record<string, unknown> => ({ type: 'string', minLength: 1, maxLength });
    if (shape === 'next')
        return {
            type: 'object',
            properties: {
                kind: { type: 'string', enum: ['next'] },
                status: str(NEXT_LIMITS.status),
                steps: {
                    type: 'array',
                    minItems: 1,
                    maxItems: NEXT_LIMITS.steps,
                    items: {
                        type: 'object',
                        properties: {
                            text: str(NEXT_LIMITS.text),
                            reason: str(NEXT_LIMITS.reason),
                            command: { type: 'string', enum: [...SUGGESTED_COMMAND_IDS] },
                            // `@{` and `}` around an identifier
                            targets: { type: 'array', items: str(PROPOSAL_LIMITS.reference + 3), maxItems: NEXT_LIMITS.targets },
                            ask: str(NEXT_LIMITS.ask),
                        },
                        required: ['text', 'reason'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['kind', 'status', 'steps'],
            additionalProperties: false,
        };
    if (shape === 'answer')
        return {
            type: 'object',
            properties: { kind: { type: 'string', enum: ['answer'] }, answer: str(REPLY_LIMITS.answer) },
            required: ['kind', 'answer'],
            additionalProperties: false,
        };
    return {
        type: 'object',
        properties: {
            kind: { type: 'string', enum: ['candidates'] },
            candidates: {
                type: 'array',
                maxItems: CANDIDATE_LIMITS.candidates,
                items: {
                    type: 'object',
                    properties: {
                        label: str(CANDIDATE_LIMITS.label),
                        // `@{` and `}` around an identifier
                        targets: { type: 'array', items: str(PROPOSAL_LIMITS.reference + 3), maxItems: CANDIDATE_LIMITS.targets },
                        how: str(CANDIDATE_LIMITS.how),
                        reason: str(CANDIDATE_LIMITS.reason),
                    },
                    required: ['label', 'targets', 'how'],
                    additionalProperties: false,
                },
            },
        },
        required: ['kind', 'candidates'],
        additionalProperties: false,
    };
}

/** The candidates chosen by their numbers, as checked (each once, in the list's order); undefined when one is not listed. */
export function chosenIndices(
    candidates: readonly Collaboration.CommandCandidate[],
    chosen: readonly number[],
): readonly [Collaboration.CandidateIndex, ...Collaboration.CandidateIndex[]] | undefined {
    const out: Collaboration.CandidateIndex[] = [];
    for (const n of [...new Set(chosen)].sort((a, b) => a - b)) {
        const made = Collaboration.makeCandidateIndex(n);
        if (!made.ok || n >= candidates.length) return undefined;
        out.push(made.value);
    }
    const [first, ...rest] = out;
    return first === undefined ? undefined : [first, ...rest];
}

export const slashCommandCommands: Collaboration.SlashCommandCommands = {
    start: decide<Collaboration.StartSlashCommandDecision>(Collaboration.SlashCommandShape, (params) => {
        const { id, kind, startedBy, opening, scope, language, startedAt, guide } = params;
        // the session without its evidence: the aggregate stores the base type
        const session: Collaboration.SessionId = params.session;
        return ok({
            Working: {
                set: { id, session, kind, startedBy, opening, scope, language, startedAt, guide },
                events: {
                    SlashCommandStarted: {
                        type: 'SlashCommandStarted',
                        commandId: id,
                        session,
                        kind,
                        startedBy,
                        opening,
                        ...(scope && { scope }),
                        language,
                        startedAt,
                        ...(guide && { guide }),
                    },
                },
            },
        });
    }),

    list: decide<Collaboration.ListSlashCommandDecision>(Collaboration.SlashCommandShape, {
        Working: (command, { candidates, listedAt }) =>
            ok({
                Listed: {
                    set: { candidates, listedAt },
                    events: { CandidatesListed: { type: 'CandidatesListed', commandId: command.id, candidates, listedAt } },
                },
            }),
    }),

    answer: decide<Collaboration.AnswerSlashCommandDecision>(Collaboration.SlashCommandShape, {
        Working: (command, { answer, next, answeredAt }) =>
            ok({
                Answered: {
                    set: { answer, next, answeredAt },
                    events: {
                        SlashCommandAnswered: { type: 'SlashCommandAnswered', commandId: command.id, answer, ...(next && { next }), answeredAt },
                    },
                },
            }),
    }),

    apply: decide<Collaboration.ApplySlashCommandDecision>(Collaboration.SlashCommandShape, {
        Listed: (command, params) => {
            const failed = Collaboration.checkApplySlashCommandRequires(command, params);
            if (failed === 'facilitatorApplies') return err({ type: 'FacilitatorOnly' });
            if (failed === 'chosenOfList') return err({ type: 'NoSuchCandidate' });
            const { appliedBy, chosen, run, appliedAt } = params;
            return ok({
                Applied: {
                    set: { chosen, appliedBy, run, appliedAt },
                    events: { CandidatesApplied: { type: 'CandidatesApplied', commandId: command.id, chosen, appliedBy, run, appliedAt } },
                },
            });
        },
    }),

    stop: decide<Collaboration.StopSlashCommandDecision>(Collaboration.SlashCommandShape, {
        Working: (command, params) => stopped(command, params),
        Listed: (command, params) => stopped(command, params),
    }),
};

function stopped(
    command: Collaboration.WorkingSlashCommand | Collaboration.ListedSlashCommand,
    params: Collaboration.StopSlashCommandParams,
): Result<
    {
        readonly Stopped: {
            readonly set: { readonly stoppedBy: Collaboration.ParticipantId; readonly stoppedAt: Date };
            readonly events: { readonly SlashCommandStopped: Collaboration.SlashCommandStopped };
        };
    },
    Collaboration.NotTheStarter
> {
    if (Collaboration.checkStopSlashCommandRequires(command, params) === 'starterOrFacilitatorStops') return err({ type: 'NotTheStarter' });
    const { stoppedBy, stoppedAt } = params;
    return ok({
        Stopped: {
            set: { stoppedBy, stoppedAt },
            events: { SlashCommandStopped: { type: 'SlashCommandStopped', commandId: command.id, stoppedBy, stoppedAt } },
        },
    });
}

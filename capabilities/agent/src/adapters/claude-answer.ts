// The Claude Code adapter of the answerer role (ADR 0030, decision 6; the plan's "Stage 3", "Stage 4" and "Two roles"):
// two kinds of turns, each in processes of their own, both through the `claude` the user signed in to (no second
// credential), with the user's settings only and no MCP server, as the runs:
//
// - stage 3 (`triage`): the light model (`--model`, default `haiku`), **no tools at all** (`--tools ""`), stage 3's JSON
//   schema; a fresh `claude -p` per turn by default, or one warm process (`triageWarm`; plan Q12);
// - answers and proposals (`answer`), and the interviews' turns (`interview`, a warm process of their own: another schema): the read-only tools only — `--tools Read,Grep,Glob` with `--permission-mode
//   dontAsk` and no settings file loaded: no edit, write or shell tool exists in the process, whatever the prompt or the
//   message says, and it reads only inside its working directory (the guarantee is here, not configurable) — the
//   answerer's JSON schema (one for answers and
//   proposals, so that one warm process takes both), its own model and effort; warm by default (`warm`), replaced after
//   `restartAfter` turns (default 50), past 150k tokens of context, after `reset` (a restored revision), and ended after
//   `idleTimeoutMs` without a turn.
//
// The working directory (`root`) is the answerer's view of the workspace (`workspace-view.ts`: the files git does not
// ignore, without `.domaintrail/` and `.git/`), brought up to date before each turn (`prepare`). A warm process that misbehaves falls back to a fresh process for the turn, and for good after repeated failures, as
// the runner does (`warm-claude.ts`). The model that answered is read from the process's `init` event. Neither a prompt
// nor the agent's output is logged.
import { spawn } from 'node:child_process';
import { answererJsonSchema, interviewerJsonSchema, triageJsonSchema } from '@domaintrail/collaboration';
import type { AnswerAgent, AnswerTurn, AnswerTurnResult } from '../core/ports.js';
import { type ClaudeResult, createStreamReader } from './claude-stream.js';
import { type AgentCommand, CLAUDE, claudeArguments, KILL_GRACE_MS, killTree } from './claude-code.js';
import { DEFAULT_ANSWER_RESTART_AFTER, DEFAULT_TRIAGE_MODEL } from './config.js';
import { createWarmClaude, type WarmClaude, type WarmClaudeOptions } from './warm-claude.js';

/** The answerer's tools: reading only. Not configurable: they are the read-only guarantee. */
export const ANSWERER_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

export interface ClaudeAnswererOptions extends Pick<
    WarmClaudeOptions,
    'contextLimit' | 'maxFailures' | 'startTimeoutMs' | 'interruptGraceMs' | 'closeGraceMs' | 'log'
> {
    /** The agent's working directory: the answerer's view of the workspace (all it can read). */
    readonly root: string;
    /** Called before each turn: brings the view up to date. A failure fails the turn. */
    readonly prepare?: () => Promise<void>;
    /** The program (default `claude` on the PATH); the tests start a fake agent. */
    readonly command?: AgentCommand;
    /** Answers and proposals (`agent.answer.*`): model and effort (unset: the user's Claude Code settings), warm, restart. */
    readonly answer?: {
        readonly model?: string;
        readonly effort?: string;
        /** One warm process across turns (default true). */
        readonly warm?: boolean;
        readonly restartAfter?: number;
        /** How long the warm process may go without a turn (default 30 minutes; 0: never). */
        readonly idleTimeoutMs?: number;
    };
    /** Stage 3 (`agent.triage.*`): the model (default `haiku`), and whether its process stays (default false: one per turn). */
    readonly triage?: {
        readonly model?: string;
        readonly warm?: boolean;
        readonly restartAfter?: number;
        readonly idleTimeoutMs?: number;
    };
}

/** The arguments of an answer or proposal turn: the reading tools only, the answerer's schema. */
export function answererArguments(options: { readonly model?: string; readonly effort?: string; readonly streamInput?: boolean } = {}): string[] {
    return claudeArguments(ANSWERER_TOOLS, undefined, { ...options, schema: answererJsonSchema() });
}

/** The arguments of an interview's turn: the reading tools only, the interviewer's schema. */
export function interviewerArguments(options: { readonly model?: string; readonly effort?: string; readonly streamInput?: boolean } = {}): string[] {
    return claudeArguments(ANSWERER_TOOLS, undefined, { ...options, schema: interviewerJsonSchema() });
}

/** The arguments of a stage 3 turn: no tool at all, stage 3's schema, the light model. */
export function triageArguments(options: { readonly model?: string; readonly streamInput?: boolean } = {}): string[] {
    return claudeArguments([], undefined, { model: options.model ?? DEFAULT_TRIAGE_MODEL, schema: triageJsonSchema(), streamInput: options.streamInput });
}

/** The model an event names (`system/init`), if it is one. */
const modelOf = (event: Readonly<Record<string, unknown>>): string | undefined =>
    event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string' && /^[\w.:@[\]/-]{1,100}$/.test(event.model)
        ? event.model
        : undefined;

/** One `claude` process for one turn: the prompt on stdin, the events read, killed with its group when `signal` aborts. */
export function runClaudeOnce(
    command: AgentCommand,
    args: readonly string[],
    prompt: string,
    root: string,
    signal: AbortSignal,
): Promise<{ readonly exitCode: number; readonly result: ClaudeResult; readonly model?: string }> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return resolve({ exitCode: -1, result: { text: '' } });
        let model: string | undefined;
        const child = spawn(command.command, [...command.args, ...args], {
            cwd: root,
            shell: false,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const stream = createStreamReader((event) => {
            model = modelOf(event) ?? model;
        });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => stream.push(chunk));
        // stderr is read so that the agent never blocks on it, and dropped: it may echo the prompt
        child.stderr.resume();
        child.stdin.on('error', (e: Error & { code?: string }) => {
            if (e.code !== 'EPIPE') reject(e);
        });
        let killer: ReturnType<typeof setTimeout> | undefined;
        const stop = (): void => {
            killTree(child.pid, 'SIGTERM');
            killer = setTimeout(() => killTree(child.pid, 'SIGKILL'), KILL_GRACE_MS);
            killer.unref();
        };
        signal.addEventListener('abort', stop, { once: true });
        child.once('error', (e) => {
            signal.removeEventListener('abort', stop);
            reject(e);
        });
        child.once('close', (code) => {
            signal.removeEventListener('abort', stop);
            if (signal.aborted) killTree(child.pid, 'SIGKILL');
            if (killer) clearTimeout(killer);
            resolve({ exitCode: code ?? -1, result: stream.end(), ...(model && { model }) });
        });
        child.stdin.end(prompt);
    });
}

/** A turn's result from a cold process's end. */
function coldResult(ran: { readonly exitCode: number; readonly result: ClaudeResult; readonly model?: string }, fallbackModel?: string): AnswerTurnResult {
    const model = ran.model ?? fallbackModel;
    if (ran.exitCode !== 0) return { text: '', error: `claude exited with ${ran.exitCode}`, ...(model && { model }) };
    return { text: ran.result.text, ...(ran.result.structured !== undefined && { structured: ran.result.structured }), ...(model && { model }) };
}

export function createClaudeAnswerer(options: ClaudeAnswererOptions): AnswerAgent {
    const command = options.command ?? CLAUDE;
    const answer = options.answer ?? {};
    const triage = options.triage ?? {};
    const answerFlags = { ...(answer.model !== undefined && { model: answer.model }), ...(answer.effort !== undefined && { effort: answer.effort }) };
    const triageModel = triage.model ?? DEFAULT_TRIAGE_MODEL;
    const shared = {
        root: options.root,
        command,
        ...(options.contextLimit !== undefined && { contextLimit: options.contextLimit }),
        ...(options.maxFailures !== undefined && { maxFailures: options.maxFailures }),
        ...(options.startTimeoutMs !== undefined && { startTimeoutMs: options.startTimeoutMs }),
        ...(options.interruptGraceMs !== undefined && { interruptGraceMs: options.interruptGraceMs }),
        ...(options.closeGraceMs !== undefined && { closeGraceMs: options.closeGraceMs }),
        ...(options.log && { log: options.log }),
    };
    const warmAnswerer: WarmClaude | undefined =
        (answer.warm ?? true)
            ? createWarmClaude({
                  ...shared,
                  name: 'answerer',
                  restartAfter: answer.restartAfter ?? DEFAULT_ANSWER_RESTART_AFTER,
                  ...(answer.idleTimeoutMs !== undefined && { idleTimeoutMs: answer.idleTimeoutMs }),
              })
            : undefined;
    // the interviews' own warm process (their schema differs from the answers'): with the answers' settings
    const warmInterviewer: WarmClaude | undefined =
        (answer.warm ?? true)
            ? createWarmClaude({
                  ...shared,
                  name: 'interviewer',
                  restartAfter: answer.restartAfter ?? DEFAULT_ANSWER_RESTART_AFTER,
                  ...(answer.idleTimeoutMs !== undefined && { idleTimeoutMs: answer.idleTimeoutMs }),
              })
            : undefined;
    const warmTriage: WarmClaude | undefined = triage.warm
        ? createWarmClaude({
              ...shared,
              name: 'triage',
              restartAfter: triage.restartAfter ?? DEFAULT_ANSWER_RESTART_AFTER,
              ...(triage.idleTimeoutMs !== undefined && { idleTimeoutMs: triage.idleTimeoutMs }),
          })
        : undefined;

    const cold = async (args: readonly string[], turn: AnswerTurn, model?: string): Promise<AnswerTurnResult> => {
        try {
            const ran = await runClaudeOnce(command, args, turn.prompt, options.root, turn.signal);
            if (turn.signal.aborted) return { text: '', error: 'stopped' };
            return coldResult(ran, model);
        } catch (e) {
            return { text: '', error: e instanceof Error ? e.message : String(e) };
        }
    };

    /** A turn of a warm process; a fresh one for this turn when the warm one never took it, or for good after repeated failures. */
    const warmTurn = async (warm: WarmClaude, args: readonly string[], turn: AnswerTurn, model?: string): Promise<AnswerTurnResult> => {
        if (warm.coldOnly) return cold(coldArgs(args), turn, model);
        let seen: string | undefined;
        const end = await warm.turn({
            profile: { args, key: JSON.stringify(args) },
            prompt: (continuing) => (continuing && turn.continuedPrompt !== undefined ? turn.continuedPrompt : turn.prompt),
            signal: turn.signal,
            onEvent: (event) => {
                seen = modelOf(event) ?? seen;
            },
        });
        const named = seen ?? model;
        const withModel = named ? { model: named } : {};
        switch (end.kind) {
            case 'result':
                if (end.isError) return { text: '', error: 'the turn ended with an error', ...withModel };
                return { text: end.result.text, ...(end.result.structured !== undefined && { structured: end.result.structured }), ...withModel };
            case 'cancelled':
                return { text: '', error: 'stopped' };
            case 'silent':
                return cold(coldArgs(args), turn, model);
            case 'exit':
                if (turn.signal.aborted) return { text: '', error: 'stopped' };
                if (!end.started) return cold(coldArgs(args), turn, model);
                return { text: '', error: `claude exited with ${end.code} during the turn`, ...withModel };
        }
    };

    /** Brings the view up to date before a turn: a failure is the turn's. */
    const prepared = async (run: () => Promise<AnswerTurnResult>): Promise<AnswerTurnResult> => {
        try {
            await options.prepare?.();
        } catch (e) {
            return { text: '', error: `the workspace could not be prepared: ${e instanceof Error ? e.message : String(e)}` };
        }
        return run();
    };

    return {
        triage(turn) {
            if (!warmTriage) return prepared(() => cold(triageArguments({ model: triageModel }), turn, triageModel));
            return prepared(() => warmTurn(warmTriage, triageArguments({ model: triageModel, streamInput: true }), turn, triageModel));
        },
        answer(turn) {
            if (!warmAnswerer) return prepared(() => cold(answererArguments(answerFlags), turn, answer.model));
            return prepared(() => warmTurn(warmAnswerer, answererArguments({ ...answerFlags, streamInput: true }), turn, answer.model));
        },
        interview(turn) {
            if (!warmInterviewer) return prepared(() => cold(interviewerArguments(answerFlags), turn, answer.model));
            return prepared(() => warmTurn(warmInterviewer, interviewerArguments({ ...answerFlags, streamInput: true }), turn, answer.model));
        },
        reset(reason) {
            warmAnswerer?.reset(reason);
            warmInterviewer?.reset(reason);
            warmTriage?.reset(reason);
        },
        async close() {
            await Promise.all([warmAnswerer?.close(), warmInterviewer?.close(), warmTriage?.close()]);
        },
    };
}

/** A warm process's arguments for a fresh process of one turn: without the stream-json input. */
function coldArgs(args: readonly string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--input-format' && args[i + 1] === 'stream-json') {
            i++;
            continue;
        }
        out.push(args[i]);
    }
    return out;
}

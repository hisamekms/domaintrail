// A warm Claude Code (plan modes, the warm agent): one long-lived `claude --input-format stream-json` process, each
// prompt one user turn, so that the process start (~1.3 s) is paid once and the agent remembers what it read. Not tied
// to a role: the run role (`claude-warm.ts`) drives it with its tools, prompt and reply schema, and a read-only role
// can drive another one with its own. What a role gives is a *profile*: the arguments of `claude` (tools, schema,
// model…) and a key that says when a process no longer fits (a different key: the process is replaced).
//
// Lifecycle: no process until the first turn; replaced (no context carried) after `restartAfter` turns, when a turn's
// context passes `contextLimit` tokens, when the profile changes, after `reset` (the role's reasons: a restored
// revision, a declined run…; at once between turns, after the turn during one), and after anything unexpected of the
// protocol (a control request of the CLI's, which is refused). A process that takes no turn for `idleTimeoutMs` after
// its last one ends (its memory freed; the timer runs only between turns), and the next turn starts a fresh one, which
// is no failure. A cancel sends the `interrupt` control request: the
// turn ends with an error result and the process stays; when no result comes within `interruptGraceMs`, the process
// group is killed. A process that fails (does not answer a turn, exits in one) is replaced too; after `maxFailures`
// in a row `coldOnly` turns true for good (logged once) and the role runs its turns cold. Notifications of the
// user's own Claude Code settings (a Stop hook's `stop-hook-error`, one a turn) are logged once and otherwise
// ignored. Neither a prompt nor the agent's output is logged.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { DEFAULT_IDLE_TIMEOUT, DEFAULT_RESTART_AFTER } from './config.js';
import { type ClaudeResult, createStreamReader, isObject, resultEvent } from './claude-stream.js';
import { type AgentCommand, CLAUDE, KILL_GRACE_MS, killTree } from './claude-code.js';

/** Tokens of context past which the process is replaced after the turn. */
export const CONTEXT_LIMIT = 150_000;
/** Failures of the warm process in a row after which a role runs cold. */
export const MAX_FAILURES = 3;

/** What a role asks of its process: `claude`'s arguments (after the command's own), and when a process fits. */
export interface WarmProfile {
    readonly args: readonly string[];
    /** Equal keys: a process started for one takes a turn of the other. */
    readonly key: string;
}

/** What a process is started with besides its arguments (the `dt` shim's PATH), and what to clean when it is gone. */
export interface WarmEnvironment {
    readonly env?: NodeJS.ProcessEnv;
    dispose?(): Promise<void>;
}

export interface WarmClaudeOptions {
    /** The working directory of the process (the workspace root). */
    readonly root: string;
    /** The program (default `claude` on the PATH); the tests start a fake agent. */
    readonly command?: AgentCommand;
    /** Made before each process is started, disposed once it is gone. */
    readonly environment?: () => Promise<WarmEnvironment>;
    /** Turns of one process before it is replaced (default `DEFAULT_RESTART_AFTER`). */
    readonly restartAfter?: number;
    /** Context tokens of a turn past which the process is replaced (default `CONTEXT_LIMIT`). */
    readonly contextLimit?: number;
    /**
     * How long a process may go without a turn after its last one before it is ended (default `DEFAULT_IDLE_TIMEOUT`
     * minutes); `0`: never.
     */
    readonly idleTimeoutMs?: number;
    /** Failures in a row after which `coldOnly` turns true (default `MAX_FAILURES`). */
    readonly maxFailures?: number;
    /** How long a turn may show no sign of life after its message was written (default 60 s). */
    readonly startTimeoutMs?: number;
    /** How long an interrupted turn gets to end before the process is killed (default 5 s). */
    readonly interruptGraceMs?: number;
    /** How long a process that is let go gets between the end of its input and SIGTERM (default 1 s). */
    readonly closeGraceMs?: number;
    /** Lifecycle lines, prefixed by the role's `name`: no prompt, no output of the agent. */
    readonly log?: (line: string) => void;
    /** Who this is in the log lines (e.g. `agent`). */
    readonly name?: string;
}

export interface WarmTurn {
    readonly profile: WarmProfile;
    /** The prompt; `continuing`: the process took turns before (it remembers them), else it is fresh. */
    readonly prompt: (continuing: boolean) => string;
    /** Aborted to cancel the turn (interrupt, then kill). */
    readonly signal: AbortSignal;
    /** Each event of the turn, as it comes (the role maps them onto activities). */
    readonly onEvent?: (event: Readonly<Record<string, unknown>>) => void;
}

/** How a turn ended. */
export type WarmTurnEnd =
    /** Its `result` came: `context` is the largest context of its model calls, in tokens. */
    | { readonly kind: 'result'; readonly result: ClaudeResult; readonly isError: boolean; readonly context: number }
    /** The process exited during the turn (`started`: an event of the turn had come) or could not be started. */
    | { readonly kind: 'exit'; readonly code: number; readonly started: boolean }
    /** Nothing of the turn came within the start timeout (the process is gone). */
    | { readonly kind: 'silent' }
    /** Cancelled: interrupted, or killed when it did not stop. */
    | { readonly kind: 'cancelled' };

export interface WarmClaude {
    /** One turn (one at a time). */
    turn(turn: WarmTurn): Promise<WarmTurnEnd>;
    /** The process goes (no context carried): now between turns, after the turn during one. */
    reset(reason: string): void;
    /** The warm process failed `maxFailures` times in a row: the role runs cold from now on. */
    readonly coldOnly: boolean;
    /** Ends the process; resolves once it is gone. */
    close(): Promise<void>;
}

interface Turn {
    started: boolean;
    context: number;
    readonly onEvent: (event: Readonly<Record<string, unknown>>) => void;
    readonly end: (end: WarmTurnEnd) => void;
}

/** One `claude` process. */
interface WarmProcess {
    readonly child: ChildProcessWithoutNullStreams;
    readonly key: string;
    /** Turns written to it (an interrupted one too: it is in the conversation). */
    turns: number;
    /** Gone, or being let go: it takes no more turns. */
    retired: boolean;
    /** Why to replace it once its turn ends. */
    replaceAfterTurn?: string;
    turn?: Turn;
    readonly exited: Promise<void>;
}

/** The context of a model call: the tokens it read (new, from the cache, written to the cache). */
function contextOf(event: Readonly<Record<string, unknown>>): number {
    const message = event.message;
    const usage = isObject(message) ? message.usage : undefined;
    if (!isObject(usage)) return 0;
    const n = (k: string): number => (typeof usage[k] === 'number' ? usage[k] : 0);
    return n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens');
}

/** A notification key fit for a log line. */
const shownKey = (key: unknown): string => (typeof key === 'string' && /^[\w.:-]{1,64}$/.test(key) ? key : '<unnamed>');

/** The longest delay `setTimeout` takes (a longer one fires at once). */
const MAX_TIMER_MS = 2_147_483_647;

/** A duration fit for a log line: minutes when whole, else seconds. */
const shownDuration = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : `${Math.round(ms / 100) / 10} s`);

export function createWarmClaude(options: WarmClaudeOptions): WarmClaude {
    const command = options.command ?? CLAUDE;
    const name = options.name ?? 'agent';
    const log = (line: string): void => options.log?.(`${name}: ${line}`);
    const restartAfter = options.restartAfter ?? DEFAULT_RESTART_AFTER;
    const contextLimit = options.contextLimit ?? CONTEXT_LIMIT;
    const maxFailures = options.maxFailures ?? MAX_FAILURES;
    const startTimeoutMs = options.startTimeoutMs ?? 60_000;
    const interruptGraceMs = options.interruptGraceMs ?? 5_000;
    const closeGraceMs = options.closeGraceMs ?? 1_000;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT * 60_000;

    let current: WarmProcess | undefined;
    let failures = 0;
    let coldOnly = false;
    const notified = new Set<string>();
    let requestIds = 0;

    /** Lets a process go: its input ends; SIGTERM to its group after `closeGraceMs`, SIGKILL after the kill grace. */
    const retire = (proc: WarmProcess, why: string | undefined): Promise<void> => {
        if (current === proc) current = undefined;
        if (proc.retired) return proc.exited;
        proc.retired = true;
        if (why) log(`the warm Claude Code process ends (${why}); the next turn starts a fresh one`);
        proc.child.stdin.end();
        const term = setTimeout(() => killTree(proc.child.pid, 'SIGTERM'), closeGraceMs);
        const kill = setTimeout(() => killTree(proc.child.pid, 'SIGKILL'), closeGraceMs + KILL_GRACE_MS);
        term.unref();
        kill.unref();
        void proc.exited.then(() => {
            clearTimeout(term);
            clearTimeout(kill);
        });
        return proc.exited;
    };

    /** Ends the current process once it has been idle for `idleTimeoutMs` (armed between turns only). */
    let idle: ReturnType<typeof setTimeout> | undefined;
    const stopIdleTimer = (): void => {
        clearTimeout(idle);
        idle = undefined;
    };
    /** Arms the idle timer for a process that just ended a turn and stays. */
    const startIdleTimer = (proc: WarmProcess): void => {
        stopIdleTimer();
        if (idleTimeoutMs <= 0 || current !== proc || proc.retired || proc.turn) return;
        idle = setTimeout(
            () => {
                idle = undefined;
                if (current === proc && !proc.turn) void retire(proc, `no turn for ${shownDuration(idleTimeoutMs)}`);
            },
            Math.min(idleTimeoutMs, MAX_TIMER_MS),
        );
        // an idle process never keeps the program alive
        idle.unref();
    };

    /** Kills a process's group at once (it may be mid-turn); its exit ends the turn. */
    const kill = (proc: WarmProcess, why: string | undefined): void => {
        if (current === proc) current = undefined;
        if (!proc.retired && why) log(`the warm Claude Code process is killed (${why}); the next turn starts a fresh one`);
        proc.retired = true;
        proc.child.stdin.end();
        killTree(proc.child.pid, 'SIGKILL');
    };

    const failed = (why: string): void => {
        failures++;
        log(`the warm Claude Code process failed (${why})`);
        if (failures >= maxFailures && !coldOnly) {
            coldOnly = true;
            log(`the warm Claude Code process failed ${failures} times in a row; from now on every turn starts its own process (cold)`);
        }
    };

    /** Writes one JSON line to the process's input (nothing once it is gone). */
    const write = (proc: WarmProcess, message: unknown): void => {
        if (proc.child.stdin.writable) proc.child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const start = async (profile: WarmProfile): Promise<WarmProcess> => {
        const environment = (await options.environment?.()) ?? {};
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(command.command, [...command.args, ...profile.args], {
                cwd: options.root,
                ...(environment.env && { env: environment.env }),
                shell: false,
                detached: process.platform !== 'win32',
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (e) {
            await environment.dispose?.();
            throw e;
        }
        let exitCode = -1;
        const exited = new Promise<void>((resolve) => {
            child.once('error', () => resolve());
            child.once('close', (code) => {
                exitCode = code ?? -1;
                resolve();
            });
        });
        const proc: WarmProcess = { child, key: profile.key, turns: 0, retired: false, exited };
        void exited.then(async () => {
            // anything it left in its group goes with it
            killTree(child.pid, 'SIGKILL');
            proc.retired = true;
            if (current === proc) current = undefined;
            proc.turn?.end({ kind: 'exit', code: exitCode, started: proc.turn.started });
            await environment.dispose?.();
        });
        const stream = createStreamReader((event) => {
            if (event.type === 'control_request') {
                // the CLI asks something of us (a permission, a hook callback): nothing we answer; refused, and the
                // process replaced after its turn
                const id = typeof event.request_id === 'string' ? event.request_id : '';
                write(proc, { type: 'control_response', response: { subtype: 'error', request_id: id, error: 'not supported here' } });
                proc.replaceAfterTurn ??= 'it sent an unexpected control request';
                return;
            }
            if (event.type === 'system' && event.subtype === 'notification') {
                const key = shownKey(event.key);
                if (!notified.has(key)) {
                    notified.add(key);
                    log(`Claude Code notified ${JSON.stringify(key)} (ignored; it comes from the user's Claude Code settings, e.g. a hook)`);
                }
                return;
            }
            proc.turn?.onEvent(event);
        });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => stream.push(chunk));
        // stderr is read so that the agent never blocks on it, and dropped: it may echo the prompt
        child.stderr.resume();
        // a write after the process exited: its exit ends the turn
        child.stdin.on('error', () => {});
        log(`started a warm Claude Code process (pid ${child.pid ?? '?'})`);
        return proc;
    };

    const drive = (proc: WarmProcess, prompt: string, w: WarmTurn): Promise<WarmTurnEnd> =>
        new Promise<WarmTurnEnd>((resolve) => {
            const { signal } = w;
            let interrupted: ReturnType<typeof setTimeout> | undefined;
            /**
             * How the turn ends once its process is gone: the turn is never resolved while the process may still write
             * files (the subscriber scans the workspace after it, and the next run may start), so a forced end kills
             * the group at once and waits for the exit, which ends the turn as this.
             */
            let forced: WarmTurnEnd | undefined;
            const force = (e: WarmTurnEnd, why: string | undefined): void => {
                forced ??= e;
                clearTimeout(silence);
                kill(proc, why);
            };
            const silence = setTimeout(() => {
                failed('a turn showed no sign of life');
                force({ kind: 'silent' }, undefined);
            }, startTimeoutMs);
            const onAbort = (): void => {
                // nothing of the turn yet: the process goes
                if (!t.started) return force({ kind: 'cancelled' }, 'a turn was cancelled before it started');
                write(proc, { type: 'control_request', request_id: `dt-interrupt-${++requestIds}`, request: { subtype: 'interrupt' } });
                interrupted = setTimeout(() => force({ kind: 'cancelled' }, 'an interrupted turn did not stop'), interruptGraceMs);
            };
            const end = (ended: WarmTurnEnd): void => {
                // forced: only the exit ends the turn
                if (forced && ended.kind !== 'exit') return;
                const e = forced ?? ended;
                if (proc.turn !== t) return;
                proc.turn = undefined;
                clearTimeout(silence);
                if (interrupted) clearTimeout(interrupted);
                signal.removeEventListener('abort', onAbort);
                resolve(signal.aborted ? { kind: 'cancelled' } : e);
            };
            const t: Turn = {
                started: false,
                context: 0,
                onEvent(event) {
                    if (!t.started) {
                        t.started = true;
                        clearTimeout(silence);
                    }
                    if (event.type === 'assistant') t.context = Math.max(t.context, contextOf(event));
                    w.onEvent?.(event);
                    if (event.type === 'result') {
                        const result = resultEvent(event) ?? { text: '' };
                        end({ kind: 'result', result, isError: event.is_error === true || event.subtype !== 'success', context: t.context });
                    }
                },
                end,
            };
            proc.turn = t;
            signal.addEventListener('abort', onAbort, { once: true });
            if (proc.retired) return end({ kind: 'exit', code: proc.child.exitCode ?? -1, started: false });
            proc.turns++;
            write(proc, { type: 'user', message: { role: 'user', content: prompt } });
        });

    return {
        get coldOnly() {
            return coldOnly;
        },
        async turn(w: WarmTurn): Promise<WarmTurnEnd> {
            stopIdleTimer();
            if (current && current.key !== w.profile.key) await retire(current, 'its tools or reply schema changed');
            if (w.signal.aborted) return { kind: 'cancelled' };
            const continuing = current !== undefined && current.turns > 0;
            const proc = current ?? (current = await start(w.profile));
            const end = await drive(proc, w.prompt(continuing), w);
            if (end.kind === 'result') {
                failures = 0;
                const why =
                    proc.replaceAfterTurn ??
                    (end.context > contextLimit
                        ? `its context passed ${contextLimit} tokens`
                        : proc.turns >= restartAfter
                          ? `after ${proc.turns} turns`
                          : undefined);
                if (why) void retire(proc, why);
            } else if (end.kind === 'exit' && !w.signal.aborted) {
                failed(`it exited with ${end.code}${end.started ? ' during a turn' : ' before its turn started'}`);
            } else if (end.kind === 'cancelled' && proc.replaceAfterTurn) {
                void retire(proc, proc.replaceAfterTurn);
            }
            startIdleTimer(proc);
            return end;
        },
        reset(reason: string): void {
            if (!current) return;
            if (current.turn) current.replaceAfterTurn ??= reason;
            else {
                stopIdleTimer();
                void retire(current, reason);
            }
        },
        async close(): Promise<void> {
            stopIdleTimer();
            if (current) await retire(current, undefined);
        },
    };
}

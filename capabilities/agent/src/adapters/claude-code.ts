// The Claude Code adapter of the subscriber (ADR 0026, S6): one headless run of `claude` per agent run, started with an
// argument array (no shell) in the workspace root, the prompt on stdin, the facilitator's tools as the only ones
// allowed (`--permission-mode dontAsk` refuses everything else without asking), the reply's JSON schema as the
// structured output (`--json-schema`), and its events streamed as JSON lines on stdout (`claude-stream.ts`): what it is
// doing is told as it goes, and the result (the reply in its `structured_output`) ends the stream. On cancel the whole
// process group is killed. Neither the prompt nor the agent's output is logged. The agent's `dt` is a shim first on
// its PATH (`dt-shim.ts`).
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type { AgentInvocation, AgentOutcome, AgentRunner } from '../core/ports.js';
import { replyJsonSchema } from '@domaintrail/collaboration';
import { parseReply } from '../core/prompt.js';
import { activityOfEvent, createStreamReader } from './claude-stream.js';
import { dtCommandOf, fingerprintDt, pinDt, withPathFirst, writeDtShim, type PinnedDt } from './dt-shim.js';

/** The command that starts the agent: the program and the arguments before the adapter's own. */
export interface AgentCommand {
    readonly command: string;
    readonly args: readonly string[];
}

export const CLAUDE: AgentCommand = { command: 'claude', args: [] };

/** How long a stopped agent gets between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 5_000;

/** What `claude` is asked besides the tools and the reply's schema. */
export interface ClaudeRunOptions {
    /** `--model`: unset, the user's Claude Code settings choose. */
    readonly model?: string;
    /** `--effort`: unset, the user's Claude Code settings choose. */
    readonly effort?: string;
    /** The user messages come as stream-json lines on stdin (a warm process: one turn each), not as one prompt. */
    readonly streamInput?: boolean;
    /** The structured output's JSON schema instead of a run's reply (the answerer role's). */
    readonly schema?: Readonly<Record<string, unknown>>;
    /** Paths of the working directory (relative, `/`-separated) the agent may neither read nor edit: e.g. those git ignores. */
    readonly deniedPaths?: readonly string[];
}

/**
 * What no agent reads or edits inside its working directory, whatever its tools: the session's own state (the agent
 * API's credential is in `.domaintrail/session/agent.json`) and git's.
 */
export const READ_DENIED: readonly string[] = ['Read(./.domaintrail/**)', 'Edit(./.domaintrail/**)', 'Read(./.git/**)', 'Edit(./.git/**)'];

/** A path as a permission rule's (gitignore syntax): its special characters escaped. */
const rulePath = (p: string): string => p.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`);

/** The deny rules of `paths` (relative to the working directory): neither read nor edited, nor anything below them. */
export function deniedRules(paths: readonly string[]): string[] {
    return paths.flatMap((p) => {
        if (!p || p.startsWith('/') || p.split('/').includes('..') || /[\0\r\n]/.test(p)) return [];
        const r = `./${rulePath(p)}`;
        return [`Read(${r})`, `Edit(${r})`, `Read(${r}/**)`, `Edit(${r}/**)`];
    });
}

/** The tools that read files: inside the working directory Claude Code lets them read without a rule. */
const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
/** The tools that write files: `Edit` rules cover them all. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * The permission rules as given to `--allowedTools`, scoped to the working directory: a bare reading tool is no rule
 * at all (reading inside the working directory needs none, and a bare `Read` rule would allow reading anywhere); a bare
 * editing tool is `Edit(./**)`. A rule with its own scope (`Bash(dt fmt:*)`, `Read(docs/**)`) stays as the facilitator
 * wrote it.
 */
export function scopedRules(rules: readonly string[]): string[] {
    const out: string[] = [];
    for (const rule of rules) {
        const scoped = READ_TOOLS.has(rule) ? undefined : EDIT_TOOLS.has(rule) ? 'Edit(./**)' : rule;
        if (scoped !== undefined && !out.includes(scoped)) out.push(scoped);
    }
    return out;
}

/** A value that must not become a flag of `claude`. */
function checkValue(what: string, value: string): string {
    if (!value.trim() || value.startsWith('-') || /[\0\r\n]/.test(value)) throw new Error(`Not ${what}: ${JSON.stringify(value)}`);
    return value;
}

/** The tool names of permission rules: `Bash(dt fmt:*)` → `Bash`. */
export function toolNames(rules: readonly string[]): string[] {
    return [...new Set(rules.map((r) => /^[A-Za-z][\w-]*/.exec(r)?.[0]).filter((n): n is string => n !== undefined))];
}

/**
 * The arguments of `claude` for a run: print mode, the events streamed as JSON lines (`stream-json` needs `--verbose` in
 * print mode), no saved session, no MCP server, the user's settings
 * only (never the workspace's `.claude/` project or local settings, which an agent could have written), the built-in tools
 * narrowed to the rules' tools, and the rules allowed without asking (anything else is refused); with `requests`, the
 * reply's JSON schema for that many requests as the structured output; the model and effort when given, and stream-json
 * input for a warm process. A rule (or a model) that looks like an option is refused: the configuration comes from
 * the facilitator, but no value may become a flag.
 *
 * What it may read (ADR 0030, as built in M4): **no settings file is loaded** (`--setting-sources ""`): neither the
 * workspace's `.claude/` (files the agent can write) nor the user's, whose allow rules (a plain `Read`, say) would let it
 * read anywhere. In `dontAsk` mode Claude Code then reads only inside its working directory, and refuses any path
 * outside it; `READ_DENIED` keeps it out of `.domaintrail/` (the agent credential) and `.git/` there too (deny rules win).
 * The user's model and effort still apply when the role has none (`userClaudeDefaults`).
 */
export function claudeArguments(allowedTools: readonly string[], requests?: number, options: ClaudeRunOptions = {}): string[] {
    for (const rule of allowedTools) checkValue('a tool rule', rule);
    const tools = toolNames(allowedTools);
    const allowed = scopedRules(allowedTools);
    return [
        '--print',
        ...(options.streamInput ? ['--input-format', 'stream-json'] : []),
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--strict-mcp-config',
        // no settings file: the workspace's (`.claude/`) are files the agent can write, the user's may allow reading anywhere
        '--setting-sources',
        '',
        '--permission-mode',
        'dontAsk',
        '--tools',
        tools.length ? tools.join(',') : '',
        ...(options.model === undefined ? [] : ['--model', checkValue('a model', options.model)]),
        ...(options.effort === undefined ? [] : ['--effort', checkValue('an effort', options.effort)]),
        ...(options.schema !== undefined
            ? ['--json-schema', JSON.stringify(options.schema)]
            : requests === undefined
              ? []
              : ['--json-schema', JSON.stringify(replyJsonSchema(requests))]),
        '--disallowedTools',
        ...READ_DENIED,
        ...deniedRules(options.deniedPaths ?? []),
        ...(allowed.length ? ['--allowedTools', ...allowed] : []),
    ];
}

export interface ClaudeCodeOptions {
    /**
     * The paths of the workspace the agent may neither read nor edit besides `READ_DENIED` (those git ignores), asked
     * before each run.
     */
    readonly deniedPaths?: () => Promise<readonly string[]>;
    /** The workspace root: the agent's working directory. */
    readonly root: string;
    /** The program (default `claude` on the PATH); the tests start a fake agent. */
    readonly command?: AgentCommand;
    /**
     * What the agent's `dt` runs: a shim for it goes first on the agent's PATH (none: the PATH as it is). Taken once,
     * when the runner is made: refused inside the workspace, and its files must not change from one run to the next.
     */
    readonly dt?: PinnedDt;
    /** `--model` and `--effort` (unset: the user's Claude Code settings). */
    readonly model?: string;
    readonly effort?: string;
}

/** The real path of the workspace (the agent may name files by it), or the path as given when it cannot be resolved. */
export function realpathOr(root: string): string {
    try {
        return realpathSync(root);
    } catch {
        return root;
    }
}

/** Kills the agent's process group (it was started detached, as the group's leader), or the agent alone on Windows. */
export function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
    if (pid === undefined) return;
    try {
        process.kill(process.platform === 'win32' ? pid : -pid, signal);
    } catch (e) {
        // ESRCH: the group is gone. EPERM: on macOS, what is left of it are zombies (the leader was reaped), or a process
        // that changed its user, which no signal of ours reaches. Either way there is nothing more to kill, and this
        // runs in event handlers, where a throw would end the subscriber in the middle of a run.
        if (!(e instanceof Error && 'code' in e && (e.code === 'ESRCH' || e.code === 'EPERM'))) throw e;
    }
}

/** A `dt` shim on disk, removed by `dispose`. */
export type DtShim = Awaited<ReturnType<typeof writeDtShim>>;

/**
 * The agent's `dt`, pinned when the runner is made: `check` refuses when a file of it changed since (the run fails to
 * start), `shim` writes a shim for it after that check (none without a `dt`).
 */
export async function pinAgentDt(options: ClaudeCodeOptions): Promise<{ check(): Promise<PinnedDt | undefined>; shim(): Promise<DtShim | undefined> }> {
    const dt = options.dt && pinDt(dtCommandOf(options.dt), options.root);
    const fingerprint = dt && (await fingerprintDt(dt));
    const check = async (): Promise<PinnedDt | undefined> => {
        if (!dt) return undefined;
        const now = pinDt(dtCommandOf(dt), options.root);
        if ((await fingerprintDt(now)) !== fingerprint) throw new Error("A file of the agent's dt changed since the subscriber started: refusing to run it.");
        return now;
    };
    return {
        check,
        async shim() {
            const now = await check();
            return now && writeDtShim(now, options.root);
        },
    };
}

export async function createClaudeCodeRunner(options: ClaudeCodeOptions): Promise<AgentRunner> {
    const command = options.command ?? CLAUDE;
    // the workspace as given and its real path: the agent names files by either
    const roots = [...new Set([options.root, realpathOr(options.root)])];
    const agentDt = await pinAgentDt(options);
    /** The shim of a run, once the command is checked again (a file of it changed: the run fails to start). */
    const shimFor = (): Promise<DtShim | undefined> => agentDt.shim();
    const flags = { ...(options.model !== undefined && { model: options.model }), ...(options.effort !== undefined && { effort: options.effort }) };
    return {
        run(invocation: AgentInvocation): Promise<AgentOutcome> {
            const { signal } = invocation;
            if (signal.aborted) return Promise.resolve({ exitCode: -1, outcome: 'done', summary: '' });
            return (options.deniedPaths?.() ?? Promise.resolve([])).then((deniedPaths) => {
                const args = [...command.args, ...claudeArguments(invocation.allowedTools, invocation.requests, { ...flags, deniedPaths })];
                return shimFor().then((shim) => spawnWithShim(shim, args));
            });
            function spawnWithShim(shim: DtShim | undefined, args: string[]): Promise<AgentOutcome> {
                const ran = spawnAgent(shim && withPathFirst(process.env, shim.dir), args);
                return shim ? ran.finally(() => shim.dispose()) : ran;
            }
            function spawnAgent(env: NodeJS.ProcessEnv | undefined, args: string[]): Promise<AgentOutcome> {
                // cancelled while the shim was written
                if (signal.aborted) return Promise.resolve({ exitCode: -1, outcome: 'done', summary: '' });
                return new Promise<AgentOutcome>((resolve, reject) => {
                    const child = spawn(command.command, args, {
                        cwd: options.root,
                        ...(env && { env }),
                        shell: false,
                        detached: process.platform !== 'win32',
                        stdio: ['pipe', 'pipe', 'pipe'],
                        windowsHide: true,
                    });
                    // what the agent does, as it goes; its result at the end
                    const stream = createStreamReader((event) => {
                        const activity = invocation.onActivity && activityOfEvent(event, roots);
                        if (activity) invocation.onActivity?.(activity);
                    });
                    child.stdout.setEncoding('utf8');
                    child.stdout.on('data', (chunk: string) => stream.push(chunk));
                    // stderr is read so that the agent never blocks on it, and dropped: it may echo the prompt
                    child.stderr.resume();
                    child.stdin.on('error', (e: Error & { code?: string }) => {
                        // the agent exited before reading the whole prompt: its exit code says what happened
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
                        // the agent is gone; anything it left in its group goes with it
                        if (signal.aborted) killTree(child.pid, 'SIGKILL');
                        if (killer) clearTimeout(killer);
                        const result = stream.end();
                        resolve({ exitCode: code ?? -1, ...parseReply(result.structured, result.text, invocation.requests) });
                    });
                    child.stdin.end(invocation.prompt);
                });
            }
        },
    };
}

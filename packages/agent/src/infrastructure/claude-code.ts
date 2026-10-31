// The Claude Code adapter of the subscriber (ADR 0026, S6): one headless run of `claude` per agent run, started with an
// argument array (no shell) in the workspace root, the prompt on stdin, the facilitator's tools as the only ones
// allowed (`--permission-mode dontAsk` refuses everything else without asking), and the result as JSON on stdout. On
// cancel the whole process group is killed. Neither the prompt nor the agent's output is logged.
import { spawn } from 'node:child_process';
import type { AgentInvocation, AgentOutcome, AgentRunner } from '../application/ports.js';
import { parseOutcome } from '../application/prompt.js';

/** The command that starts the agent: the program and the arguments before the adapter's own. */
export interface AgentCommand {
    readonly command: string;
    readonly args: readonly string[];
}

export const CLAUDE: AgentCommand = { command: 'claude', args: [] };

/** Most of the agent's stdout kept (the JSON result is at its end). */
const MAX_OUTPUT = 8 * 1024 * 1024;
/** How long a stopped agent gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** The tool names of permission rules: `Bash(dt fmt:*)` → `Bash`. */
export function toolNames(rules: readonly string[]): string[] {
    return [...new Set(rules.map((r) => /^[A-Za-z][\w-]*/.exec(r)?.[0]).filter((n): n is string => n !== undefined))];
}

/**
 * The arguments of `claude` for a run: print mode, JSON output, no saved session, no MCP server, the user's settings
 * only (never the workspace's `.claude/` project or local settings, which an agent could have written), the built-in tools
 * narrowed to the rules' tools, and the rules allowed without asking (anything else is refused). A rule that looks like
 * an option is refused: the configuration comes from the facilitator, but no value may become a flag.
 */
export function claudeArguments(allowedTools: readonly string[]): string[] {
    for (const rule of allowedTools) {
        if (!rule.trim() || rule.startsWith('-') || /[\0\r\n]/.test(rule)) throw new Error(`Not a tool rule: ${JSON.stringify(rule)}`);
    }
    const tools = toolNames(allowedTools);
    return [
        '--print',
        '--output-format',
        'json',
        '--no-session-persistence',
        '--strict-mcp-config',
        // the user's settings only: the workspace's project and local settings (`.claude/`) are files the agent can write
        '--setting-sources',
        'user',
        '--permission-mode',
        'dontAsk',
        '--tools',
        tools.length ? tools.join(',') : '',
        ...(allowedTools.length ? ['--allowedTools', ...allowedTools] : []),
    ];
}

/** The reply text in `claude --output-format json`'s result (`{"type":"result","result":"…",…}`), else the raw output. */
export function replyOf(stdout: string): string {
    const text = stdout.trim();
    const candidates = [text, text.split('\n').at(-1) ?? ''];
    for (const candidate of candidates) {
        let value: unknown;
        try {
            value = JSON.parse(candidate);
        } catch {
            // not the JSON result (an older or a fake agent printing text): try the next, then the text itself
            continue;
        }
        if (typeof value === 'object' && value !== null && 'result' in value && typeof value.result === 'string') return value.result;
    }
    return text;
}

export interface ClaudeCodeOptions {
    /** The workspace root: the agent's working directory. */
    readonly root: string;
    /** The program (default `claude` on the PATH); the tests start a fake agent. */
    readonly command?: AgentCommand;
}

/** Kills the agent's process group (it was started detached, as the group's leader), or the agent alone on Windows. */
function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
    if (pid === undefined) return;
    try {
        process.kill(process.platform === 'win32' ? pid : -pid, signal);
    } catch (e) {
        // ESRCH: the group is already gone
        if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) throw e;
    }
}

export function createClaudeCodeRunner(options: ClaudeCodeOptions): AgentRunner {
    const command = options.command ?? CLAUDE;
    return {
        run(invocation: AgentInvocation): Promise<AgentOutcome> {
            const { signal } = invocation;
            if (signal.aborted) return Promise.resolve({ exitCode: -1, summary: '' });
            const args = [...command.args, ...claudeArguments(invocation.allowedTools)];
            return new Promise<AgentOutcome>((resolve, reject) => {
                const child = spawn(command.command, args, {
                    cwd: options.root,
                    shell: false,
                    detached: process.platform !== 'win32',
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true,
                });
                let stdout = '';
                let kept = 0;
                child.stdout.setEncoding('utf8');
                child.stdout.on('data', (chunk: string) => {
                    if (kept >= MAX_OUTPUT) return;
                    stdout += chunk;
                    kept += chunk.length;
                });
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
                    const outcome = parseOutcome(replyOf(stdout));
                    resolve({ exitCode: code ?? -1, ...outcome });
                });
                child.stdin.end(invocation.prompt);
            });
        },
    };
}

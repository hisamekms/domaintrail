// Whether Claude Code is usable as the agent (plan modes, "Claude Code is usable"): `claude` starts, `claude
// --version` answers within the timeout, and `claude --help` lists every flag the adapters pass. `dt open` and
// `dt collab` start the agent in process only when it is, and print the reason otherwise.
import { spawn } from 'node:child_process';
import { type AgentCommand, CLAUDE, killTree } from './claude-code.js';

/** The flags (and the permission mode) the adapters need of `claude --help`. */
export const NEEDED_FLAGS = ['--setting-sources', '--strict-mcp-config', '--tools', '--allowedTools', '--input-format', 'dontAsk'] as const;

export type ClaudeUsability = { readonly ok: true; readonly version: string } | { readonly ok: false; readonly reason: string };

/** Runs `command` with `args`: its stdout, or why not (did not start, timed out, exited non-zero). */
function output(command: AgentCommand, args: readonly string[], timeoutMs: number): Promise<{ ok: true; text: string } | { ok: false; why: string }> {
    return new Promise((resolve) => {
        let text = '';
        const child = spawn(command.command, [...command.args, ...args], {
            shell: false,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        });
        const timer = setTimeout(() => {
            killTree(child.pid, 'SIGKILL');
            resolve({ ok: false, why: `did not answer within ${timeoutMs / 1000} s` });
        }, timeoutMs);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            if (text.length < 1_000_000) text += chunk;
        });
        child.once('error', (e: Error & { code?: string }) => {
            clearTimeout(timer);
            resolve({ ok: false, why: e.code === 'ENOENT' ? 'not found on PATH' : e.message });
        });
        child.once('close', (code) => {
            clearTimeout(timer);
            resolve(code === 0 ? { ok: true, text } : { ok: false, why: `exited with ${code ?? 'a signal'}` });
        });
    });
}

/** Whether `claude` (or `command`) can be the agent, with its version, or the reason it cannot, in a few words. */
export async function checkClaudeCode(command: AgentCommand = CLAUDE, timeoutMs = 5_000): Promise<ClaudeUsability> {
    const name = command === CLAUDE ? 'claude' : command.command;
    const version = await output(command, ['--version'], timeoutMs);
    if (!version.ok) return { ok: false, reason: `${name} ${version.why}` };
    const help = await output(command, ['--help'], timeoutMs);
    if (!help.ok) return { ok: false, reason: `${name} --help ${help.why}` };
    const missing = NEEDED_FLAGS.filter((flag) => !help.text.includes(flag));
    if (missing.length) return { ok: false, reason: `${name} does not know ${missing.join(', ')} (update Claude Code)` };
    return { ok: true, version: version.text.trim().split('\n')[0].slice(0, 100) };
}

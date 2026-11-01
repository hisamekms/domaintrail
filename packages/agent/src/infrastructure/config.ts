// The agent's settings in the `session.agent` section of domaintrail.jsonc (ADR 0026; ADR 0027, Project analysis and
// configuration: the agent owns the allowed tools): `allowedTools` and `dt`, their defaults and their validation. The
// settings of its adapters (ADR 0027, Authorization: the agent's tools are enforced by its adapter): the Claude Code
// runner's tools and the `dt` of the shim, whose paths are resolved against the config file's directory. The app
// composes them with the other sections and reports the first error (`fail` throws). That `dt` lies outside the
// workspace reads the disk (symbolic links) and is checked after the pure validation (`checkDtOutsideWorkspace`,
// ./dt-shim.ts).
import * as path from 'node:path';

/**
 * The tools the agent of a session may use unless the facilitator chooses others (ADR 0026), as Claude Code permission
 * rules: reading, editing and writing files, finding them, and `dt fmt` and `dt check`.
 */
export const DEFAULT_AGENT_TOOLS: readonly string[] = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(dt fmt:*)', 'Bash(dt check:*)'];

/** The runtimes the agent's `dt` may be started with, as `[<runtime>, <script>]`. */
export const DT_RUNTIMES = ['node', 'bun', 'deno'] as const;

/** The agent's keys, by where they sit in the file. */
export const AGENT_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = { 'session.agent': ['allowedTools', 'dt'] };

/** The agent's part of the `session.agent` section of the config file. */
export interface AgentConfigFile {
    /** The tools the agent may use, as Claude Code permission rules. Default: `DEFAULT_AGENT_TOOLS`. */
    allowedTools?: string[];
    /**
     * The `dt` the agent and the pipeline run: `["node" | "bun" | "deno", "<script>"]` or `["<dt executable>"]`,
     * paths relative to the config file, outside the workspace. Default: the running `dt` itself.
     */
    dt?: string[];
}

/** The agent's part resolved. */
export interface ResolvedAgentConfig {
    allowedTools: string[];
    /** The command (absolute paths) the agent's `dt` runs, when configured. */
    dt?: string[];
}

const isRuntime = (word: string): boolean =>
    (DT_RUNTIMES as readonly string[]).includes(
        path
            .basename(word)
            .toLowerCase()
            .replace(/\.exe$/, ''),
    );
const hasSeparator = (word: string): boolean => /[\\/]/.test(word);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');

/** Checks `session.agent.allowedTools` and `session.agent.dt` (`agent`: an object). */
export function validateAgentConfig(agent: Record<string, unknown>, fail: (msg: string) => never): void {
    if (agent.allowedTools !== undefined && !isStringList(agent.allowedTools)) fail("'session.agent.allowedTools' must be an array of tool rules");
    if (agent.dt !== undefined) {
        if (!(isStringList(agent.dt) && agent.dt.length > 0 && agent.dt.every((a) => !/[\0\r\n]/.test(a))))
            fail('\'session.agent.dt\' must be a command as a non-empty array of non-empty strings (e.g. ["node", "../clone/dist/dt.js"])');
        const wrong = dtShapeError(agent.dt);
        if (wrong) fail(`'session.agent.dt' ${wrong}`);
    }
}

/** The agent's settings with their defaults (validated); `dt`'s paths resolved against `dir` when given. */
export function resolveAgentConfig(agent: AgentConfigFile = {}, dir?: string): ResolvedAgentConfig {
    return {
        allowedTools: agent.allowedTools ?? [...DEFAULT_AGENT_TOOLS],
        ...(agent.dt && { dt: dir === undefined ? [...agent.dt] : resolveCommand(agent.dt, dir) }),
    };
}

/**
 * The agent's `dt` as it runs: `[<runtime>, <script>]` (a runtime named bare stays for the PATH) or `[<dt
 * executable>]`, every path resolved against the config file's directory.
 */
export function resolveCommand(command: readonly string[], dir: string): string[] {
    return command.map((part, i) => (i === 0 && command.length === 2 && !hasSeparator(part) ? part : path.resolve(dir, part)));
}

/** Why the agent's `dt` has not one of its two shapes, if it has not. */
function dtShapeError(dt: readonly string[]): string | undefined {
    const shape = 'must be ["node" | "bun" | "deno", "<script>"] or ["<dt executable>"], with no other word';
    if (dt.length === 2) {
        if (!isRuntime(dt[0])) return `${shape}: ${dt[0]} is not one of the runtimes`;
        if (dt[1].startsWith('-')) return `${shape}: ${dt[1]} is an option`;
        return undefined;
    }
    if (dt.length === 1) return hasSeparator(dt[0]) && !dt[0].startsWith('-') ? undefined : `${shape}: a dt executable is given by its path`;
    return shape;
}

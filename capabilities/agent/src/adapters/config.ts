// The agent's settings in the `session.agent` section of domaintrail.jsonc (ADR 0026; ADR 0027, Project analysis and
// configuration: the agent owns the allowed tools): `allowedTools` and `dt`, and how Claude Code carries out runs
// (`run`: `warm`, `restartAfter`, `idleTimeout`, `model`, `effort`; plan modes, the warm agent; the run role's keys, grouped so that
// they move together when the section is renamed), their defaults and their validation. The
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

/** Runs of one warm Claude Code process before it is replaced by a fresh one, unless configured. */
export const DEFAULT_RESTART_AFTER = 20;

/** Minutes a warm Claude Code process may go without a run before it is ended (its memory freed), unless configured. */
export const DEFAULT_IDLE_TIMEOUT = 30;

/** The effort levels Claude Code takes (`claude --effort`). */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

/** How Claude Code carries out runs (the run role), the keys of `session.agent.run`. */
export const RUN_CONFIG_KEYS = ['warm', 'restartAfter', 'idleTimeout', 'model', 'effort'] as const;

/** The agent's keys, by where they sit in the file. */
export const AGENT_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
    'session.agent': ['allowedTools', 'dt', 'run'],
    'session.agent.run': [...RUN_CONFIG_KEYS],
};

/** How Claude Code carries out runs (`session.agent.run`), as the file gives it. */
export interface RunConfigFile {
    /** One long-lived Claude Code process across runs (`true`), or one per run (`false`). Default: true. */
    warm?: boolean;
    /** Runs of one warm process before a fresh one replaces it. Default: `DEFAULT_RESTART_AFTER`. */
    restartAfter?: number;
    /** Minutes without a run after which the warm process is ended; `0`: never. Default: `DEFAULT_IDLE_TIMEOUT`. */
    idleTimeout?: number;
    /** `claude --model`; unset: the model of the user's Claude Code settings. */
    model?: string;
    /** `claude --effort`; unset: the effort of the user's Claude Code settings. */
    effort?: AgentEffort;
}

/** How Claude Code carries out runs, resolved. */
export interface RunConfig {
    warm: boolean;
    restartAfter: number;
    /** Minutes; `0`: never. */
    idleTimeout: number;
    model?: string;
    effort?: AgentEffort;
}

/** The agent's part of the `session.agent` section of the config file. */
export interface AgentConfigFile {
    /** How Claude Code carries out runs. */
    run?: RunConfigFile;
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
    run: RunConfig;
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
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasSeparator = (word: string): boolean => /[\\/]/.test(word);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');

/** Checks `session.agent.allowedTools`, `dt` and `run` (`agent`: an object). */
export function validateAgentConfig(agent: Record<string, unknown>, fail: (msg: string) => never): void {
    if (agent.allowedTools !== undefined && !isStringList(agent.allowedTools)) fail("'session.agent.allowedTools' must be an array of tool rules");
    if (agent.dt !== undefined) {
        if (!(isStringList(agent.dt) && agent.dt.length > 0 && agent.dt.every((a) => !/[\0\r\n]/.test(a))))
            fail('\'session.agent.dt\' must be a command as a non-empty array of non-empty strings (e.g. ["node", "../clone/dist/dt.js"])');
        const wrong = dtShapeError(agent.dt);
        if (wrong) fail(`'session.agent.dt' ${wrong}`);
    }
    if (agent.run !== undefined) validateRunConfig(agent.run, fail);
}

/** Checks `session.agent.run`. */
function validateRunConfig(run: unknown, fail: (msg: string) => never): void {
    const at = 'session.agent.run';
    if (!isRecord(run)) return fail(`'${at}' must be an object`);
    const r = run;
    for (const key of Object.keys(r)) if (!(RUN_CONFIG_KEYS as readonly string[]).includes(key)) fail(`unknown key '${at}.${key}'`);
    if (r.warm !== undefined && typeof r.warm !== 'boolean') fail(`'${at}.warm' must be true or false`);
    if (r.restartAfter !== undefined && !(typeof r.restartAfter === 'number' && Number.isInteger(r.restartAfter) && r.restartAfter >= 1))
        fail(`'${at}.restartAfter' must be a positive integer (runs)`);
    if (r.idleTimeout !== undefined && !(typeof r.idleTimeout === 'number' && Number.isFinite(r.idleTimeout) && r.idleTimeout >= 0))
        fail(`'${at}.idleTimeout' must be a number of minutes, 0 or more (0: never)`);
    if (r.model !== undefined && !(typeof r.model === 'string' && /^[A-Za-z0-9][\w.:@[\]/-]*$/.test(r.model)))
        fail(`'${at}.model' must be a Claude Code model name or alias (e.g. "sonnet")`);
    if (r.effort !== undefined && !(AGENT_EFFORTS as readonly unknown[]).includes(r.effort))
        fail(`'${at}.effort' must be one of ${AGENT_EFFORTS.map((e) => `"${e}"`).join(', ')}`);
}

/** The agent's settings with their defaults (validated); `dt`'s paths resolved against `dir` when given. */
export function resolveAgentConfig(agent: AgentConfigFile = {}, dir?: string): ResolvedAgentConfig {
    return {
        allowedTools: agent.allowedTools ?? [...DEFAULT_AGENT_TOOLS],
        ...(agent.dt && { dt: dir === undefined ? [...agent.dt] : resolveCommand(agent.dt, dir) }),
        run: resolveRunConfig(agent.run),
    };
}

/**
 * `session.agent.run` with its defaults: warm, replaced after `DEFAULT_RESTART_AFTER` runs, ended after
 * `DEFAULT_IDLE_TIMEOUT` minutes without a run, the user's model and effort.
 */
export function resolveRunConfig(run: RunConfigFile = {}): RunConfig {
    return {
        warm: run.warm ?? true,
        restartAfter: run.restartAfter ?? DEFAULT_RESTART_AFTER,
        idleTimeout: run.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
        ...(run.model !== undefined && { model: run.model }),
        ...(run.effort !== undefined && { effort: run.effort }),
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

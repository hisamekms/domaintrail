// The agent's settings in the `agent` section of domaintrail.jsonc (ADR 0026; ADR 0027, Project analysis and
// configuration: the agent owns the allowed tools; ADR 0030: one section for what `dt agent` reads, a part per role):
// `agent.run` (the runner: `allowedTools`, `dt`, and how Claude Code carries out the runs, `warm`, `restartAfter`,
// `idleTimeout`, `model`, `effort`), `agent.answer` (the read-only answerer: `model`, `effort`, `warm`, `restartAfter`,
// `idleTimeout`, `timeout`), `agent.triage` (the light model of the triage's stage 3: `model`, `warm`) and
// `agent.extract` (the extractor of knowledge, ADR 0031: `model`, `effort`, `timeout`; its model and effort are the
// answerer's unless given, the stronger model the ADR measures the cost of; and `gateModel`, the light model that
// decides first whether an extraction is worth running, the triage's unless given, else `haiku`). A role's
// unset model or effort falls back to the user's Claude Code settings, never to another role's. Their defaults and
// their validation; the settings of its adapters (ADR 0027, Authorization: the agent's tools are enforced by its
// adapter): the Claude Code runner's tools and the `dt` of the shim, whose paths are resolved against the config file's
// directory. The app composes them with the other sections (and checks the unknown keys, `agent.run` holding
// Collaboration's `maxPreviousRunDiff` too) and reports the first error (`fail` throws). That `dt` lies outside the
// workspace reads the disk (symbolic links) and is checked after the pure validation (`checkDtOutsideWorkspace`,
// ./dt-shim.ts).
//
// What the AI may read outside the workspace, read-only (`agent.read.paths` for both roles, `agent.answer.read.paths`
// and `agent.run.read.paths` added for one): directories or files, absolute, `~/…` or relative to the config file; a
// path inside the workspace (or holding it) is an error (`checkReadPaths`, ./read-paths.ts, after the pure validation).
import { homedir } from 'node:os';
import * as path from 'node:path';

/**
 * The tools the agent of a session may use unless the facilitator chooses others (ADR 0026), as Claude Code permission
 * rules: reading, editing and writing files, finding them, `dt fmt` and `dt check`, and `dt guide` (it only prints).
 */
export const DEFAULT_AGENT_TOOLS: readonly string[] = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(dt fmt:*)', 'Bash(dt check:*)', 'Bash(dt guide:*)'];

/** The runtimes the agent's `dt` may be started with, as `[<runtime>, <script>]`. */
export const DT_RUNTIMES = ['node', 'bun', 'deno'] as const;

/** Runs of one warm Claude Code process before it is replaced by a fresh one, unless configured. */
export const DEFAULT_RESTART_AFTER = 20;

/** Minutes a warm Claude Code process may go without a run before it is ended (its memory freed), unless configured. */
export const DEFAULT_IDLE_TIMEOUT = 30;

/** Answers of one warm answerer process before it is replaced by a fresh one, unless configured. */
export const DEFAULT_ANSWER_RESTART_AFTER = 50;

/** The most seconds an answer may take, unless configured. */
export const DEFAULT_ANSWER_TIMEOUT = 120;

/** The model of the triage's stage 3 (a light one is the point of the stage), unless configured. */
export const DEFAULT_TRIAGE_MODEL = 'haiku';

/** The most seconds an extraction of knowledge may take, unless configured. */
export const DEFAULT_EXTRACT_TIMEOUT = 180;

/** The effort levels Claude Code takes (`claude --effort`). */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

/** How Claude Code carries out runs (the run role), its keys of `agent.run` besides `allowedTools` and `dt`. */
export const RUN_CONFIG_KEYS = ['warm', 'restartAfter', 'idleTimeout', 'model', 'effort'] as const;

/** The keys of `agent.answer`. */
export const ANSWER_CONFIG_KEYS = ['model', 'effort', 'warm', 'restartAfter', 'idleTimeout', 'timeout'] as const;

/** The keys of `agent.triage`. */
export const TRIAGE_CONFIG_KEYS = ['model', 'warm'] as const;

/** The keys of `agent.extract`. */
export const EXTRACT_CONFIG_KEYS = ['model', 'effort', 'timeout', 'gateModel'] as const;

/** The keys of `agent.read`, `agent.run.read` and `agent.answer.read`. */
export const READ_CONFIG_KEYS = ['paths'] as const;

/** The agent's keys, by where they sit in the file. */
export const AGENT_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
    agent: ['run', 'answer', 'triage', 'extract', 'read'],
    'agent.read': [...READ_CONFIG_KEYS],
    'agent.run': ['allowedTools', 'dt', 'read', ...RUN_CONFIG_KEYS],
    'agent.run.read': [...READ_CONFIG_KEYS],
    'agent.answer': [...ANSWER_CONFIG_KEYS, 'read'],
    'agent.answer.read': [...READ_CONFIG_KEYS],
    'agent.triage': [...TRIAGE_CONFIG_KEYS],
    'agent.extract': [...EXTRACT_CONFIG_KEYS],
};

/** What a role may read outside the workspace (`agent.read`, `agent.<role>.read`), as the file gives it. */
export interface ReadConfigFile {
    /**
     * Directories or files outside the workspace the AI may read (never write): absolute, `~/…`, or relative to the
     * config file. In a git work tree, the files git does not ignore there; elsewhere every file; never `.git` nor
     * `.domaintrail`.
     */
    paths?: string[];
}

/** What each role may read outside the workspace: absolute paths, as configured (not resolved through links). */
export interface ReadPaths {
    answer: string[];
    run: string[];
}

/** How Claude Code carries out runs (`agent.run`), as the file gives it. */
export interface RunConfigFile {
    /** The tools the agent may use, as Claude Code permission rules. Default: `DEFAULT_AGENT_TOOLS`. */
    allowedTools?: string[];
    /**
     * The `dt` the agent and the pipeline run: `["node" | "bun" | "deno", "<script>"]` or `["<dt executable>"]`,
     * paths relative to the config file, outside the workspace. Default: the running `dt` itself.
     */
    dt?: string[];
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
    /** What the runner may read outside the workspace besides `agent.read` (never write). */
    read?: ReadConfigFile;
}

/** How Claude Code carries out runs, resolved (the process's settings). */
export interface RunConfig {
    warm: boolean;
    restartAfter: number;
    /** Minutes; `0`: never. */
    idleTimeout: number;
    model?: string;
    effort?: AgentEffort;
}

/** `agent.run` resolved: the runner's tools and `dt`, and its process's settings. */
export interface ResolvedRunConfig extends RunConfig {
    allowedTools: string[];
    /** The command (absolute paths) the agent's `dt` runs, when configured. */
    dt?: string[];
}

/** How the read-only answerer runs (`agent.answer`), as the file gives it. Its tools are not configurable. */
export interface AnswerConfigFile {
    /** `claude --model`; unset: the model of the user's Claude Code settings (never the runs'). */
    model?: string;
    /** `claude --effort`; unset: the effort of the user's Claude Code settings. */
    effort?: AgentEffort;
    /** One long-lived answerer process (`true`), or one per answer (`false`). Default: true. */
    warm?: boolean;
    /** Answers of one warm process before a fresh one replaces it. Default: `DEFAULT_ANSWER_RESTART_AFTER`. */
    restartAfter?: number;
    /** Minutes without an answer after which the warm process is ended; `0`: never. Default: `DEFAULT_IDLE_TIMEOUT`. */
    idleTimeout?: number;
    /** The most seconds an answer may take. Default: `DEFAULT_ANSWER_TIMEOUT`. */
    timeout?: number;
    /** What the answerer may read outside the workspace besides `agent.read`. */
    read?: ReadConfigFile;
}

/** `agent.answer` resolved. */
export interface AnswerConfig {
    warm: boolean;
    restartAfter: number;
    /** Minutes; `0`: never. */
    idleTimeout: number;
    /** Seconds. */
    timeout: number;
    model?: string;
    effort?: AgentEffort;
}

/** The triage's stage 3 (`agent.triage`), as the file gives it. */
export interface TriageConfigFile {
    /** `claude --model` of the light model. Default: `DEFAULT_TRIAGE_MODEL`. */
    model?: string;
    /** One long-lived triage process (`true`), or a fresh `claude -p` per triage (`false`). Default: false. */
    warm?: boolean;
}

/** `agent.triage` resolved. */
export interface TriageConfig {
    model: string;
    warm: boolean;
}

/** The extractor of knowledge (`agent.extract`), as the file gives it. */
export interface ExtractConfigFile {
    /** `claude --model`. Default: the answerer's (`agent.answer.model`), else the user's Claude Code setting. */
    model?: string;
    /** `claude --effort`. Default: the answerer's, else the user's. */
    effort?: AgentEffort;
    /** The most seconds an extraction may take. Default: `DEFAULT_EXTRACT_TIMEOUT`. */
    timeout?: number;
    /**
     * `claude --model` of the light model that decides first whether there is anything to extract (ADR 0031, section
     * 3). Default: the triage's (`agent.triage.model`), else `DEFAULT_TRIAGE_MODEL`.
     */
    gateModel?: string;
}

/** `agent.extract` resolved: the model and effort fall back to the answerer's, the gate's model to the triage's. */
export interface ExtractConfig {
    /** Seconds. */
    timeout: number;
    model?: string;
    effort?: AgentEffort;
    gateModel: string;
}

/** The agent's part of the `agent` section of the config file (the app's: `agent.port`). */
export interface AgentConfigFile {
    /** The runner. */
    run?: RunConfigFile;
    /** The read-only answerer. */
    answer?: AnswerConfigFile;
    /** The triage's stage 3. */
    triage?: TriageConfigFile;
    /** The extractor of knowledge. */
    extract?: ExtractConfigFile;
    /** What both roles may read outside the workspace. */
    read?: ReadConfigFile;
}

/** The agent's part resolved. */
export interface ResolvedAgentConfig {
    run: ResolvedRunConfig;
    answer: AnswerConfig;
    triage: TriageConfig;
    extract: ExtractConfig;
    /** What each role may read outside the workspace (`agent.read.paths` and its own). */
    read: ReadPaths;
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

/**
 * Checks `agent.run`, `agent.answer` and `agent.triage` (`agent`: an object), their unknown keys excepted (the app's,
 * which knows every owner's keys).
 */
export function validateAgentConfig(agent: Record<string, unknown>, fail: (msg: string) => never): void {
    if (agent.run !== undefined) validateRunConfig(agent.run, fail);
    if (agent.answer !== undefined) validateAnswerConfig(agent.answer, 'agent.answer', fail);
    if (agent.triage !== undefined) validateTriageConfig(agent.triage, 'agent.triage', fail);
    if (agent.extract !== undefined) validateExtractConfig(agent.extract, 'agent.extract', fail);
    if (agent.read !== undefined) validateReadConfig(agent.read, 'agent.read', fail);
}

/** Checks a `read` part (`at`: where it sits), its unknown keys excepted: `paths`, an array of paths. */
export function validateReadConfig(read: unknown, at: string, fail: (msg: string) => never): void {
    if (!isRecord(read)) return fail(`'${at}' must be an object`);
    if (read.paths !== undefined && !(isStringList(read.paths) && read.paths.every((p) => !/[\0\r\n]/.test(p))))
        fail(`'${at}.paths' must be an array of paths (directories or files outside the workspace: absolute, ~/…, or relative to the config file)`);
}

const isModel = (v: unknown): boolean => typeof v === 'string' && /^[A-Za-z0-9][\w.:@[\]/-]*$/.test(v);
const isMinutes = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isPositiveInteger = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 1;

/** The checks a role's process shares: `warm`, `restartAfter`, `idleTimeout`, `model`, `effort` (`r`: an object). */
function validateProcessConfig(at: string, r: Record<string, unknown>, jobs: string, fail: (msg: string) => never): void {
    if (r.warm !== undefined && typeof r.warm !== 'boolean') fail(`'${at}.warm' must be true or false`);
    if (r.restartAfter !== undefined && !isPositiveInteger(r.restartAfter)) fail(`'${at}.restartAfter' must be a positive integer (${jobs})`);
    if (r.idleTimeout !== undefined && !isMinutes(r.idleTimeout)) fail(`'${at}.idleTimeout' must be a number of minutes, 0 or more (0: never)`);
    if (r.model !== undefined && !isModel(r.model)) fail(`'${at}.model' must be a Claude Code model name or alias (e.g. "sonnet")`);
    if (r.effort !== undefined && !(AGENT_EFFORTS as readonly unknown[]).includes(r.effort))
        fail(`'${at}.effort' must be one of ${AGENT_EFFORTS.map((e) => `"${e}"`).join(', ')}`);
}

/** Checks `agent.run`. */
function validateRunConfig(run: unknown, fail: (msg: string) => never): void {
    const at = 'agent.run';
    if (!isRecord(run)) return fail(`'${at}' must be an object`);
    if (run.allowedTools !== undefined && !isStringList(run.allowedTools)) fail(`'${at}.allowedTools' must be an array of tool rules`);
    if (run.dt !== undefined) {
        if (!(isStringList(run.dt) && run.dt.length > 0 && run.dt.every((a) => !/[\0\r\n]/.test(a))))
            fail(`'${at}.dt' must be a command as a non-empty array of non-empty strings (e.g. ["node", "../clone/dist/dt.js"])`);
        const wrong = dtShapeError(run.dt);
        if (wrong) fail(`'${at}.dt' ${wrong}`);
    }
    validateProcessConfig(at, run, 'runs', fail);
    if (run.read !== undefined) validateReadConfig(run.read, `${at}.read`, fail);
}

/** Checks `agent.answer` (`at`: where it sits, for the messages), its unknown keys excepted. */
export function validateAnswerConfig(answer: unknown, at: string, fail: (msg: string) => never): void {
    if (!isRecord(answer)) return fail(`'${at}' must be an object`);
    validateProcessConfig(at, answer, 'answers', fail);
    if (answer.timeout !== undefined && !(typeof answer.timeout === 'number' && Number.isFinite(answer.timeout) && answer.timeout > 0))
        fail(`'${at}.timeout' must be a positive number of seconds`);
    if (answer.read !== undefined) validateReadConfig(answer.read, `${at}.read`, fail);
}

/** Checks `agent.triage` (`at`: where it sits, for the messages), its unknown keys excepted. */
export function validateTriageConfig(triage: unknown, at: string, fail: (msg: string) => never): void {
    if (!isRecord(triage)) return fail(`'${at}' must be an object`);
    if (triage.model !== undefined && !isModel(triage.model)) fail(`'${at}.model' must be a Claude Code model name or alias (e.g. "haiku")`);
    if (triage.warm !== undefined && typeof triage.warm !== 'boolean') fail(`'${at}.warm' must be true or false`);
}

/** Checks `agent.extract` (`at`: where it sits, for the messages), its unknown keys excepted. */
export function validateExtractConfig(extract: unknown, at: string, fail: (msg: string) => never): void {
    if (!isRecord(extract)) return fail(`'${at}' must be an object`);
    if (extract.model !== undefined && !isModel(extract.model)) fail(`'${at}.model' must be a Claude Code model name or alias (e.g. "sonnet")`);
    if (extract.effort !== undefined && !(AGENT_EFFORTS as readonly unknown[]).includes(extract.effort))
        fail(`'${at}.effort' must be one of ${AGENT_EFFORTS.map((e) => `"${e}"`).join(', ')}`);
    if (extract.timeout !== undefined && !(typeof extract.timeout === 'number' && Number.isFinite(extract.timeout) && extract.timeout > 0))
        fail(`'${at}.timeout' must be a positive number of seconds`);
    if (extract.gateModel !== undefined && !isModel(extract.gateModel)) fail(`'${at}.gateModel' must be a Claude Code model name or alias (e.g. "haiku")`);
}

/** The agent's settings with their defaults (validated); `dt`'s paths resolved against `dir` when given. */
export function resolveAgentConfig(agent: AgentConfigFile = {}, dir?: string): ResolvedAgentConfig {
    const run = agent.run ?? {};
    return {
        run: {
            allowedTools: run.allowedTools ?? [...DEFAULT_AGENT_TOOLS],
            ...(run.dt && { dt: dir === undefined ? [...run.dt] : resolveCommand(run.dt, dir) }),
            ...resolveRunConfig(run),
        },
        answer: resolveAnswerConfig(agent.answer),
        triage: resolveTriageConfig(agent.triage),
        extract: resolveExtractConfig(agent.extract, agent.answer, agent.triage),
        read: resolveReadPaths(agent, dir),
    };
}

/**
 * A path of a `read` part as written: `~` and `~/…` from the home directory, an absolute path as it is, else relative
 * to `dir` (the config file's directory; none: the working directory).
 */
export function resolveReadPath(p: string, dir?: string, home: string = homedir()): string {
    if (p === '~') return home;
    if (p.startsWith('~/') || p.startsWith(`~${path.sep}`)) return path.join(home, p.slice(2));
    return path.resolve(dir ?? '.', p);
}

/** What each role reads outside the workspace: `agent.read.paths`, then the role's own, resolved, each once. */
export function resolveReadPaths(agent: AgentConfigFile = {}, dir?: string): ReadPaths {
    const common = agent.read?.paths ?? [];
    const of = (own: readonly string[] = []): string[] => [...new Set([...common, ...own].map((p) => resolveReadPath(p, dir)))];
    return { answer: of(agent.answer?.read?.paths), run: of(agent.run?.read?.paths) };
}

/**
 * How Claude Code carries out runs, from `agent.run`, with its defaults: warm, replaced after `DEFAULT_RESTART_AFTER`
 * runs, ended after `DEFAULT_IDLE_TIMEOUT` minutes without a run, the user's model and effort.
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
 * `agent.answer` with its defaults: warm, replaced after `DEFAULT_ANSWER_RESTART_AFTER` answers, ended after
 * `DEFAULT_IDLE_TIMEOUT` idle minutes, `DEFAULT_ANSWER_TIMEOUT` seconds an answer, the user's model and effort.
 */
export function resolveAnswerConfig(answer: AnswerConfigFile = {}): AnswerConfig {
    return {
        warm: answer.warm ?? true,
        restartAfter: answer.restartAfter ?? DEFAULT_ANSWER_RESTART_AFTER,
        idleTimeout: answer.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
        timeout: answer.timeout ?? DEFAULT_ANSWER_TIMEOUT,
        ...(answer.model !== undefined && { model: answer.model }),
        ...(answer.effort !== undefined && { effort: answer.effort }),
    };
}

/**
 * `agent.extract` with its defaults: `DEFAULT_EXTRACT_TIMEOUT` seconds, the answerer's model and effort (else the
 * user's), the triage's model for the gate (else `DEFAULT_TRIAGE_MODEL`).
 */
export function resolveExtractConfig(extract: ExtractConfigFile = {}, answer: AnswerConfigFile = {}, triage: TriageConfigFile = {}): ExtractConfig {
    const model = extract.model ?? answer.model;
    const effort = extract.effort ?? answer.effort;
    return {
        timeout: extract.timeout ?? DEFAULT_EXTRACT_TIMEOUT,
        ...(model !== undefined && { model }),
        ...(effort !== undefined && { effort }),
        gateModel: extract.gateModel ?? triage.model ?? DEFAULT_TRIAGE_MODEL,
    };
}

/** `agent.triage` with its defaults: `DEFAULT_TRIAGE_MODEL`, a fresh process per triage. */
export function resolveTriageConfig(triage: TriageConfigFile = {}): TriageConfig {
    return { model: triage.model ?? DEFAULT_TRIAGE_MODEL, warm: triage.warm ?? false };
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

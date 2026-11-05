// The agent's `dt` (ADR 0026): a private directory outside the workspace holding an executable `dt` that runs the
// configured `dt` (by default this very CLI: its runtime and its entry), put first on the agent's PATH, so that the
// prompt and the allowed tools stay `dt fmt` / `dt check` / `dt guide` whatever is installed on the facilitator's machine.
//
// The agent can write in the workspace while it runs, so the rules are positive and few:
// - what runs has one of two shapes: `[<node|bun|deno>, <script>]` or `[<dt executable>]`, pinned once when the
//   subscriber starts to absolute real paths (the runtime found on the PATH), the script or executable outside the
//   workspace; both are fingerprinted then and checked again before each run (`pinDt`, `fingerprintDt`);
// - the agent's `dt` takes `fmt` or `check` and, after it, `.dt` / `.dtes` files of the workspace only, or `guide`
//   with a topic name or `--all` (it only prints): no other option of the agent ever reaches `dt`, and
//   `-r <workspace>` is always the launcher's own;
// - `dt` runs with a private working directory (the shim's), never the workspace: no runtime picks a config of it up;
// - the shim's words are never parsed by a shell: `dt` (or `dt.cmd`) only starts this runtime on a launcher holding
//   the command as JSON, which spawns it with `shell: false`.
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DT_RUNTIMES, resolveCommand } from './config.js';
import type { DtCommand } from './dt-tools.js';

/** A word quoted for `sh`: inside single quotes, a quote closed, escaped and reopened. */
const shQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;
/** Characters `cmd.exe` interprets even in double quotes, or that end them. */
const CMD_SPECIAL = /["%!^&|<>\r\n\0]/;

const checkWord = (w: string): void => {
    if (w === '' || /[\0\r\n]/.test(w)) throw new Error(`Not a command word: ${JSON.stringify(w)}`);
};

/** A path as it really is: symbolic links followed up to its deepest existing directory, the rest as written. */
const real = (p: string): string => {
    const abs = path.resolve(p);
    try {
        return realpathSync.native(abs);
    } catch {
        const parent = path.dirname(abs);
        return parent === abs ? abs : path.join(real(parent), path.basename(abs));
    }
};

/** Whether `p` is `root` or inside it, both taken as they really are, by path segments (`<root>/..evil` is inside). */
export function inside(root: string, p: string): boolean {
    const rel = path.relative(real(root), real(p));
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Refuses a configured `agent.run.dt` (as written, `dir` the config file's directory) that runs a file of the
 * workspace (that directory), symbolic links followed and compared by path segments: the agent writes there during a
 * run. The configuration's check (the app runs it after validating the section); the subscriber checks again when it
 * starts, with the runtime found on the PATH (`pinDt`).
 */
export function checkDtOutsideWorkspace(dt: readonly string[] | undefined, dir: string, fail: (msg: string) => never): void {
    if (!dt) return;
    const within = resolveCommand(dt, dir).filter((p) => path.isAbsolute(p) && inside(dir, p));
    if (within.length)
        fail(
            `'agent.run.dt' may not run anything inside the workspace (${within.join(', ')}): the agent can write there during a run. Use a dt outside the workspace (e.g. a clone next to it).`,
        );
}

const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();

/** A program found on the PATH as the OS would (with PATHEXT on Windows), or undefined. */
export function findProgram(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
    if (/[\\/]/.test(command)) return isFile(command) ? path.resolve(command) : undefined;
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
    const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
    for (const dir of (key ? env[key] : '')?.split(path.delimiter) ?? []) {
        if (!dir) continue;
        for (const ext of exts) {
            const candidate = path.join(dir, command + ext);
            if (isFile(candidate)) return candidate;
        }
    }
    return undefined;
}

/** The runtime a program is (`node`, `bun`, `deno`, also as `node.exe`), or undefined. */
export const runtimeOf = (program: string): (typeof DT_RUNTIMES)[number] | undefined =>
    DT_RUNTIMES.find(
        (r) =>
            path
                .basename(program)
                .toLowerCase()
                .replace(/\.exe$/, '') === r,
    );

/** The `dt` that runs: absolute real paths only, exactly what was checked and fingerprinted. */
export interface PinnedDt {
    /** `node`, `bun` or `deno`, found on the PATH; absent for a `dt` executable. */
    readonly runtime?: string;
    /** The script the runtime runs, or the `dt` executable. */
    readonly script: string;
}

/** The pinned `dt` as a command: `[runtime, script]` or `[script]`. */
export const dtCommandOf = (dt: PinnedDt): DtCommand => (dt.runtime ? { command: dt.runtime, args: [dt.script] } : { command: dt.script, args: [] });

/**
 * Pins the agent's `dt` for a workspace: `[<node|bun|deno>, <script>]` (the runtime found on the PATH) or
 * `[<dt executable>]`, as absolute real paths, the script or executable an existing file outside the workspace (symbolic
 * links followed). Anything else is refused with the reason.
 */
export function pinDt(dt: DtCommand, root: string, env: NodeJS.ProcessEnv = process.env): PinnedDt {
    const words = [dt.command, ...dt.args];
    words.forEach(checkWord);
    const shape = 'The agent\'s dt must be ["node" | "bun" | "deno", "<script>"] or ["<dt executable>"]';
    if (words.length > 2) throw new Error(`${shape}, with no other word: ${JSON.stringify(words)}`);
    const [first, second] = words;
    let runtime: string | undefined;
    let script: string;
    if (second !== undefined) {
        if (!runtimeOf(first)) throw new Error(`${shape}: ${first} is not one of the runtimes.`);
        const found = findProgram(first, env);
        if (!found) throw new Error(`The agent's dt cannot run: ${first} is not found.`);
        runtime = real(found);
        if (!runtimeOf(runtime)) throw new Error(`${shape}: ${first} is ${runtime}, not one of the runtimes.`);
        script = second;
    } else {
        if (!/[\\/]/.test(first)) throw new Error(`${shape}: a dt executable is given by its path, not ${first}.`);
        script = first;
    }
    if (!path.isAbsolute(script)) throw new Error(`The agent's dt must name its script by an absolute path: ${script}`);
    script = real(script);
    if (!isFile(script)) throw new Error(`The agent's dt cannot run: ${script} is not a file.`);
    for (const p of [script, ...(runtime ? [runtime] : [])])
        if (inside(root, p)) throw new Error(`The agent's dt may not run anything inside the workspace (${p}): the agent can write there.`);
    return { ...(runtime && { runtime }), script };
}

/** A fingerprint of what the pinned `dt` runs (SHA-256 of the runtime and of the script), to tell that none changed since. */
export async function fingerprintDt(dt: PinnedDt): Promise<string> {
    const hash = createHash('sha256');
    for (const file of [dt.runtime ?? '', dt.script]) {
        hash.update(file).update('\0');
        if (file && isFile(file)) hash.update(await readFile(file));
        hash.update('\0');
    }
    return hash.digest('hex');
}

/**
 * What the agent may ask of its `dt`: `fmt` or `check`, then `.dt` / `.dtes` files of the workspace; or `guide` alone,
 * with one topic or rule name, or with `--all`. Nothing else.
 */
export const AGENT_SUBCOMMANDS = ['fmt', 'check', 'guide'] as const;

/** What the agent is told when its `dt` refuses (the launcher says the same). */
const AGENT_DT_USAGE =
    'Use `dt fmt` or `dt check`, optionally followed by .dt / .dtes files of the workspace, or `dt guide [<topic> | --all]`; no other options.';

/** A name `dt guide` takes: a topic (`storming-practice`) or a rule code (`M010`); never an option. */
const GUIDE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Whether the arguments after `guide` are what it may take: none, one name, or `--all`. */
const guideArguments = (rest: readonly string[]): boolean => rest.length === 0 || (rest.length === 1 && (rest[0] === '--all' || GUIDE_NAME.test(rest[0])));

/**
 * The arguments `dt` gets for what the agent typed in `cwd`: `-r <root>`, the subcommand, and the files made absolute
 * (for `guide`, its topic or `--all` as given); or why it is refused (said to the agent). Pure: the launcher runs the
 * same rule.
 */
export function agentDtArguments(given: readonly string[], cwd: string, root: string): { ok: true; args: string[] } | { ok: false; error: string } {
    const [sub, ...files] = given;
    const usage = AGENT_DT_USAGE;
    if (!sub || !(AGENT_SUBCOMMANDS as readonly string[]).includes(sub)) return { ok: false, error: `dt: only fmt, check and guide are available. ${usage}` };
    if (sub === 'guide') {
        if (!guideArguments(files)) return { ok: false, error: `dt: guide takes one topic or --all (${files.join(' ')}). ${usage}` };
        return { ok: true, args: ['-r', root, sub, ...files] };
    }
    const out: string[] = [];
    for (const f of files) {
        if (f.startsWith('-')) return { ok: false, error: `dt: options are not accepted (${f}). ${usage}` };
        if (!/\.dt(es)?$/.test(f)) return { ok: false, error: `dt: not a .dt or .dtes file (${f}). ${usage}` };
        const abs = path.resolve(cwd, f);
        if (!inside(root, abs)) return { ok: false, error: `dt: ${f} is not in the workspace. ${usage}` };
        out.push(abs);
    }
    return { ok: true, args: ['-r', root, sub, ...out] };
}

/**
 * The launcher: checks the agent's arguments (`agentDtArguments`, inlined: the launcher stands alone), then runs the
 * pinned `dt` on the workspace with the shim's directory as its working directory, without a shell, and exits as it did.
 */
export function launcherScript(dt: PinnedDt, root: string, cwd: string): string {
    const command = dtCommandOf(dt);
    [command.command, ...command.args, root, cwd].forEach(checkWord);
    return [
        "import { spawnSync } from 'node:child_process';",
        "import { realpathSync } from 'node:fs';",
        "import { dirname, basename, join, relative, resolve, isAbsolute, sep } from 'node:path';",
        `const [command, ...pinned] = ${JSON.stringify([command.command, ...command.args])};`,
        `const root = ${JSON.stringify(real(root))};`,
        'const real = (p) => { try { return realpathSync.native(p); } catch { const d = dirname(p); return d === p ? p : join(real(d), basename(p)); } };',
        "const inside = (p) => { const r = relative(root, real(p)); return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)); };",
        `const usage = ${JSON.stringify(AGENT_DT_USAGE)};`,
        'const refuse = (m) => { console.error(`dt: ${m} ${usage}`); process.exit(2); };',
        'const [sub, ...files] = process.argv.slice(2);',
        "if (sub !== 'fmt' && sub !== 'check' && sub !== 'guide') refuse('only fmt, check and guide are available.');",
        `const guideName = ${GUIDE_NAME.toString()};`,
        "const guideOk = files.length === 0 || (files.length === 1 && (files[0] === '--all' || guideName.test(files[0])));",
        "if (sub === 'guide' && !guideOk) refuse(`guide takes one topic or --all (${files.join(' ')}).`);",
        "const abs = sub === 'guide' ? files : files.map((f) => {",
        "    if (f.startsWith('-')) refuse(`options are not accepted (${f}).`);",
        '    if (!/\\.dt(es)?$/.test(f)) refuse(`not a .dt or .dtes file (${f}).`);',
        '    const a = resolve(process.cwd(), f);',
        '    if (!inside(a)) refuse(`${f} is not in the workspace.`);',
        '    return a;',
        '});',
        `const r = spawnSync(command, [...pinned, '-r', root, sub, ...abs], { cwd: ${JSON.stringify(cwd)}, stdio: 'inherit', shell: false, windowsHide: true });`,
        'if (r.error) { console.error(`dt could not start: ${r.error.message}`); process.exit(127); }',
        'process.exit(r.status ?? 1);',
        '',
    ].join('\n');
}

/**
 * The `dt` that starts `runtime` on `launcher`: a `sh` script, or a `.cmd` file on Windows (whose two paths may hold
 * none of the characters `cmd.exe` interprets; the configured words are in the launcher, never here).
 */
export function dtShim(runtime: string, launcher: string, platform: NodeJS.Platform = process.platform): { readonly file: string; readonly text: string } {
    [runtime, launcher].forEach(checkWord);
    if (platform === 'win32') {
        for (const w of [runtime, launcher]) if (CMD_SPECIAL.test(w)) throw new Error(`A path the dt shim cannot hold on Windows: ${JSON.stringify(w)}`);
        return { file: 'dt.cmd', text: `@echo off\r\n"${runtime}" "${launcher}" %*\r\n` };
    }
    return { file: 'dt', text: `#!/bin/sh\nexec ${shQuote(runtime)} ${shQuote(launcher)} "$@"\n` };
}

/** The environment with `dir` first on its PATH (the key keeps its case, `Path` on Windows). */
export function withPathFirst(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const rest = env[key];
    return { ...env, [key]: rest ? `${dir}${path.delimiter}${rest}` : dir };
}

/** A new private directory (0700) outside `root`; `dispose` removes it. */
export async function privateDir(root: string, prefix = 'domaintrail-dt-'): Promise<{ readonly dir: string; dispose(): Promise<void> }> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
    if (inside(root, dir)) {
        await dispose();
        throw new Error(`The temporary directory is inside the workspace (${dir}): refusing to run the agent's dt there.`);
    }
    await chmod(dir, 0o700);
    return { dir, dispose };
}

/**
 * Writes the shim and its launcher in a new private directory outside `root` (also `dt`'s working directory);
 * `dispose` removes it. `runtime` runs the launcher (default: this process's runtime).
 */
export async function writeDtShim(dt: PinnedDt, root: string, runtime: string = process.execPath): Promise<{ readonly dir: string; dispose(): Promise<void> }> {
    const shimDir = await privateDir(root);
    try {
        const launcher = path.join(shimDir.dir, 'launcher.mjs');
        await writeFile(launcher, launcherScript(dt, root, shimDir.dir), { mode: 0o600 });
        const shim = dtShim(runtime, launcher);
        const file = path.join(shimDir.dir, shim.file);
        await writeFile(file, shim.text, { mode: 0o700 });
        await chmod(file, 0o700);
    } catch (e) {
        await shimDir.dispose();
        throw e;
    }
    return shimDir;
}

/**
 * The launcher of `dt mcp` for the agent's Claude Code (ADR 0031: the answerer and the runner read knowledge through
 * the same tools as `dt mcp`): a `sh` script (a `.cmd` file on Windows) that changes to `cwd`, a private directory
 * outside the workspace, then runs the pinned `dt` with `-r <root>` (and `-c <config>`) and `mcp`. Claude Code starts
 * it in its own working directory, the workspace or the answerer's view of it: run there, a runtime would pick up a
 * config file of it (a `bunfig.toml`) that an agent could have written. Nothing of it comes from the agent.
 */
export function knowledgeMcpLauncher(
    dt: PinnedDt,
    root: string,
    cwd: string,
    configPath?: string,
    platform: NodeJS.Platform = process.platform,
): { readonly file: string; readonly text: string } {
    const command = dtCommandOf(dt);
    const words = [command.command, ...command.args, '-r', root, ...(configPath ? ['-c', configPath] : []), 'mcp'];
    [...words, cwd].forEach(checkWord);
    if (platform === 'win32') {
        for (const w of [...words, cwd]) if (CMD_SPECIAL.test(w)) throw new Error(`A path the dt mcp launcher cannot hold on Windows: ${JSON.stringify(w)}`);
        return { file: 'dt-mcp.cmd', text: `@echo off\r\ncd /d "${cwd}" || exit /b 1\r\n${words.map((w) => `"${w}"`).join(' ')}\r\n` };
    }
    return { file: 'dt-mcp', text: `#!/bin/sh\ncd ${shQuote(cwd)} || exit 1\nexec ${words.map(shQuote).join(' ')}\n` };
}

/**
 * Writes the launcher of `dt mcp` (`knowledgeMcpLauncher`) in a new private directory outside `root`, also `dt`'s
 * working directory; `dispose` removes it. `command` is what Claude Code starts.
 */
export async function writeKnowledgeMcpLauncher(
    dt: PinnedDt,
    root: string,
    configPath?: string,
): Promise<{ readonly command: string; readonly args: readonly string[]; dispose(): Promise<void> }> {
    const dir = await privateDir(root, 'domaintrail-dt-mcp-');
    try {
        const launcher = knowledgeMcpLauncher(dt, root, dir.dir, configPath);
        const file = path.join(dir.dir, launcher.file);
        await writeFile(file, launcher.text, { mode: 0o700 });
        await chmod(file, 0o700);
        return { command: file, args: [], dispose: () => dir.dispose() };
    } catch (e) {
        await dir.dispose();
        throw e;
    }
}

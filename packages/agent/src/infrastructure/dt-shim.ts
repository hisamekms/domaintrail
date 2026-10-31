// The agent's `dt` (ADR 0026): a private directory outside the workspace holding an executable `dt` that runs the
// configured command (by default this very CLI: its runtime and its entry), put first on the agent's PATH. The prompt
// and the allowed tools stay `dt fmt` / `dt check`, whatever `dt` is (or is not) installed on the facilitator's machine.
//
// The command's words are never re-parsed by a shell: the `dt` script (or `dt.cmd` on Windows) only starts this
// runtime on a launcher, which holds the command as JSON and spawns it with the agent's arguments and `shell: false`.
// The agent can write in the workspace while it runs, so nothing `dt` runs may be there: the command is pinned when the
// subscriber starts (`pinDtCommand`: its program resolved to its real file; refused through a package runner, or with
// the program or an argument inside the workspace), its files are fingerprinted then and checked before each run
// (`fingerprintDt`), the shim's directory is refused inside the workspace, and the command runs outside it (`-r`).
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { DtCommand } from './dt-tools.js';

/** A word quoted for `sh`: inside single quotes, a quote closed, escaped and reopened. */
const shQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;
/** Characters `cmd.exe` interprets even in double quotes, or that end them. */
const CMD_SPECIAL = /["%!^&|<>\r\n\0]/;

const checkWord = (w: string): void => {
    if (w === '' || /[\0\r\n]/.test(w)) throw new Error(`Not a command word: ${JSON.stringify(w)}`);
};

/**
 * The launcher: runs the command outside the workspace (`cwd`: the shim's own directory, so that no runtime picks a
 * config file of the workspace up), on the workspace it was called from (`-r`, the caller's directory), with the
 * caller's arguments — those naming an existing file there made absolute — without a shell; it exits as the command did.
 */
export function launcherScript(dt: DtCommand, cwd: string): string {
    [dt.command, ...dt.args, cwd].forEach(checkWord);
    return [
        "import { spawnSync } from 'node:child_process';",
        "import { existsSync } from 'node:fs';",
        "import { resolve } from 'node:path';",
        `const [command, ...args] = ${JSON.stringify([dt.command, ...dt.args])};`,
        'const here = process.cwd();',
        'const given = process.argv.slice(2).map((a) => (!a.startsWith("-") && existsSync(resolve(here, a)) ? resolve(here, a) : a));',
        `const r = spawnSync(command, [...args, '-r', here, ...given], { cwd: ${JSON.stringify(cwd)}, stdio: 'inherit', shell: false, windowsHide: true });`,
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

/** A path as it really is: symbolic links followed up to its deepest existing directory, the rest as written. */
const real = (p: string): string => {
    const abs = path.resolve(p);
    try {
        return realpathSync(abs);
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

/** Package runners: they fetch or resolve code from the workspace (`node_modules`, `package.json` scripts). */
const RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
const RUNNER_VERBS: Record<string, readonly string[]> = {
    npm: ['exec', 'x', 'run', 'run-script'],
    pnpm: ['dlx', 'exec', 'run'],
    yarn: ['dlx', 'exec', 'run'],
    bun: ['run', 'x'],
};

/** The words of a command that may name files: every argument that is not a bare flag, and the value of `--opt=value`. */
const candidates = (args: readonly string[]): string[] =>
    args.flatMap((a) => {
        if (!a.startsWith('-')) return [a];
        const eq = a.indexOf('=');
        return eq > 0 ? [a.slice(eq + 1)] : [];
    });

/** The command as `dt` runs it: the program resolved on the PATH to its real file, the arguments as given. */
export interface PinnedDt {
    readonly program: string;
    readonly args: readonly string[];
    /** The files it names (the program, and the arguments that are files), as they really are. */
    readonly files: readonly string[];
}

/**
 * Pins the `dt` command for a workspace: its program resolved on the PATH to its real file. Refused (with the reason)
 * when the program cannot be found, is a package runner, or when the program or any argument that is a file or a path
 * (also as `--opt=value`, relative ones taken from `root`) is inside the workspace, directly or through a symbolic
 * link: the agent writes there during a run, and could make `dt` run anything.
 */
export function pinDtCommand(dt: DtCommand, root: string, env: NodeJS.ProcessEnv = process.env): PinnedDt {
    const found = findProgram(dt.command, env);
    if (!found) throw new Error(`The agent's dt cannot run: ${dt.command} is not found.`);
    const program = real(found);
    // by the name given and by the file it is (npm is npm-cli.js)
    const names = [dt.command, program].map((p) =>
        path
            .basename(p)
            .toLowerCase()
            .replace(/\.(exe|cmd|bat|com|js|cjs|mjs)$/, '')
            .replace(/-cli$/, ''),
    );
    const verb = dt.args.find((a) => !a.startsWith('-'));
    if (names.some((name) => RUNNERS.has(name) || (verb !== undefined && RUNNER_VERBS[name]?.includes(verb))))
        throw new Error(`The agent's dt may not go through a package runner (${dt.command}): it resolves code from the workspace.`);
    if (inside(root, program)) throw new Error(`The agent's dt may not run anything inside the workspace (${dt.command}): the agent can write there.`);
    const files = [program];
    for (const word of candidates(dt.args)) {
        const resolved = path.resolve(root, word);
        if (!/[\\/]/.test(word) && !existsSync(resolved)) continue;
        if (inside(root, resolved)) throw new Error(`The agent's dt may not run anything inside the workspace (${word}): the agent can write there.`);
        if (isFile(resolved)) files.push(real(resolved));
    }
    return { program, args: dt.args, files };
}

/** A fingerprint of the files the pinned command names (SHA-256 of each), to tell that none changed since. */
export async function fingerprintDt(pinned: PinnedDt): Promise<string> {
    const hash = createHash('sha256');
    for (const file of pinned.files) {
        hash.update(file).update('\0');
        if (isFile(file)) hash.update(await readFile(file));
        hash.update('\0');
    }
    return hash.digest('hex');
}

/**
 * Writes the shim and its launcher in a new private directory (0700) outside `root`; `dispose` removes it. `runtime`
 * runs the launcher (default: this process's runtime).
 */
export async function writeDtShim(
    pinned: PinnedDt,
    root: string,
    runtime: string = process.execPath,
): Promise<{ readonly dir: string; dispose(): Promise<void> }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-dt-'));
    try {
        if (inside(root, dir)) throw new Error(`The temporary directory is inside the workspace (${dir}): refusing to put the agent's dt there.`);
        await chmod(dir, 0o700);
        const launcher = path.join(dir, 'launcher.mjs');
        await writeFile(launcher, launcherScript({ command: pinned.program, args: pinned.args }, dir), { mode: 0o600 });
        const shim = dtShim(runtime, launcher);
        const file = path.join(dir, shim.file);
        await writeFile(file, shim.text, { mode: 0o700 });
        await chmod(file, 0o700);
    } catch (e) {
        await rm(dir, { recursive: true, force: true });
        throw e;
    }
    return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

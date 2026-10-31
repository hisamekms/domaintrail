// The agent's `dt` (ADR 0026): a private directory outside the workspace holding an executable `dt` that runs the
// configured command (by default this very CLI: its runtime and its entry), put first on the agent's PATH. The prompt
// and the allowed tools stay `dt fmt` / `dt check`, whatever `dt` is (or is not) installed on the facilitator's machine.
//
// The command's words are never re-parsed by a shell: the `dt` script (or `dt.cmd` on Windows) only starts this
// runtime on a launcher, which holds the command as JSON and spawns it with the agent's arguments and `shell: false`.
// The agent can write in the workspace while it runs, so nothing `dt` runs may be there: the configured command is
// refused when a path of it is inside the workspace (`checkDtCommand`), its files are fingerprinted when the
// subscriber starts and checked before each run (`fingerprintDt`), and the shim's directory is refused inside it.
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

/** The launcher: spawns the command with the arguments it is given, without a shell, and exits as it did. */
export function launcherScript(dt: DtCommand): string {
    [dt.command, ...dt.args].forEach(checkWord);
    return [
        "import { spawnSync } from 'node:child_process';",
        `const [command, ...args] = ${JSON.stringify([dt.command, ...dt.args])};`,
        "const r = spawnSync(command, [...args, ...process.argv.slice(2)], { stdio: 'inherit', shell: false, windowsHide: true });",
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

/** A path as it really is (symbolic links followed), or as written when it does not exist. */
const real = (p: string): string => {
    try {
        return realpathSync(p);
    } catch {
        return path.resolve(p);
    }
};

/** Whether `p` is `root` or inside it, both taken as they really are. */
export function inside(root: string, p: string): boolean {
    const rel = path.relative(real(root), real(p));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The words of a command that are paths (with a separator, not an option). */
const pathWords = (dt: DtCommand): string[] => [dt.command, ...dt.args].filter((w) => /[\\/]/.test(w) && !w.startsWith('-'));

/**
 * Refuses a `dt` command with a path inside the workspace (directly or through a symbolic link): the agent writes
 * there, and could make `dt` run anything.
 */
export function checkDtCommand(dt: DtCommand, root: string): void {
    for (const w of pathWords(dt)) {
        if (inside(root, w)) throw new Error(`The agent's dt may not run anything inside the workspace (${w}): the agent can write there.`);
    }
}

/** A fingerprint of the files the command names (SHA-256 of each), to tell that none changed since. */
export async function fingerprintDt(dt: DtCommand): Promise<string> {
    const hash = createHash('sha256');
    for (const w of pathWords(dt)) {
        const file = real(w);
        hash.update(file).update('\0');
        if (existsSync(file) && statSync(file).isFile()) hash.update(await readFile(file));
        hash.update('\0');
    }
    return hash.digest('hex');
}

/** A bare program name resolved on the PATH as Windows would (with PATHEXT), for a shim that never searches itself. */
export function resolveProgram(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
    if (platform !== 'win32' || /[\\/]/.test(command)) return command;
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
    const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    for (const dir of (key ? env[key] : '')?.split(path.delimiter) ?? []) {
        for (const ext of ['', ...exts]) {
            const candidate = path.join(dir, command + ext);
            if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
        }
    }
    return command;
}

/**
 * Writes the shim and its launcher in a new private directory (0700) outside `root`; `dispose` removes it. `runtime`
 * runs the launcher (default: this process's runtime).
 */
export async function writeDtShim(
    dt: DtCommand,
    root: string,
    runtime: string = process.execPath,
): Promise<{ readonly dir: string; dispose(): Promise<void> }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-dt-'));
    try {
        if (inside(root, dir)) throw new Error(`The temporary directory is inside the workspace (${dir}): refusing to put the agent's dt there.`);
        await chmod(dir, 0o700);
        const launcher = path.join(dir, 'launcher.mjs');
        await writeFile(launcher, launcherScript({ command: resolveProgram(dt.command), args: dt.args }), { mode: 0o600 });
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
